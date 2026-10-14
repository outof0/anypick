package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/agentbridge"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/buildinfo"
	"github.com/outof0/anypick/go/internal/cli"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/doctor"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/modelcache"
	"github.com/outof0/anypick/go/internal/ownership"
	"github.com/outof0/anypick/go/internal/proxy"
)

func cmdProviders(ctx context.Context, a *appView, args []string) int {
	if wantJSON(args) {
		type providerInfo struct {
			ID          string `json:"id"`
			Description string `json:"description"`
		}
		var out []providerInfo
		for _, id := range a.Providers.IDs() {
			pv, _ := a.Providers.Get(id)
			out = append(out, providerInfo{ID: id, Description: pv.Description()})
		}
		jsonOut(out)
		return int(anyerr.Success)
	}
	return cmdList(ctx, a, []string{"providers"})
}

func cmdClients(ctx context.Context, a *appView, args []string) int {
	type clientInfo struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Present bool   `json:"present"`
		Issues  string `json:"issues,omitempty"`
	}
	var out []clientInfo
	for _, id := range a.Clients.IDs() {
		cad, err := a.Clients.Get(id)
		if err != nil {
			continue
		}
		info := clientInfo{ID: cad.ID(), Name: cad.Name()}
		if insp, ierr := cad.Inspect(); ierr == nil {
			info.Present = insp.Present
			info.Issues = strings.Join(insp.Issues, "; ")
		}
		out = append(out, info)
	}
	if wantJSON(args) {
		jsonOut(out)
		return int(anyerr.Success)
	}
	for _, c := range out {
		state := "not installed"
		if c.Present {
			state = "present"
		}
		fmt.Printf("%s\t%s\t%s\n", c.ID, c.Name, state)
	}
	return int(anyerr.Success)
}

// doctorFlagValues holds the parsed `doctor` flags.
type doctorFlagValues struct {
	Fix    *bool
	DryRun *bool
	Yes    *bool
	ShortY *bool
}

// registerDoctorFlags registers the `doctor` command's flags on fs. It is a
// named function rather than inline registration so the parity gate can read
// the real registration instead of a hand-kept copy of it — a copy is what let
// the golden tree advertise `--fix` for a handler that parsed nothing.
func registerDoctorFlags(fs *flag.FlagSet) doctorFlagValues {
	return doctorFlagValues{
		Fix:    fs.Bool("fix", false, "apply the allowlisted repairs (prints a plan and asks first; use --dry-run to preview without asking)"),
		DryRun: fs.Bool("dry-run", false, "with --fix, print the plan and change nothing"),
		Yes:    fs.Bool("yes", false, "with --fix, skip the confirmation prompt"),
		// The docs show `doctor --fix -y`; `-y` is the short form of the global
		// --yes, but isGlobalFlag only knows the long name, so the handler has
		// to register the alias or the documented invocation fails to parse.
		ShortY: fs.Bool("y", false, "alias of --yes"),
	}
}

// cmdDoctor runs read-only health checks over the local installation, and —
// with --fix — applies the repairs allowlisted in internal/doctor.
//
// The flag set is real: the golden tree advertises --fix, and a substring scan
// for "--json" used to let every other flag through unparsed, so
// `doctor --definitely-not-a-flag` printed a report and exited 0.
func cmdDoctor(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	flags := registerDoctorFlags(fs)
	if err := fs.Parse(reorder(args)); err != nil {
		return usageError("usage: anypick doctor [target] [--fix [--dry-run] [-y]]")
	}
	// The Go diagnosis is installation-wide: no check narrows by client or
	// provider yet. Accepting an unknown target made a typo indistinguishable
	// from a valid one, and the troubleshooting page sent people here to
	// "narrow to one client" — a narrowing that never happened. A target that
	// names neither a registered client nor a provider is refused up front;
	// a valid one is accepted for compatibility and reported as unfiltered.
	if target := fs.Arg(0); target != "" {
		if _, cerr := a.Clients.Get(target); cerr != nil {
			return reportErr(anyerr.Newf(
				"unknown doctor target "+strconv.Quote(target)+
					": the Go diagnosis is installation-wide and does not narrow yet",
				"DOCTOR_TARGET_UNKNOWN", anyerr.WithExitCode(anyerr.InvalidUsage)))
		}
	}
	if fs.NArg() > 1 {
		return usageError("usage: anypick doctor [target] [--fix [--dry-run] [-y]]")
	}

	report := doctor.DiagnoseInstallation(ctx, doctor.InstallationDeps{
		Root: a.Root, Providers: a.Providers, Clients: a.Clients, Accounts: a.Accounts,
		Bindings: a.BindingSvc, Proxy: a.Proxy, Environment: currentDoctorEnvironment(),
		PluginDiagnostics: a.PluginDiagnostics,
		NamedProfiles:     namedProfileRefs(a),
	})

	if !*flags.Fix {
		renderDoctorReport(report)
		return int(anyerr.Success)
	}
	// --dry-run and --yes are also global flags, and normalizeGlobalFlags
	// strips them before dispatch; reading both keeps the handler correct
	// whichever layer consumed them.
	return runDoctorFix(ctx, a,
		*flags.DryRun || globals.DryRun,
		*flags.Yes || *flags.ShortY || globals.Yes)
}

