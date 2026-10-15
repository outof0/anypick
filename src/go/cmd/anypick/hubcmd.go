package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/ownership"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
)

func cmdHub(ctx context.Context, a *appView, args []string) int {
	usage := func() int {
		cliFprintln(os.Stderr,
			"usage: anypick proxy hub <status|enable|source|owner|preview|start|stop|token> <name> …")
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
		return cmdHubStatus(ctx, a, usage, fs, rest)

	case "token":
		return cmdHubToken(ctx, a, usage, fs, rest)

	case "enable":
		return cmdHubEnable(ctx, a, usage, fs, rest)

	case "source":
		return cmdHubSource(ctx, a, usage, fs, rest)

	case "owner":
		return cmdHubOwner(ctx, a, usage, fs, rest)

	case "preview":
		return cmdHubPreview(ctx, a, usage, fs, rest)

	case "start":
		return cmdHubStart(ctx, a, usage, fs, rest)
	case "stop":
		if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
			return usage()
		}
		name := fs.Arg(0)
		if globals.DryRun {
			printDryRunFields("proxy.hub.stop", "Would stop the unified Proxy Hub")
			return int(anyerr.Success)
		}
		if serr := stopHubChild(a, ctx, name); serr != nil {
			return reportErr(serr)
		}
		emitOK("stopped",
			kv{Key: "ok", Value: true},
			kv{Key: "state", Value: "stopped"},
			kv{Key: "hub", Value: name})
		return int(anyerr.Success)

	default:
		return usage()
	}
}

var _ = os.Stdout

// stopHubChild stops one hub child ownership-verified (ADR 0003 §3): the
// live process must match the pidfile record plus the /health instance echo
// before its session group is signalled. Missing record means not running.
func stopHubChild(a *appView, ctx context.Context, name string) error {
	pidFile := hubPIDPath(a.Root, name)
	rec := ownership.Load(pidFile)
	if rec == nil {
		return nil
	}
	cfg, gerr := a.ProxyHub.GetConfig(ctx, name)
	if gerr != nil {
		return gerr
	}
	stopped := ownership.Stop(pidFile, ownership.StopOptions{
		Timeout: stopWait,
		Health: func(r ownership.Record) bool {
			if cfg == nil || cfg.Port == 0 {
				return false
			}
			return hubHealthEcho(fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port), r.InstanceID)
		},
	})
	if !stopped {
		return anyerr.Newf(
			"could not verify ownership of hub `"+name+"`; not signalling it",
			"HUB_OWNERSHIP_UNVERIFIED")
	}
	return nil
}

// reloadHubChild restarts a running hub child so config mutations (sources,
// owners) reach the serving process; hub children hold their config in
// memory and never re-read it (ADR-0030). A stopped hub stays stopped.
// Failures warn instead of failing the mutation: the config is saved either
// way, and the next start serves it fresh.
func reloadHubChild(a *appView, ctx context.Context, name string) bool {
	pidFile := hubPIDPath(a.Root, name)
	if ownership.Load(pidFile) == nil {
		return false
	}
	if err := stopHubChild(a, ctx, name); err != nil {
		cliFprintf(os.Stderr, "warning: hub %s config saved but child not restarted: %s\n", name, err)
		return false
	}
	if _, err := spawnDetachedService(a.Root, []string{"_serve-hub", name}, pidFile); err != nil {
		cliFprintf(os.Stderr, "warning: hub %s config saved but child not restarted: %s\n", name, err)
		return false
	}
	return true
}

