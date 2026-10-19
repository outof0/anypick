// Package app is the Go composition root. It builds the full service graph, runs
// the one-time bootstrap under `.migrate.lock`, performs startup journal
// recovery and stale lease reaping, and exposes an idempotent Close.
package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/desktop"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/journal"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/ownership"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/plugins"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/presets"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/pubgate"
	"github.com/outof0/anypick/go/internal/runtime"
	"github.com/outof0/anypick/go/internal/store"
)

// App is the composed service graph. Command handlers stay thin; every
// behavior lives on a service.
type App struct {
	Root string
	// Home is the client home (~) every builtin provider and client was
	// registered with. Tests set it to a temp dir so live reads (DetectLive,
	// Backup, Inspect) can never reach the developer's real credentials.
	Home      string
	DB        *db.DB
	Store     *store.AccountStore
	Providers *provider.Registry
	Clients   *client.Registry
	Accounts  *accounts.Service
	// Inspections owns the desktop backup-import staged review. It uses the
	// Accounts service for inspection and restore so desktop import shares the
	// same API as the CLI and TUI.
	Inspections *desktop.InspectionManager
	Deps        *activation.Deps
	Proxy       *proxy.Service
	Runtime     *runtimeView
	// PoolSvc is the service boundary outer layers talk to; the raw store
	// stays inside internal/pools. The name is a naming convention the facade
	// gate does not require: that gate forbids reconstructed selector chains
	// ending in one of ten literal tails (see facade_test.go), and these names
	// happen to avoid all ten. Renaming a field to dodge a tail is not what
	// keeps the coupling out.
	PoolSvc *pools.Service
	Hub     *hub.Store
	// ProxyHub is what outer layers should use. Hub stays for a few engine
	// paths that still need the table-owning store (e2e route snapshot helpers).
	ProxyHub *hub.Service
	Journal  *journal.OperationJournal
	// PresetSvc is the service boundary outer layers talk to; the raw store
	// stays inside internal/presets.
	PresetSvc *presets.Service
	// BindingSvc is the service boundary outer layers talk to; the raw store
	// stays inside internal/bindings.
	BindingSvc *bindings.Service
	// CodexProfileSvc stores named native route profiles; it is separate from
	// the one active global binding exposed by BindingSvc.
	CodexProfileSvc *client.ProfileService
	Config          *config.ConfigService
	ConfigStore     *config.Store
	Plugins         *plugins.Service
	PluginStore     *plugins.Store
	// PluginRuntime contains digest-verified candidates and non-fatal package
	// failures. Nothing is activated: this build has no plugin host (ADR 0020
	// §5), so every candidate degrades to a LoadFailure. See plugin_host.go.
	PluginRuntime plugins.Runtime
	// pluginSup holds the diagnostics surface that replaced the supervised
	// host: startup failures and the inert health/identity view.
	pluginSup *pluginSupervisor

	closeOnce closeGuard
}

// runtimeView groups the runtime-facing stores the CLI needs (profiles,
// presets, catalog). Kept unexported-typed to avoid widening the surface.
type runtimeView struct {
	Root    string
	Home    string
	Clients *client.Registry
	// ProfileSvc is the service boundary outer layers talk to; the raw store
	// stays inside internal/profile.
	ProfileSvc *profile.Service
	Catalog    *catalog.Index
}

// Options configures the composition root.
type Options struct {
	// Root overrides the data root; empty resolves to ANYPICK_HOME/~/.anypick.
	Root string
	// Home overrides the client home (~) used for live credential and
	// client-config paths; empty resolves to the real user home, exactly as
	// before. Tests set it to a temp dir to isolate live reads.
	Home string
	// SkipMigrate skips filesystem migration + binding migration but still
	// ensures bootstrap state (used by isolated tests).
	SkipMigrate bool
	// Bare skips plugin activation entirely (fixture isolation).
	Bare bool
	// SkipMaintenance suppresses startup journal recovery + stale lease
	// reaping. Required for short-lived helper processes (detached proxy /
	// hub / pool children): they boot while the spawning parent still holds
	// its mutation lock and must never race an in-flight activation.
	SkipMaintenance bool
}