// renderDoctorReport prints the read-only diagnosis. It renders whatever
// DiagnoseInstallation returned and adds nothing of its own, so --fix cannot
// change the report shape. The report did gain a "permissions" finding in the
// same change, because the docs promise `doctor` inspects file permissions and
// the repair needs that diagnosis to plan from; that finding is part of the
// diagnosis, not a side effect of --fix.
func renderDoctorReport(report doctor.InstallationReport) {
	if globals.JSON {
		jsonOut(report)
		return
	}
	fmt.Printf("anypick doctor — %s\n", report.Status)
	for _, f := range report.Findings {
		detail := ""
		if globals.Verbose {
			detail = f.Detail
		}
		fmt.Printf("  [%s] %s %s\n", f.Status, f.Check, detail)
	}
}

// runDoctorFix plans and (unless --dry-run) applies the allowlisted repairs.
// A dry run prints the plan and returns before any confirmation, because it
// mutates nothing and must work in CI. A real run goes through confirmDelete,
// which owns the no-TTY rule and the CONFIRMATION_REQUIRED/exit-2 contract
// (AGENTS.md invariant 7).
// printDoctorPlan renders the plan before the consent question: "Do you want
// to delete the allowlisted doctor repairs?" asked a yes/no about something
// the user had not been shown. Returns false when there is nothing to do.
func printDoctorPlan(plan doctor.FixPlan) bool {
	if len(plan.Actions) == 0 && len(plan.Manual) == 0 {
		fmt.Println("anypick doctor --fix: nothing to repair")
		return false
	}
	for _, action := range plan.Actions {
		fmt.Printf("  [plan] %s: %s\n", action.Kind, action.Description)
	}
	for _, manual := range plan.Manual {
		fmt.Printf("  [manual] %s: %s\n", manual.Check, manual.Detail)
	}
	return true
}

func runDoctorFix(ctx context.Context, a *appView, dryRun, yes bool) int {
	deps := doctorFixDeps(ctx, a)
	plan := doctor.PlanFixes(ctx, deps)

	if dryRun {
		// One JSON value on stdout (invariant 7), or one "[dry-run]" line per
		// planned action in human mode. Nothing is applied either way.
		if globals.JSON {
			jsonOut(struct {
				DryRun  bool                   `json:"dryRun"`
				Action  string                 `json:"action"`
				Planned []doctor.FixAction     `json:"planned"`
				Manual  []doctor.ManualFinding `json:"manual"`
			}{DryRun: true, Action: "doctor.fix", Planned: plan.Actions, Manual: plan.Manual})
			return int(anyerr.Success)
		}
		for _, action := range plan.Actions {
			fmt.Println("[dry-run] " + doctor.DryRunMessage(action))
		}
		for _, manual := range plan.Manual {
			fmt.Println("[dry-run] manual only: " + manual.Detail)
		}
		if len(plan.Actions) == 0 {
			fmt.Println("anypick doctor --fix: nothing to repair")
		}
		return int(anyerr.Success)
	}

	printDoctorPlan(plan)
	if len(plan.Actions) == 0 && len(plan.Manual) == 0 {
		return int(anyerr.Success)
	}

	if err := confirmDelete("the allowlisted doctor repairs listed above", yes); err != nil {
		if err == errDeclined {
			return int(anyerr.Success)
		}
		return reportErr(err)
	}

	result := doctor.ApplyFixes(ctx, plan, deps, false)
	failed := countFailedRepairs(result)

	if globals.JSON {
		jsonOut(struct {
			DryRun  bool                   `json:"dryRun"`
			Applied []doctor.FixOutcome    `json:"applied"`
			Manual  []doctor.ManualFinding `json:"manual"`
			Failed  int                    `json:"failed,omitempty"`
		}{DryRun: false, Applied: result.Applied, Manual: plan.Manual, Failed: failed})
		return fixExitCode(failed)
	}

	printRepairOutcomes(result)
	printManualFindings(plan.Manual)
	if len(result.Applied) == 0 {
		fmt.Println("anypick doctor --fix: nothing to repair")
	}
	// A repair that failed is not a success: a script running --fix in CI must
	// be able to tell "all green" from "one repair was refused".
	return fixExitCode(failed)
}