// hubHealthEcho proves a hub child's identity: /health must echo the exact
// instance id recorded at spawn (ADR 0003 §3). Bounded, no retries.
func hubHealthEcho(healthURL, wantInstanceID string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(healthURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false
	}
	var payload struct {
		OK         bool   `json:"ok"`
		InstanceID string `json:"instanceId"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&payload) != nil {
		return false
	}
	return payload.OK && payload.InstanceID == wantInstanceID
}

func cmdHubStatus(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
		return usage()
	}
	name := fs.Arg(0)
	cfg, gerr := a.ProxyHub.GetConfig(ctx, name)
	if gerr != nil {
		return reportErr(gerr)
	}
	if cfg == nil {
		return reportErr(anyerr.Newf("Proxy Hub not found: "+name, "HUB_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound)))
	}
	// Status is a read. The listener bearer is printed only by `proxy hub token`.
	if wantJSON(rest) {
		jsonOut(cfg)
		return int(anyerr.Success)
	}
	cliPrintf("hub %s: enabled=%v port=%d sources=%d\n",
		cfg.Name, cfg.Enabled, cfg.Port, len(cfg.Sources))
	for _, s := range cfg.Sources {
		cliPrintf("  source %s/%s\n", s.ProviderID, s.Account)
	}
	return int(anyerr.Success)
}

func cmdHubToken(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	rotate := fs.Bool("rotate", false, "rotate and generate a fresh API key")
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() < 1 {
		return usage()
	}
	name := fs.Arg(0)
	isRotate := *rotate
	if fs.NArg() >= 2 && fs.Arg(1) == "rotate" {
		isRotate = true
	}
	if isRotate {
		token, err := a.ProxyHub.RotateHubTokenContext(ctx, name)
		if err != nil {
			return reportErr(err)
		}
		if wantJSON(rest) {
			jsonOut(map[string]string{"hub": name, "apiKey": token})
			return int(anyerr.Success)
		}
		cliPrintf("hub %s: new api_key: %s\n", name, token)
		return int(anyerr.Success)
	}
	token, err := a.ProxyHub.EnsureHubTokenContext(ctx, name)
	if err != nil {
		return reportErr(err)
	}
	if wantJSON(rest) {
		jsonOut(map[string]string{"hub": name, "apiKey": token})
		return int(anyerr.Success)
	}
	cliPrintf("hub %s: api_key: %s\n", name, token)
	return int(anyerr.Success)
}

// enableHub applies the enable overrides under the hub's mutation lock and
// returns the saved config. Split out of cmdHubEnable to keep that handler
// within the long-function budget (internal/app/debtgate_test.go).
func enableHub(ctx context.Context, a *appView, name, host, strategy string, port int) (*hub.Config, error) {
	var saved *hub.Config
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.ProxyHubRef(name)), func(c context.Context) error {
		existing, gerr := a.ProxyHub.GetConfig(c, name)
		if gerr != nil {
			return gerr
		}
		if existing == nil {
			existing = &hub.Config{Name: name, Sources: []hub.Source{}}
		}
		existing.Enabled = true
		if port != 0 {
			existing.Port = port
		}
		if host != "" {
			existing.Host = host
		}
		if strategy != "" {
			existing.Strategy = strategy
		}
		upserted, uerr := a.ProxyHub.UpsertConfig(c, *existing)
		saved = &upserted
		return uerr
	})
	return saved, err
}

// cmdHubEnable flips a hub on, keeping host/port/strategy unless overridden.
func cmdHubEnable(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	host := fs.String("host", "127.0.0.1", "loopback host")
	port := fs.Int("port", 0, "fixed port (default: auto)")
	// -p is the documented short form of --port; the stdlib parser has no
	// alias concept, so the same target is registered twice.
	portShort := fs.Int("p", 0, "alias of --port")
	// --start is the documented "enable and start" form. It is not a second
	// behaviour: `proxy hub start` already spawns the child, so this only
	// chains that call after a successful enable.
	start := fs.Bool("start", false, "start the hub after enabling it")
	strategy := fs.String("strategy", "", "failover | round-robin (default: keep the current mode)")
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
		return usage()
	}
	if *portShort != 0 {
		if *port != 0 && *port != *portShort {
			return usageError("pass one port (--port or -p)")
		}
		*port = *portShort
	}
	switch *strategy {
	case "", hub.StrategyFailover, hub.StrategyRoundRobin:
	default:
		return usageError("--strategy must be failover or round-robin")
	}
	name := fs.Arg(0)
	if globals.DryRun {
		// Resolve the effective host/port read-only (TS: opts ?? current).
		effPort := *port
		var portVal any
		if existing, gerr := a.ProxyHub.GetConfig(ctx, name); gerr == nil && existing != nil && effPort == 0 {
			effPort = existing.Port
		}
		if effPort != 0 {
			portVal = effPort
		}
		printDryRunFields("proxy.hub.enable", "Would enable the unified Proxy Hub",
			kv{Key: "host", Value: *host},
			kv{Key: "port", Value: portVal}, // Go never invents a default port (ADR 0020; retired PARITY.md)
			kv{Key: "start", Value: *start})
		return int(anyerr.Success)
	}
	saved, err := enableHub(ctx, a, name, *host, *strategy, *port)
	if err != nil {
		return reportErr(err)
	}
	// --start chains the existing start path rather than reimplementing it.
	// Delegating also keeps --json to one result stream: the start emit is the
	// single value, instead of an enable value followed by a start value.
	if *start {
		return cmdHubStart(ctx, a, usage, fsFor(nil), []string{name})
	}
	emitOK(fmt.Sprintf("enabled hub %s (port %d)", name, saved.Port),
		kv{Key: "ok", Value: true},
		kv{Key: "hub", Value: name},
		kv{Key: "enabled", Value: true},
		kv{Key: "port", Value: saved.Port})
	return int(anyerr.Success)
}

func cmdHubPreview(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
		return usage()
	}
	hubName := fs.Arg(0)
	manifest, perr := a.ProxyHub.PreviewManifest(ctx, hubName)
	if perr != nil {
		return reportErr(perr)
	}
	extra, xerr := unpinnedHubModelLines(ctx, a, hubName)
	if xerr != nil {
		return reportErr(xerr)
	}
	manifest.Lines = append(manifest.Lines, extra...)
	if wantJSON(rest) {
		jsonOut(manifest)
		return int(anyerr.Success)
	}
	for _, line := range manifest.Lines {
		cliPrintln(line)
	}
	return int(anyerr.Success)
}

// unpinnedHubModelLines renders the models a hub's sources can serve but that
// no route pins. PreviewManifest only walks proxy_hub_routes, so without this
// the command reported a hub as serving seven models when its accounts publish
// twenty-three. Catalog-only: a preview must not spend saved credentials on
// vendor egress, so a cold cache shows fewer models, never more.
func unpinnedHubModelLines(ctx context.Context, a *appView, hubName string) ([]string, error) {
	if a == nil || a.ProxyHub == nil {
		return nil, nil
	}
	pinned, err := hubPinnedModels(ctx, a, hubName)
	if err != nil {
		return nil, err
	}
	if len(pinned) == 0 {
		return nil, nil
	}
	pinnedSet := make(map[string]bool, len(pinned))
	for _, id := range pinned {
		pinnedSet[id] = true
	}
	var lines []string
	for _, id := range mergeModelIDsOrdered(hubSourceModels(ctx, a, hubName, false)) {
		if pinnedSet[id] {
			continue
		}
		lines = append(lines, fmt.Sprintf("model %s → any source that serves it", id))
	}
	return lines, nil
}

// cmdHubStart spawns the hub child, adopting a running one only when it
// serves the stored config revision (ADR-0030).
func cmdHubStart(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 1 {
		return usage()
	}
	name := fs.Arg(0)
	cfg, gerr := a.ProxyHub.GetConfig(ctx, name)
	if gerr != nil {
		return reportErr(gerr)
	}
	if cfg == nil || !cfg.Enabled {
		return reportErr(anyerr.Newf("hub "+name+" is not enabled", "HUB_DISABLED"))
	}
	pidFile := hubPIDPath(a.Root, name)
	if pid := readPID(pidFile); pid != 0 {
		// A live pid is not a fresh child: restart it when its config
		// revision trails the stored one (ADR-0030), adopt it otherwise.
		if cfg.Port != 0 && !hub.ChildSynced(fmt.Sprintf("http://127.0.0.1:%d", cfg.Port), cfg.Revision) {
			if err := stopHubChild(a, ctx, name); err != nil {
				return reportErr(err)
			}
		} else {
			emitOK(fmt.Sprintf("already running (pid %d)", pid),
				kv{Key: "ok", Value: true},
				kv{Key: "state", Value: "already running"},
				kv{Key: "hub", Value: name},
				kv{Key: "pid", Value: pid})
			return int(anyerr.Success)
		}
	}
	// No live child. Publish a port before spawn so the next freshness check
	// has an address. A child that is already running with port 0 returned
	// above: assigning a port it is not bound to would make RestartStaleChild
	// refuse to signal it (ADR-0030).
	if hub.ShouldPublishPort(cfg.Port, false) {
		picked, perr := proxy.PickFreePort()
		if perr != nil {
			return reportErr(perr)
		}
		err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.ProxyHubRef(name)), func(c context.Context) error {
			existing, gerr := a.ProxyHub.GetConfig(c, name)
			if gerr != nil {
				return gerr
			}
			if existing == nil || !existing.Enabled {
				return anyerr.Newf("hub "+name+" is not enabled", "HUB_DISABLED")
			}
			if existing.Port != 0 {
				return nil
			}
			existing.Port = picked
			_, uerr := a.ProxyHub.UpsertConfig(c, *existing)
			return uerr
		})
		if err != nil {
			return reportErr(err)
		}
	}
	pid, serr := spawnDetachedService(a.Root, []string{"_serve-hub", name}, pidFile)
	if serr != nil {
		return reportErr(serr)
	}
	emitOK(fmt.Sprintf("started (pid %d)", pid),
		kv{Key: "ok", Value: true},
		kv{Key: "state", Value: "started"},
		kv{Key: "hub", Value: name},
		kv{Key: "pid", Value: pid})
	return int(anyerr.Success)
}

// cmdHubSourceDryRun resolves toggle semantics read-only: present source
// would be removed, absent one attached.
func cmdHubSourceDryRun(ctx context.Context, a *appView, name, providerID, account string) int {
	existing, gerr := a.ProxyHub.GetConfig(ctx, name)
	if gerr != nil {
		return reportErr(gerr)
	}
	enabled := true
	found := false
	if existing != nil {
		for _, s := range existing.Sources {
			if s.ProviderID == providerID && s.Account == account {
				found, enabled = true, false
			}
		}
	}
	if !found && account == "" {
		return reportErr(anyerr.Newf("source needs an account name", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	printDryRunFields("proxy.hub.source",
		fmt.Sprintf("Would %s %s/%s behind Proxy Hub", map[bool]string{true: "enable", false: "disable"}[enabled], providerID, account),
		kv{Key: "provider", Value: providerID}, kv{Key: "account", Value: account},
		kv{Key: "enabled", Value: enabled})
	return int(anyerr.Success)
}

// cmdHubSource toggles one hub source: present → remove (pins naming it
// drop), absent → attach (refused fast for unknown accounts).
func cmdHubSource(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() < 2 || fs.NArg() > 3 {
		return usage()
	}
	name, providerID, account := fs.Arg(0), fs.Arg(1), fs.Arg(2)
	if globals.DryRun {
		return cmdHubSourceDryRun(ctx, a, name, providerID, account)
	}
	var mutated bool
	var notice string
	var unpinned []string
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.ProxyHubRef(name)), func(c context.Context) error {
		var terr error
		notice, unpinned, terr = toggleHubSource(ctx, c, a, name, providerID, account)
		if terr != nil {
			return terr
		}
		mutated = true
		return nil
	})
	if err != nil {
		return reportErr(err)
	}
	// Reload outside the mutation lock: process stop/spawn takes seconds
	// and must not hold the coordinator scope. The restart line stays a
	// second human line. --json gets one object so the two sentences cannot
	// become two documents.
	restarted := false
	if mutated {
		restarted = reloadHubChild(a, ctx, name)
	}
	fields := []kv{
		{Key: "ok", Value: true},
		{Key: "hub", Value: name},
		{Key: "restarted", Value: restarted},
	}
	if len(unpinned) > 0 {
		fields = append(fields, kv{Key: "unpinned", Value: unpinned})
	}
	emitOK(notice, fields...)
	if !globals.JSON && restarted {
		cliPrintf("hub %s restarted\n", name)
	}
	return int(anyerr.Success)
}

// toggleHubSource removes a source that is already attached and attaches one
// that is not. The caller holds the hub mutation lock.
func toggleHubSource(ctx, c context.Context, a *appView, name, providerID, account string) (string, []string, error) {
	existing, gerr := a.ProxyHub.GetConfig(c, name)
	if gerr != nil {
		return "", nil, gerr
	}
	if existing == nil {
		return "", nil, anyerr.Newf("Proxy Hub not found: "+name, "HUB_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	for _, s := range existing.Sources {
		if s.ProviderID != providerID || s.Account != account {
			continue
		}
		removed, dropped, rerr := a.ProxyHub.RemoveSource(c, name, providerID, account)
		if rerr != nil {
			return "", nil, rerr
		}
		notice := fmt.Sprintf("sources updated for %s", name)
		if removed && len(dropped) > 0 {
			notice = fmt.Sprintf("sources updated for %s (unpinned: %s)", name, strings.Join(dropped, ", "))
			return notice, dropped, nil
		}
		return notice, nil, nil
	}
	if account == "" {
		return "", nil, anyerr.Newf("source needs an account name", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	// Fail fast on typos: the foreign key would refuse the upsert
	// with a raw constraint error. Pool refs name a pool, not an
	// account, and validate through the pool lifecycle instead.
	if !strings.HasPrefix(account, "pool:") {
		acc, aerr := a.Accounts.Get(ctx, providerID, account)
		if aerr != nil {
			return "", nil, aerr
		}
		if acc == nil {
			return "", nil, anyerr.Newf(
				"Account "+providerID+"/"+account+" does not exist; nothing was attached.",
				"ACCOUNT_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound))
		}
	}
	existing.Sources = append(existing.Sources, hub.Source{ProviderID: providerID, Account: account})
	if _, uerr := a.ProxyHub.UpsertConfig(c, *existing); uerr != nil {
		return "", nil, uerr
	}
	return fmt.Sprintf("sources updated for %s", name), nil, nil
}

func cmdHubOwner(ctx context.Context, a *appView, usage func() int, fs *flag.FlagSet, rest []string) int {
	if err := fs.Parse(reorder(rest)); err != nil || fs.NArg() != 3 {
		return usage()
	}
	name, model, owner := fs.Arg(0), fs.Arg(1), fs.Arg(2)
	if globals.DryRun {
		// TS takes separate provider/account args; Go's owner is one ref.
		p, acct, _ := strings.Cut(owner, "/")
		printDryRunFields("proxy.hub.owner",
			fmt.Sprintf("Would route %s through %s/%s", model, p, acct),
			kv{Key: "model", Value: model}, kv{Key: "provider", Value: p},
			kv{Key: "account", Value: acct})
		return int(anyerr.Success)
	}
	err := lock.WithMutationLock(ctx, a.Root, refs.MutationScopeForRef(refs.ProxyHubRef(name)), func(c context.Context) error {
		return a.ProxyHub.SetModelOwner(c, name, model, owner)
	})
	if err != nil {
		return reportErr(err)
	}
	restarted := reloadHubChild(a, ctx, name)
	emitOK(fmt.Sprintf("model %s owned by %s", model, owner),
		kv{Key: "ok", Value: true},
		kv{Key: "hub", Value: name},
		kv{Key: "model", Value: model},
		kv{Key: "owner", Value: owner},
		kv{Key: "restarted", Value: restarted})
	if !globals.JSON && restarted {
		cliPrintf("hub %s restarted\n", name)
	}
	return int(anyerr.Success)
}
