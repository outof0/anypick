package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
)

func cmdPreset(ctx context.Context, a *appView, args []string) int {
	if len(args) == 0 {
		return usageError("usage: anypick preset <list|show|remove> …")
	}
	switch args[0] {
	case "list":
		saved, err := a.PresetSvc.ListContext(ctx)
		if err != nil {
			return reportErr(err)
		}
		if wantJSON(args) {
			jsonOut(saved)
			return int(anyerr.Success)
		}
		for _, p := range saved {
			cliPrintf("%s\t%s\n", p.Name, refs.DisplayRef(p.Spec.Source))
		}
		return int(anyerr.Success)
	case "show":
		return cmdPresetShow(ctx, a, args[1:])
	case "remove":
		return cmdPresetRemove(ctx, a, args[1:])
	default:
		return usageError("unknown preset subcommand %q", args[0])
	}
}

func cmdPresetShow(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick preset show <name>")
	}
	p, err := a.PresetSvc.GetByNameContext(ctx, fs.Arg(0))
	if err != nil || p == nil {
		return reportErr(anyerr.Newf("preset not found: "+fs.Arg(0), "PRESET_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound)))
	}
	out := struct {
		Name      string `json:"name"`
		Client    string `json:"client"`
		Model     string `json:"model,omitempty"`
		CreatedAt string `json:"createdAt"`
		LastUsed  string `json:"lastUsedAt,omitempty"`
		UseCount  int    `json:"useCount"`
	}{p.Name, p.Spec.Client, p.Spec.Model.ID, p.CreatedAt, p.LastUsedAt, p.UseCount}
	if wantJSON(args) {
		jsonOut(out)
	} else {
		cliPrintf("%s: %s × %s (used %d×)\n", p.Name, p.Spec.Client, refs.DisplayRef(p.Spec.Source), p.UseCount)
	}
	return int(anyerr.Success)
}

func cmdPresetRemove(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick preset remove <name>")
	}
	if globals.DryRun {
		printDryRunFields("preset.remove", "Would remove preset @"+fs.Arg(0),
			kv{Key: "name", Value: fs.Arg(0)})
		return int(anyerr.Success)
	}
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.PresetRef(fs.Arg(0))), func(c context.Context) error {
		return a.PresetSvc.DeleteByNameContext(c, fs.Arg(0))
	})
	if err != nil {
		return reportErr(err)
	}
	emitOK(fmt.Sprintf("removed %s", fs.Arg(0)),
		kv{Key: "ok", Value: true}, kv{Key: "name", Value: fs.Arg(0)})
	return int(anyerr.Success)
}

// `link` writes a PROJECT binding, `unlink` removes project binding(s),
// and `reset` clears the client's managed config AND its global binding.
// None of them touch global bindings implicitly.

