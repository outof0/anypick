package doctor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/journal"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/modelcache"
	"github.com/outof0/anypick/go/internal/ownership"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
)

// This file is the mutation half of the doctor. doctor.go stays read-only by
// contract; everything that writes lives here so "diagnose" and "repair" can be
// reviewed against different bars.
//
// The allowlist is seven kinds. There is no delete_stale_lock kind: locks
// are flock(2) descriptors opened O_CREAT|O_RDWR at
// internal/lock/platform_unix.go — never written to, and released by the kernel
// when the holder dies. There is no stale lock to find, so advertising one only
// invited a repair that could delete a lock a live process holds. The decision
// to drop it is recorded in docs/src/content/docs/reference/troubleshooting.mdx
// as well as here.

// FixKind names one allowlisted repair. The string values are the contract the
// docs and the CLI plan output use.
type FixKind string

const (
	FixDeleteTempOverlay       FixKind = "delete_temp_overlay"
	FixRepairPermissions       FixKind = "repair_permissions"
	FixRebuildCaches           FixKind = "rebuild_caches"
	FixDeleteStalePID          FixKind = "delete_stale_pid"
	FixStopOrphanProxy         FixKind = "stop_orphan_proxy"
	FixCompleteJournalRollback FixKind = "complete_journal_rollback"
	FixRemoveOrphanedProfile   FixKind = "remove_orphaned_profile"
)

// FixAllowlist is the hard allowlist from the CLI-DX spec §18.4, minus the
// stale-lock entry that cannot exist (see the file comment). A kind not in this
// list is refused at plan time and again at apply time; the second check is not
// redundant, because ApplyFixes accepts a plan from any caller.
var FixAllowlist = []FixKind{
	FixDeleteTempOverlay,
	FixRepairPermissions,
	FixRebuildCaches,
	FixDeleteStalePID,
	FixStopOrphanProxy,
	FixCompleteJournalRollback,
	FixRemoveOrphanedProfile,
}

// Allowlisted reports whether a kind may be applied.
func Allowlisted(kind FixKind) bool {
	for _, k := range FixAllowlist {
		if k == kind {
			return true
		}
	}
	return false
}

// String renders a kind for human output.
func (k FixKind) String() string { return string(k) }

// FixAction is one planned repair. Target is an absolute path or a resource
// reference, never a value the caller may widen at apply time.
type FixAction struct {
	ID          string  `json:"id"`
	Kind        FixKind `json:"kind"`
	Description string  `json:"description"`
	Target      string  `json:"target"`
	// Provider/Account carry the identity stop_orphan_proxy needs. They are
	// separate fields rather than a params map so a typo cannot silently drop
	// them and turn the guard into a no-op.
	Provider string `json:"provider,omitempty"`
	Account  string `json:"account,omitempty"`
	// JournalIDs are the incomplete entries complete_journal_rollback covers.
	// Recovery is a whole-journal replay, so one action carries every pending
	// id rather than one action per id.
	JournalIDs []string `json:"journalIds,omitempty"`
	// Reason is set when the scan found the target but refuses to touch it.
	// A refused action is still reported: omitting it would make --fix look
	// like it had nothing to say.
	Reason string `json:"reason,omitempty"`
	// Paths carries the exact paths the diagnosis flagged, for repairs that
	// must touch only what the report names (repair_permissions). Empty for
	// repairs whose target is the whole root.
	Paths []string `json:"paths,omitempty"`
}

// ManualFinding is a diagnosis that --fix must not touch. The split is real:
// the CLI prints these with their manual command and never plans them.
type ManualFinding struct {
	Check       string   `json:"check"`
	Detail      string   `json:"detail"`
	Suggestions []string `json:"suggestions,omitempty"`
}

// FixPlan is what PlanFixes returns: applicable actions and the findings that
// stay manual.
type FixPlan struct {
	Actions []FixAction     `json:"actions"`
	Manual  []ManualFinding `json:"manual"`
}

// FixOutcome is one applied (or refused) action.
type FixOutcome struct {
	ID      string  `json:"id"`
	Kind    FixKind `json:"kind"`
	OK      bool    `json:"ok"`
	Message string  `json:"message"`
}

// FixResult is the whole apply.
type FixResult struct {
	Applied []FixOutcome `json:"applied"`
	DryRun  bool         `json:"dryRun"`
	// JournalID names the doctor:fix row that recorded the mutation. Empty on
	// a dry run, which writes nothing (invariant #3).
	JournalID string `json:"journalId,omitempty"`
}

