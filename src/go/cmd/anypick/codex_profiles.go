package main

import (
	"context"
	"os"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/transport"
)

// cmdCodex owns the small management surface for named Codex routes. The
// actual activation still goes through `use --profile`, so profile creation,
// proxy startup, config writes, and the durable mapping share one journalled
// transaction.
func cmdCodex(ctx context.Context, a *appView, args []string) int {
	if len(args) == 0 {
		return usageError("usage: anypick codex profile <login|list|show|remove> …")
	}
	if args[0] != "profile" {
		return usageError("unknown codex subcommand %q", args[0])
	}
	if len(args) == 1 {
		return usageError("usage: anypick codex profile <login|list|show|remove> …")
	}
	switch args[1] {
	case "login":
		return cmdCodexProfileLogin(ctx, a, args[2:])
	case "list":
		return cmdCodexProfileList(ctx, a, args[2:])
	case "show":
		return cmdCodexProfileShow(ctx, a, args[2:])
	case "remove":
		return cmdCodexProfileRemove(ctx, a, args[2:])
	default:
		return usageError("unknown codex profile subcommand %q", args[1])
	}
}

// cmdCodexProfileLogin signs in with CODEX_HOME pointed at the profile's
// private home. The official CLI therefore writes B's auth.json beside B's
// config, while the desktop account and its live auth.json remain untouched.
func cmdCodexProfileLogin(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	authMethod := fs.String("auth-method", "", "browser sign-in method id")
	source := fs.String("source", "", "sign-in source")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick codex profile login <name> [--auth-method <id>] [--source <id>]")
	}
	name := fs.Arg(0)
	if err := client.ValidateCodexProfileName(name); err != nil {
		return reportErr(anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	if globals.DryRun {
		printDryRunFields("codex.profile.login", "Would sign in to Codex profile "+name,
			kv{Key: "profile", Value: name},
			kv{Key: "codexHome", Value: client.CodexProfileHomePath(a.Root, name)})
		return int(anyerr.Success)
	}

	var loginResult accounts.LoginResult
	err := lock.WithMutationLocks(ctx, a.Root,
		[]string{refs.ProviderScope("codex"), "client-profile/codex/" + name},
		func(c context.Context) error {
			previousActive, err := a.Accounts.Active(c, "codex")
			if err != nil {
				return err
			}
			existing, err := a.Accounts.Get(c, "codex", name)
			if err != nil {
				return err
			}
			ownsAccount := false
			if existing != nil {
				if a.CodexProfileSvc == nil {
					return anyerr.Newf("Codex profiles are not available.", "STATE_CONFLICT")
				}
				profile, perr := a.CodexProfileSvc.GetContext(c, "codex", name)
				if perr != nil {
					return perr
				}
				ownsAccount = profileOwnsCodexAccount(profile, name)
				if !ownsAccount {
					return anyerr.Newf(
						"Codex account \""+name+"\" already exists and is not this profile.",
						"ACCOUNT_NAME_TAKEN",
						anyerr.WithSuggestions(
							"Choose a profile name that is not an existing Codex account.",
							"Or remove that saved account first if this profile should take it over."))
				}
			}
			restoreEnv := useCodexProfileHome(client.CodexProfileHomePath(a.Root, name))
			defer restoreEnv()
			loginResult, err = a.Accounts.Login(c, "codex", accounts.LoginOptions{
				Name: name, MethodID: *authMethod, Source: *source,
				// A profile that does not already own `name` must not replace
				// some other saved login that the new identity does not match.
				// The pre-check above covers the name collision; this covers
				// a login that resolves onto that name by identity.
				RefuseDistinctOverwrite: !ownsAccount,
			})
			if err != nil {
				return err
			}
			// Login normally publishes the account as the provider's active
			// pointer. That pointer belongs to the desktop/live CODEX_HOME, so
			// put it back before publishing the independent profile route.
			if err := a.Accounts.SetActive(c, "codex", previousActive); err != nil {
				return err
			}
			// Plan the account login actually saved. The requested profile
			// name is a route label; an identity match may have refreshed a
			// different saved account and never created `name`.
			ref := refs.AccountRef("codex", loginResult.Account.Name)
			plan, err := activation.PlanActivation(c, activation.Request{
				Mode: activation.ModeProfile, Client: "codex", Source: &ref, ProfileName: name,
			}, a.Deps, activation.Options{})
			if err != nil {
				return err
			}
			_, err = activation.Execute(c, plan, a.Deps, activation.ExecuteOptions{})
			return err
		}, 0)
	if err != nil {
		return reportErr(err)
	}

	human := "signed in Codex profile " + name
	if loginResult.Account.Identity != "" {
		human += " (" + loginResult.Account.Identity + ")"
	}
	emitOK(human,
		kv{Key: "ok", Value: true},
		kv{Key: "profile", Value: name},
		kv{Key: "account", Value: "codex/" + loginResult.Account.Name},
		kv{Key: "codexHome", Value: client.CodexProfileHomePath(a.Root, name)},
		kv{Key: "auth", Value: client.CodexProfileAuthPath(a.Root, name)},
		kv{Key: "launch", Value: client.CodexProfileLaunchCommand(a.Root, name, false)})
	return int(anyerr.Success)
}

func useCodexProfileHome(home string) func() {
	oldHome, hadHome := os.LookupEnv("CODEX_HOME")
	oldAuth, hadAuth := os.LookupEnv("CODEX_AUTH_PATH")
	_ = os.Setenv("CODEX_HOME", home)
	_ = os.Unsetenv("CODEX_AUTH_PATH")
	return func() {
		if hadHome {
			_ = os.Setenv("CODEX_HOME", oldHome)
		} else {
			_ = os.Unsetenv("CODEX_HOME")
		}
		if hadAuth {
			_ = os.Setenv("CODEX_AUTH_PATH", oldAuth)
		} else {
			_ = os.Unsetenv("CODEX_AUTH_PATH")
		}
	}
}

func cmdCodexProfileList(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 0 {
		return usageError("usage: anypick codex profile list")
	}
	if a.CodexProfileSvc == nil {
		return reportErr(anyerr.Newf("Codex profile service is unavailable.",
			"OPERATIONAL", anyerr.WithExitCode(anyerr.Operational)))
	}
	profiles, err := a.CodexProfileSvc.ListContext(ctx, "codex")
	if err != nil {
		return reportErr(err)
	}
	if globals.JSON {
		type profileInfo struct {
			Name      string `json:"name"`
			Source    string `json:"source"`
			Model     string `json:"model,omitempty"`
			Transport string `json:"transport"`
		}
		out := make([]profileInfo, 0, len(profiles))
		for _, p := range profiles {
			out = append(out, profileInfo{
				Name: p.Name, Source: refs.DisplayRef(p.Spec.Source),
				Model: p.Spec.Model.ID, Transport: p.Spec.TransportPolicy,
			})
		}
		jsonOut(out)
		return int(anyerr.Success)
	}
	if len(profiles) == 0 {
		cliPrintln("No Codex profiles.")
		return int(anyerr.Success)
	}
	for _, p := range profiles {
		model := p.Spec.Model.ID
		if model == "" {
			model = "(native default)"
		}
		transportPolicy := p.Spec.TransportPolicy
		if transportPolicy == "" {
			transportPolicy = "auto"
		}
		cliPrintf("%s\t%s\t%s\t%s\n", p.Name, refs.DisplayRef(p.Spec.Source), model, transportPolicy)
	}
	return int(anyerr.Success)
}

func cmdCodexProfileShow(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick codex profile show <name>")
	}
	name := fs.Arg(0)
	if err := client.ValidateCodexProfileName(name); err != nil {
		return reportErr(anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	if a.CodexProfileSvc == nil {
		return reportErr(anyerr.Newf("Codex profile service is unavailable.",
			"OPERATIONAL", anyerr.WithExitCode(anyerr.Operational)))
	}
	p, err := a.CodexProfileSvc.GetContext(ctx, "codex", name)
	if err != nil {
		return reportErr(err)
	}
	if p == nil {
		return reportErr(codexProfileNotFound(name))
	}
	model := p.Spec.Model.ID
	transportPolicy := p.Spec.TransportPolicy
	if transportPolicy == "" {
		transportPolicy = "auto"
	}
	profileHome := client.CodexProfileHomePath(a.Root, name)
	authPath := client.CodexProfileAuthPath(a.Root, name)
	configPath := client.CodexProfileConfigPathForRoot(a.Root, name)
	envPath := client.CodexProfileEnvPath(a.Root, name)
	// Native account profiles use their copied auth.json directly. Gateway and
	// proxy profiles also need the generated per-profile env file.
	sourceEnv := codexProfileNeedsEnv(ctx, a, p)
	fields := []kv{
		{Key: "name", Value: p.Name},
		{Key: "source", Value: refs.DisplayRef(p.Spec.Source)},
		{Key: "model", Value: strOrNil(model)},
		{Key: "transport", Value: transportPolicy},
		{Key: "codexHome", Value: profileHome},
		{Key: "auth", Value: authPath},
		{Key: "config", Value: configPath},
		{Key: "launch", Value: client.CodexProfileLaunchCommand(a.Root, name, sourceEnv)},
	}
	if sourceEnv {
		fields = append(fields, kv{Key: "envFile", Value: envPath})
	}
	if globals.JSON {
		emitOK("", fields...)
		return int(anyerr.Success)
	}
	cliPrintf("Codex profile %s\n", p.Name)
	cliPrintf("  source: %s\n  model: %s\n  transport: %s\n", refs.DisplayRef(p.Spec.Source),
		orDefaultStr(model, "(native default)"), transportPolicy)
	cliPrintf("  CODEX_HOME: %s\n  auth: %s\n  config: %s\n  launch: %s\n",
		profileHome, authPath, configPath,
		client.CodexProfileLaunchCommand(a.Root, name, sourceEnv))
	return int(anyerr.Success)
}

func cmdCodexProfileRemove(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick codex profile remove <name> [--yes]")
	}
	name := fs.Arg(0)
	if err := client.ValidateCodexProfileName(name); err != nil {
		return reportErr(anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	if a.CodexProfileSvc == nil {
		return reportErr(anyerr.Newf("Codex profile service is unavailable.",
			"OPERATIONAL", anyerr.WithExitCode(anyerr.Operational)))
	}
	p, removal, err := activation.PlanNamedProfileRemoval(ctx, "codex", name, a.Deps)
	if err != nil {
		return reportErr(err)
	}
	if globals.DryRun {
		printDryRunFields("codex.profile.remove", "Would remove Codex profile "+name,
			kv{Key: "name", Value: name},
			kv{Key: "source", Value: refs.DisplayRef(p.Spec.Source)})
		return int(anyerr.Success)
	}
	if err := confirmDelete("Codex profile "+name, globals.Yes); err != nil {
		if err == errDeclined {
			return int(anyerr.Success)
		}
		return reportErr(err)
	}
	err = activation.RemoveNamedProfiles(ctx, []activation.ProfileRemoval{removal}, a.Deps,
		func(c context.Context) error {
			// The confirmation named a specific route; if it moved in the
			// meantime the user never agreed to this removal.
			current, gerr := a.CodexProfileSvc.GetContext(c, "codex", name)
			if gerr != nil {
				return gerr
			}
			if current == nil {
				return activation.NamedProfileNotFound(name)
			}
			if activation.NamedProfileChanged(p, current) {
				return anyerr.Newf(
					"Codex profile changed while removal was being confirmed; review it and retry.",
					"STATE_CONFLICT",
				)
			}
			return nil
		})
	if err != nil {
		return reportErr(err)
	}
	emitOK("removed Codex profile "+name,
		kv{Key: "ok", Value: true}, kv{Key: "profile", Value: name})
	return int(anyerr.Success)
}

// codexProfileNeedsEnv resolves the effective transport for a saved profile.
// An account from another provider can be proxy-backed even when its stored
// policy is "auto", so checking the policy string alone misses its token file.
func codexProfileNeedsEnv(ctx context.Context, a *appView, p *client.NamedProfile) bool {
	if p == nil || p.Spec.Source.Kind != refs.KindAccount {
		return true
	}
	if a == nil || a.Deps == nil {
		return p.Spec.TransportPolicy == string(transport.PolicyProxy)
	}
	resolved, err := activation.MaterializeResolvedSource(ctx, p.Spec.Source, a.Deps)
	if err != nil {
		return p.Spec.TransportPolicy == string(transport.PolicyProxy)
	}
	capability, err := transport.ResolveTransportPolicy(
		resolved.Adapter, "codex", transport.Policy(p.Spec.TransportPolicy))
	if err != nil {
		return p.Spec.TransportPolicy == string(transport.PolicyProxy)
	}
	return capability != transport.Direct
}

// profileOwnsCodexAccount reports whether this profile's saved route is
// already the named Codex account. A colliding desktop account that the
// profile does not own must not be replaced by a profile login.
func profileOwnsCodexAccount(p *client.NamedProfile, accountName string) bool {
	if p == nil {
		return false
	}
	src := p.Spec.Source
	return src.Kind == refs.KindAccount && src.Provider == "codex" && src.Name == accountName
}

func codexProfileNotFound(name string) error {
	return activation.NamedProfileNotFound(name)
}