func cmdLink(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	dir := fs.String("dir", "", "project directory (default: cwd)")
	model := fs.String("model", "", "explicit model for the binding")
	withFlag := fs.String("with", "", "source reference")
	// The same consent `use` takes: linking a project rewrites the same client
	// config, and failing closed with no way to confirm would strand a user who
	// pointed that client at their own login.
	allowForeign := fs.Bool("allow-foreign-config", false,
		"back up and replace client settings AnyPick does not own")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick link <client> --with <source> [--model id] [--allow-foreign-config]")
	}
	clientID := fs.Arg(0)
	root, rerr := projectRoot(*dir)
	if rerr != nil {
		return reportErr(rerr)
	}

	// Without --with: re-apply the ENTIRE global spec into this project —
	// model, client options (model roles) and provenance travel with it.
	// Planning a fresh source-only request would silently drop them.
	var planOpts activation.Options
	var catalogSource *refs.Ref
	if *withFlag == "" {
		global, gerr := a.BindingSvc.GetGlobalContext(ctx, clientID)
		if gerr != nil {
			return reportErr(gerr)
		}
		if global == nil {
			return reportErr(anyerr.Newf(
				fmt.Sprintf("no --with source and no global binding for %s", clientID),
				"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage)))
		}
		specCopy := global.Spec
		planOpts.ReapplySpec = &specCopy
		sourceCopy := specCopy.Source
		catalogSource = &sourceCopy
		// Snapshot provenance must survive link-without---with: record
		// globalBindingUpdatedAt from the source global binding.
		planOpts.ReapplyProv = &bindings.Provenance{
			Kind:                   "global_binding_snapshot",
			GlobalBindingUpdatedAt: global.UpdatedAt,
		}
	}
	var ref refs.Ref
	if *withFlag != "" {
		parsed, err := parseSourceRef(a, *withFlag)
		if err != nil {
			return reportErr(err)
		}
		ref = parsed
	}
	req := activation.Request{
		Mode:        activation.ModeProject,
		Client:      clientID,
		Model:       *model,
		ProjectRoot: root,
	}
	if *withFlag != "" {
		req.Source = &ref
		req.ModelCatalog, req.ModelCatalogErr = activationModelCatalog(ctx, a, ref)
	} else if catalogSource != nil {
		req.ModelCatalog, req.ModelCatalogErr = activationModelCatalog(ctx, a, *catalogSource)
	}
	plan, err := activation.PlanActivation(ctx, req, a.Deps, planOpts)
	if err != nil {
		return reportErr(err)
	}
	if globals.DryRun {
		// Planning is pure, so nothing was persisted and nothing will be
		// executed.
		if globals.JSON {
			display := ""
			if plan.ResolvedSource != nil {
				display = plan.ResolvedSource.Display
			}
			cliPrintln(orderedJSON([]kv{
				{Key: "client", Value: clientID},
				{Key: "source", Value: display},
				{Key: "dryRun", Value: true},
				{Key: "scope", Value: "project"},
			}))
		} else {
			cliPrintln("Dry run — project link plan:")
			for _, s := range plan.Steps {
				cliPrintf("  · %s\n", s.Kind)
			}
		}
		return int(anyerr.Success)
	}
	if _, err := activation.Execute(ctx, plan, a.Deps, activation.ExecuteOptions{
		AllowForeignConfig: *allowForeign,
	}); err != nil {
		return reportErr(err)
	}
	display := refs.DisplayRef(ref)
	if *withFlag == "" {
		display = refs.DisplayRef(plan.ResolvedSource.Ref)
	}
	emitOK(fmt.Sprintf("linked %s → %s (project)", clientID, display),
		kv{Key: "ok", Value: true},
		kv{Key: "client", Value: clientID},
		kv{Key: "source", Value: display})
	return int(anyerr.Success)
}

func cmdUnlink(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	dir := fs.String("dir", "", "project directory (default: cwd)")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() > 1 {
		return usageError("usage: anypick unlink [<client>]")
	}
	root, rerr := projectRoot(*dir)
	if rerr != nil {
		return reportErr(rerr)
	}
	clientID := fs.Arg(0)
	if globals.DryRun {
		// Read-only count for unlink: no lock, no mutation.
		var removed int64
		if clientID == "" {
			n, cerr := a.BindingSvc.CountProjectsContext(ctx, root)
			if cerr != nil {
				return reportErr(cerr)
			}
			removed = n
		} else {
			existing, gerr := a.BindingSvc.GetProjectContext(ctx, root, clientID)
			if gerr != nil {
				return reportErr(gerr)
			}
			if existing != nil {
				removed = 1
			}
		}
		printDryRunFields("binding.unlink",
			fmt.Sprintf("Would remove %d project binding(s)", removed),
			kv{Key: "client", Value: strOrJSONNull(clientID)}, kv{Key: "removed", Value: removed})
		return int(anyerr.Success)
	}
	var removed int64
	err := lock.WithMutationLock(ctx, a.Root, "project/"+root, func(c context.Context) error {
		if clientID == "" {
			n, derr := a.BindingSvc.DeleteAllProjectsContext(c, root)
			removed = n
			return derr
		}
		existed, gerr := a.BindingSvc.GetProjectContext(c, root, clientID)
		if gerr != nil {
			return gerr
		}
		if existed == nil {
			return nil
		}
		removed = 1
		return a.BindingSvc.DeleteProjectContext(c, root, clientID)
	})
	if err != nil {
		return reportErr(err)
	}
	human := "Nothing to unlink"
	if removed > 0 {
		human = fmt.Sprintf("Removed %d project binding(s)", removed)
	}
	emitOK(human, kv{Key: "ok", Value: true}, kv{Key: "removed", Value: removed})
	return int(anyerr.Success)
}

// cmdReset clears AnyPick-managed client configuration and the global
// binding under the client lock.
func cmdReset(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick reset <client> [--yes]")
	}
	clientID := fs.Arg(0)
	cad, gerr := a.Clients.Get(clientID)
	if gerr != nil {
		return reportErr(gerr)
	}
	if globals.DryRun {
		g, rerr := a.BindingSvc.GetGlobalContext(ctx, clientID)
		if rerr != nil {
			return reportErr(rerr)
		}
		emitResetDryRun(clientID, g != nil, false)
		return int(anyerr.Success)
	}
	// Reset rewrites the client's own login file, so refusing without --yes
	// on a headless stdin is the only safe default (invariant #7).
	switch err := confirmDelete("client "+clientID, globals.Yes); {
	case errors.Is(err, errDeclined):
		return int(anyerr.Success)
	case err != nil:
		return reportErr(err)
	}
	// `c`, not the outer ctx: re-entrancy is carried in the context (ADR 0009),
	// and the delete error must be returned — dropping it reported "reset" for
	// a binding that was still on disk.
	err := lock.WithMutationLock(ctx, a.Root, "client/"+cad.ID(), func(c context.Context) error {
		if err := cad.Reset(); err != nil {
			return err
		}
		return a.BindingSvc.DeleteGlobalContext(c, clientID)
	})
	if err != nil {
		return reportErr(err)
	}
	emitOK(fmt.Sprintf("reset %s", clientID),
		kv{Key: "ok", Value: true}, kv{Key: "client", Value: clientID})
	return int(anyerr.Success)
}