// FixDeps is the service slice the repairs need. Every collaborator is
// optional: a nil one degrades to a reported refusal instead of a panic, which
// is how a partially composed app (tests, the desktop protocol) stays safe.
type FixDeps struct {
	Root      string
	TempDir   string
	Providers []string
	Store     *modelcache.Store
	// Ownership is injectable so a test can plant a record without a process.
	// It is the read-only Inspect, never Load: planning must not mutate.
	Ownership func(string) (*ownership.Record, error)
	Binding   *bindings.Service
	// Leases answers "does any live lease reference this pair?" through the
	// proxy service, so this package never holds the lease store directly.
	Leases func(context.Context, string, string) ([]*proxy.Lease, error)
	Proxy  *proxy.Service
	// Journal is read for planning; Recovery is what actually rolls an
	// incomplete entry back. They are separate so planning stays read-only.
	Journal  *journal.OperationJournal
	Recovery func(context.Context) (*activation.RecoveryResult, error)
	// Now and MinOverlayAge make the one-hour overlay rule testable without
	// touching the filesystem clock.
	Now           func() time.Time
	MinOverlayAge time.Duration
	// RemoveOrphanedProfile removes ONE orphaned named profile's row. It is
	// wired to activation.RemoveNamedProfiles with PurgeCredentials=false by
	// the composition: doctor --fix may remove the profile CONFIG with the
	// user's consent, but it never deletes a credential home unattended.
	RemoveOrphanedProfile func(ctx context.Context, client, name string) error
	// NamedProfiles feeds the orphaned-profile plan; it is the doctor's own
	// audit input, so the plan and the report cannot disagree.
	NamedProfiles func(context.Context) ([]NamedProfileRef, error)
	// AccountExists resolves whether the account a profile points at still
	// exists. A lookup ERROR is not "gone": the plan skips it and lets the
	// next doctor run retry, so a transient lock timeout never reads as an
	// orphan (fail closed).
	AccountExists func(ctx context.Context, provider, name string) (bool, error)
}

func (d FixDeps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d FixDeps) minOverlayAge() time.Duration {
	if d.MinOverlayAge > 0 {
		return d.MinOverlayAge
	}
	return time.Hour
}

func (d FixDeps) tempDir() string {
	if d.TempDir != "" {
		return d.TempDir
	}
	return os.TempDir()
}

// PlanFixes turns a read-only scan of the filesystem and the database into the
// actions that may be applied. It performs no mutation, so `--fix --dry-run`
// and the confirmation prompt can share it.
// planOrphanedProfileRemovals adds one remove_orphaned_profile action per
// named profile whose account is gone. A lookup ERROR plans nothing for that
// profile (fail closed): a transient lock timeout must not read as an orphan.
// PurgeCredentials=false by construction — the wired remover never deletes a
// credential home.
func planOrphanedProfileRemovals(ctx context.Context, deps FixDeps, add func(FixAction)) {
	if deps.NamedProfiles == nil || deps.AccountExists == nil || deps.RemoveOrphanedProfile == nil {
		return
	}
	profiles, err := deps.NamedProfiles(ctx)
	if err != nil {
		return
	}
	for _, p := range profiles {
		if p.SourceKind != "account" {
			continue
		}
		exists, xerr := deps.AccountExists(ctx, p.Provider, p.AccountName)
		if xerr != nil || exists {
			continue
		}
		client, name := p.Client, p.Name
		add(FixAction{
			ID:          "remove_orphaned_profile:" + client + "/" + name,
			Kind:        FixRemoveOrphanedProfile,
			Description: fmt.Sprintf("Remove named profile %s/%s whose account %s/%s no longer exists (credential home left on disk)", client, name, p.Provider, p.AccountName),
			Target:      "profile:" + client + "/" + name,
		})
	}
}