func countFailedRepairs(result doctor.FixResult) int {
	failed := 0
	for _, outcome := range result.Applied {
		if !outcome.OK {
			failed++
		}
	}
	return failed
}

func fixExitCode(failed int) int {
	if failed > 0 {
		return int(anyerr.HealthFailure)
	}
	return int(anyerr.Success)
}

func printRepairOutcomes(result doctor.FixResult) {
	for _, outcome := range result.Applied {
		prefix := "fixed"
		if !outcome.OK {
			prefix = "refused"
		}
		fmt.Printf("  [%s] %s\n", prefix, outcome.Message)
	}
	if failed := countFailedRepairs(result); failed > 0 {
		fmt.Printf("anypick doctor --fix: %d repair(s) failed\n", failed)
	}
}

func printManualFindings(manual []doctor.ManualFinding) {
	for _, finding := range manual {
		fmt.Printf("  [manual] %s: %s\n", finding.Check, finding.Detail)
		for _, suggestion := range finding.Suggestions {
			fmt.Printf("           %s\n", suggestion)
		}
	}
}

// doctorFixDeps assembles the mutation collaborators from the composed app. The
// recovery callback is activation.RecoverIncompleteOperations, which is the one
// implementation of exact journal rollback (invariant #3).
func doctorFixDeps(ctx context.Context, a *appView) doctor.FixDeps {
	deps := doctor.FixDeps{
		Root:          a.Root,
		Providers:     a.Providers.IDs(),
		Binding:       a.BindingSvc,
		Proxy:         a.Proxy,
		Journal:       a.Journal,
		NamedProfiles: namedProfileRefs(a),
		AccountExists: func(c context.Context, provider, name string) (bool, error) {
			acct, err := a.Accounts.CachedAccount(c, provider, name)
			if err != nil {
				return false, err
			}
			return acct != nil, nil
		},
		RemoveOrphanedProfile: func(c context.Context, client, name string) error {
			named, gerr := a.CodexProfileSvc.GetContext(c, client, name)
			if gerr != nil {
				return gerr
			}
			if named == nil || named.Client != client {
				return nil // already gone, or re-parented: nothing to remove
			}
			return activation.RemoveNamedProfiles(c,
				[]activation.ProfileRemoval{activation.ProfileRemovalFor(named, false)}, a.Deps, nil)
		},
		Recovery: func(c context.Context) (*activation.RecoveryResult, error) {
			return activation.RecoverIncompleteOperations(c, a.Deps)
		},
	}
	if a.DB != nil {
		deps.Store = &modelcache.Store{DB: a.DB}
	}
	if a.Proxy != nil {
		deps.Leases = a.Proxy.ListLeasesByAccountContext
	}
	return deps
}

// namedProfileRefs adapts the client profile store to the doctor's leaf
// package shape: internal/doctor must not import internal/client.
func namedProfileRefs(a *appView) func(context.Context) ([]doctor.NamedProfileRef, error) {
	if a == nil || a.CodexProfileSvc == nil {
		return nil
	}
	return func(ctx context.Context) ([]doctor.NamedProfileRef, error) {
		profiles, err := a.CodexProfileSvc.ListAllContext(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]doctor.NamedProfileRef, 0, len(profiles))
		for _, p := range profiles {
			out = append(out, doctor.NamedProfileRef{
				Client: p.Client, Name: p.Name,
				SourceKind: string(p.Spec.Source.Kind),
				Provider:   p.Spec.Source.Provider, AccountName: p.Spec.Source.Name,
			})
		}
		return out, nil
	}
}