func cmdRun(ctx context.Context, a *appView, args []string) int {
	head, passThrough := splitRunArgs(args)
	fs := fsFor(head)
	with := fs.String("with", "", "source reference")
	profileName := fs.String("profile", "", "named Codex profile")
	model := fs.String("model", "", "explicit model id")
	transportPolicy := fs.String("transport", "auto", "transport policy")
	if err := fs.Parse(reorder(head)); err != nil || fs.NArg() < 1 ||
		(*with == "" && *profileName == "") || (*with != "" && *profileName != "") {
		return usageError("usage: anypick run <client> (--with <source>|--profile <name>) [--model id] [--transport p] -- <args…>")
	}
	clientID := fs.Arg(0)
	var ref refs.Ref
	var err error
	if *profileName != "" {
		ref, err = resolveCodexProfileRun(ctx, a, clientID, *profileName, model, transportPolicy)
		if err != nil {
			return reportErr(err)
		}
	} else {
		ref, err = parseSourceRef(a, *with)
		if err != nil {
			return reportErr(err)
		}
	}
	modelCatalog, modelCatalogErr := activationModelCatalog(ctx, a, ref)
	plan, err := activation.PlanActivation(ctx, activation.Request{
		Mode:            activation.ModeEphemeral,
		Client:          clientID,
		Source:          &ref,
		ProfileName:     *profileName,
		Model:           *model,
		ModelCatalog:    modelCatalog,
		ModelCatalogErr: modelCatalogErr,
		TransportPolicy: refToPolicy(*transportPolicy),
	}, a.Deps, activation.Options{})
	if err != nil {
		return reportErr(err)
	}
	result, err := activation.Execute(ctx, plan, a.Deps, activation.ExecuteOptions{})
	if err != nil {
		return reportErr(err)
	}
	return runEphemeralCommand(ctx, a, plan, result, passThrough)
}

func splitRunArgs(args []string) ([]string, []string) {
	for i, arg := range args {
		if arg == "--" {
			return args[:i], args[i+1:]
		}
	}
	return args, nil
}

