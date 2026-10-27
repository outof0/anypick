package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/refs"
)

func cmdProxyConfig(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	port := fs.Int("port", 0, "fixed port (default: auto)")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 2 {
		return usageError("usage: anypick proxy config <provider> <account> [--port N]")
	}
	if globals.DryRun {
		printDryRunFields("proxy.config",
			fmt.Sprintf("Would configure %s/%s", fs.Arg(0), fs.Arg(1)),
			kv{Key: "provider", Value: fs.Arg(0)}, kv{Key: "name", Value: fs.Arg(1)},
			kv{Key: "port", Value: intOrNil(*port)},
			kv{Key: "restart", Value: true}) // restart defaults to true
		return int(anyerr.Success)
	}
	cfg, err := a.Proxy.Configure(ctx, fs.Arg(0), fs.Arg(1), true, *port)
	if err != nil {
		return reportErr(err)
	}
	out := struct {
		Enabled bool `json:"enabled"`
		Port    int  `json:"port"`
	}{cfg.Enabled, cfg.Port}
	if wantJSON(args) {
		jsonOut(out)
	} else {
		cliPrintf("configured %s/%s (port %d)\n", fs.Arg(0), fs.Arg(1), cfg.Port)
	}
	return int(anyerr.Success)
}

func cmdProxyRestart(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 2 {
		return usageError("usage: anypick proxy restart <provider> <account>")
	}
	if err := a.Proxy.Stop(ctx, fs.Arg(0), fs.Arg(1)); err != nil {
		return reportErr(err)
	}
	res, err := a.Proxy.StartProxy(ctx, fs.Arg(0), fs.Arg(1))
	if err != nil {
		return reportErr(err)
	}
	human := fmt.Sprintf("restarted (%s)\nendpoint: %s", res.InstanceID[:8], res.Endpoint)
	emitOK(human,
		kv{Key: "ok", Value: true},
		kv{Key: "instanceId", Value: res.InstanceID[:8]},
		kv{Key: "endpoint", Value: res.Endpoint})
	return int(anyerr.Success)
}

