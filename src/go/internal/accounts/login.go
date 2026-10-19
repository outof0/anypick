// Run a provider-owned browser sign-in, then commit its native credential
// as an AnyPick account. The prior native login and active pointer are
// restored exactly if any step after checkpointing fails.
package accounts

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
	"github.com/outof0/anypick/go/internal/store"
)

const fallbackAccountName = "stash"

// loginCommitHook runs after the snapshot commit and before the cancel
// barrier. Tests cancel in that window. Production leaves it nil.
var loginCommitHook func()

// LoginResult is the saved-account outcome of a browser sign-in, minus
// protocol framing.
type LoginResult struct {
	Provider   string               `json:"provider"`
	Account    store.Meta           `json:"account"`
	Method     provider.LoginMethod `json:"method"`
	BackedUpTo *string              `json:"backedUpTo,omitempty"`
}

// LoginOptions carries the caller-supplied naming and method choice.
type LoginOptions struct {
	MethodID string
	Source   string
	Name     string
	Label    string
	// RefuseDistinctOverwrite rejects a save onto an existing account whose
	// identity is not this login. Codex profile login sets it so a profile
	// name cannot wipe a desktop account that merely shares the name.
	// A profile that already owns the account leaves it false so a refresh
	// can replace that profile's own snapshot.
	RefuseDistinctOverwrite bool
}

// LoginMethods lists a provider's browser sign-in methods, filtered by source
// and ordered by preference only (official first, then preferred, then label).
func (s *Service) LoginMethods(_ context.Context, providerID, source string) ([]provider.LoginMethod, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return nil, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	methodsp, isMethodAware := pv.(provider.LoginMethodsProvider)
	_, canLogin := pv.(provider.Loginer)
	if !isMethodAware || !canLogin {
		return []provider.LoginMethod{}, nil
	}
	methods := append([]provider.LoginMethod(nil), methodsp.LoginMethods()...)
	filtered := make([]provider.LoginMethod, 0, len(methods))
	for _, m := range methods {
		if source != "" && m.Source != "" && m.Source != source {
			continue
		}
		filtered = append(filtered, m)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		oi := 0
		if a.Provenance == "official" {
			oi = 1
		}
		oj := 0
		if b.Provenance == "official" {
			oj = 1
		}
		if oi != oj {
			return oi > oj
		}
		pi, pj := 0, 0
		if a.Preferred {
			pi = 1
		}
		if b.Preferred {
			pj = 1
		}
		if pi != pj {
			return pi > pj
		}
		return a.Label < b.Label
	})
	return filtered, nil
}