func currentDoctorEnvironment() doctor.EnvironmentReport {
	report := agentbridge.InspectEnvironment(os.Environ())
	return doctor.EnvironmentReport{Proxy: doctor.ProxyEnvironment{
		Present: report.Proxy.Present, HTTPProxy: report.Proxy.HTTPProxy,
		HTTPSProxy: report.Proxy.HTTPSProxy, AllProxy: report.Proxy.AllProxy,
		NoProxySet: report.Proxy.NoProxySet, NoProxySize: report.Proxy.NoProxySize,
		Warnings: report.Proxy.Warnings,
	}}
}

// cmdUpdate checks GitHub Releases for a newer published version (advisory
// only). The canonical channels are the GitHub Release assets and a source
// checkout; the thin npm launcher is an optional channel when it is published,
// so the guidance names all three.
func cmdUpdate(ctx context.Context, a *appView, args []string) int {
	const releasesAPI = "https://api.github.com/repos/outof0/anypick/releases/latest"
	const releasesPage = "https://github.com/outof0/anypick/releases/latest"
	if len(args) > 0 && (args[0] == "check" || args[0] == "download") {
		return cmdUpdateCore(ctx, args[0], args[1:])
	}
	if cli.WantsHelp(args) {
		fmt.Print("usage: anypick update [--json]\n" +
			"       anypick update check [--json] [--current <version>]\n" +
			"       anypick update download [--json] [--current <version>]\n\n" +
			"Checks GitHub for a newer release and says how to upgrade. Never\n" +
			"downgrades: a published release older than this build is reported,\n" +
			"not advertised.\n\n" +
			"check/download print one JSON state per line with --json (the last\n" +
			"line is the final state); the macOS Settings > Updates pane reads it.\n" +
			"download only fetches and checks a direct-install asset into the\n" +
			"user cache; it never replaces the installed app.\n")
		return int(anyerr.Success)
	}
	current := packageVersion()
	req, err := http.NewRequest(http.MethodGet, releasesAPI, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "update check failed (current version %s)\n", current)
		return int(anyerr.HealthFailure)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "anypick/"+current)
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "update check failed (current version %s)\n", current)
		return int(anyerr.HealthFailure)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// No release has been published yet; the source workflow is the only
		// channel that exists today, so say that instead of failing.
		if wantJSON(args) {
			jsonOut(map[string]any{"current": current, "latest": nil, "detail": "no published release yet"})
			return int(anyerr.Success)
		}
		fmt.Printf("anypick %s: no published release yet\n", current)
		fmt.Println("update a source checkout with: git pull && make build")
		return int(anyerr.Success)
	}
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "update check failed (current version %s)\n", current)
		return int(anyerr.HealthFailure)
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil || body.TagName == "" {
		fmt.Fprintf(os.Stderr, "update check returned an unreadable response\n")
		return int(anyerr.HealthFailure)
	}
	latest := strings.TrimPrefix(body.TagName, "v")
	if wantJSON(args) {
		jsonOut(map[string]string{"current": current, "latest": latest})
		return int(anyerr.Success)
	}
	running := strings.TrimPrefix(current, "v")
	switch compareVersions(latest, running) {
	case -1:
		// The newest published release is OLDER than this build: a source
		// checkout ahead of the last tag, or a local build. Advertising an
		// upgrade to it would walk the user backwards, over a data directory
		// this newer build may have already migrated.
		fmt.Printf("anypick %s is newer than the latest published release (%s); nothing to update\n", current, latest)
		return int(anyerr.Success)
	case 0:
		fmt.Printf("anypick %s is up to date\n", current)
		return int(anyerr.Success)
	}
	if globals.DryRun {
		printDryRun("update", "Would upgrade anypick "+current+" → "+latest,
			map[string]any{"latest": latest})
		return int(anyerr.Success)
	}
	fmt.Printf("anypick %s → %s available\n", current, latest)
	fmt.Println("upgrade: npm install --global anypick (when published), download " + releasesPage +
		", or update a source checkout with: git pull && make build")
	return int(anyerr.Success)
}

