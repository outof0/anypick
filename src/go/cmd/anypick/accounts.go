package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mattn/go-isatty"
	accountsvc "github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
	"github.com/outof0/anypick/go/internal/store"
	"github.com/outof0/anypick/go/internal/transfer"
)

// jsonOut prints one machine-readable result on stdout (invariant #6).
func jsonOut(v interface{}) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return
	}
	cliPrintln(string(data))
}

func wantJSON(args []string) bool {
	if globalJSON {
		return true
	}
	for _, a := range args {
		if a == "--json" {
			return true
		}
	}
	return false
}

func usageError(format string, args ...interface{}) int {
	cliFprintf(os.Stderr, format+"\n", args...)
	return int(anyerr.InvalidUsage)
}

// appView aliases the composed application for command handlers.
type appView = app.App

func cmdAccount(ctx context.Context, a *appView, args []string) int {
	if len(args) == 0 {
		return usageError("usage: anypick account <list|remove|refresh|export|import> …")
	}
	switch args[0] {
	case "list":
		return cmdList(ctx, a, []string{"accounts"})
	case "remove":
		return cmdAccountRemove(ctx, a, args[1:])
	case "refresh":
		return cmdAccountRefresh(ctx, a, args[1:])
	case "export":
		return cmdAccountExport(ctx, a, args[1:])
	case "import":
		return cmdAccountImport(ctx, a, args[1:])
	default:
		return usageError("unknown account subcommand %q", args[0])
	}
}