// Login runs the browser flow and saves the resulting live credential under
// the provider's single mutation scope (ADR 0009/0011).
func (s *Service) Login(ctx context.Context, providerID string, opts LoginOptions) (LoginResult, error) {
	var result LoginResult
	err := lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID),
		func(c context.Context) error {
			r, runErr := s.loginLocked(c, providerID, opts)
			if runErr == nil {
				result = r
			}
			return runErr
		})
	if err != nil {
		return result, err
	}
	changed := []store.Meta{result.Account}
	if result.BackedUpTo != nil {
		changed = append(changed, store.Meta{Provider: providerID, Name: *result.BackedUpTo})
	}
	if err := s.afterSnapshotChanges(ctx, changed); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Service) loginLocked(ctx context.Context, providerID string, opts LoginOptions) (LoginResult, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return LoginResult{}, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	_, isMethodAware := pv.(provider.LoginMethodsProvider)
	loginer, canLogin := pv.(provider.Loginer)
	if !isMethodAware || !canLogin {
		return LoginResult{}, anyerr.Newf(
			pv.Name()+" does not offer browser sign-in.",
			"PROVIDER_LOGIN_UNSUPPORTED")
	}

	sourceCount := 1
	if sp, ok := pv.(interface{ AccountSourceCount() int }); ok {
		sourceCount = sp.AccountSourceCount()
	}
	needsSource := sourceCount > 1
	if needsSource && opts.Source == "" && opts.MethodID == "" {
		return LoginResult{}, anyerr.Newf(
			"Choose which "+pv.Name()+" sign-in source to use.",
			"ACCOUNT_SOURCE_REQUIRED",
			anyerr.WithSuggestions(
				fmt.Sprintf("Select an available sign-in source for %s in the Add Login sheet.", pv.Name()),
				"Or pass --source <source> together with --auth-method <id> on the command line."))
	}

	methods, err := s.LoginMethods(ctx, providerID, opts.Source)
	if err != nil {
		return LoginResult{}, err
	}
	method, err := selectLoginMethod(methods, opts.MethodID)
	if err != nil {
		return LoginResult{}, err
	}
	if !method.Available {
		msg := method.UnavailableReason
		if msg == "" {
			msg = method.Label + " is unavailable."
		}
		return LoginResult{}, anyerr.Newf(
			msg,
			"PROVIDER_LOGIN_UNAVAILABLE",
			anyerr.WithSuggestions(
				fmt.Sprintf("Install %s on this Mac, then try again.", method.Label),
				"Ensure the application has completed its initial setup."))
	}
	source := opts.Source
	if source == "" {
		source = method.Source
	}
	if needsSource && source == "" {
		return LoginResult{}, anyerr.Newf(
			"Choose which "+pv.Name()+" sign-in source to use.",
			"ACCOUNT_SOURCE_REQUIRED",
			anyerr.WithSuggestions(
				fmt.Sprintf("Select an available sign-in source for %s in the Add Login sheet.", pv.Name()),
				"Or pass --source <source> together with --auth-method "+method.ID+" on the command line."))
	}
	if opts.Source != "" && method.Source != "" && opts.Source != method.Source {
		return LoginResult{}, anyerr.Newf(
			method.Label+" cannot sign in to source \""+opts.Source+"\".",
			"PROVIDER_LOGIN_METHOD_UNKNOWN")
	}

	checkpoint, err := s.CheckpointLiveAuth(ctx, providerID, false)
	if err != nil {
		return LoginResult{}, err
	}
	var backedUpTo *string
	defer func() { _ = s.DiscardLiveAuthCheckpoint(checkpoint) }()

	// preservedEnv is the live dotenv taken before the clear. An empty
	// checkpoint rolls back through ClearLive, which strips API-key and
	// Vertex lines the new OAuth snapshot does not replace; success merges
	// the same lines back so they are not discarded with the checkpoint.
	preservedEnv, preserveErr := preserveLiveEnv(pv)
	if preserveErr != nil {
		return LoginResult{}, preserveErr
	}
	restorePreserved := func() error { return restoreLiveEnv(pv, preservedEnv) }

	// overwritten is the account whose snapshot WriteMeta replaced. createdName
	// is an account this login inserted. Both stay empty until that commit, so
	// an earlier failure does not delete or rewrite a snapshot it never touched.
	var overwritten *store.Account
	var overwrittenSnap string
	var createdName string
	// rollbackOrCancel restores the checkpoint exactly once and returns the
	// cause (or the rollback failure when restoration itself broke).
	rollback := func(cause error) (LoginResult, error) {
		// Compensation runs after the trigger is gone — cancellation is the
		// most likely cause of this rollback, so restoring with the original
		// context would fail on its own cancellation and leave the user's real
		// previous login unrestored. WithoutCancel keeps the coordinator locks
		// the context carries while dropping the cancellation.
		rbCtx := context.WithoutCancel(ctx)
		var rbErr error
		switch {
		case overwritten != nil:
			// writeMeta already deleted the previous snapshot rows (ADR 0004).
			// Put that copy back before restoring the live files.
			rbErr = s.Store.WriteMetaContext(rbCtx, overwritten.Meta, overwrittenSnap)
		case createdName != "":
			_, rbErr = s.Delete(rbCtx, providerID, createdName)
		}
		liveErr := s.restoreCheckpointQuiet(rbCtx, checkpoint)
		if envErr := restorePreserved(); envErr != nil && liveErr == nil {
			liveErr = envErr
		}
		if rbErr == nil {
			rbErr = liveErr
		}
		if rbErr != nil {
			return LoginResult{}, anyerr.Wrapf(rbErr,
				"Provider sign-in failed and the previous login could not be restored",
				"PROVIDER_LOGIN_ROLLBACK_FAILED")
		}
		return LoginResult{}, cause
	}
	// commitBarrier closes the late-success race: once the launcher returns,
	// a cancel that arrives before AnyPick commits must not mutate state or
	// publish success (exactly-once cancellation).
	commitBarrier := func() error {
		if ctx.Err() != nil {
			return errLoginCancelled()
		}
		return nil
	}

	if checkpoint.HadLiveAuth {
		stashName, stashErr := s.stashBackupTarget(ctx, pv)
		if stashErr == nil {
			_, stashErr = s.saveLocked(ctx, pv, stashName, nil)
		}
		if stashErr != nil {
			return rollback(stashErr)
		}
		name := stashName
		backedUpTo = &name
	}

	// Browser login must start from an empty provider-owned staging store. The
	// checkpoint above is the compensation copy; clearing here prevents a
	// provider CLI from silently reusing the account that was already active.
	// The clear is the store this method is about to rewrite, not every
	// credential the provider can see: an external IDE login and an API key
	// the new snapshot does not replace must survive.
	if err := clearLiveForLogin(pv, source); err != nil {
		return rollback(err)
	}

	if err := loginer.Login(ctx, method.ID, source); err != nil {
		// Once the context is cancelled the terminal result must be
		// cancellation — however the launcher itself exited.
		if cerr := commitBarrier(); cerr != nil {
			return rollback(cerr)
		}
		return rollback(err)
	}
	// The launcher finished, but the request may already be abandoned.
	if cerr := commitBarrier(); cerr != nil {
		return rollback(cerr)
	}

	live, err := loginLiveSource(pv, source)
	if err != nil {
		return rollback(err)
	}
	if !live.Present {
		err := anyerr.Newf(
			method.Label+" completed without a usable local login.",
			"PROVIDER_LOGIN_NO_CREDENTIAL",
			anyerr.WithSuggestions("Try Sign In again and complete every step in the browser."))
		return rollback(err)
	}
	if cerr := commitBarrier(); cerr != nil {
		return rollback(cerr)
	}

	accountName, err := s.resolveCurrentSaveName(ctx, pv, opts.Name, live)
	if err != nil {
		return rollback(err)
	}
	accountName, err = s.avoidClobberingStash(ctx, pv, accountName, backedUpTo, live, source)
	if err != nil {
		return rollback(err)
	}
	if opts.RefuseDistinctOverwrite {
		if err := s.refuseDistinctOverwrite(ctx, pv, accountName, live); err != nil {
			return rollback(err)
		}
	}
	if previous, gerr := s.Get(ctx, providerID, accountName); gerr != nil {
		return rollback(gerr)
	} else if previous != nil {
		dir, merr := os.MkdirTemp("", "anypick-login-prev-")
		if merr != nil {
			return rollback(merr)
		}
		defer os.RemoveAll(dir)
		if cerr := s.Store.CopySnapshotFiles(ctx, providerID, accountName, dir); cerr != nil {
			return rollback(cerr)
		}
		overwritten = previous
		overwrittenSnap = dir
	}
	meta, err := s.saveLockedWithLabelSource(ctx, pv, accountName, opts.Label, source)
	if err != nil {
		return rollback(err)
	}
	if overwritten == nil {
		createdName = meta.Name
	}
	if loginCommitHook != nil {
		loginCommitHook()
	}
	// The snapshot write above is the commit (ADR 0004). A cancel here must
	// put the previous rows back rather than publish success.
	if cerr := commitBarrier(); cerr != nil {
		return rollback(cerr)
	}
	if err := restorePreserved(); err != nil {
		return rollback(err)
	}
	if err := s.Store.SetActiveContext(ctx, providerID, meta.Name); err != nil {
		return rollback(err)
	}
	return LoginResult{Provider: providerID, Account: meta, Method: method, BackedUpTo: backedUpTo}, nil
}