// compareVersions orders dotted numeric versions: -1 when a < b, 0 when
// equal, 1 when a > b. String equality was not enough: with current 1.0.1 and
// latest 1.0.0 the old check offered an "upgrade" to the older release, and a
// user who obeyed downgraded the CLI below the schema that already migrated
// the data directory. Segments compare numerically. A non-numeric segment is
// a pre-release suffix ("1.1.0-beta"): a version WITH a suffix sorts before
// the same version without one, and two suffixed segments compare as strings.
// Both versions come from our own release tooling, so dotted numeric is the
// contract; anything else is a tag we do not publish.
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var as_, bs_ string
		if i < len(as) {
			as_ = as[i]
		}
		if i < len(bs) {
			bs_ = bs[i]
		}
		an, aok := atoi(as_)
		bn, bok := atoi(bs_)
		if aok && bok {
			switch {
			case an < bn:
				return -1
			case an > bn:
				return 1
			}
			continue
		}
		if !aok && bok {
			return -1 // "beta" vs missing segment: pre-release sorts first
		}
		if aok && !bok {
			return 1
		}
		if c := strings.Compare(as_, bs_); c != 0 {
			return c
		}
	}
	return 0
}

func atoi(s string) (int, bool) {
	n, err := strconv.Atoi(s)
	return n, err == nil
}

// packageVersion reports the linked release version; "(devel)" for source
// builds (internal/buildinfo — injected via -ldflags by the release pipeline).
func packageVersion() string { return buildinfo.Version }

