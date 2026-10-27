package main

import (
	"context"
	"flag"
	"fmt"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
)

const hubComboUsage = "usage: anypick proxy hub combo add <hub> <name> <provider/account=model>…\n" +
	"       anypick proxy hub combo list <hub>\n" +
	"       anypick proxy hub combo remove <hub> <name>"

// cmdHubCombo manages a hub's named combos (ADR-0036): model ids the hub
// defines, each an ordered chain of (source, model) steps.
func cmdHubCombo(ctx context.Context, a *appView, _ func() int, fs *flag.FlagSet, rest []string) int {
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() < 2 {
		return usageError(hubComboUsage)
	}
	switch verb, hubName := fs.Arg(0), fs.Arg(1); verb {
	case "list":
		if fs.NArg() != 2 {
			return usageError(hubComboUsage)
		}
		return hubComboList(ctx, a, hubName)
	case "add":
		if fs.NArg() < 4 {
			return usageError(hubComboUsage)
		}
		steps := make([]hub.ComboStep, 0, fs.NArg()-3)
		for _, arg := range fs.Args()[3:] {
			step, err := parseComboStep(arg)
			if err != nil {
				return reportErr(err)
			}
			steps = append(steps, step)
		}
		return hubComboSave(ctx, a, hubName, hub.Combo{Name: fs.Arg(2), Steps: steps})
	case "remove":
		if fs.NArg() != 3 {
			return usageError(hubComboUsage)
		}
		return hubComboRemove(ctx, a, hubName, fs.Arg(2))
	default:
		return usageError(hubComboUsage)
	}
}

// parseComboStep reads "provider/account=model". The account is everything
// between the first "/" and the first "=", so a pool source reads
// "codex/pool:codex=gpt-5"; the model is everything after "=", so a model id
// with its own slashes (openrouter's "anthropic/claude-sonnet-4") survives.
func parseComboStep(arg string) (hub.ComboStep, error) {
	source, model, ok := strings.Cut(arg, "=")
	providerID, account, okSource := strings.Cut(source, "/")
	if !ok || !okSource || providerID == "" || account == "" || strings.TrimSpace(model) == "" {
		return hub.ComboStep{}, anyerr.Newf(
			"A combo step is provider/account=model (for example claude/work=claude-opus-4); got \""+arg+"\".",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return hub.ComboStep{Provider: providerID, Account: account, Model: strings.TrimSpace(model)}, nil
}

// mutateHubCombos edits the hub's combo list under the hub's lock and then
// restarts a running hub, which holds its config in memory (ADR-0030).
func mutateHubCombos(ctx context.Context, a *appView, hubName string, edit func(*hub.Config) error) error {
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.ProxyHubRef(hubName)), func(c context.Context) error {
		cfg, gerr := a.ProxyHub.GetConfig(c, hubName)
		if gerr != nil {
			return gerr
		}
		if cfg == nil {
			return anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound))
		}
		if eerr := edit(cfg); eerr != nil {
			return eerr
		}
		_, uerr := a.ProxyHub.UpsertConfig(c, *cfg)
		return uerr
	})
	if err != nil {
		return err
	}
	// Outside the lock: a restart takes seconds and must not hold the scope.
	reloadHubChild(a, ctx, hubName)
	return nil
}

func hubComboSave(ctx context.Context, a *appView, hubName string, combo hub.Combo) int {
	if globals.DryRun {
		printDryRunFields("proxy.hub.combo.add",
			fmt.Sprintf("Would save combo %s with %d steps in hub %s", combo.Name, len(combo.Steps), hubName),
			kv{Key: "hub", Value: hubName}, kv{Key: "combo", Value: combo.Name})
		return int(anyerr.Success)
	}
	pins, err := a.ProxyHub.RouteModelsContext(ctx, hubName)
	if err != nil {
		return reportErr(err)
	}
	pinned := make([]string, 0, len(pins))
	for _, pin := range pins {
		pinned = append(pinned, pin.Model)
	}
	replaced := false
	err = mutateHubCombos(ctx, a, hubName, func(cfg *hub.Config) error {
		if verr := hub.ValidateCombo(*cfg, combo, pinned); verr != nil {
			return verr
		}
		for i := range cfg.Combos {
			if cfg.Combos[i].Name == combo.Name {
				cfg.Combos[i], replaced = combo, true
				return nil
			}
		}
		cfg.Combos = append(cfg.Combos, combo)
		return nil
	})
	if err != nil {
		return reportErr(err)
	}
	verb := "saved"
	if replaced {
		verb = "replaced"
	}
	emitOK(fmt.Sprintf("%s combo %s in hub %s (%d steps)", verb, combo.Name, hubName, len(combo.Steps)),
		kv{Key: "ok", Value: true}, kv{Key: "hub", Value: hubName},
		kv{Key: "combo", Value: combo.Name}, kv{Key: "replaced", Value: replaced})
	return int(anyerr.Success)
}

func hubComboRemove(ctx context.Context, a *appView, hubName, name string) int {
	if globals.DryRun {
		printDryRunFields("proxy.hub.combo.remove",
			fmt.Sprintf("Would remove combo %s from hub %s", name, hubName),
			kv{Key: "hub", Value: hubName}, kv{Key: "combo", Value: name})
		return int(anyerr.Success)
	}
	err := mutateHubCombos(ctx, a, hubName, func(cfg *hub.Config) error {
		kept := cfg.Combos[:0]
		for _, combo := range cfg.Combos {
			if combo.Name != name {
				kept = append(kept, combo)
			}
		}
		if len(kept) == len(cfg.Combos) {
			return anyerr.Newf("Hub "+hubName+" has no combo named "+name+".", "COMBO_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound))
		}
		cfg.Combos = kept
		return nil
	})
	if err != nil {
		return reportErr(err)
	}
	emitOK(fmt.Sprintf("removed combo %s from hub %s", name, hubName),
		kv{Key: "ok", Value: true}, kv{Key: "hub", Value: hubName}, kv{Key: "combo", Value: name})
	return int(anyerr.Success)
}

func hubComboList(ctx context.Context, a *appView, hubName string) int {
	cfg, err := a.ProxyHub.GetConfig(ctx, hubName)
	if err != nil {
		return reportErr(err)
	}
	if cfg == nil {
		return reportErr(anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound)))
	}
	combos := cfg.Combos
	if combos == nil {
		combos = []hub.Combo{}
	}
	if globals.JSON {
		jsonOut(map[string]interface{}{"hub": hubName, "combos": combos})
		return int(anyerr.Success)
	}
	if len(combos) == 0 {
		cliPrintf("hub %s has no combos\n", hubName)
		return int(anyerr.Success)
	}
	for _, combo := range combos {
		parts := make([]string, 0, len(combo.Steps))
		for _, step := range combo.Steps {
			part := step.Provider + "/" + step.Account + "=" + step.Model
			// A step whose source left the hub is skipped at request time;
			// say so here rather than letting the chain look whole.
			if !hubHasSource(*cfg, step) {
				part += " (source not in hub)"
			}
			parts = append(parts, part)
		}
		cliPrintf("%s: %s\n", combo.Name, strings.Join(parts, " → "))
	}
	return int(anyerr.Success)
}

func hubHasSource(cfg hub.Config, step hub.ComboStep) bool {
	for _, src := range cfg.Sources {
		if src.ProviderID == step.Provider && src.Account == step.Account {
			return true
		}
	}
	return false
}
