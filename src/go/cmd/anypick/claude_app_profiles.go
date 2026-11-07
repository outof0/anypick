package main

import (
	"context"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
)

const claudeAppUsage = "usage: anypick claude-app profile <list|open|remove> …"

// cmdClaudeApp manages separate Claude desktop app data folders. A profile
// holds the app's own login, so it is independent of `anypick use claude`,
// which changes Claude Code's credential and never reaches the app (ADR 0038).
func cmdClaudeApp(ctx context.Context, a *appView, args []string) int {
	if len(args) == 0 {
		return usageError(claudeAppUsage)
	}
	if args[0] != "profile" {
		return usageError("unknown claude-app subcommand %q", args[0])
	}
	if len(args) == 1 {
		return usageError(claudeAppUsage)
	}
	switch args[1] {
	case "list":
		return cmdClaudeAppProfileList(a, args[2:])
	case "open":
		return cmdClaudeAppProfileOpen(ctx, a, args[2:])
	case "remove":
		return cmdClaudeAppProfileRemove(ctx, a, args[2:])
	default:
		return usageError("unknown claude-app profile subcommand %q", args[1])
	}
}

func cmdClaudeAppProfileList(a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 0 {
		return usageError("usage: anypick claude-app profile list")
	}
	profiles, err := client.ListClaudeAppProfiles(a.Root)
	if err != nil {
		return reportErr(err)
	}
	if globals.JSON {
		type profileInfo struct {
			Name     string `json:"name"`
			SignedIn bool   `json:"signedIn"`
			Running  bool   `json:"running"`
		}
		out := make([]profileInfo, 0, len(profiles))
		for _, p := range profiles {
			out = append(out, profileInfo{Name: p.Name, SignedIn: p.SignedIn, Running: p.Running})
		}
		jsonOut(out)
		return int(anyerr.Success)
	}
	if len(profiles) == 0 {
		cliPrintln("No Claude app profiles.")
		return int(anyerr.Success)
	}
	for _, p := range profiles {
		state := "not signed in"
		if p.SignedIn {
			state = "signed in"
		}
		if p.Running {
			state += ", open"
		}
		cliPrintln(p.Name + " (" + state + ")")
	}
	return int(anyerr.Success)
}

func cmdClaudeAppProfileOpen(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick claude-app profile open <name>")
	}
	name := fs.Arg(0)
	if err := client.ValidateClaudeAppProfileName(name); err != nil {
		return reportErr(anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	userData := client.ClaudeAppProfileInstancePath(a.Root, name)
	if globals.DryRun {
		printDryRunFields("claude-app.profile.open", "Would open Claude app profile "+name,
			kv{Key: "profile", Value: name},
			kv{Key: "userData", Value: userData})
		return int(anyerr.Success)
	}
	if err := activation.OpenClaudeAppProfile(ctx, a.Root, name); err != nil {
		return reportErr(err)
	}
	emitOK("opened Claude app profile "+name,
		kv{Key: "ok", Value: true},
		kv{Key: "profile", Value: name},
		kv{Key: "userData", Value: userData})
	return int(anyerr.Success)
}

func cmdClaudeAppProfileRemove(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 1 {
		return usageError("usage: anypick claude-app profile remove <name> [--yes]")
	}
	name := fs.Arg(0)
	if err := client.ValidateClaudeAppProfileName(name); err != nil {
		return reportErr(anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	if globals.DryRun {
		printDryRunFields("claude-app.profile.remove", "Would remove Claude app profile "+name,
			kv{Key: "profile", Value: name},
			kv{Key: "path", Value: client.ClaudeAppProfilePath(a.Root, name)})
		return int(anyerr.Success)
	}
	if err := confirmDelete("Claude app profile "+name, globals.Yes); err != nil {
		if err == errDeclined {
			return int(anyerr.Success)
		}
		return reportErr(err)
	}
	if err := activation.RemoveClaudeAppProfile(ctx, a.Root, name); err != nil {
		return reportErr(err)
	}
	emitOK("removed Claude app profile "+name,
		kv{Key: "ok", Value: true},
		kv{Key: "profile", Value: name})
	return int(anyerr.Success)
}