func PlanFixes(ctx context.Context, deps FixDeps) FixPlan {
	plan := FixPlan{Actions: []FixAction{}, Manual: []ManualFinding{}}
	seen := map[string]bool{}
	add := func(a FixAction) {
		if !Allowlisted(a.Kind) || seen[a.ID] {
			return
		}
		seen[a.ID] = true
		plan.Actions = append(plan.Actions, a)
	}

	// Overlays live under the system temp directory, not the data root, so
	// this is the one kind whose guard is "under the system temp dir".
	for _, overlay := range scanTempOverlays(deps) {
		add(FixAction{
			ID:          "delete_temp_overlay:" + overlay.Name,
			Kind:        FixDeleteTempOverlay,
			Description: "Leftover temporary client overlay: " + overlay.Name,
			Target:      overlay.Path,
			Reason:      overlay.Refusal,
		})
	}

	// Permissions: the plan carries the exact paths the diagnosis flagged, so
	// the repair can never touch a path the report did not name. The earlier
	// shape walked the whole root and chmod'ed anything not 0700/0600, which
	// silently widened the reported scope: one 0644 file made every 0755
	// directory under the root get rewritten too.
	if paths := permissivePaths(deps.Root); len(paths) > 0 {
		add(FixAction{
			ID:          "repair_permissions:" + deps.Root,
			Kind:        FixRepairPermissions,
			Description: fmt.Sprintf("Repair permissions on %d AnyPick-owned path(s)", len(paths)),
			Target:      deps.Root,
			Paths:       paths,
		})
	}

	planOrphanedProfileRemovals(ctx, deps, add)

	// Rebuilding derived caches is safe and unconditional when the store is
	// present: the cache is advisory (internal/modelcache), and the spec's
	// "rebuild derived local caches" is a supported action whether or not a row
	// looks wrong.
	if deps.Store != nil && len(deps.Providers) > 0 {
		add(FixAction{
			ID:          "rebuild_caches:root",
			Kind:        FixRebuildCaches,
			Description: "Rebuild derived model caches",
			Target:      deps.Root,
		})
	}

	planPIDActions(deps, add, &plan)
	planOrphanActions(ctx, deps, add)

	// Incomplete journal entries. ONE action covers all of them, because
	// deps.Recovery is a whole-journal replay: it recovers every incomplete
	// entry in a single pass and reports the ids it could not finish. Planning
	// one action per entry ran that replay once per entry, so N pending entries
	// produced N identical recoveries and N lines each claiming the whole set.
	// The count a user read then depended on how many entries happened to be
	// pending rather than on what recovery did. EntryIDs keeps the per-entry
	// detail available for the message.
	if ids := incompleteJournalIDs(ctx, deps); len(ids) > 0 {
		add(FixAction{
			ID:          "complete_journal_rollback",
			Kind:        FixCompleteJournalRollback,
			Description: fmt.Sprintf("Complete or roll back %d interrupted operation(s)", len(ids)),
			Target:      "journal",
			JournalIDs:  ids,
		})
	}

	return plan
}

// planPIDActions plans a delete per dead PID record and reports each live one
// as manual, so the split the docs promise stays visible.
func planPIDActions(deps FixDeps, add func(FixAction), plan *FixPlan) {
	for _, rec := range scanPIDRecords(deps) {
		if rec.Alive {
			plan.Manual = append(plan.Manual, ManualFinding{
				Check:  "pid:" + rec.Provider + "/" + rec.Account,
				Detail: fmt.Sprintf("proxy PID record for %s/%s names live process %d", rec.Provider, rec.Account, rec.PID),
				Suggestions: []string{
					fmt.Sprintf("stop the proxy first: anypick proxy stop %s %s", rec.Provider, rec.Account),
				},
			})
			continue
		}
		add(FixAction{
			ID:          "delete_stale_pid:" + rec.Provider + "/" + rec.Account,
			Kind:        FixDeleteStalePID,
			Description: fmt.Sprintf("Stale proxy PID record for %s/%s", rec.Provider, rec.Account),
			Target:      rec.Path,
			Provider:    rec.Provider,
			Account:     rec.Account,
		})
	}
}

// planOrphanActions plans a stop per running proxy with no lease and no
// binding.
func planOrphanActions(ctx context.Context, deps FixDeps, add func(FixAction)) {
	for _, orphan := range scanOrphanProxies(ctx, deps) {
		add(FixAction{
			ID:          "stop_orphan_proxy:" + orphan.Provider + "/" + orphan.Account,
			Kind:        FixStopOrphanProxy,
			Description: fmt.Sprintf("Orphan proxy running for %s/%s", orphan.Provider, orphan.Account),
			Target:      orphan.Endpoint,
			Provider:    orphan.Provider,
			Account:     orphan.Account,
		})
	}
}

// ---------------------------------------------------------------------------
// scanning (read-only)
// ---------------------------------------------------------------------------

type overlayCandidate struct {
	Name    string
	Path    string
	Refusal string // non-empty when the overlay is too recent to touch
}