func cmdCompletion(a *appView, args []string) int {
	if cli.WantsHelp(args) {
		fmt.Print("usage: anypick completion <bash|zsh|fish>\n\n" +
			"Prints the shell completion script for the given shell.\n")
		return int(anyerr.Success)
	}
	shell := ""
	if len(args) > 0 {
		shell = args[0]
	}
	// Static word lists reflect the dispatched tree minus hidden helpers;
	// positional depth resolves live ids through the hidden `__complete`
	// helper.
	const topLevel = "use run current list models add account gateway preset proxy plugin link unlink reset codex tui tray serve doctor update completion providers clients app start status stop stop-proxy"
	switch shell {
	case "bash":
		fmt.Printf(`# bash completion for anypick
_anypick_completions() {
  local cur cmd
  cur="${COMP_WORDS[COMP_CWORD]}"
  cmd="${COMP_WORDS[1]}"
  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W '%[1]s' -- "$cur") )
    return
  fi
  case "$cmd" in
	    use|run|link|unlink|reset)
	      [[ ${COMP_CWORD} -eq 2 ]] && COMPREPLY=( $(compgen -W "$(anypick __complete clients 2>/dev/null)" -- "$cur") )
	      ;;
	    codex)
	      if [[ ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W 'profile' -- "$cur") )
	      elif [[ ${COMP_CWORD} -eq 3 && ${COMP_WORDS[2]} == profile ]]; then COMPREPLY=( $(compgen -W 'login list show remove' -- "$cur") )
	      elif [[ ${COMP_CWORD} -eq 4 && ${COMP_WORDS[2]} == profile && ${COMP_WORDS[3]} != list ]]; then COMPREPLY=( $(compgen -W "$(anypick __complete codex-profiles 2>/dev/null)" -- "$cur") ); fi
	      ;;
    list)
      COMPREPLY=( $(compgen -W 'accounts gateways clients presets' -- "$cur") )
      ;;
    add)
      if [[ ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W 'account gateway' -- "$cur") )
      elif [[ ${COMP_CWORD} -eq 3 && ${COMP_WORDS[2]} == account ]]; then COMPREPLY=( $(compgen -W "$(anypick __complete providers 2>/dev/null)" -- "$cur") ); fi
      ;;
    account)
      if [[ ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W 'list remove refresh export import' -- "$cur") )
      elif [[ ${COMP_WORDS[2]} == import && ${COMP_CWORD} -ge 3 ]]; then COMPREPLY=( $(compgen -f -- "$cur" | grep -E '\.(json|anypick-backup)$') )
      elif [[ ${COMP_CWORD} -eq 3 ]]; then COMPREPLY=( $(compgen -W "$(anypick __complete providers 2>/dev/null)" -- "$cur") )
      elif [[ ${COMP_CWORD} -eq 4 ]]; then COMPREPLY=( $(compgen -W "$(anypick __complete accounts ${COMP_WORDS[3]} 2>/dev/null)" -- "$cur") ); fi
      ;;
    gateway)
      if [[ ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W 'add list show edit remove reset' -- "$cur") )
      else COMPREPLY=( $(compgen -W "$(anypick __complete gateways 2>/dev/null)" -- "$cur") ); fi
      ;;
    preset)
      [[ ${COMP_CWORD} -eq 2 ]] && COMPREPLY=( $(compgen -W 'list show remove' -- "$cur") )
      ;;
	plugin)
	  [[ ${COMP_CWORD} -eq 2 ]] && COMPREPLY=( $(compgen -W 'list add remove enable disable trust' -- "$cur") )
	  ;;
    proxy)
      if [[ ${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W 'status start stop enable disable config logs pool hub' -- "$cur") )
      elif [[ ${COMP_CWORD} -eq 3 && ${COMP_WORDS[2]} != pool && ${COMP_WORDS[2]} != hub ]]; then COMPREPLY=( $(compgen -W "$(anypick __complete providers 2>/dev/null)" -- "$cur") )
      elif [[ ${COMP_CWORD} -eq 4 && ${COMP_WORDS[2]} != pool && ${COMP_WORDS[2]} != hub ]]; then COMPREPLY=( $(compgen -W "$(anypick __complete accounts ${COMP_WORDS[2]} 2>/dev/null)" -- "$cur") ); fi
      ;;
  esac
}
complete -F _anypick_completions anypick
`, topLevel)
	case "zsh":
		fmt.Printf(`#compdef anypick
_anypick() {
  if (( CURRENT == 2 )); then
    _values 'command' %[1]s
    return
  fi
  case $words[2] in
	    (use|run|link|unlink|reset)
	      (( CURRENT == 3 )) && _values 'client' ${(f)"$(anypick __complete clients 2>/dev/null)"}
	      ;;
	    (codex)
	      if (( CURRENT == 3 )); then _values 'action' profile
	      elif (( CURRENT == 4 )) && [[ $words[3] == profile ]]; then _values 'action' login list show remove
	      elif (( CURRENT == 5 )) && [[ $words[3] == profile && $words[4] != list ]]; then _values 'profile' ${(f)"$(anypick __complete codex-profiles 2>/dev/null)"}; fi
	      ;;
    (list)
      _values 'kind' accounts gateways clients presets
      ;;
    (add)
      if (( CURRENT == 2 )); then _values 'kind' account gateway
      elif (( CURRENT == 3 )) && [[ $words[3] == account ]]; then _values 'provider' ${(f)"$(anypick __complete providers 2>/dev/null)"}; fi
      ;;
    (account)
      if (( CURRENT == 2 )); then _values 'action' list remove refresh export import
      elif (( CURRENT >= 3 )) && [[ $words[3] == import ]]; then _files -g '*.(json|anypick-backup)'
      elif (( CURRENT == 3 )); then _values 'provider' ${(f)"$(anypick __complete providers 2>/dev/null)"}
      elif (( CURRENT == 4 )); then _values 'account' ${(f)"$(anypick __complete accounts $words[3] 2>/dev/null)"}; fi
      ;;
    (gateway)
      if (( CURRENT == 2 )); then _values 'action' add list show edit remove reset
      else _values 'gateway' ${(f)"$(anypick __complete gateways 2>/dev/null)"}; fi
      ;;
    (preset)
      (( CURRENT == 2 )) && _values 'action' list show remove
      ;;
	(plugin)
	  (( CURRENT == 2 )) && _values 'action' list add remove enable disable trust
	  ;;
    (proxy)
      if (( CURRENT == 2 )); then _values 'action' status start stop enable disable config logs pool hub
      elif (( CURRENT == 3 )); then _values 'provider' ${(f)"$(anypick __complete providers 2>/dev/null)"}
      elif (( CURRENT == 4 )); then _values 'account' ${(f)"$(anypick __complete accounts $words[3] 2>/dev/null)"}; fi
      ;;
  esac
}
compdef _anypick anypick
`, topLevel)
	case "fish":
		fmt.Println("# fish completion for anypick")
		fmt.Println("complete -c anypick -f")
		fmt.Printf("complete -c anypick -n __fish_use_subcommand -a '%s'\n", topLevel)
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from use run link unlink reset' -a '(anypick __complete clients 2>/dev/null)'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from codex' -a 'profile'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from profile' -a 'login list show remove'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from show remove' -a '(anypick __complete codex-profiles 2>/dev/null)'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from list' -a 'accounts gateways clients presets'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from add' -a 'account gateway'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from plugin' -a 'list add remove enable disable trust'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from account' -a '(anypick __complete providers 2>/dev/null)'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from import' -a '(__fish_complete_path)' -F")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from gateway' -a '(anypick __complete gateways 2>/dev/null)'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from account; and test (count (commandline -opc)) -eq 3' -a '(anypick __complete accounts (commandline -opc)[3] 2>/dev/null)'")
		fmt.Println("complete -c anypick -n '__fish_seen_subcommand_from proxy; and test (count (commandline -opc)) -eq 4' -a '(anypick __complete accounts (commandline -opc)[3] 2>/dev/null)'")
	default:
		return usageError("usage: anypick completion <bash|zsh|fish>")
	}
	return int(anyerr.Success)
}

