import { AccountStore } from './store';
import { AccountService } from './service';
import { ProxyService } from './proxy-service';
import { ProviderRegistry, registry as defaultAccountRegistry } from './registry';
import { ProfileStore } from './profile-store';
import { ProfileService } from './profile-service';
import { ClientStateStore } from './client-state-store';
import { RuntimeService } from './runtime-service';
import { DoctorService } from './doctor';
import { GlobalConfigStore } from './config';
import { openDatabase, type HotplugDatabase } from './db';
import { migrateFilesystemIfNeeded } from './migrate-fs';
import {
  CatalogRegistry,
  catalogRegistry as defaultCatalog,
  registerBuiltinCatalog,
} from '../catalog/providers';
import {
  ClientRegistry,
  clientRegistry as defaultClients,
  registerBuiltinClients,
} from '../clients/index';
import { registerBuiltinProviders } from '../providers/index';
import { getHotplugRoot } from './paths';
import { join } from 'node:path';
import { logInternalError } from '../utils/log';
import {
  makeEmitter,
  InMemoryEventSink,
  DebugStderrEventSink,
  type HotplugEvent,
  type HotplugEventSink,
} from './events';
import { withFileLock } from '../utils/lock';
import { BindingStore } from './binding-store';
import { PresetStore } from './preset-store';
import { OperationJournal } from './journal';
import { LeaseStore } from './lease-store';
import { BindingService } from './binding-service';
import { migrateBindingsIfNeeded } from './migrate-bindings';
import { recoverIncompleteOperations } from './activation-executor';
import { reapStaleLeases } from './proxy-lifecycle';
import { PoolStore } from './pool-store';
import { runningTrayPid } from './tray-runtime';
import { PluginStore } from './plugin-store';
import { ModelCacheStore } from './model-cache-store';
import { ModelDiscoveryService } from './model-discovery';
import { modelPolicyLookup } from './model-policy';
import { PluginService } from './plugin-service';
import { loadPlugins, pluginsDisabledByEnv } from './plugin-loader';
import { PLUGIN_API_VERSION, type LoadedPlugin, type PluginLoadFailure } from '../types';

/**
 * The supported programmatic surface: services, registries, and lifecycle.
 *
 * Deliberately excludes the database and every raw store. Stores own SQL and
 * assume the coordinator locks held by the services above them (ADR 0009), so
 * an embedder that writes through a store directly bypasses both. Annotate
 * embedding code as `Hotplug` rather than `HotplugApp` and the compiler enforces
 * that for you.
 */
export interface Hotplug {
  root: string;
  accounts: AccountService;
  proxy: ProxyService;
  accountRegistry: ProviderRegistry;
  profiles: ProfileService;
  runtime: RuntimeService;
  clients: ClientRegistry;
  catalog: CatalogRegistry;
  doctor: DoctorService;
  bindingService: BindingService;
  /** Live vendor model lists, cached; falls back to the static catalog. */
  modelDiscovery: ModelDiscoveryService;
  plugins: PluginService;
  /**
   * Plugins that contributed to the registries above, and those that were
   * enabled but refused. Failures are surfaced (doctor, `plugin list`) rather
   * than thrown, so one bad extension cannot make Hotplug unusable.
   */
  pluginRuntime: {
    loaded: readonly LoadedPlugin[];
    failures: readonly PluginLoadFailure[];
  };
  /** Structured event sink + emitter for degraded/lifecycle conditions (OBS-01). */
  events: {
    sink: HotplugEventSink;
    emit: ReturnType<typeof makeEmitter>;
    /** Snapshot of framework lifecycle events, oldest first. */
    list: () => readonly HotplugEvent[];
  };
  /** Release framework-owned resources. Safe to call more than once. */
  close: () => void;
}

/**
 * The composition root, including the raw persistence layer.
 *
 * This is what `createApp` builds and what the CLI, TUI, and tray consume. It is
 * **not** a stability promise: members may be added, renamed, or removed as the
 * internal graph changes. Programmatic consumers should depend on `Hotplug`.
 */