// liveEnvPreserver snapshots auth env lines a full ClearLive would strip.
// The login keeps them in memory because the checkpoint backup omits a
// Vertex-only dotenv, and success discards the checkpoint directory.
type liveEnvPreserver interface {
	PreserveAuthEnv() (string, error)
	RestoreAuthEnv(string) error
}

func preserveLiveEnv(pv provider.Provider) (string, error) {
	preserver, ok := pv.(liveEnvPreserver)
	if !ok {
		return "", nil
	}
	return preserver.PreserveAuthEnv()
}

func restoreLiveEnv(pv provider.Provider, body string) error {
	if body == "" {
		return nil
	}
	preserver, ok := pv.(liveEnvPreserver)
	if !ok {
		return nil
	}
	return preserver.RestoreAuthEnv(body)
}

// clearLiveForLogin clears the store the selected method rewrites. A provider
// that refuses CanClearLive for this source keeps its external credential;
// a source-scoped clear leaves every other store in place. Providers with
// only ClearLive (one credential file) keep that behavior.
func clearLiveForLogin(pv provider.Provider, source string) error {
	if policy, ok := pv.(provider.LiveClearPolicy); ok && !policy.CanClearLive(source) {
		return nil
	}
	if source != "" {
		if scoped, ok := pv.(interface{ ClearLiveSource(string) error }); ok {
			return scoped.ClearLiveSource(source)
		}
	}
	if clearer, ok := pv.(provider.LiveClearer); ok {
		return clearer.ClearLive()
	}
	return nil
}