// scanTempOverlays finds the directories os.MkdirTemp creates for AnyPick-owned
// scratch space: "anypick-<client>-" in internal/runtime/ephemeral.go and
// internal/client/commandcode.go, and "anypick-live-checkpoint-" in
// internal/accounts/service.go. Nothing sweeps the checkpoint directories
// today, which is how they accumulate.
// scanTempOverlays lists AnyPick-owned directories under the system temp dir.
//
// The age check is the ONLY liveness signal available, and it is a heuristic,
// not a proof. An `anypick run <client>` overlay lives as long as its child
// process, which can exceed the one-hour threshold in an ordinary agent
// session, and nothing in the overlay records which process owns it: the
// runtime creates it with os.MkdirTemp and no ownership record. So a long-lived
// run CAN have its isolated home deleted underneath it.
//
// That is why the threshold is a FixDeps field a caller can raise, and why the
// refusal message names the age rather than claiming the directory is dead.
// Treating age as liveness is a known limitation of this repair; the honest
// guard would be an ownership record on the overlay, which the runtime does not
// write today.
func scanTempOverlays(deps FixDeps) []overlayCandidate {
	entries, err := os.ReadDir(deps.tempDir())
	if err != nil {
		return nil
	}
	cutoff := deps.now().Add(-deps.minOverlayAge())
	var out []overlayCandidate
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "anypick-") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		candidate := overlayCandidate{
			Name: entry.Name(),
			Path: filepath.Join(deps.tempDir(), entry.Name()),
		}
		if info.ModTime().After(cutoff) {
			candidate.Refusal = fmt.Sprintf(
				"modified %s ago; refusing to delete an overlay younger than %s",
				deps.now().Sub(info.ModTime()).Round(time.Second), deps.minOverlayAge())
		}
		out = append(out, candidate)
	}
	return out
}

// scanPermissions lived here and duplicated doctor.go's countPermissivePaths.
// The scan belongs with the read-only diagnosis, so this file calls it rather
// than keeping a second copy that could drift from the one the report uses.

type pidCandidate struct {
	Provider string
	Account  string
	Path     string
	PID      int
	Alive    bool
	// Stale marks a record Inspect refused: unreadable, wrong version, or a
	// legacy bare-PID file. It is planned for deletion, never deleted during
	// planning.
	Stale  bool
	Reason string
}

// scanPIDRecords reads every account proxy PID path under the data root.
//
// It reads through ownership.Inspect, never ownership.Load: Load DELETES a
// record it cannot trust, and PlanFixes promises to perform no mutation so
// that `--fix --dry-run`, the confirmation prompt and a non-TTY refusal can
// all share it. Planning through Load made `doctor --fix --dry-run` delete
// proxy.pid files while printing nothing about them, and made the non-TTY
// refusal mutate before refusing. A record Inspect refuses becomes a
// delete_stale_pid action, so the deletion happens at apply time, under the
// plan and the journal.
func scanPIDRecords(deps FixDeps) []pidCandidate {
	if deps.Root == "" {
		return nil
	}
	providers, err := os.ReadDir(filepath.Join(deps.Root, "providers"))
	if err != nil {
		return nil
	}
	inspect := deps.Ownership
	if inspect == nil {
		inspect = ownership.Inspect
	}
	var out []pidCandidate
	for _, provider := range providers {
		if !provider.IsDir() {
			continue
		}
		accounts, err := os.ReadDir(filepath.Join(deps.Root, "providers", provider.Name(), "accounts"))
		if err != nil {
			continue
		}
		for _, account := range accounts {
			if !account.IsDir() {
				continue
			}
			pidPath := paths.ProxyPidPath(deps.Root, provider.Name(), account.Name())
			if _, err := os.Stat(pidPath); err != nil {
				continue
			}
			rec, ierr := inspect(pidPath)
			if ierr != nil {
				// Unreadable, wrong version, or a legacy bare-PID file. The
				// record is untrustworthy, so it is planned for deletion
				// rather than deleted here.
				out = append(out, pidCandidate{
					Provider: provider.Name(), Account: account.Name(),
					Path: pidPath, Stale: true, Reason: ierr.Error(),
				})
				continue
			}
			if rec == nil {
				continue
			}
			out = append(out, pidCandidate{
				Provider: provider.Name(), Account: account.Name(),
				Path: pidPath, PID: rec.PID, Alive: rec.Alive(),
			})
		}
	}
	return out
}

type orphanCandidate struct {
	Provider string
	Account  string
	Endpoint string
}