// New composes the graph without running bootstrap. Most callers want Ready.
//
// New binds the real user home and is the production entry point. Tests that
// need a live read must go through Ready with Options.Home: New has no seam to
// pass one, so a test using it would resolve adapters against the developer's
// own ~/.claude, ~/.codex and ~/.gemini.
func New(root string) (*App, error) {
	return newWithHome(root, "")
}

func newWithHome(root, home string) (*App, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, anyerr.Wrapf(err, "create data root", "FS_PATH")
	}
	database, err := db.Open(root)
	if err != nil {
		return nil, err
	}
	a := &App{Root: root, Home: homeDir(home), DB: database}
	if err := a.compose(); err != nil {
		_ = database.Close()
		return nil, err
	}
	return a, nil
}

func (a *App) compose() error {
	// ADR-0025: production binaries write the Antigravity OS credential
	// mirror; go test keeps the provider package's no-op default so a
	// forgotten per-package guard cannot reach the developer's Keychain.
	if !testing.Testing() {
		provider.EnableAntigravityKeyringWrites()
	}

	st := store.New(a.Root, a.DB)
	a.Store = st

	gate := pubgate.New()
	provReg := provider.NewRegistry()
	provReg.SetGate(gate)
	if err := provider.RegisterBuiltin(provReg, a.Home); err != nil {
		return err
	}
	if err := provider.RegisterBuiltinCompatibles(provReg, a.Home); err != nil {
		return err
	}
	clientReg := client.NewRegistry()
	clientReg.SetGate(gate)
	if err := client.RegisterBuiltin(clientReg, a.Home, a.Root); err != nil {
		return err
	}
	clientProfileStore := &client.ProfileStore{Root: a.Root, DB: a.DB.DB}

	svc := accounts.New(st, provReg)
	leases := &proxy.LeaseStore{Root: a.Root, DB: a.DB.DB}
	px := proxy.New(st, leases)
	svc.Proxy = px

	poolsStore := &pools.Store{Root: a.Root, DB: a.DB.DB}
	presetsStore := &presets.Store{Root: a.Root, DB: a.DB.DB}
	profileStore := &profile.Store{Root: a.Root, DB: a.DB.DB}
	bindingsStore := &bindings.Store{Root: a.Root, DB: a.DB.DB}
	hubStore := &hub.Store{DB: a.DB.DB, Root: a.Root}
	jrnl := &journal.OperationJournal{DB: a.DB.DB}

	cfgStore := config.NewStore(a.Root, a.DB)
	a.ConfigStore = cfgStore
	a.Config = config.NewService(cfgStore)
	pluginStore := &plugins.Store{DB: a.DB.DB}
	a.PluginStore = pluginStore
	a.Plugins = plugins.NewService(pluginStore, a.Root, "")

	catalogRegistry := catalog.NewIndex(catalog.Builtin())
	catalogRegistry.SetGate(gate)
	depCatalog := activation.NewCatalogIndex(catalogEntriesFrom(catalog.Builtin()))
	depCatalog.SetGate(gate)
	rt := &runtime.Service{
		Root:     a.Root,
		Home:     a.Home,
		Clients:  clientReg,
		Profiles: profileStore,
		Catalog:  catalogRegistry,
	}
	presetSvc := presets.NewService(presetsStore)
	bindingSvc := bindings.NewService(bindingsStore)
	profileSvc := profile.NewService(profileStore)
	poolSvc := pools.NewService(poolsStore)
	hubSvc := hub.NewService(hubStore)
	deps := &activation.Deps{
		Root:           a.Root,
		Accounts:       activation.NewAccountsView(svc),
		Providers:      provReg,
		Clients:        clientReg,
		ClientProfiles: clientProfileStore,
		Bindings:       bindingSvc,
		Presets:        activation.NewPresetsView(presetSvc),
		Profiles:       profileSvc,
		Pools:          activation.NewPoolsView(poolSvc),
		Journal:        jrnl,
		Runtime:        rt,
		Proxy:          px,
		Catalog:        depCatalog,
		Hub:            hubSvc,
		SpawnHubChild: func(hubName string) (int, error) {
			selfExe, exeErr := selfExecutable()
			if exeErr != nil {
				return 0, exeErr
			}
			hubDir := filepath.Join(a.Root, "runtime", "hub", hubName)
			pidFile := filepath.Join(hubDir, "service.pid")
			// Lifecycle ownership (ADR 0003): adopt an existing child only when a
			// TRUSTED record verifies the live process; legacy numeric or stale
			// records are removed and a fresh, instance-stamped child is spawned.
			if rec := ownership.Load(pidFile); rec != nil && rec.VerifyLive() {
				// Liveness is not freshness: an adopted child may serve a
				// config from before the last mutation (ADR-0030). Restart it
				// when its revision trails the stored one; adopt it otherwise.
				endpoint, revision := "", 0
				if cfg, cerr := hubStore.GetConfigContext(context.Background(), hubName); cerr != nil {
					return 0, cerr
				} else if cfg != nil && cfg.Port != 0 {
					endpoint = fmt.Sprintf("http://127.0.0.1:%d", cfg.Port)
					revision = cfg.Revision
				}
				if restarted, rerr := hub.RestartStaleChild(a.Root, hubName, endpoint, revision, 3*time.Second); rerr != nil {
					return 0, rerr
				} else if !restarted {
					return rec.PID, nil
				}
				// Fall through: spawn fresh below.
			}
			rec, err := ownership.Spawn(selfExe, []string{"_serve-hub", hubName}, pidFile,
				filepath.Join(hubDir, "service.log"), "ANYPICK_HUB_CHILD=1")
			if err != nil {
				return 0, err
			}
			return rec.PID, nil
		},
	}
	px.Resolver = &snapshotUpstreamResolver{store: st, providers: provReg, profiles: rt.Profiles}
	px.Pools = poolsStore
	px.DefaultPort = func(providerID string) int {
		pv, err := provReg.Get(providerID)
		if err != nil {
			return 0
		}
		if dp, ok := pv.(provider.DefaultProxyPorter); ok {
			return dp.DefaultProxyPort()
		}
		return 0
	}
	px.QuotaGuardPolicy = func(ctx context.Context) config.QuotaGuardPolicy {
		cfg, err := a.Config.Read(ctx)
		if err != nil {
			return config.QuotaGuardPolicy{ServeWhenAllCooling: true}
		}
		return config.QuotaGuardPolicyOf(cfg)
	}
	px.PoolSpawner = func(providerID string) (int, error) {
		selfExe, exeErr := selfExecutable()
		if exeErr != nil {
			return 0, exeErr
		}
		// The detached `_serve-pool` child runs under the SAME structured
		// ownership record the CLI's `pool stop` verifies
		// (runtime/pools/<provider>/service.pid, ADR 0003). A live trusted record
		// means the previous child survived the pre-stop — fail closed rather
		// than port-collide; a crashed child leaves a stale record that the fresh
		// spawn overwrites. Identity is proven at /health via the instance echo,
		// never the PID.
		poolDir := filepath.Join(a.Root, "runtime", "pools", providerID)
		pidFile := filepath.Join(poolDir, "service.pid")
		if rec := ownership.Load(pidFile); rec != nil && rec.VerifyLive() {
			return 0, anyerr.Newf(
				"existing pool child for "+providerID+" is still running",
				"PROXY_START_FAILED")
		}
		rec, err := ownership.Spawn(selfExe, []string{"_serve-pool", providerID}, pidFile,
			filepath.Join(poolDir, "service.log"), "ANYPICK_POOL_CHILD=1")
		if err != nil {
			return 0, err
		}
		return rec.PID, nil
	}
	if selfExe, exeErr := selfExecutable(); exeErr == nil {
		px.Spawner = proxy.ExecSpawner(selfExe)
	}

	a.Providers = provReg
	a.Clients = clientReg
	a.Accounts = svc
	a.Inspections = desktop.NewInspectionManager(svc)
	a.Proxy = px
	a.PoolSvc = poolSvc
	a.Hub = hubStore
	a.ProxyHub = hubSvc
	a.Journal = jrnl
	a.PresetSvc = presetSvc
	a.BindingSvc = bindingSvc
	a.CodexProfileSvc = client.NewProfileService(clientProfileStore)
	svc.SetAfterSwitch(a.BindingSvc.RealignNativeClientBinding)
	svc.SetAfterSnapshotChange(a.refreshCodexProfilesForAccount)
	// Deleting an account must take its named native profiles with it: a Codex
	// profile whose route is codex/<name> owns a private CODEX_HOME holding
	// that account's credential, and nothing else can reach it once the row is
	// gone (activation.AccountProfileRemovals).
	svc.SetBeforeDelete(func(ctx context.Context, providerID, accountName string) ([]string, error) {
		return a.removeAccountProfiles(ctx, providerID, accountName)
	})
	a.Runtime = &runtimeView{
		Root: a.Root, Home: a.Home, Clients: clientReg,
		ProfileSvc: profileSvc, Catalog: catalogRegistry,
	}
	a.Deps = deps
	a.pluginSup = newPluginSupervisor(a)
	return nil
}