// stashSnapshotPreserver reports when a source-scoped save would discard
// credentials the stash snapshot still holds.
type stashSnapshotPreserver interface {
	SourceSaveDropsSnapshot(snapshotDir, source string) bool
}

// avoidClobberingStash keeps the pre-login backup when the new source
// snapshot would replace it and drop an API key or another sign-in source.
// The new login is saved under a different name.
func (s *Service) avoidClobberingStash(ctx context.Context, pv provider.Provider, accountName string, backedUpTo *string, live provider.LiveAuthStatus, source string) (string, error) {
	if backedUpTo == nil || *backedUpTo == "" || *backedUpTo != accountName || source == "" {
		return accountName, nil
	}
	preserver, ok := pv.(stashSnapshotPreserver)
	if !ok {
		return accountName, nil
	}
	existing, err := s.Get(ctx, pv.ID(), accountName)
	if err != nil || existing == nil {
		return accountName, err
	}
	if !preserver.SourceSaveDropsSnapshot(existing.SnapshotDir, source) {
		return accountName, nil
	}
	base := accountName
	if live.Identity != "" {
		if derived, derr := accountNameFromIdentity(live.Identity); derr == nil && derived != "" {
			base = derived
		}
	}
	return s.accountNameAvoiding(ctx, pv.ID(), base, *backedUpTo)
}

// accountNameAvoiding returns a free account name, skipping the stash that
// this login must keep and any name already saved.
func (s *Service) accountNameAvoiding(ctx context.Context, providerID, base, avoid string) (string, error) {
	if strings.TrimSpace(base) == "" {
		base = fallbackAccountName
	}
	for n := 0; n < 100; n++ {
		candidate := base
		if n > 0 {
			candidate = fmt.Sprintf("%s-%d", base, n+1)
		}
		if candidate == avoid {
			continue
		}
		slugged, serr := slug.AccountName(candidate)
		if serr != nil {
			return "", serr
		}
		if slugged == avoid {
			continue
		}
		existing, err := s.Get(ctx, providerID, slugged)
		if err != nil {
			return "", err
		}
		if existing == nil {
			return slugged, nil
		}
	}
	return "", anyerr.Newf(
		"Could not choose a free account name that keeps the previous login.",
		"ACCOUNT_NAME_TAKEN")
}

// refuseDistinctOverwrite rejects a save that would replace an existing
// account with a login we cannot prove is the same one. Profile login sets
// this so a profile name cannot wipe a desktop account that shares it.
func (s *Service) refuseDistinctOverwrite(ctx context.Context, pv provider.Provider, accountName string, live provider.LiveAuthStatus) error {
	existing, err := s.Get(ctx, pv.ID(), accountName)
	if err != nil || existing == nil {
		return err
	}
	if provider.AccountScopedIdentity(live.Identity) && provider.AccountScopedIdentity(existing.Meta.Identity) &&
		identitiesEqual(existing.Meta.Identity, live.Identity) {
		return nil
	}
	if !provider.AccountScopedIdentity(live.Identity) && !provider.AccountScopedIdentity(existing.Meta.Identity) {
		return nil
	}
	return anyerr.Newf(
		pv.Name()+" account \""+accountName+"\" already exists and is a different login.",
		"ACCOUNT_NAME_TAKEN",
		anyerr.WithSuggestions(
			"Choose a name that is not an existing "+pv.Name()+" account.",
			"Or sign in as that account again so the saved login is refreshed."))
}