// scanOrphanProxies finds running account proxies with neither a live lease nor
// a binding that references them. A proxy whose pair is still referenced is
// skipped, and so is one whose status cannot be read.
func scanOrphanProxies(ctx context.Context, deps FixDeps) []orphanCandidate {
	if deps.Proxy == nil || deps.Root == "" {
		return nil
	}
	providers, err := os.ReadDir(filepath.Join(deps.Root, "providers"))
	if err != nil {
		return nil
	}
	var out []orphanCandidate
	for _, provider := range providers {
		if !provider.IsDir() {
			continue
		}
		accounts, err := os.ReadDir(filepath.Join(deps.Root, "providers", provider.Name(), "accounts"))
		if err != nil {
			continue
		}
		for _, account := range accounts {
			if !account.IsDir() {
				continue
			}
			st, err := deps.Proxy.StatusContext(ctx, provider.Name(), account.Name())
			if err != nil || st == nil || !st.Running {
				continue
			}
			if referencesPair(ctx, deps, provider.Name(), account.Name()) {
				continue
			}
			out = append(out, orphanCandidate{
				Provider: provider.Name(), Account: account.Name(), Endpoint: st.Endpoint,
			})
		}
	}
	return out
}

// referencesPair reports whether any live lease or any binding still names the
// provider/account. Fail closed: an unreadable store counts as a reference, so
// a database error never turns into "nothing references this, stop it".
func referencesPair(ctx context.Context, deps FixDeps, providerID, accountName string) bool {
	if deps.Leases != nil {
		leases, err := deps.Leases(ctx, providerID, accountName)
		if err != nil || len(leases) > 0 {
			return true
		}
	}
	if deps.Binding != nil {
		globals, err := deps.Binding.ListGlobalsContext(ctx)
		if err != nil {
			return true
		}
		for _, b := range globals {
			if namesPair(b.Spec.Source, providerID, accountName) {
				return true
			}
		}
		projects, err := deps.Binding.ListProjectsContext(ctx)
		if err != nil {
			return true
		}
		for _, p := range projects {
			if namesPair(p.Spec.Source, providerID, accountName) {
				return true
			}
		}
	}
	return false
}

func namesPair(source refs.Ref, providerID, accountName string) bool {
	switch source.Kind {
	case refs.KindAccount:
		return source.Provider == providerID && source.Name == accountName
	case refs.KindAccountPool:
		// A pool binding stores {Kind: account-pool, Provider: gemini, Name:
		// ""} — no account name. Its runtime state and lease live under the
		// pool's PRIMARY account slot, so provider match alone is the signal:
		// without this case the guard reported "nothing references this" for a
		// working pool route and stop_orphan_proxy killed a live pool proxy as
		// a "repair".
		return source.Provider == providerID
	default:
		return false
	}
}

// incompleteJournalIDs lists the entries recovery would act on, without acting.
// The read goes through the journal store directly: calling
// activation.RecoverIncompleteOperations here would roll entries back during a
// dry run, which is exactly what --dry-run promises not to do.
func incompleteJournalIDs(ctx context.Context, deps FixDeps) []string {
	if deps.Journal == nil {
		return nil
	}
	entries, err := deps.Journal.ListIncompleteContext(ctx)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.ID)
	}
	return out
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

// ApplyFixes executes a plan. A dry run reports what would happen and touches
// nothing; a real run journals the whole mutation first (spec §18.6) so a crash
// mid-repair is recoverable by the same recovery path that handles activation.
func ApplyFixes(ctx context.Context, plan FixPlan, deps FixDeps, dryRun bool) FixResult {
	result := FixResult{Applied: []FixOutcome{}, DryRun: dryRun}
	if dryRun {
		for _, action := range plan.Actions {
			result.Applied = append(result.Applied, FixOutcome{
				ID: action.ID, Kind: action.Kind, OK: action.Reason == "",
				Message: "[dry-run] " + dryRunMessage(action),
			})
		}
		return result
	}

	var journalID string
	if deps.Journal != nil && len(plan.Actions) > 0 {
		entry, err := deps.Journal.CreateContext(ctx, "doctor:fix", journal.CreateOptions{
			AffectedResources: actionTargets(plan.Actions),
			State:             journal.StateExecuting,
		})
		if err != nil {
			// A journal that cannot record the mutation is a reason not to
			// mutate: the whole point of the row is that a crash is visible.
			for _, action := range plan.Actions {
				result.Applied = append(result.Applied, FixOutcome{
					ID: action.ID, Kind: action.Kind, OK: false,
					Message: "refused: could not journal the fix: " + err.Error(),
				})
			}
			return result
		}
		journalID = entry.ID
		result.JournalID = journalID
	}

	allOK := true
	for _, action := range plan.Actions {
		if action.Reason != "" {
			allOK = false
			result.Applied = append(result.Applied, FixOutcome{
				ID: action.ID, Kind: action.Kind, OK: false, Message: "refused: " + action.Reason,
			})
			continue
		}
		message, err := applyFix(ctx, action, deps)
		if err != nil {
			allOK = false
			result.Applied = append(result.Applied, FixOutcome{
				ID: action.ID, Kind: action.Kind, OK: false, Message: err.Error(),
			})
			continue
		}
		result.Applied = append(result.Applied, FixOutcome{
			ID: action.ID, Kind: action.Kind, OK: true, Message: message,
		})
	}

	if journalID != "" {
		state := journal.StateCommitted
		if !allOK {
			state = journal.StateFailed
		}
		_, _ = deps.Journal.UpdateContext(ctx, journalID, journal.Entry{State: state})
	}
	return result
}