// Ready runs the startup lifecycle:
//
//	.migrate.lock → legacy root migration → schema migration →
//	config/binding bootstrap → startup journal recovery → stale lease reap.
//
// The lock is best-effort: contention fails fast instead of blocking.
func Ready(ctx context.Context, opts Options) (_ *App, closeFn func(), err error) {
	root := paths.Root(opts.Root)
	lockPath := filepath.Join(root, ".migrate.lock")
	// The lock guards ONLY the bootstrap section below:
	// it must be released before command execution so short-lived helpers
	// (detached proxy children) can boot while the parent keeps running.
	fl, lockErr := lock.AcquireFileLock(lockPath, 0)
	if lockErr != nil {
		return nil, nil, anyerr.Wrapf(lockErr, "acquire .migrate.lock", "OPERATIONAL")
	}
	releaseLock := func() { _ = fl.Release() }
	bootstrapDone := false
	defer func() {
		if !bootstrapDone {
			releaseLock()
		}
	}()

	a, err := newWithHome(root, opts.Home)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		if err != nil {
			a.Close()
		}
	}()

	if !opts.Bare && !plugins.DisabledByEnv() {
		pluginRuntime, pluginErr := a.Plugins.Inspect(ctx)
		if pluginErr != nil {
			return nil, nil, anyerr.Wrapf(pluginErr, "inspect plugin registry", "DB_READ")
		}
		a.PluginRuntime = a.activatePlugins(ctx, pluginRuntime)
	} else {
		a.PluginRuntime = plugins.Runtime{
			Candidates: []plugins.Candidate{}, Loaded: []plugins.LoadedPlugin{},
			Failures: []plugins.LoadFailure{},
		}
	}
	// Registries are immutable once startup begins resolving adapters. Plugin
	// activation is the final registration window, so long-lived services can never
	// observe a graph that changes under
	// an in-flight operation.
	a.Providers.Seal()
	a.Clients.Seal()

	if !opts.SkipMigrate {
		// No mid-flight filesystem→SQLite or binding migrations exist here;
		// fresh Go roots start at baseline.
		// Config bootstrap lands with the config service milestone.
		_ = ensureBootstrapState(ctx, a)
	}

	if !opts.SkipMaintenance {
		runStartupMaintenance(ctx, a, root)
	}

	releaseLock()
	bootstrapDone = true
	closer := func() {
		a.Close()
	}
	return a, closer, nil
}