func resolveCodexProfileRun(ctx context.Context, a *appView, clientID, name string, model, policy *string) (refs.Ref, error) {
	if clientID != "codex" {
		return refs.Ref{}, anyerr.Newf(
			"--profile is currently supported only with the codex client.",
			"UNSUPPORTED_PROFILE", anyerr.WithExitCode(anyerr.CapabilityConflict))
	}
	if err := client.ValidateCodexProfileName(name); err != nil {
		return refs.Ref{}, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if a.CodexProfileSvc == nil {
		return refs.Ref{}, anyerr.Newf("Codex profile service is unavailable.",
			"OPERATIONAL", anyerr.WithExitCode(anyerr.Operational))
	}
	profile, err := a.CodexProfileSvc.GetContext(ctx, clientID, name)
	if err != nil {
		return refs.Ref{}, err
	}
	if profile == nil {
		return refs.Ref{}, anyerr.Newf(
			"Codex profile "+name+" does not exist.",
			"CODEX_PROFILE_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound),
			anyerr.WithSuggestions(
				"anypick use codex --with <source> --profile "+name,
				"anypick codex profile list"))
	}
	if *model == "" && profile.Spec.Model.Mode == "explicit" {
		*model = profile.Spec.Model.ID
	}
	if *policy == "auto" && profile.Spec.TransportPolicy != "" {
		*policy = profile.Spec.TransportPolicy
	}
	return profile.Spec.Source, nil
}

func runEphemeralCommand(
	ctx context.Context,
	a *appView,
	plan *activation.Plan,
	result *activation.ExecuteResult,
	passThrough []string,
) int {
	cleanup := func(code int) int {
		if result.Cleanup != nil {
			if cleanupErr := result.Cleanup(ctx); cleanupErr != nil {
				cliFprintf(os.Stderr, "run cleanup: %v\n", cleanupErr)
				if code == int(anyerr.Success) {
					return int(anyerr.Operational)
				}
			}
		}
		return code
	}
	// `run` prints no activation summary, so plan warnings would otherwise be
	// dropped on the floor.
	for _, w := range result.Warnings {
		cliFprintf(os.Stderr, "warning: %s\n", w)
	}
	binary := plan.Client
	if cad, clientErr := a.Clients.Get(plan.Client); clientErr == nil {
		if launcher, ok := cad.(client.ExecutableAdapter); ok && launcher.Executable() != "" {
			binary = launcher.Executable()
		}
	}
	env := map[string]string(nil)
	if result.Isolated != nil {
		env = result.Isolated.Environment
	}
	if len(passThrough) == 0 && result.Isolated == nil {
		cliFprintln(os.Stderr, "run: nothing to launch (pass the command after --)")
		return cleanup(int(anyerr.InvalidUsage))
	}
	launchArgs := passThrough
	if plan.Client == "codex" && plan.ProfileName != "" {
		if hasCodexProfileFlag(passThrough) {
			cliFprintln(os.Stderr, "run: do not pass --profile after -- when using AnyPick --profile")
			return cleanup(int(anyerr.InvalidUsage))
		}
		launchArgs = append([]string{"--profile", plan.ProfileName}, passThrough...)
	}
	cmd := exec.Command(binary, launchArgs...)
	cmd.Env = mergedEnvironment(os.Environ(), env)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return cleanup(ee.ExitCode())
		}
		return cleanup(reportErr(err))
	}
	return cleanup(int(anyerr.Success))
}

func hasCodexProfileFlag(args []string) bool {
	for _, arg := range args {
		if arg == "--profile" || strings.HasPrefix(arg, "--profile=") {
			return true
		}
	}
	return false
}

// mergedEnvironment replaces inherited keys instead of appending duplicate
// entries. execve permits duplicates, but lookup order is platform/runtime
// dependent; an inherited CODEX_HOME could otherwise win over the isolated
// profile selected for this run.
func mergedEnvironment(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}
	remaining := make(map[string]string, len(overrides))
	for key, value := range overrides {
		remaining[key] = value
	}
	out := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			out = append(out, entry)
			continue
		}
		value, replace := remaining[key]
		if !replace {
			out = append(out, entry)
			continue
		}
		out = append(out, key+"="+value)
		delete(remaining, key)
	}
	for key, value := range remaining {
		out = append(out, key+"="+value)
	}
	return out
}

func projectRoot(dir string) (string, error) {
	if dir == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		return filepath.Clean(cwd), nil
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	info, statErr := os.Stat(abs)
	if statErr != nil || !info.IsDir() {
		return "", anyerr.Newf("not a directory: "+abs, "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return abs, nil
}

func parseSourceRef(a *appView, with string) (refs.Ref, error) {
	providerSet := map[string]bool{}
	for _, id := range a.Providers.IDs() {
		providerSet[id] = true
	}
	return refs.ParseRef(strings.TrimSpace(with), &refs.ParseContext{AccountProviders: providerSet})
}