func actionTargets(actions []FixAction) []string {
	out := make([]string, 0, len(actions))
	for _, action := range actions {
		out = append(out, action.Target)
	}
	return out
}

func dryRunMessage(action FixAction) string {
	if action.Reason != "" {
		return "would refuse " + action.Kind.String() + ": " + action.Reason
	}
	message := "would " + action.Kind.String() + ": " + action.Description
	if action.Target != "" && !strings.Contains(action.Description, action.Target) {
		message += " (" + action.Target + ")"
	}
	return message
}

// DryRunMessage is dryRunMessage for callers that render the plan themselves
// (the CLI's printDryRunFields path). It carries no "[dry-run]" prefix: the
// renderer adds that.
func DryRunMessage(action FixAction) string { return dryRunMessage(action) }

func applyFix(ctx context.Context, action FixAction, deps FixDeps) (string, error) {
	if !Allowlisted(action.Kind) {
		return "", anyerr.Newf("refused non-allowlisted fix kind: "+action.Kind.String(), "FIX_NOT_ALLOWED",
			anyerr.WithSuggestions("Run `anypick doctor --fix --dry-run` to see the allowlisted plan."))
	}
	switch action.Kind {
	case FixDeleteTempOverlay:
		return fixDeleteTempOverlay(action, deps)
	case FixRepairPermissions:
		return fixRepairPermissions(action, deps)
	case FixRebuildCaches:
		return fixRebuildCaches(ctx, deps)
	case FixDeleteStalePID:
		return fixDeleteStalePID(action, deps)
	case FixStopOrphanProxy:
		return fixStopOrphanProxy(ctx, action, deps)
	case FixCompleteJournalRollback:
		return fixCompleteJournalRollback(ctx, action, deps)
	case FixRemoveOrphanedProfile:
		client, name, ok := strings.Cut(strings.TrimPrefix(action.Target, "profile:"), "/")
		if !ok || deps.RemoveOrphanedProfile == nil {
			return "", anyerr.Newf("orphaned profile removal is unavailable in this composition",
				"FIX_UNAVAILABLE")
		}
		if err := deps.RemoveOrphanedProfile(ctx, client, name); err != nil {
			return "", anyerr.Wrapf(err, "remove orphaned profile "+client+"/"+name, "STATE_CONFLICT")
		}
		return fmt.Sprintf("removed named profile %s/%s (credential home left on disk)", client, name), nil
	default:
		return "", anyerr.Newf("unknown fix kind: "+action.Kind.String(), "FIX_NOT_ALLOWED")
	}
}

func fixDeleteTempOverlay(action FixAction, deps FixDeps) (string, error) {
	if !isUnder(deps.tempDir(), action.Target) {
		return "", anyerr.Newf("refusing to delete overlay outside the system temp directory: "+action.Target,
			"FIX_OUTSIDE_ROOT",
			anyerr.WithSuggestions("This is a doctor bug; report it rather than deleting by hand."))
	}
	if !strings.HasPrefix(filepath.Base(action.Target), "anypick-") {
		return "", anyerr.Newf("not an AnyPick-owned temp overlay: "+action.Target, "FIX_OUTSIDE_ROOT")
	}
	info, err := os.Lstat(action.Target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "overlay already gone: " + action.Target, nil
		}
		return "", anyerr.Wrapf(err, "stat overlay "+action.Target, "FS_PATH")
	}
	if !info.IsDir() {
		return "", anyerr.Newf("not a directory: "+action.Target, "FIX_OUTSIDE_ROOT")
	}
	if age := deps.now().Sub(info.ModTime()); age < deps.minOverlayAge() {
		return "", anyerr.Newf(
			fmt.Sprintf("overlay %s was modified %s ago; refusing to delete anything younger than %s",
				action.Target, age.Round(time.Second), deps.minOverlayAge()),
			"FIX_OVERLAY_RECENT",
			anyerr.WithSuggestions("A live `anypick run` may own this directory. Retry once it is idle."))
	}
	if err := os.RemoveAll(action.Target); err != nil {
		return "", anyerr.Wrapf(err, "delete overlay "+action.Target, "FS_PATH")
	}
	return "deleted temp overlay: " + action.Target, nil
}