func cmdProxyLogs(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	lines := fs.Int("lines", 50, "number of trailing lines")
	follow := fs.Bool("follow", false, "stream new log output")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 2 {
		return usageError("usage: anypick proxy logs <provider> <account> [--lines N] [--follow]")
	}
	// The engine's own log file answers through the Service, secret-screened.
	text, err := a.Proxy.ProxyLogs(ctx, fs.Arg(0), fs.Arg(1), *lines)
	if err != nil {
		return reportErr(err)
	}
	if globals.JSON && *follow {
		return reportErr(anyerr.Newf(
			"--follow cannot be combined with --json.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	if globals.JSON {
		logLines := []string{}
		if text != "" {
			logLines = strings.Split(strings.TrimRight(text, "\n"), "\n")
		}
		emitOK("",
			kv{Key: "ok", Value: true},
			kv{Key: "lines", Value: logLines})
		return int(anyerr.Success)
	}
	if text != "" {
		cliPrintlnRaw(text)
	}
	logPath := filepath.Join(paths.AccountProxyRuntimeDir(a.Root, fs.Arg(0), fs.Arg(1)), "proxy.log")
	if *follow {
		followFile(logPath, func(chunk string) string {
			return a.Proxy.ScreenProxyLog(fs.Arg(0), fs.Arg(1), chunk)
		})
	}
	return int(anyerr.Success)
}

func followFile(path string, screen func(string) string) {
	var offset int64
	for i := 0; i < 600; i++ { // bounded: ~5 minutes at 500ms
		data, err := os.ReadFile(path)
		if err == nil && int64(len(data)) > offset {
			chunk := string(data[offset:])
			if screen != nil {
				chunk = screen(chunk)
			}
			fmt.Print(chunk)
			offset = int64(len(data))
		} else if err != nil {
			return
		}
		sleepMS(500)
	}
}

func cmdPool(ctx context.Context, a *appView, args []string) int {
	usage := func() int {
		cliFprintln(os.Stderr,
			"usage: anypick proxy pool status|enable|disable|member|start|stop <provider> …")
		return int(anyerr.InvalidUsage)
	}
	if len(args) == 0 {
		return usage()
	}
	sub := args[0]
	rest := args[1:]
	fs := fsFor(rest)
	switch sub {
	case "status":
		if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
			return usage()
		}
		pool, err := a.PoolSvc.GetContext(ctx, fs.Arg(0))
		if err != nil {
			return reportErr(err)
		}
		if pool == nil {
			return reportErr(anyerr.Newf("no pool configured for "+fs.Arg(0), "POOL_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound)))
		}
		if wantJSON(rest) {
			jsonOut(pool)
			return int(anyerr.Success)
		}
		cliPrintf("pool %s: mode=%s enabled=%v strategy=%s\n",
			pool.Provider, pool.Mode, pool.Enabled, pool.Strategy)
		for _, m := range pool.Members {
			state := "off"
			if m.Enabled {
				state = "on"
			}
			cliPrintf("  %s [%s]\n", m.Account, state)
		}
		return int(anyerr.Success)

	case "enable":
		strategy := fs.String("strategy", "failover", "failover | round-robin | soonest-reset")
		mode := fs.String("mode", "multi", "single | multi")
		port := fs.Int("port", 0, "fixed port (default: auto)")
		// -p is the documented short form of --port; the stdlib parser has no
		// alias concept, so the same target is registered twice.
		portShort := fs.Int("p", 0, "alias of --port")
		if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() < 1 {
			return usage()
		}
		if *portShort != 0 {
			if *port != 0 && *port != *portShort {
				return usageError("pass one port (--port or -p)")
			}
			*port = *portShort
		}
		if !pools.ValidStrategy(*strategy) || *strategy == "" {
			return usageError("--strategy must be failover, round-robin or soonest-reset")
		}
		switch *mode {
		case "single", "multi":
		default:
			return usageError("--mode must be single or multi")
		}
		providerID := fs.Arg(0)
		memberArgs := fs.Args()[1:]
		if globals.DryRun {
			printDryRunFields("proxy.pool.enable",
				fmt.Sprintf("Would enable the %s multi-account pool", providerID),
				kv{Key: "provider", Value: providerID},
				kv{Key: "port", Value: intOrNil(*port)},
				kv{Key: "host", Value: nil}, // --host has no default here
				kv{Key: "start", Value: true})
			return int(anyerr.Success)
		}
		err := lock.WithMutationLock(ctx, a.Root, refs.ProviderScope(providerID), func(c context.Context) error {
			existing, gerr := a.PoolSvc.GetContext(c, providerID)
			if gerr != nil {
				return gerr
			}
			pool := pools.Pool{
				Provider: providerID, Mode: *mode, Enabled: true,
				Strategy: *strategy,
			}
			if existing != nil {
				pool.Members = append(pool.Members, existing.Members...)
				// Preserve an explicit port unless the caller overrides it.
				pool.Port = existing.Port
				pool.Host = existing.Host
			}
			for _, name := range memberArgs {
				enabled := true
				if strings.HasPrefix(name, "-") {
					enabled = false
					name = strings.TrimPrefix(name, "-")
				} else if strings.HasPrefix(name, "+") {
					name = strings.TrimPrefix(name, "+")
				}
				pool.Members = upsertMember(pool.Members, name, enabled)
			}
			if *port != 0 {
				pool.Port = *port
			}
			if pool.Host == "" {
				pool.Host = "127.0.0.1"
			}
			return a.PoolSvc.Set(c, pool)
		})
		if err != nil {
			return reportErr(err)
		}
		emitOK(fmt.Sprintf("enabled pool for %s (%s/%s)", providerID, *mode, *strategy),
			kv{Key: "ok", Value: true},
			kv{Key: "provider", Value: providerID},
			kv{Key: "mode", Value: *mode},
			kv{Key: "strategy", Value: *strategy},
			kv{Key: "enabled", Value: true})
		return int(anyerr.Success)

	case "disable":
		if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
			return usage()
		}
		providerID := fs.Arg(0)
		if globals.DryRun {
			printDryRunFields("proxy.pool.disable",
				fmt.Sprintf("Would disable the %s pool", providerID),
				kv{Key: "provider", Value: providerID})
			return int(anyerr.Success)
		}
		err := lock.WithMutationLock(ctx, a.Root, refs.ProviderScope(providerID), func(c context.Context) error {
			return a.PoolSvc.DisableContext(c, providerID)
		})
		if err != nil {
			return reportErr(err)
		}
		// The child-stop must be verified exactly like an explicit stop (ADR 0003
		// §3): an unverifiable pool process fails the command instead of leaving
		// an orphaned credential-bearing listener behind a false success.
		if serr := a.Proxy.StopPoolProxy(ctx, providerID); serr != nil {
			return reportErr(serr)
		}
		emitOK(fmt.Sprintf("disabled pool for %s", providerID),
			kv{Key: "ok", Value: true},
			kv{Key: "provider", Value: providerID},
			kv{Key: "enabled", Value: false})
		return int(anyerr.Success)

	case "member":
		if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 3 {
			return usage()
		}
		providerID := fs.Arg(0)
		accountArg := fs.Arg(1)
		enabled, validState := poolMemberState(fs.Arg(2))
		if !validState {
			return usageError(fmt.Sprintf("unknown state %q; use on or off", fs.Arg(2)))
		}
		if globals.DryRun {
			verb := "enable"
			if !enabled {
				verb = "pause"
			}
			printDryRunFields("proxy.pool.member",
				fmt.Sprintf("Would %s %s/%s", verb, providerID, accountArg),
				kv{Key: "provider", Value: providerID},
				kv{Key: "account", Value: accountArg},
				kv{Key: "enabled", Value: enabled})
			return int(anyerr.Success)
		}
		var updated *pools.Pool
		err := lock.WithMutationLock(ctx, a.Root, refs.ProviderScope(providerID), func(c context.Context) error {
			existing, gerr := a.PoolSvc.GetContext(c, providerID)
			if gerr != nil {
				return gerr
			}
			if existing == nil {
				return anyerr.Newf("no pool configured for "+providerID, "POOL_NOT_FOUND",
					anyerr.WithExitCode(anyerr.NotFound))
			}
			account, aerr := a.Accounts.Get(c, providerID, accountArg)
			if aerr != nil {
				return aerr
			}
			if account == nil {
				return anyerr.Newf(
					fmt.Sprintf("No account %q for provider %q.", accountArg, providerID),
					"ACCOUNT_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound))
			}

			// A member toggle changes exactly one field. In particular it must
			// not call SetMultiContext, which also forces multi/enabled/failover
			// and silently destroys the user's pool configuration.
			next := *existing
			next.Members = append([]pools.Member(nil), existing.Members...)
			next.Members = upsertMember(next.Members, account.Meta.Name, enabled)
			if serr := a.PoolSvc.Set(c, next); serr != nil {
				return serr
			}
			updated = &next
			return nil
		})
		if err != nil {
			return reportErr(err)
		}
		// Hot reload without starting a pool
		// that was stopped. A NULL-account lease identifies a pool instance;
		// per-account proxy state alone is not sufficient evidence.
		running, rerr := poolProxyIsRunning(ctx, a, providerID)
		if rerr != nil {
			return reportErr(rerr)
		}
		if updated != nil && updated.Mode == "multi" && updated.Enabled && running {
			if _, rerr := a.Proxy.StartPoolProxy(ctx, providerID); rerr != nil {
				return reportErr(rerr)
			}
		}
		emitOK("members updated",
			kv{Key: "ok", Value: true},
			kv{Key: "provider", Value: providerID},
			kv{Key: "account", Value: accountArg},
			kv{Key: "enabled", Value: enabled})
		return int(anyerr.Success)

	case "start", "stop":
		if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
			return usage()
		}
		providerID := fs.Arg(0)
		pool, perr := a.PoolSvc.GetContext(ctx, providerID)
		if perr != nil {
			return reportErr(perr)
		}
		if pool == nil || !pool.Enabled {
			return reportErr(anyerr.Newf("pool for "+providerID+" is not enabled", "POOL_DISABLED"))
		}
		if sub == "stop" {
			// Verified stop through the Service (ADR 0003 §3): the /health instance
			// echo vetoes signalling a process we do not own, the (provider, "")
			// lease and proxy_state are released on success, and an unverified
			// child fails loudly instead of printing a false "stopped".
			if serr := a.Proxy.StopPoolProxy(ctx, providerID); serr != nil {
				return reportErr(serr)
			}
			emitOK("stopped",
				kv{Key: "ok", Value: true},
				kv{Key: "state", Value: "stopped"},
				kv{Key: "provider", Value: providerID})
			return int(anyerr.Success)
		}
		pid, err := spawnDetachedService(a.Root, []string{"_serve-pool", providerID},
			poolPIDPath(a.Root, providerID))
		if err != nil {
			return reportErr(err)
		}
		emitOK(fmt.Sprintf("started (pid %d)", pid),
			kv{Key: "ok", Value: true},
			kv{Key: "state", Value: "started"},
			kv{Key: "provider", Value: providerID},
			kv{Key: "pid", Value: pid})
		return int(anyerr.Success)

	default:
		return usage()
	}
}

func upsertMember(members []pools.Member, account string, enabled bool) []pools.Member {
	for i := range members {
		if members[i].Account == account {
			members[i].Enabled = enabled
			return members
		}
	}
	members = append(members, pools.Member{Account: account, Enabled: enabled})
	sort.SliceStable(members, func(i, j int) bool {
		return members[i].Account < members[j].Account
	})
	return members
}

func poolMemberState(state string) (enabled bool, valid bool) {
	switch state {
	case "on", "enable", "1":
		return true, true
	case "off", "disable", "0":
		return false, true
	default:
		return false, false
	}
}

// poolProxyIsRunning distinguishes the shared pool process from an account
// proxy. Both store runtime state under an account, but only a pool owns a
// NULL-account lease whose instance id and endpoint match that live state.
func poolProxyIsRunning(ctx context.Context, a *appView, providerID string) (bool, error) {
	leases, err := a.Proxy.ListPoolLeasesContext(ctx, providerID)
	if err != nil {
		return false, err
	}
	if len(leases) == 0 {
		return false, nil
	}
	accounts, err := a.Accounts.List(ctx, providerID)
	if err != nil {
		return false, err
	}
	for _, account := range accounts {
		state, serr := a.Proxy.RuntimeState(ctx, providerID, account.Meta.Name)
		if serr != nil {
			return false, serr
		}
		if state == nil {
			continue
		}
		for _, lease := range leases {
			if lease.InstanceID == "" || lease.InstanceID != state.InstanceID {
				continue
			}
			status, serr := a.Proxy.StatusContext(ctx, providerID, account.Meta.Name)
			if serr != nil {
				return false, serr
			}
			if status != nil && status.Running &&
				(lease.Endpoint == "" || lease.Endpoint == status.Endpoint) {
				return true, nil
			}
		}
	}
	return false, nil
}