// cmdComplete backs shell completion: hidden `__complete <kind> [arg]` prints
// live ids one per line from the current data root. Never listed in help.
func cmdComplete(ctx context.Context, a *appView, args []string) int {
	if len(args) == 0 {
		return usageError("usage: anypick __complete <providers|clients|gateways|accounts|codex-profiles> [<provider>]")
	}
	arg := ""
	if len(args) > 1 {
		arg = args[1]
	}
	var out []string
	switch args[0] {
	case "providers":
		out = append(out, a.Providers.IDs()...)
	case "clients":
		out = append(out, a.Clients.IDs()...)
	case "gateways", "profiles":
		names, err := a.Runtime.ProfileSvc.ListContext(ctx)
		if err != nil {
			return reportErr(err)
		}
		out = append(out, names...)
	case "codex-profiles":
		if a.CodexProfileSvc == nil {
			return int(anyerr.Success)
		}
		profiles, err := a.CodexProfileSvc.ListContext(ctx, "codex")
		if err != nil {
			return reportErr(err)
		}
		for _, p := range profiles {
			out = append(out, p.Name)
		}
	case "accounts":
		providers := []string{arg}
		if arg == "" {
			providers = a.Providers.IDs()
		}
		for _, providerID := range providers {
			list, err := a.Accounts.List(ctx, providerID)
			if err != nil {
				continue
			}
			for _, acct := range list {
				out = append(out, acct.Meta.Name)
			}
		}
	default:
		return usageError("unknown completion kind %q", args[0])
	}
	for _, id := range out {
		fmt.Println(id)
	}
	return int(anyerr.Success)
}

// serveHubChild serves one hub until terminated (hidden `_serve-hub <name>`).
func serveHubChild(ctx context.Context, a *appView, args []string) int {
	if len(args) != 1 {
		return usageError("_serve-hub requires a hub name")
	}
	name := args[0]
	cfg, err := a.ProxyHub.GetConfig(ctx, name)
	if err != nil || cfg == nil || !cfg.Enabled {
		fmt.Fprintln(os.Stderr, "hub is not enabled:", name)
		return int(anyerr.Operational)
	}
	srv := &hub.Server{
		Config: *cfg,
		// Echo the parent-recorded instance so `proxy hub stop` can prove the
		// process it is about to signal is the one it spawned (ADR 0003 §3).
		Instance:  os.Getenv(ownership.EnvInstanceID),
		Store:     a.ProxyHub,
		Resolver:  hubUpstreamResolver{a},
		PoolRings: hubPoolRings{a},
		// Rotation spreads a model over every enabled account that can serve
		// it, so the hub needs to know which providers advertise which models.
		ModelsForProvider: hubProviderModels{a}.ModelsForProvider,
		// Hub-only quota guard: an account the vendor refused for quota reasons
		// cools down and the request moves to the next account that can serve
		// the model. Pool proxies keep their own guard.
		Quotas: hubQuotaGuard(a, name),
	}
	if err := srv.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "hub start failed:", err)
		return int(anyerr.Operational)
	}
	// The parent health-checks the stored port. A kernel-assigned listener
	// used to leave that port at 0, and freshness then skipped the child
	// (ADR-0030). The write does not bump revision: this process is already
	// serving the revision it loaded.
	if port := portFromEndpoint(srv.Endpoint()); port > 0 && a.ProxyHub != nil {
		if nerr := a.ProxyHub.NoteBoundPort(ctx, name, port); nerr != nil {
			fmt.Fprintf(os.Stderr, "warning: hub %s is listening but its port was not saved: %s\n", name, nerr)
		}
	}
	proxy.Logf("proxy-hub listening on %s", srv.Endpoint())
	awaitSignal(ctx)
	_ = srv.Stop()
	return int(anyerr.Success)
}