// RunStartupMaintenance rolls back operations a previous run left mid-flight
// and reaps detached proxy children nobody owns. Ready calls it unless
// SkipMaintenance is set. The bare no-TTY path opens the database first so it
// can read ui.defaultSurface, then calls this only when that surface is not
// the terminal UI. A configured tui with no terminal must not reap proxies
// the desktop app is using.
func RunStartupMaintenance(ctx context.Context, a *App) {
	if a == nil {
		return
	}
	runStartupMaintenance(ctx, a, a.Root)
}

// runStartupMaintenance rolls back operations a previous run left mid-flight and
// reaps detached proxy children nobody owns. Both are best-effort: a failure
// here must not stop AnyPick from starting, but it must not be silent either —
// "recovery could not roll this back" and "there was nothing to roll back"
// used to look identical to the user.
func runStartupMaintenance(ctx context.Context, a *App, root string) {
	if a.Deps != nil {
		recovered, err := activation.RecoverIncompleteOperations(ctx, a.Deps)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[anypick] startup journal recovery failed: %v\n", err)
		}
		if recovered != nil && len(recovered.Failed) > 0 {
			fmt.Fprintf(os.Stderr,
				"[anypick] %d incomplete operation(s) could not be rolled back: %v\n"+
					"[anypick] run `anypick doctor` before retrying them.\n",
				len(recovered.Failed), recovered.Failed)
		}
	}
	// Named profiles whose account is gone are swept before anything else
	// reads them: a Codex profile still pointing at a deleted account keeps
	// that account's credential in a private CODEX_HOME, and every later
	// activation of the profile would fail on the missing source anyway.
	cleanOrphanedProfilesAtStartup(ctx, a)
	// Detached proxy children are reaped only when no live supervisor owns them.
	if RunningTrayPid(root) != nil {
		return
	}
	if _, err := a.Proxy.ReapStaleContext(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "[anypick] stale lease reaping failed: %v\n", err)
	}
}