// fixRepairPermissions walks only the data root and only ever tightens modes.
// The root itself is the guard: a target outside it is refused, not skipped, so
// a caller that hands in the wrong path cannot chmod the user's home. Symlinks
// are skipped rather than followed, because following one is how a walk inside
// the root reaches a file outside it.
func fixRepairPermissions(action FixAction, deps FixDeps) (string, error) {
	if runtime.GOOS == "windows" {
		return "", anyerr.Newf("permission repair by POSIX mode is unavailable on Windows; files use inherited ACLs", "FIX_UNSUPPORTED")
	}
	if deps.Root == "" {
		return "", anyerr.Newf("no data root to repair", "FIX_OUTSIDE_ROOT")
	}
	if !isUnder(deps.Root, action.Target) {
		return "", anyerr.Newf("refusing to repair permissions outside the data root: "+action.Target,
			"FIX_OUTSIDE_ROOT",
			anyerr.WithSuggestions("Only paths under "+deps.Root+" are AnyPick-owned."))
	}
	if len(action.Paths) == 0 {
		return "", anyerr.Newf("repair_permissions carried no path list; re-run anypick doctor to plan it",
			"STATE_CONFLICT")
	}
	fixed := 0
	for _, path := range action.Paths {
		if !isUnder(deps.Root, path) {
			continue // the plan is stale or hand-edited; never widen it
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			continue // vanished or a symlink: not ours to touch
		}
		// Tighten group/other access only; owner bits (including +x) are the
		// user's. An 0755 script becomes 0700, not 0600, so no repair ever
		// strips an executable bit — and the previous mode needs no record
		// because nothing about the owner half changes.
		mode := info.Mode().Perm() &^ 0o077
		if mode == info.Mode().Perm() {
			continue // already tight
		}
		if cerr := os.Chmod(path, mode); cerr == nil {
			fixed++
		}
	}
	return fmt.Sprintf("repaired permissions on %d AnyPick-owned path(s) under %s", fixed, deps.Root), nil
}