// stashBackupTarget resolves the backup name for the no-explicit-name
// path used by login: identity match first, then active reuse, then an
// identity-derived name, then "stash".
func (s *Service) stashBackupTarget(ctx context.Context, pv provider.Provider) (string, error) {
	live, err := pv.DetectLive()
	if err != nil {
		return "", err
	}
	if live.Identity != "" {
		if byIdentity := s.findAccountNameByIdentity(ctx, pv.ID(), live.Identity); byIdentity != "" {
			return byIdentity, nil
		}
	}
	active, err := s.Store.GetActive(ctx, pv.ID())
	if err != nil {
		return "", err
	}
	if active != "" {
		activeAccount, gerr := s.Store.Get(ctx, pv.ID(), active)
		if gerr == nil && activeAccount != nil &&
			(live.Identity == "" || activeAccount.Meta.Identity == "" ||
				identitiesEqual(activeAccount.Meta.Identity, live.Identity)) {
			return active, nil
		}
	}
	if live.Identity != "" {
		return accountNameFromIdentity(live.Identity)
	}
	return fallbackAccountName, nil
}

// resolveCurrentSaveName resolves the save name: existing identities win
// so a refreshed token overwrites its snapshot instead of aliasing.
func (s *Service) resolveCurrentSaveName(ctx context.Context, pv provider.Provider, requestedName string, live provider.LiveAuthStatus) (string, error) {
	if !live.Present {
		return "", anyerr.Newf(
			"No live "+pv.Name()+" login to save.",
			"NO_LIVE_AUTH",
			anyerr.WithSuggestions(
				fmt.Sprintf("Sign in to %s directly in the official app or browser, then try saving again.", pv.Name())))
	}
	if live.Identity != "" {
		if existing := s.findAccountNameByIdentity(ctx, pv.ID(), live.Identity); existing != "" {
			return existing, nil
		}
	}
	if strings.TrimSpace(requestedName) != "" {
		return slug.AccountName(requestedName)
	}
	active, err := s.Store.GetActive(ctx, pv.ID())
	if err != nil {
		return "", err
	}
	if active != "" {
		activeAccount, gerr := s.Store.Get(ctx, pv.ID(), active)
		if gerr == nil && activeAccount != nil &&
			(live.Identity == "" || activeAccount.Meta.Identity == "" ||
				identitiesEqual(activeAccount.Meta.Identity, live.Identity)) {
			return active, nil
		}
	}
	if live.Identity != "" {
		return accountNameFromIdentity(live.Identity)
	}
	return "", anyerr.Newf(
		"Name the "+pv.Name()+" login before saving it.",
		"MISSING_ACCOUNT_NAME",
		anyerr.WithSuggestions(
			"Enter an account name before saving.",
			"In the terminal, run: anypick add account "+pv.ID()+" --current --name <name>"))
}

func (s *Service) findAccountNameByIdentity(ctx context.Context, providerID, identity string) string {
	// Display-only constants ("API key") are not account identities: matching
	// one would resolve a different login onto the wrong account.
	if !provider.AccountScopedIdentity(identity) {
		return ""
	}
	accounts, err := s.Store.ListAccounts(ctx, providerID)
	if err != nil {
		return ""
	}
	for _, acct := range accounts {
		if acct.Meta.Identity != "" && identitiesEqual(acct.Meta.Identity, identity) {
			return acct.Meta.Name
		}
	}
	return ""
}

// accountNameFromIdentity derives a stable account name from an email or id;
// failures fall back to "stash".
func accountNameFromIdentity(identity string) (string, error) {
	trimmed := strings.TrimSpace(identity)
	local := trimmed
	if idx := strings.Index(trimmed, "@"); idx >= 0 {
		local = trimmed[:idx]
	}
	name, err := slug.AccountName(local)
	if err != nil {
		return fallbackAccountName, nil
	}
	return name, nil
}