// removeAccountProfiles is the accounts.Service.BeforeDelete cascade. It runs
// inside the deletion's own mutation lock and scope (provider/<id>), so a
// failure here means the account survives and the caller can retry.
func (a *App) removeAccountProfiles(ctx context.Context, providerID, accountName string) ([]string, error) {
	if a.Deps == nil {
		return nil, nil
	}
	removals, err := activation.AccountProfileRemovals(ctx, a.Deps, providerID, accountName)
	if err != nil {
		return nil, err
	}
	if err := activation.RemoveNamedProfiles(ctx, removals, a.Deps, nil); err != nil {
		return nil, err
	}
	return activation.ProfileRemovalLabels(removals), nil
}

// cleanOrphanedProfilesAtStartup reports named profiles whose account no
// longer exists. It deliberately REMOVES NOTHING: the sweep runs unattended on
// every CLI invocation, its old shape deleted whole credential homes (sessions,
// history, plugins) the moment a DB lacked the account rows, and a repair that
// destructive belongs behind `doctor --fix` where the user consents to a plan.
// `anypick doctor` names every orphan and offers the removal.
func cleanOrphanedProfilesAtStartup(ctx context.Context, a *App) {
	if a.Deps == nil {
		return
	}
	orphans, err := activation.OrphanedAccountProfiles(ctx, a.Deps)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[anypick] orphaned profile check incomplete: %v\n", err)
	}
	if len(orphans) > 0 {
		fmt.Fprintf(os.Stderr,
			"[anypick] %d named profile(s) reference accounts that no longer exist: %s\n"+
				"[anypick] run `anypick doctor --fix` to review and remove them.\n",
			len(orphans), strings.Join(activation.ProfileRemovalLabels(orphans), ", "))
	}
}

// Close disposes the app idempotently. The plugin supervisor closes first:
// it wins every recovery race by refusing spawns and draining any in-flight
// restart before the process tree is torn down.
func (a *App) Close() {
	a.closeOnce.Do(func() {
		if a.pluginSup != nil {
			a.pluginSup.Close()
		}
		if a.Proxy != nil {
			a.Proxy.Close()
		}
		if a.DB != nil {
			_ = a.DB.Close()
		}
	})
}

// selfExecutable resolves the running binary; ANYPICK_SELF_EXE lets tests
// point detached-child spawns at a real built CLI.
func selfExecutable() (string, error) {
	if p := os.Getenv("ANYPICK_SELF_EXE"); p != "" {
		return p, nil
	}
	return os.Executable()
}

func homeDir(override string) string {
	if override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	return home
}