// servePoolChild keeps an enabled pool's proxies alive until terminated
// (hidden `_serve-pool <provider>`). All pool business logic — member ring,
// failover, quota guard, ownership echo — lives in the proxy service; this
// wrapper only dispatches, awaits a signal, and maps failures to exit codes.
func portFromEndpoint(endpoint string) int {
	i := strings.LastIndex(endpoint, ":")
	if i < 0 || i+1 >= len(endpoint) {
		return 0
	}
	n, err := strconv.Atoi(endpoint[i+1:])
	if err != nil {
		return 0
	}
	return n
}

func servePoolChild(ctx context.Context, a *appView, args []string) int {
	if len(args) != 1 {
		return usageError("_serve-pool requires a provider id")
	}
	if err := a.Proxy.ServePoolExisting(ctx, args[0]); err != nil {
		fmt.Fprintln(os.Stderr, "pool serve failed:", err)
		return int(anyerr.Operational)
	}
	return int(anyerr.Success)
}

func awaitSignal(ctx context.Context) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sigCh:
	case <-ctx.Done():
	}
}

// hubUpstreamResolver adapts the app's snapshot resolver for the hub server.
type hubUpstreamResolver struct{ a *appView }

func (h hubUpstreamResolver) ResolveUpstream(ctx context.Context, providerID, account string) (*proxy.Upstream, error) {
	resolver := h.a.Proxy.Resolver
	if resolver == nil {
		return nil, fmt.Errorf("no upstream resolver configured")
	}
	return resolver.ResolveUpstream(ctx, providerID, account)
}

// hubQuotaGuard builds the Proxy Hub's own quota guard from the validated global
// policy, persisting cooldowns beside the hub's runtime files. A policy with the
// guard disabled returns nil, which turns the guard off entirely.
func hubQuotaGuard(a *appView, hubName string) *hub.Quotas {
	if a == nil || a.Config == nil {
		return nil
	}
	cfg, err := a.Config.Read(context.Background())
	if err != nil {
		return nil
	}
	guardPolicy := config.QuotaGuardPolicyOf(cfg)
	if !guardPolicy.Enabled {
		return nil
	}
	hubDir := filepath.Join(a.Root, "runtime", "hub", hubName)
	return hub.NewQuotas(guardPolicy, filepath.Join(hubDir, "quota-guard.json"))
}

// hubProviderModels answers "can this provider serve this model" from the model
// cache the desktop writes. Advisory: a miss narrows rotation to the resolved
// source's provider instead of failing the request.
type hubProviderModels struct{ a *appView }

func (h hubProviderModels) ModelsForProvider(providerID string) []string {
	if h.a == nil || h.a.DB == nil {
		return nil
	}
	store := &modelcache.Store{DB: h.a.DB}
	models, err := store.ModelsForProvider(context.Background(), providerID)
	if err != nil {
		return nil
	}
	return models
}

// hubPoolRings adapts the proxy service's pool ring builder for hub sources
// whose account value references a multi-account pool.
type hubPoolRings struct{ a *appView }

func (h hubPoolRings) ResolvePoolRing(ctx context.Context, providerID string) (*proxy.PoolServer, error) {
	return h.a.Proxy.HubPoolRing(ctx, providerID)
}