func (s *Service) saveLockedWithLabelSource(ctx context.Context, pv provider.Provider, accountName, label, source string) (store.Meta, error) {
	existing, err := s.Get(ctx, pv.ID(), accountName)
	if err != nil {
		return store.Meta{}, err
	}
	meta, err := s.saveLockedSource(ctx, pv, accountName, existing, source)
	if err != nil {
		return store.Meta{}, err
	}
	if label != "" && label != meta.Label {
		return s.Store.PatchMetaContext(ctx, pv.ID(), meta.Name, store.MetaPatch{LabelSet: true, Label: label})
	}
	return meta, nil
}

// loginLiveSource verifies exactly the store selected by the login method.
// DetectLive is intentionally broad for status polling, but using it after a
// source-specific login could accept a stale Antigravity credential after a
// Gemini CLI flow (or the reverse).
func loginLiveSource(pv provider.Provider, source string) (provider.LiveAuthStatus, error) {
	if source == "" {
		return pv.DetectLive()
	}
	if scoped, ok := pv.(provider.SourceScopedProvider); ok {
		return scoped.DetectLiveSource(source)
	}
	return pv.DetectLive()
}

// errLoginCancelled reports PROVIDER_LOGIN_CANCELLED for post-launcher
// cancellation barriers.
func errLoginCancelled() error {
	return anyerr.Newf("Browser sign-in was cancelled.", "PROVIDER_LOGIN_CANCELLED")
}

// selectLoginMethod resolves the sign-in method: explicit ids resolve
// strictly; otherwise the single preferred official method wins and
// ambiguity is an interactive decision we never guess.
func selectLoginMethod(methods []provider.LoginMethod, requestedMethodID string) (provider.LoginMethod, error) {
	if requestedMethodID != "" {
		for _, m := range methods {
			if m.ID == requestedMethodID {
				return m, nil
			}
		}
		suggestion := ""
		if len(methods) > 0 {
			ids := make([]string, 0, len(methods))
			for _, m := range methods {
				ids = append(ids, m.ID)
			}
			suggestion = "Choose one of: " + strings.Join(ids, ", ") + "."
		}
		opt := []anyerr.Option{}
		if suggestion != "" {
			opt = append(opt, anyerr.WithSuggestions(suggestion))
		}
		return provider.LoginMethod{}, anyerr.Newf(
			"Unknown browser sign-in method \""+requestedMethodID+"\".",
			"PROVIDER_LOGIN_METHOD_UNKNOWN", opt...)
	}

	available := make([]provider.LoginMethod, 0, len(methods))
	for _, m := range methods {
		if m.Available {
			available = append(available, m)
		}
	}
	var official, preferredOfficial, preferred []provider.LoginMethod
	for _, m := range available {
		if m.Provenance == "official" {
			official = append(official, m)
			if m.Preferred {
				preferredOfficial = append(preferredOfficial, m)
			}
		}
	}
	if len(preferredOfficial) == 1 {
		return preferredOfficial[0], nil
	}
	if len(official) == 1 {
		return official[0], nil
	}
	if len(official) > 1 {
		ids := make([]string, 0, len(official))
		for _, m := range official {
			ids = append(ids, m.ID)
		}
		return provider.LoginMethod{}, anyerr.Newf(
			"Choose an official browser sign-in method.",
			"PROVIDER_LOGIN_METHOD_REQUIRED",
			anyerr.WithSuggestions("Choose one of: "+strings.Join(ids, ", ")+"."))
	}
	for _, m := range available {
		if m.Preferred {
			preferred = append(preferred, m)
		}
	}
	if len(preferred) == 1 {
		return preferred[0], nil
	}
	if len(available) == 1 {
		return available[0], nil
	}
	if len(available) == 0 {
		for _, m := range methods {
			if m.Preferred {
				return m, nil
			}
		}
		if len(methods) > 0 {
			return methods[0], nil
		}
		return provider.LoginMethod{}, anyerr.Newf(
			"No browser sign-in method is available.",
			"PROVIDER_LOGIN_UNAVAILABLE")
	}
	ids := make([]string, 0, len(available))
	for _, m := range available {
		ids = append(ids, m.ID)
	}
	return provider.LoginMethod{}, anyerr.Newf(
		"Choose a browser sign-in method.",
		"PROVIDER_LOGIN_METHOD_REQUIRED",
		anyerr.WithSuggestions("Choose one of: "+strings.Join(ids, ", ")+"."))
}