export interface HotplugApp extends Hotplug {
  db: HotplugDatabase;
  accountStore: AccountStore;
  profileStore: ProfileStore;
  config: GlobalConfigStore;
  bindings: BindingStore;
  presets: PresetStore;
  journal: OperationJournal;
  leases: LeaseStore;
  pools: PoolStore;
  pluginStore: PluginStore;
  modelCacheStore: ModelCacheStore;
  /**
   * Raw event sink under the name `ExecutorDeps` expects. Callers that hand the
   * whole app to `executeActivation` therefore get structured events instead of
   * silently dropping them.
   */
  eventSink: HotplugEventSink;
}

export interface CreateAppOptions {
  root?: string;
  /** Skip registering builtins (tests). */
  bare?: boolean;
  /** Skip FS→SQLite migration. */
  skipMigrate?: boolean;
  accountRegistry?: ProviderRegistry;
  catalog?: CatalogRegistry;
  clients?: ClientRegistry;
  db?: HotplugDatabase;
  /** Injectable structured event sink (OBS-01). Defaults to an in-memory ring
   * plus a debug-stderr echo (behind HOTPLUG_DEBUG). */
  events?: HotplugEventSink;
  /**
   * Already-imported plugins to activate before the registries seal.
   *
   * `createApp` is synchronous, so `createAppReady` does the async discovery and
   * `import()` and passes the result down. A synchronous `activate` is what lets
   * plugin contributions land inside the same window as the builtins.
   */
  plugins?: LoadedPlugin[];
  /** Failures from that load pass, carried through for reporting. */
  pluginFailures?: PluginLoadFailure[];
}

/**
 * Run each plugin's `activate`, collecting any that throw as failures.
 *
 * A plugin that throws here is dropped, but everything it registered before
 * throwing is already in the registry. Registration is idempotent per id and
 * the adapters are inert until something resolves them, so a partial
 * contribution is reported rather than unwound — unwinding would mean removing
 * items from a registry, which is precisely the mutable-graph behavior sealing
 * exists to prevent.
 */
function activatePlugins(
  plugins: LoadedPlugin[],
  registries: {
    accountRegistry: ProviderRegistry;
    catalog: CatalogRegistry;
    clients: ClientRegistry;
  },
): { loaded: LoadedPlugin[]; failures: PluginLoadFailure[] } {
  const loaded: LoadedPlugin[] = [];
  const failures: PluginLoadFailure[] = [];
  for (const entry of plugins) {
    const checkpoints = {
      accountRegistry: registries.accountRegistry.checkpoint(),
      catalog: registries.catalog.checkpoint(),
      clients: registries.clients.checkpoint(),
    };
    try {
      entry.plugin.activate({
        apiVersion: PLUGIN_API_VERSION,
        pluginRoot: entry.record.path,
        registerProvider: (p) => registries.accountRegistry.register(p),
        registerClient: (c) => registries.clients.register(c),
        registerCatalogProvider: (p) => registries.catalog.register(p),
      });
      loaded.push(entry);
    } catch (err) {
      // Registration is atomic per plugin. A plugin may throw after registering
      // one adapter; leaving that adapter active would make startup depend on a
      // failed, unreviewed partial setup.
      registries.accountRegistry.restore(checkpoints.accountRegistry);
      registries.catalog.restore(checkpoints.catalog);
      registries.clients.restore(checkpoints.clients);
      failures.push({
        name: entry.record.name,
        path: entry.record.path,
        reason: err instanceof Error ? err.message : String(err),
        untrusted: false,
      });
    }
  }
  return { loaded, failures };
}

/**
 * Wire stores, registries, and services for CLI or tests.
 * All structured data shares one SQLite database under ~/.hotplug/hotplug.db.
 */