// fixRebuildCaches drops the SQLite model cache per provider. The cache is
// rows in anypick.db (internal/modelcache); there is no cache directory to
// rebuild.
func fixRebuildCaches(ctx context.Context, deps FixDeps) (string, error) {
	if deps.Store == nil {
		return "", anyerr.Newf("model cache store unavailable", "FIX_UNAVAILABLE",
			anyerr.WithSuggestions("Run this from the CLI, where the database is open."))
	}
	// modelcache.Store.Clear executes the DELETE itself and takes no lock, so
	// the coordinator scope lives on the caller: internal/discovery uses
	// "model-cache" for both its Write and its Clear. Taking it here is what
	// keeps this repair from interleaving with a concurrent discovery refresh
	// (ADR 0009 invariant 5). deps.Root is the root discovery locks.
	cleared := 0
	err := lock.WithMutationLock(ctx, deps.Root, "model-cache", func(c context.Context) error {
		for _, providerID := range deps.Providers {
			if cerr := deps.Store.Clear(c, providerID); cerr != nil {
				return anyerr.Wrapf(cerr, "clear model cache for "+providerID, "DB_WRITE")
			}
			cleared++
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("rebuilt derived caches for %d provider(s)", cleared), nil
}

func fixDeleteStalePID(action FixAction, deps FixDeps) (string, error) {
	if !isUnder(deps.Root, action.Target) {
		return "", anyerr.Newf("refusing to delete a PID record outside the data root: "+action.Target,
			"FIX_OUTSIDE_ROOT",
			anyerr.WithSuggestions("Only paths under "+deps.Root+" are AnyPick-owned."))
	}
	inspect := deps.Ownership
	if inspect == nil {
		inspect = ownership.Inspect
	}
	rec, ierr := inspect(action.Target)
	if ierr != nil {
		// The record is unreadable, wrong-version, or a legacy bare-PID file.
		// That is what this repair is for, and planning already refused to
		// touch it, so the deletion happens here under the plan and journal.
		if derr := ownership.Discard(action.Target); derr != nil {
			return "", anyerr.Wrapf(derr, "delete PID record "+action.Target, "FS_PATH")
		}
		return "deleted unreadable PID record: " + action.Target, nil
	}
	if rec == nil {
		if _, err := os.Stat(action.Target); errors.Is(err, os.ErrNotExist) {
			return "PID record already gone: " + action.Target, nil
		}
		return "", anyerr.Newf("not a live AnyPick ownership record: "+action.Target,
			"STATE_CONFLICT",
			anyerr.WithSuggestions("Delete it by hand only if no proxy is running for this account."))
	}
	if rec.Alive() {
		return "", anyerr.Newf(
			fmt.Sprintf("process %d is still running; refusing to delete %s", rec.PID, action.Target),
			"STATE_CONFLICT",
			anyerr.WithSuggestions(fmt.Sprintf("Stop the proxy first: anypick proxy stop %s %s", action.Provider, action.Account)))
	}
	if err := os.Remove(action.Target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", anyerr.Wrapf(err, "delete PID record "+action.Target, "FS_PATH")
	}
	return "deleted stale PID record: " + action.Target, nil
}

func fixStopOrphanProxy(ctx context.Context, action FixAction, deps FixDeps) (string, error) {
	if action.Provider == "" || action.Account == "" {
		return "", anyerr.Newf("orphan proxy fix requires a provider and account", "FIX_NOT_ALLOWED")
	}
	// Re-check the guard before anything else. The plan may be stale — a
	// binding can appear between planning and applying — and stopping a proxy
	// a live binding references would break a working login.
	if referencesPair(ctx, deps, action.Provider, action.Account) {
		return "", anyerr.Newf(
			fmt.Sprintf("a live lease or binding still references %s/%s; refusing to stop it",
				action.Provider, action.Account),
			"STATE_CONFLICT",
			anyerr.WithSuggestions(fmt.Sprintf("Run `anypick reset %s` or `anypick proxy stop %s %s` first.",
				action.Provider, action.Provider, action.Account)))
	}
	if deps.Proxy == nil {
		return "", anyerr.Newf("proxy service unavailable", "FIX_UNAVAILABLE")
	}
	if err := deps.Proxy.Stop(ctx, action.Provider, action.Account); err != nil {
		return "", anyerr.Wrapf(err, "stop orphan proxy "+action.Provider+"/"+action.Account, "PROXY_STOP_FAILED")
	}
	return fmt.Sprintf("stopped orphan proxy %s/%s", action.Provider, action.Account), nil
}

func fixCompleteJournalRollback(ctx context.Context, action FixAction, deps FixDeps) (string, error) {
	if deps.Recovery == nil {
		return "", anyerr.Newf("journal recovery unavailable", "FIX_UNAVAILABLE")
	}
	if len(action.JournalIDs) == 0 {
		return "", anyerr.Newf("journal fix requires at least one entry id", "FIX_NOT_ALLOWED")
	}
	// One replay covers every pending entry. The action carries the ids it was
	// planned for so the message can say which of them recovery did not report,
	// which is the per-entry detail the old one-action-per-entry shape was
	// reaching for without running the replay N times.
	result, err := deps.Recovery(ctx)
	if err != nil {
		return "", anyerr.Wrapf(err, "recover incomplete operations", "DB_WRITE")
	}
	if result == nil {
		return "", anyerr.Newf("journal recovery returned no result", "STATE_CONFLICT")
	}
	message := fmt.Sprintf("journal recovery: recovered=%d failed=%d refused=%d",
		result.Recovered, len(result.Failed), len(result.Refused))
	var unreported []string
	for _, id := range action.JournalIDs {
		if !containsString(result.Failed, id) && !containsString(result.Refused, id) {
			unreported = append(unreported, id)
		}
	}
	if len(unreported) > 0 {
		message += "; not reported by recovery: " + strings.Join(unreported, ", ")
	}
	return message, nil
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// isUnder reports whether path is root or a descendant of it. It compares
// cleaned absolute paths, so ".." cannot escape. An empty root or path is never
// under anything, which makes a missing target a refusal rather than a
// root-wide match.
func isUnder(root, path string) bool {
	if root == "" || path == "" {
		return false
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