func cmdAccountRemove(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 2 {
		return usageError("usage: anypick account remove <provider> <name> [--yes]")
	}
	providerID, name := fs.Arg(0), fs.Arg(1)
	if globals.DryRun {
		// Planner-purity analog (invariant #3): print and exit before any
		// service call or lock acquisition.
		printDryRunFields("account.remove", fmt.Sprintf("Would remove %s/%s", providerID, name),
			kv{Key: "provider", Value: providerID}, kv{Key: "name", Value: name})
		return int(anyerr.Success)
	}
	acct, err := a.Accounts.Get(ctx, providerID, name)
	if err != nil {
		return reportErr(err)
	}
	if acct == nil {
		return reportErr(anyerr.Newf("Account not found: "+providerID+"/"+name, "ACCOUNT_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound)))
	}
	// --yes short-circuits; non-TTY refuses with CONFIRMATION_REQUIRED and
	// exit 2 instead of consuming stdin (#6).
	switch err := confirmDelete(providerID+"/"+name, globals.Yes); {
	case errors.Is(err, errDeclined):
		return int(anyerr.Success)
	case err != nil:
		return reportErr(err)
	}
	deleted, err := a.Accounts.Delete(ctx, providerID, name)
	if err != nil {
		return reportErr(err)
	}
	// Hub sources and route pins name accounts by value; without a prune the
	// deleted row rots into ghosts that fail requests. Best-effort after a
	// successful delete: the account is gone either way.
	prunedMsg := ""
	if a.ProxyHub != nil {
		if pruned, perr := a.ProxyHub.PruneAccount(ctx, providerID, name); perr != nil {
			cliFprintf(os.Stderr, "warning: hub cleanup for %s/%s failed: %s\n", providerID, name, perr)
		} else if len(pruned) > 0 {
			prunedMsg = fmt.Sprintf(" Hub references dropped: %s.", strings.Join(pruned, ", "))
		}
		refreshUnsyncedHubs(ctx, a, providerID, name)
	}
	// Named profiles are removed with the account inside Delete, so the
	// cleanup is reported rather than left invisible: the user asked to
	// remove one account and lost a native Codex profile too.
	profileMsg := ""
	if len(deleted.Profiles) > 0 {
		profileMsg = fmt.Sprintf(" Removed named profile(s): %s.", strings.Join(deleted.Profiles, ", "))
	}
	emitOK(fmt.Sprintf("removed %s/%s%s%s", providerID, name, profileMsg, prunedMsg),
		kv{Key: "ok", Value: true},
		kv{Key: "provider", Value: providerID},
		kv{Key: "name", Value: name},
		kv{Key: "profiles", Value: deleted.Profiles})
	return int(anyerr.Success)
}

// isTTY reports whether f is a terminal that a human can answer on.
//
// It must NOT be `Mode()&os.ModeCharDevice != 0`: /dev/null is a character
// device too, so that check calls it a terminal. confirmDelete and
// confirmPluginTrust then print a prompt and read stdin under cron and CI
// instead of refusing outright, which breaks invariant #6 (never prompt
// without a TTY) and gives scripts the wrong exit code.
// refreshUnsyncedHubs restarts children that are still serving the deleted
// account. In-sync hubs and port-0 hubs are left alone: the former already
// match, and the latter cannot be echoed (ADR-0030).
func refreshUnsyncedHubs(ctx context.Context, a *appView, providerID, name string) {
	if a.ProxyHub == nil || a.Deps == nil || a.Deps.SpawnHubChild == nil {
		return
	}
	configs, err := a.ProxyHub.ListConfigsContext(ctx)
	if err != nil {
		cliFprintf(os.Stderr, "warning: hub refresh for %s/%s failed: %s\n", providerID, name, err)
		return
	}
	if err := hub.ReloadUnsynced(configs, a.Deps.SpawnHubChild); err != nil {
		cliFprintf(os.Stderr, "warning: hub refresh for %s/%s failed: %s\n", providerID, name, err)
	}
}

func isTTY(f *os.File) bool {
	if f == nil {
		return false
	}
	return isatty.IsTerminal(f.Fd())
}

// accountRefreshResult is one row of `account refresh` output.
type accountRefreshResult struct {
	Provider    string   `json:"provider"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	Suggestions []string `json:"suggestions,omitempty"`
}

// refreshProviderAccounts refreshes every saved account of one provider.
func refreshProviderAccounts(ctx context.Context, a *appView, providerID string,
	refreshOne func(provider, name string) accountRefreshResult) ([]accountRefreshResult, error) {
	list, lerr := a.Accounts.List(ctx, providerID)
	if lerr != nil {
		return nil, lerr
	}
	var out []accountRefreshResult
	for _, acct := range list {
		out = append(out, refreshOne(providerID, acct.Meta.Name))
	}
	return out, nil
}

func cmdAccountRefresh(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	// --all is the documented spelling of "refresh every saved account". That
	// is already what a provider with no account name does (and what no
	// arguments does across providers), so the flag only has to be accepted
	// and to refuse the contradictory `--all <provider> <name>` form.
	all := fs.Bool("all", false, "refresh every saved account of the named provider")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() > 2 {
		return usageError("usage: anypick account refresh [<provider> [<name>]] [--all]")
	}
	if *all && fs.NArg() == 2 {
		return usageError("usage: anypick account refresh [<provider>] --all (not both --all and an account name)")
	}
	var results []accountRefreshResult
	refreshOne := func(providerID, name string) accountRefreshResult {
		meta, err := a.Accounts.RefreshSnapshot(ctx, providerID, name)
		if err != nil {
			row := accountRefreshResult{Provider: providerID, Name: name, Status: "error: " + err.Error()}
			var ae *anyerr.Error
			if errors.As(err, &ae) {
				row.Suggestions = append([]string(nil), ae.Suggestions...)
			}
			return row
		}
		return accountRefreshResult{Provider: providerID, Name: meta.Name, Status: "refreshed"}
	}
	switch fs.NArg() {
	case 2:
		results = append(results, refreshOne(fs.Arg(0), fs.Arg(1)))
	case 1:
		// A provider alone filters: the documented usage says
		// `[<provider> [<name>]]`, and silently refreshing every provider when
		// one was named is the kind of surprise this CLI refuses elsewhere.
		providerID := fs.Arg(0)
		rows, lerr := refreshProviderAccounts(ctx, a, providerID, refreshOne)
		if lerr != nil {
			return reportErr(anyerr.Wrapf(lerr, "list "+providerID, "ACCOUNT_LIST_FAILED"))
		}
		results = rows
	default:
		for _, providerID := range a.Providers.IDs() {
			// A provider whose list fails is skipped, not fatal: a bulk
			// inventory should still refresh the ones it can read.
			rows, lerr := refreshProviderAccounts(ctx, a, providerID, refreshOne)
			if lerr == nil {
				results = append(results, rows...)
			}
		}
	}
	failed := 0
	if wantJSON(args) {
		jsonOut(results)
	} else {
		for _, r := range results {
			cliPrintf("%s/%s: %s\n", r.Provider, r.Name, r.Status)
			for _, suggestion := range r.Suggestions {
				cliPrintf("  %s\n", suggestion)
			}
		}
	}
	for _, r := range results {
		if strings.HasPrefix(r.Status, "error:") {
			failed++
		}
	}
	// A named account is a single contract: failure must be visible as the
	// process exit. Bulk refresh keeps per-row status and exits 0 so a
	// proxy-only account that cannot re-detect live auth does not fail the
	// whole inventory.
	if fs.NArg() == 2 && failed > 0 {
		return int(anyerr.Operational)
	}
	return int(anyerr.Success)
}

func cmdAccountExport(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	out := fs.String("out", "", "output file")
	// -o is the documented short form of --out; the stdlib parser has no alias
	// concept, so the same target is registered twice.
	outShort := fs.String("o", "", "alias of --out")
	all := fs.Bool("all", false, "export every saved account (or every account for one provider)")
	overwrite := fs.Bool("overwrite", false, "replace an existing multi-account backup file")
	if err := fs.Parse(reorder(args)); err != nil {
		return usageError("usage: anypick account export [<provider> <name>] [--out <file>] [--all]")
	}
	if *outShort != "" {
		if *out != "" && *out != *outShort {
			return usageError("pass one output path (--out or -o)")
		}
		*out = *outShort
	}
	if *all {
		if fs.NArg() > 1 {
			return usageError("usage: anypick account export [<provider>] --all [--out <file>]")
		}
		providerFilter := ""
		if fs.NArg() == 1 {
			providerFilter = fs.Arg(0)
		}
		return cmdAccountExportAll(ctx, a, args, providerFilter, *out, *overwrite)
	}
	if fs.NArg() != 2 {
		return usageError("usage: anypick account export <provider> <name> [--out <file>]")
	}
	providerID, name := fs.Arg(0), fs.Arg(1)
	outPath, pathErr := accountEnvelopeExportPath(a.Root, providerID, name, *out)
	if pathErr != nil {
		return usageError("invalid provider or account name: %v", pathErr)
	}
	if globals.DryRun {
		printDryRunFields("account.export",
			fmt.Sprintf("Would export %s/%s → %s", providerID, name, outPath),
			kv{Key: "provider", Value: providerID}, kv{Key: "name", Value: name},
			kv{Key: "out", Value: outPath})
		return int(anyerr.Success)
	}
	if err := a.Accounts.ExportEnvelope(ctx, providerID, name, outPath); err != nil {
		return reportErr(err)
	}
	if wantJSON(args) {
		jsonOut(map[string]string{"file": outPath})
		return int(anyerr.Success)
	}
	cliPrintf("exported %s/%s → %s\n", providerID, name, outPath)
	return int(anyerr.Success)
}

func cmdAccountExportAll(ctx context.Context, a *appView, args []string, providerFilter, requestedPath string, overwrite bool) int {
	providerIDs := append([]string(nil), a.Providers.IDs()...)
	if providerFilter != "" {
		providerIDs = []string{providerFilter}
	}
	sort.Strings(providerIDs)
	selection := make([]transfer.BackupEntry, 0)
	for _, providerID := range providerIDs {
		accounts, err := a.Accounts.List(ctx, providerID)
		if err != nil {
			return reportErr(err)
		}
		for _, account := range accounts {
			selection = append(selection, transfer.BackupEntry{Provider: providerID, Name: account.Meta.Name})
		}
	}
	outPath := accountBackupExportPath(a.Root, requestedPath)
	if globals.DryRun {
		printDryRunFields("account.export", fmt.Sprintf("Would export %d account(s) → %s", len(selection), outPath),
			kv{Key: "accounts", Value: selection}, kv{Key: "out", Value: outPath},
			kv{Key: "overwrite", Value: overwrite})
		return int(anyerr.Success)
	}
	count, err := a.Accounts.ExportSelectedBackup(ctx, selection, outPath, overwrite)
	if err != nil {
		return reportErr(err)
	}
	if wantJSON(args) {
		jsonOut(map[string]interface{}{"file": outPath, "accounts": count})
		return int(anyerr.Success)
	}
	cliPrintf("exported %d account(s) → %s\n", count, outPath)
	return int(anyerr.Success)
}

func cmdAccountImport(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	force := fs.Bool("force", false, "overwrite existing account / identity conflict")
	// The guides write `account import <provider> <name> -i ./work.json`; -i is
	// the documented short form of the input file, which the reference also
	// accepts positionally.
	input := fs.String("i", "", "input file (or pass it positionally)")
	inputLong := fs.String("input", "", "alias of --i")
	if err := fs.Parse(reorder(args)); err != nil {
		return reportErr(accountImportUsageError(a.Root, "usage: anypick account import <provider> <name> <file.json> [--force]"))
	}
	positionals := append([]string(nil), fs.Args()...)
	positionalCount := len(positionals)
	if *input != "" && *inputLong != "" && *input != *inputLong {
		return reportErr(accountImportUsageError(a.Root, "pass one input path (--i or --input)"))
	}
	if *input == "" {
		*input = *inputLong
	}

	// The explicit provider/name form remains available for one envelope. With
	// no provider/name, every positional JSON path is imported as a batch; this
	// also makes shell-expanded `*.json` imports work without a wrapper script.
	// Keep the legacy provider/name/file spelling, but let three or more
	// path-like arguments stay a batch. Without this check exactly three
	// `*.json` files would be mistaken for provider, account, and file.
	if positionalCount == 3 && *input == "" && !looksLikeImportFile(positionals[0]) {
		return importOneAccount(ctx, a, positionals[0], positionals[1], positionals[2], *force, args)
	}
	if positionalCount == 2 && *input != "" {
		return importOneAccount(ctx, a, positionals[0], positionals[1], *input, *force, args)
	}
	if positionalCount == 0 && *input != "" {
		if globals.DryRun {
			printDryRunFields("account.import", fmt.Sprintf("Would import %s", *input),
				kv{Key: "input", Value: *input}, kv{Key: "force", Value: *force})
			return int(anyerr.Success)
		}
		return runAccountImport(ctx, a, accountsvc.ImportRequest{Paths: []string{*input}, Force: *force}, args)
	}
	if *input != "" {
		return reportErr(accountImportUsageError(a.Root, "usage: anypick account import <provider> <name> <file.json> [--force]"))
	}
	if len(positionals) == 0 {
		return reportErr(accountImportUsageError(a.Root, "usage: anypick account import <file.json> [<file2.json> …] [--force]"))
	}
	if globals.DryRun {
		printDryRunFields("account.import", fmt.Sprintf("Would import %d JSON file(s)", len(positionals)),
			kv{Key: "files", Value: positionals}, kv{Key: "force", Value: *force})
		return int(anyerr.Success)
	}
	return runAccountImport(ctx, a, accountsvc.ImportRequest{Paths: positionals, Force: *force}, args)
}

func importOneAccount(ctx context.Context, a *appView, providerID, name, file string, force bool, args []string) int {
	if globals.DryRun {
		printDryRunFields("account.import",
			fmt.Sprintf("Would import %s/%s from %s", providerID, name, file),
			kv{Key: "provider", Value: providerID}, kv{Key: "name", Value: name},
			kv{Key: "input", Value: file}, kv{Key: "force", Value: force})
		return int(anyerr.Success)
	}
	return runAccountImport(ctx, a, accountsvc.ImportRequest{
		Paths: []string{file}, ProviderID: providerID, Name: name, Force: force,
	}, args)
}

func runAccountImport(ctx context.Context, a *appView, request accountsvc.ImportRequest, args []string) int {
	metas, err := a.Accounts.Import(ctx, request)
	if err != nil {
		return reportErr(withImportFileSuggestions(err, a.Root))
	}
	if wantJSON(args) {
		if request.Name != "" && len(metas) == 1 {
			jsonOut(metas[0])
		} else {
			jsonOut(metas)
		}
		return int(anyerr.Success)
	}
	return reportImportedAccounts(metas, false)
}

func reportImportedAccounts(metas []store.Meta, jsonMode bool) int {
	if jsonMode {
		jsonOut(metas)
		return int(anyerr.Success)
	}
	for _, meta := range metas {
		cliPrintf("imported %s/%s\n", meta.Provider, meta.Name)
	}
	return int(anyerr.Success)
}

func accountEnvelopeExportPath(root, providerID, name, requested string) (string, error) {
	if requested == "" {
		providerSlug, err := slug.Normalize(providerID, "Provider")
		if err != nil {
			return "", err
		}
		accountSlug, err := slug.AccountName(name)
		if err != nil {
			return "", err
		}
		return filepath.Join(paths.Root(root), "exports", fmt.Sprintf("anypick-%s-%s.json", providerSlug, accountSlug)), nil
	}
	return ensureJSONPath(requested), nil
}

func accountBackupExportPath(root, requested string) string {
	if requested == "" {
		return filepath.Join(paths.Root(root), "exports", "anypick-backup.json")
	}
	return ensureJSONPath(requested)
}

func ensureJSONPath(path string) string {
	if strings.EqualFold(filepath.Ext(path), ".json") {
		return path
	}
	return path + ".json"
}

func looksLikeImportFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".json" || ext == ".anypick-backup" {
		return true
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func accountImportUsageError(root, message string) error {
	suggestions := []string{"Choose a JSON envelope or backup file, for example: anypick account import ./account.json"}
	suggestions = append(suggestions, importJSONFileSuggestions(root)...)
	return anyerr.Newf(message, "INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage),
		anyerr.WithSuggestions(suggestions...))
}

func withImportFileSuggestions(err error, root string) error {
	if err == nil {
		return nil
	}
	var ae *anyerr.Error
	if errors.As(err, &ae) {
		ae.Suggestions = appendUniqueSuggestions(ae.Suggestions, importJSONFileSuggestions(root)...)
	}
	return err
}

func appendUniqueSuggestions(existing []string, additions ...string) []string {
	seen := make(map[string]bool, len(existing)+len(additions))
	for _, value := range existing {
		seen[value] = true
	}
	for _, value := range additions {
		if value != "" && !seen[value] {
			existing = append(existing, value)
			seen[value] = true
		}
	}
	return existing
}

func importJSONFileSuggestions(root string) []string {
	dirs := []string{}
	if cwd, err := os.Getwd(); err == nil {
		dirs = append(dirs, cwd)
	}
	dirs = append(dirs, filepath.Join(paths.Root(root), "exports"))
	seen := map[string]bool{}
	var out []string
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if entry.IsDir() || (ext != ".json" && ext != ".anypick-backup") {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			if seen[path] {
				continue
			}
			seen[path] = true
			out = append(out, "JSON file: "+path)
		}
	}
	sort.Strings(out)
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

func cmdGatewayShow(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick gateway show <name>")
	}
	pr, err := a.Runtime.ProfileSvc.GetContext(ctx, fs.Arg(0))
	if err != nil {
		return reportErr(err)
	}
	if pr == nil {
		return reportErr(anyerr.Newf("gateway not found", "GATEWAY_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound)))
	}
	// Secrets are masked unless --reveal.
	shown := pr.Secrets.APIKey
	if !globals.Reveal && shown != "" {
		shown = maskSecret(shown)
	}
	if wantJSON(args) {
		jsonOut(struct {
			Meta    map[string]string `json:"meta"`
			Secrets map[string]string `json:"secrets"`
		}{
			Meta: map[string]string{
				"name":         pr.Meta.Name,
				"provider":     pr.Meta.Provider,
				"endpoint":     pr.Meta.Endpoint,
				"defaultModel": pr.Meta.DefaultModel,
			},
			Secrets: map[string]string{"apiKey": shown},
		})
		return int(anyerr.Success)
	}
	cliPrintlnRaw(pr.Meta.Name)
	cliPrintf("  provider  %s\n", pr.Meta.Provider)
	cliPrintf("  endpoint  %s\n", pr.Meta.Endpoint)
	cliPrintf("  apiKey    %s\n", shown)
	cliPrintf("  model     %s\n", pr.Meta.DefaultModel)
	return int(anyerr.Success)
}

func maskSecret(value string) string {
	if len(value) == 0 {
		return "(empty)"
	}
	if len(value) <= 8 {
		return "••••••••"
	}
	return value[:4] + "…" + value[len(value)-4:]
}

func cmdGatewayEdit(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	endpoint := fs.String("endpoint", "", "new base URL")
	model := fs.String("model", "", "default model")
	// The docs write `gateway edit <name> -m <id>`; -m is the short form of
	// --model. Registered as a separate variable rather than an alias so the
	// stdlib parser (which has no alias concept) accepts either spelling.
	modelShort := fs.String("m", "", "alias of --model")
	// Editing the stored key is what the docs promise, and the desktop
	// mutateGatewayEdit already writes Meta/Secrets this way; only the CLI
	// lacked the flag. Bare `--api-key` means "prompt on the TTY", like
	// `add gateway`.
	args, _, promptAPIKey := splitBareSecretFlags(args)
	apiKey := fs.String("api-key", "", "new API key value; bare flag prompts on the TTY")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick gateway edit <name> [--endpoint url] [--model id] [--api-key key]")
	}
	name := fs.Arg(0)
	if *modelShort != "" {
		if *model != "" && *model != *modelShort {
			return usageError("pass one model id (--model or -m)")
		}
		*model = *modelShort
	}
	if *apiKey == "" && promptAPIKey {
		var perr error
		*apiKey, perr = promptSecret("API key")
		if perr != nil {
			return reportErr(perr)
		}
	}
	if globals.DryRun {
		printDryRunFields("gateway.edit", "Would update gateway "+name,
			kv{Key: "name", Value: name},
			kv{Key: "endpoint", Value: strOrNil(*endpoint)},
			kv{Key: "model", Value: strOrNil(*model)},
			kv{Key: "models", Value: nil}, // Go edit has no --models flag yet
			kv{Key: "hasApiKey", Value: *apiKey != ""})
		return int(anyerr.Success)
	}
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.GatewayRef(name)), func(c context.Context) error {
		existing, gerr := a.Runtime.ProfileSvc.GetContext(c, name)
		if gerr != nil {
			return gerr
		}
		if existing == nil {
			return anyerr.Newf("gateway not found", "GATEWAY_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound))
		}
		if *endpoint != "" {
			existing.Meta.Endpoint = *endpoint
		}
		if *model != "" {
			existing.Meta.DefaultModel = *model
		}
		if *apiKey != "" {
			existing.Secrets.APIKey = *apiKey
		}
		_, uerr := a.Runtime.ProfileSvc.UpsertContext(c, *existing)
		return uerr
	})
	if err != nil {
		return reportErr(err)
	}
	emitOK(fmt.Sprintf("updated %s", name),
		kv{Key: "ok", Value: true},
		kv{Key: "name", Value: name})
	return int(anyerr.Success)
}

func cmdGatewayRemove(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick gateway remove <name>")
	}
	name := fs.Arg(0)
	if globals.DryRun {
		printDryRunFields("gateway.remove", "Would remove gateway "+name,
			kv{Key: "name", Value: name})
		return int(anyerr.Success)
	}
	switch err := confirmDelete("gateway "+name, globals.Yes); {
	case errors.Is(err, errDeclined):
		return int(anyerr.Success)
	case err != nil:
		return reportErr(err)
	}
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.GatewayRef(name)), func(c context.Context) error {
		return a.Runtime.ProfileSvc.DeleteContext(c, name)
	})
	if err != nil {
		return reportErr(err)
	}
	emitOK(fmt.Sprintf("removed %s", name),
		kv{Key: "ok", Value: true}, kv{Key: "name", Value: name})
	return int(anyerr.Success)
}

func cmdGatewayReset(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	clientID := fs.String("client", "", "client to reset from the gateway profile")
	// -c is the short form the golden tree advertises; the stdlib parser has no
	// alias concept, so the same target is registered twice.
	clientShort := fs.String("c", "", "alias of --client")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick gateway reset <gateway> --client <clientId> [--yes]")
	}
	if *clientShort != "" {
		if *clientID != "" && *clientID != *clientShort {
			return usageError("pass one client (--client or -c)")
		}
		*clientID = *clientShort
	}
	if *clientID == "" {
		return usageError("usage: anypick gateway reset <gateway> --client <clientId> [--yes]")
	}
	gateway := fs.Arg(0)
	if _, err := a.Clients.Get(*clientID); err != nil {
		return reportErr(err)
	}
	if globals.DryRun {
		g, gerr := a.BindingSvc.GetGlobalContext(ctx, *clientID)
		if gerr != nil {
			return reportErr(gerr)
		}
		emitResetDryRun(*clientID, g != nil, true)
		return int(anyerr.Success)
	}
	// Same gate as reset: the mutation below rewrites the client's own login
	// file, and a headless stdin gets no prompt (invariant #7).
	switch err := confirmDelete("client "+*clientID+" of gateway "+gateway, globals.Yes); {
	case errors.Is(err, errDeclined):
		return int(anyerr.Success)
	case err != nil:
		return reportErr(err)
	}
	err := lock.WithMutationLock(ctx, a.Root, "client/"+*clientID, func(context.Context) error {
		cad, gerr := a.Clients.Get(*clientID)
		if gerr != nil {
			return gerr
		}
		return cad.Reset()
	})
	if err != nil {
		return reportErr(err)
	}
	emitOK(fmt.Sprintf("reset %s", *clientID),
		kv{Key: "ok", Value: true}, kv{Key: "client", Value: *clientID})
	return int(anyerr.Success)
}

var _ = profile.Runtime{}
var _ = store.Meta{}
var _ = filepath.Join
var _ = strings.TrimSpace