export function createApp(opts: CreateAppOptions = {}): HotplugApp {
  const root = getHotplugRoot(opts.root);
  const db = opts.db ?? openDatabase(root);
  const ownsDatabase = !opts.db;

  const accountRegistry = opts.accountRegistry ?? new ProviderRegistry();
  const catalog = opts.catalog ?? new CatalogRegistry();
  const clients = opts.clients ?? new ClientRegistry();

  if (!opts.bare) {
    if (!opts.accountRegistry) {
      registerBuiltinProviders(accountRegistry);
    }
    if (!opts.catalog) {
      registerBuiltinCatalog(catalog);
    }
    if (!opts.clients) {
      registerBuiltinClients(clients);
    }
  }

  // Plugins extend the same three registries the builtins use, and must land
  // inside the same window: after builtins (so a plugin cannot shadow a builtin
  // id) and before sealing.
  const pluginRuntime = activatePlugins(opts.plugins ?? [], {
    accountRegistry,
    catalog,
    clients,
  });
  const pluginFailures = [...(opts.pluginFailures ?? []), ...pluginRuntime.failures];

  // Extension registration is a startup concern. Freezing registries prevents
  // a long-lived process from resolving a different provider/client graph half
  // way through an activation. Consumers register extensions before creating
  // the app, which also keeps tests and embedding deterministic.
  accountRegistry.seal();
  catalog.seal();
  clients.seal();

  const accountStore = new AccountStore(root, db);
  const pools = new PoolStore(root, db);
  const profileStore = new ProfileStore(root, db);
  const profiles = new ProfileService(profileStore, catalog);
  const clientState = new ClientStateStore(root, db);
  const config = new GlobalConfigStore(root, db);
  const runtime = new RuntimeService(
    profileStore,
    clientState,
    clients,
    config,
    root,
    accountRegistry,
  );
  const bindings = new BindingStore(db);
  const presets = new PresetStore(db);
  const journal = new OperationJournal(db);
  const leases = new LeaseStore(db);
  const pluginStore = new PluginStore(db);
  const plugins = new PluginService(pluginStore, root);
  const modelCacheStore = new ModelCacheStore(root, db);
  const modelDiscovery = new ModelDiscoveryService({
    root,
    cache: modelCacheStore,
    policyFor: modelPolicyLookup({ accountRegistry, catalog }),
  });

  // The lease store is constructed before the proxy service so it can be a real
  // constructor dependency: proxies started outside the activation pipeline
  // (e.g. `hotplug proxy start`) record leases and are reaped on restart.
  const proxy = new ProxyService(
    accountStore,
    accountRegistry,
    pools,
    { bindings, runtime, clientState },
    leases,
  );
  const accounts = new AccountService(accountStore, accountRegistry, proxy);

  const eventSink: HotplugEventSink = opts.events ?? new InMemoryEventSink();
  const eventLog = eventSink instanceof InMemoryEventSink ? eventSink : undefined;
  let closed = false;
  const emit = makeEmitter(
    // Default behavior: in-memory ring + debug-stderr echo (no-op unless HOTPLUG_DEBUG).
    new (class extends DebugStderrEventSink {
      emit(e: Parameters<HotplugEventSink['emit']>[0]): void {
        super.emit(e);
        eventSink.emit(e);
      }
    })(),
  );

  const doctor = new DoctorService({
    accounts,
    proxy,
    profiles,
    runtime,
    catalog,
    clients,
    root,
    bindings,
    leases,
    journal,
    accountStore,
    plugins: {
      installed: () => pluginStore.list(),
      loadedNames: pluginRuntime.loaded.map((l) => l.record.name),
      failures: pluginFailures,
    },
  });

  const resolveDeps = {
    accounts,
    proxy,
    accountRegistry,
    profiles,
    profileStore,
    bindings,
    presets,
    catalog,
    clients,
    pools,
    journal,
    leases,
    runtime,
    eventSink,
  };

  const bindingService = new BindingService(resolveDeps);

  const app: HotplugApp = {
    root,
    db,
    accounts,
    proxy,
    accountStore,
    accountRegistry,
    profiles,
    profileStore,
    runtime,
    clients,
    catalog,
    doctor,
    config,
    bindings,
    presets,
    journal,
    leases,
    bindingService,
    modelDiscovery,
    pools,
    plugins,
    pluginStore,
    modelCacheStore,
    pluginRuntime: {
      loaded: pluginRuntime.loaded,
      failures: pluginFailures,
    },
    eventSink,
    events: {
      sink: eventSink,
      emit,
      list: () => eventLog?.list() ?? [],
    },
    close: (): void => {
      if (closed) {
        return;
      }
      closed = true;
      for (const entry of [...pluginRuntime.loaded].reverse()) {
        try {
          entry.plugin.dispose?.();
        } catch (err) {
          emit('warn', 'plugin_dispose_failed', `Plugin ${entry.record.name} failed to dispose`, {
            resourceIds: [`plugin/${entry.record.name}`],
            context: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      if (ownsDatabase) {
        db.close();
      }
    },
  };

  return app;
}

/**
 * Create app and run one-time filesystem → SQLite migration if needed.
 *
 * The migration and config-ensure run under a process-scoped file lock so two
 * concurrent `hotplug` invocations (e.g. a CLI call while the TUI is open) cannot
 * race the schema bootstrap. The lock is best-effort: a contended lock fails
 * fast rather than blocking the user.
 */
export async function createAppReady(opts: CreateAppOptions = {}): Promise<HotplugApp> {
  const root = getHotplugRoot(opts.root);
  let app: HotplugApp | undefined;
  const ownsDatabase = !opts.db;

  try {
    // `openDatabase()` runs schema migration. It must therefore be inside the
    // same lock as the legacy filesystem import and initial config bootstrap;
    // constructing the app first used to race before this lock was acquired.
    await withFileLock(join(root, '.migrate.lock'), async () => {
      const db = opts.db ?? openDatabase(root);
      // Plugins must be imported before `createApp`, which seals the registries
      // the moment it returns. `bare` builds (tests) skip this so a stray
      // installed plugin cannot leak into an isolated fixture.
      const pluginLoad =
        opts.bare || opts.plugins || pluginsDisabledByEnv()
          ? undefined
          : await loadPlugins(new PluginStore(db).list());
      app = createApp({
        ...opts,
        root,
        db,
        plugins: opts.plugins ?? pluginLoad?.loaded,
        pluginFailures: opts.pluginFailures ?? pluginLoad?.failures,
      });
      if (!opts.skipMigrate) {
        await migrateFilesystemIfNeeded(app.db, root);
        await app.config.ensure();
        await migrateBindingsIfNeeded(app);
      } else {
        await app.config.ensure();
      }
    });
  } catch (err) {
    if (app && ownsDatabase) {
      app.db.close();
    }
    throw err;
  }
  if (!app) {
    throw new Error('Hotplug app initialization did not complete');
  }
  // A refused plugin is a degraded condition, not a crash: report it as an
  // event so `doctor` can show it even when the user never runs `plugin list`.
  for (const failure of app.pluginRuntime.failures) {
    app.events.emit('warn', 'plugin_load_failed', `Plugin ${failure.name} was not loaded`, {
      resourceIds: [`plugin/${failure.name}`],
      context: { reason: failure.reason, untrusted: failure.untrusted },
    });
  }

  // Best-effort journal recovery on startup (re-resolves adapters from ResourceRefs).
  // A failure here means a partial/crashed operation could not be rolled back
  // automatically — log it (HOTPLUG_DEBUG) rather than discarding, since silent
  // inconsistency is the exact condition this tool must not hide.
  try {
    await recoverIncompleteOperations({
      journal: app.journal,
      events: app.events.sink,
      resolve: {
        accounts: app.accounts,
        proxy: app.proxy,
        accountRegistry: app.accountRegistry,
        profiles: app.profiles,
        profileStore: app.profileStore,
        bindings: app.bindings,
        presets: app.presets,
        catalog: app.catalog,
        clients: app.clients,
      },
    });
  } catch (err) {
    logInternalError('startup journal recovery', err);
    app.events.emit('error', 'startup_recovery_failed', 'Automatic journal recovery failed', {
      context: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Reap detached proxy processes whose owning CLI/TUI session has exited,
  // so stale leases do not hold ports across sessions.
  try {
    // A live menu-bar supervisor is the lifecycle owner. CLI invocations must
    // not reap its children while it is keeping local client endpoints alive.
    if ((await runningTrayPid(root)) == null) {
      await reapStaleLeases({ proxy: app.proxy, leases: app.leases, pools: app.pools });
    }
  } catch (err) {
    logInternalError('startup lease reap', err);
    app.events.emit('error', 'startup_lease_reap_failed', 'Stale proxy lease reaping failed', {
      context: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  return app;
}

/** Default process-wide app used by CLI entry. */
let defaultApp: HotplugApp | null = null;

export function getDefaultApp(): HotplugApp {
  if (!defaultApp) {
    registerBuiltinProviders(defaultAccountRegistry);
    registerBuiltinCatalog(defaultCatalog);
    registerBuiltinClients(defaultClients);
    defaultApp = createApp({
      accountRegistry: defaultAccountRegistry,
      catalog: defaultCatalog,
      clients: defaultClients,
    });
  }
  return defaultApp;
}
