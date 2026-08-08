import { readFile } from 'node:fs/promises';
import type {
  ClientId,
  Protocol,
  ProxyHubConfig,
  ProxyHubModelOwner,
  ProxyHubRouteManifest,
  ProxyHubSource,
  ProxyHubSourceRef,
  ProxyHubStatus,
} from '../types';
import {
  assignDesktopAliases,
  expandHubRoutesWithDesktopAliases,
  loadNativeListSlots,
  orderHubModelsForDesktop,
} from '../clients/codex-desktop-catalog';
import { accountAdapterFor, poolAdapterFor } from '../sources/account-adapters';
import { assertLoopbackHost } from '../utils/network';
import { anypickError, ExitCode } from '../utils/errors';
import { withMutationLocks } from './mutation-lock';
import { displayRef, providerScope, serializeRef } from './refs';
import { ProxyHubBackendRegistry, type ProxyHubServerDeps } from './proxy-hub-server';
import { compileProxyHubRoutes, type CompiledProxyHubRoutes } from './proxy-hub-routes';
import { DEFAULT_PROXY_HUB, ProxyHubStore, type ProxyHubRouteSecret } from './proxy-hub-store';
import { proxyHubLogPath, proxyHubPidPath } from './paths';
import { pathExists } from '../utils/fs';
import {
  isListenPortFree,
  isProcessRunning,
  listenPidsOnPort,
  readPidRecord,
  spawnDetached,
  stopPidFile,
  waitForHttp,
  writePidRecord,
} from '../utils/process';
import { resolveAnyPickCliLaunch } from '../providers/opencode-cli-entry';

export interface ProxyHubCatalogSnapshot {
  source: ProxyHubSourceRef;
  catalogId: string;
  models: string[];
}

export interface ProxyHubPreview extends CompiledProxyHubRoutes {
  config: ProxyHubConfig;
  catalogs: ProxyHubCatalogSnapshot[];
  unavailable: Array<{ source: ProxyHubSourceRef; reason: string }>;
}

/**
 * Owns Hub configuration and route attachment. The server owns no persisted
 * mutation: it reads these versioned, token-scoped manifests at its boundary.
 */
export class ProxyHubService {
  private readonly previewCache = new Map<
    string,
    { revision: number; expiresAt: number; value: ProxyHubPreview }
  >();
  private readonly previewPending = new Map<string, Promise<ProxyHubPreview>>();

  constructor(
    private readonly root: string,
    private readonly store: ProxyHubStore,
    private readonly deps: ProxyHubServerDeps,
  ) {}

  /**
   * Optional re-publisher for the live Codex config block, wired in app.ts so this
   * service does not depend on Codex/Proxy services it was not constructed with.
   */
  private codexLiveConfigSync?: () => Promise<void>;

  setCodexLiveConfigSync(fn: () => Promise<void>): void {
    this.codexLiveConfigSync = fn;
  }

  private async syncCodexLiveConfig(): Promise<void> {
    try {
      await this.codexLiveConfigSync?.();
    } catch {
      // Best-effort: a failed live-block refresh must never fail a Hub op.
    }
  }

  async get(name = DEFAULT_PROXY_HUB): Promise<ProxyHubConfig> {
    return this.store.getOrDefault(name);
  }

  async save(
    config: Omit<ProxyHubConfig, 'revision' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<ProxyHubConfig, 'revision' | 'createdAt' | 'updatedAt'>>,
  ): Promise<ProxyHubConfig> {
    assertLoopbackHost(config.host);
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw anypickError('Proxy Hub port must be between 1 and 65535.', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    const uniqueSources = dedupeSources(config.sources);
    // Enabled sources must still resolve; disabled rows are config-only.
    // Deleted accounts are pruned on account delete via forgetAccount — they
    // should not linger as enabled hub sources.
    await this.validateSources(uniqueSources.filter((source) => source.enabled));
    const scopes = [
      `proxy/hub/${config.name}`,
      ...uniqueSources.map((source) => providerScope(source.ref.provider)),
    ];
    return withMutationLocks(this.root, scopes, async () => {
      const saved = this.store.save({
        ...this.store.getOrDefault(config.name),
        ...config,
        sources: uniqueSources,
        modelOwners: validOwners(config.modelOwners, uniqueSources),
      });
      this.previewCache.delete(config.name);
      return saved;
    });
  }

  async setSources(name: string, sources: ProxyHubSource[]): Promise<ProxyHubConfig> {
    const config = await this.get(name);
    return this.save({ ...config, sources });
  }

  /**
   * Drop a deleted saved account from Hub sources and model owners.
   * AccountService calls this after the account row is gone so a removed
   * login cannot keep blocking attach or linger in Hub Sources.
   */
  async forgetAccount(
    providerId: string,
    accountName: string,
    name = DEFAULT_PROXY_HUB,
  ): Promise<void> {
    const config = await this.get(name);
    const matches = (ref: { kind: string; provider?: string; name?: string }) =>
      ref.kind === 'account' && ref.provider === providerId && ref.name === accountName;
    const sources = config.sources.filter((source) => !matches(source.ref));
    const modelOwners = config.modelOwners.filter((owner) => !matches(owner.source));
    if (
      sources.length === config.sources.length &&
      modelOwners.length === config.modelOwners.length
    ) {
      return;
    }
    await this.save({ ...config, sources, modelOwners });
  }

  async setModelOwner(
    name: string,
    model: string,
    source: ProxyHubSourceRef | undefined,
  ): Promise<ProxyHubConfig> {
    return this.setModelOwners(name, [model], source);
  }

  /**
   * Persist one explicit source choice for a set of colliding raw model ids.
   * Discovery and the single config write share the Hub/provider lock set, so
   * a stale Tray action can never assign a model to a source that stopped
   * advertising it while the action was in flight.
   */
  async setModelOwners(
    name: string,
    models: readonly string[],
    source: ProxyHubSourceRef | undefined,
  ): Promise<ProxyHubConfig> {
    const normalized = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    if (normalized.length === 0) {
      throw anypickError('At least one model id is required.', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }

    return this.withStableConfig(name, async (config) => {
      if (source) {
        const sourceId = serializeRef(source);
        if (
          !config.sources.some((entry) => entry.enabled && serializeRef(entry.ref) === sourceId)
        ) {
          throw invalidModelOwner(normalized, source, 'is not an enabled Hub source');
        }

        // Compile candidate identity from the fresh catalogs, not from a label
        // or action payload supplied by the Tray helper.
        const preview = await this.previewWithConfig(config);
        for (const model of normalized) {
          const candidates = modelCandidates(preview, model);
          if (
            candidates.length < 2 ||
            !candidates.some((candidate) => serializeRef(candidate) === sourceId)
          ) {
            throw invalidModelOwner(
              [model],
              source,
              'is no longer a candidate for that model conflict',
            );
          }
        }
      }

      const replaced = new Set(normalized);
      const owners = config.modelOwners.filter((owner) => !replaced.has(owner.model));
      if (source) {
        owners.push(...normalized.map((model) => ({ model, source })));
      }
      return this.save({ ...config, modelOwners: owners });
    });
  }

  /** Refresh source catalogs through provider-owned in-process backends. */
  async preview(name = DEFAULT_PROXY_HUB): Promise<ProxyHubPreview> {
    return this.loadPreview(name, false);
  }

  /** Force provider-owned catalog discovery instead of accepting the 10 s preview cache. */
  async refreshPreview(name = DEFAULT_PROXY_HUB): Promise<ProxyHubPreview> {
    return this.loadPreview(name, true);
  }

  private async loadPreview(name: string, force: boolean): Promise<ProxyHubPreview> {
    const config = await this.get(name);
    if (!force) {
      const cached = this.cachedPreview(config);
      if (cached) {
        return cached;
      }
    }
    const pending = this.previewPending.get(name);
    if (pending) {
      try {
        const result = await pending;
        if (!force) {
          return result;
        }
      } catch (error) {
        if (!force) {
          throw error;
        }
      }
    }
    const work = this.withStableConfig(name, async (latest) => {
      if (!force) {
        const latestCached = this.cachedPreview(latest);
        if (latestCached) {
          return latestCached;
        }
      }
      const preview = await this.previewWithConfig(latest);
      this.previewCache.set(name, {
        revision: latest.revision,
        expiresAt: Date.now() + 10_000,
        value: preview,
      });
      return preview;
    });
    this.previewPending.set(name, work);
    try {
      return await work;
    } finally {
      if (this.previewPending.get(name) === work) {
        this.previewPending.delete(name);
      }
    }
  }

  /** Read a bounded tail of the detached Hub process log. */
  async logs(name = DEFAULT_PROXY_HUB, lines = 80): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
      throw anypickError('Invalid Proxy Hub log source.', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    const boundedLines = Number.isFinite(lines)
      ? Math.max(1, Math.min(200, Math.trunc(lines)))
      : 80;
    const logPath = proxyHubLogPath(this.root, name);
    if (!(await pathExists(logPath))) {
      return '';
    }
    const raw = await readFile(logPath, 'utf8');
    const all = raw.replace(/\r?\n$/u, '').split(/\r?\n/u);
    if (all.length === 1 && all[0] === '') {
      return '';
    }
    return all.slice(Math.max(0, all.length - boundedLines)).join('\n');
  }

  private async previewWithConfig(config: ProxyHubConfig): Promise<ProxyHubPreview> {
    const registry = new ProxyHubBackendRegistry(this.deps, () => {});
    const catalogs: ProxyHubCatalogSnapshot[] = [];
    const unavailable: ProxyHubPreview['unavailable'] = [];
    try {
      for (const source of config.sources) {
        if (!source.enabled) {
          continue;
        }
        try {
          const backend = await registry.open(source.ref);
          // Request a fresh catalog so models the account gained upstream (a new
          // free tier, etc.) show in the picker instead of a cached list. Non-
          // OpenCode backends ignore the unknown query param and list as usual.
          const response = await fetch(`${backend.handle.endpoint}/v1/models?refresh=1`, {
            headers: { authorization: `Bearer ${backend.token}` },
            signal: AbortSignal.timeout(12_000),
          });
          if (!response.ok) {
            throw new Error(`catalog returned ${response.status}`);
          }
          const body: unknown = await response.json();
          const models = modelsFromCatalog(body);
          if (models.length === 0) {
            throw new Error('catalog returned no models');
          }
          const adapter = await this.adapterForSource(source.ref);
          catalogs.push({
            source: source.ref,
            catalogId: adapter.capabilities.provider,
            models,
          });
        } catch {
          unavailable.push({
            source: source.ref,
            // Catalog errors can originate in provider SDKs. This result crosses
            // CLI/TUI boundaries, so keep diagnostics safe and provider-neutral.
            reason: 'catalog unavailable',
          });
        }
      }
    } finally {
      await registry.close();
    }
    const compiled = compileProxyHubRoutes(config, catalogs);
    return { config, catalogs, unavailable, ...compiled };
  }

  async attachRoute(
    routeId: string,
    client: ClientId,
    protocol: Protocol,
    name = DEFAULT_PROXY_HUB,
    requiredModels: readonly string[] = [],
  ): Promise<ProxyHubRouteSecret> {
    const secret = await this.withStableConfig(name, async (config) => {
      // Hold the Hub scope throughout discovery and persistence: an updated
      // source set cannot race in after catalog discovery but before the route
      // manifest becomes visible to the public listener.
      const preview = await this.previewWithConfig(config);
      this.previewCache.set(name, {
        revision: config.revision,
        expiresAt: Date.now() + 10_000,
        value: preview,
      });
      // A stale enabled source (deleted account, dead catalog) must not block
      // attach when other sources still provide the models the client needs.
      // Only hard-fail when nothing usable remains, or required models are gone.
      if (preview.routes.length === 0) {
        const detail =
          preview.unavailable.length > 0
            ? preview.unavailable
                .map((entry) => `${displayRef(entry.source)}: ${entry.reason}`)
                .join('; ')
            : 'no uniquely routed models';
        throw anypickError(
          preview.unavailable.length > 0
            ? `Proxy Hub sources are not ready: ${detail}`
            : 'Proxy Hub has no uniquely routed models. Add a source or resolve conflicts.',
          preview.unavailable.length > 0 ? 'PROXY_START_FAILED' : 'STATE_CONFLICT',
          preview.unavailable.length > 0 ? undefined : { exitCode: ExitCode.CAPABILITY_CONFLICT },
        );
      }
      const available = new Set(preview.routes.map((route) => route.model));
      const missing = [
        ...new Set(requiredModels.map((model) => model.trim()).filter(Boolean)),
      ].filter((model) => !available.has(model));
      if (missing.length > 0) {
        const unavailableHint =
          preview.unavailable.length > 0
            ? ` Unavailable sources: ${preview.unavailable
                .map((entry) => displayRef(entry.source))
                .join(', ')}.`
            : '';
        throw anypickError(
          `Proxy Hub cannot route selected model${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.${unavailableHint}`,
          'STATE_CONFLICT',
          { exitCode: ExitCode.CAPABILITY_CONFLICT },
        );
      }
      await this.validateRoutesForClient(preview.routes, client);
      // Codex Desktop only lists native GPT allowlist slugs. Expand the route
      // table so those slugs rewrite to real Hub models (upstreamModel).
      let routes = preview.routes;
      if (client === 'codex') {
        const nativeSlots = loadNativeListSlots();
        // requiredModels is Default + List 2–5 from the binding (activation
        // passes clientOptions.modelRoles). Order pins Desktop picker slots.
        const ordered = orderHubModelsForDesktop(
          preview.routes.map((route) => route.model),
          requiredModels,
        );
        const aliases = assignDesktopAliases(ordered, nativeSlots);
        routes = expandHubRoutesWithDesktopAliases(preview.routes, aliases);
      }
      const manifest: ProxyHubRouteManifest = {
        version: 1,
        hub: name,
        revision: preview.config.revision,
        client,
        protocol,
        routes,
      };
      return this.store.attachRoute(routeId, manifest);
    });
    void this.syncCodexLiveConfig();
    return secret;
  }

  getAttachedRoute(routeId: string): ProxyHubRouteSecret | null {
    return this.store.getRoute(routeId);
  }

  getAttachedRouteCount(name = DEFAULT_PROXY_HUB): number {
    return this.store.countRoutes(name);
  }

  async restoreRoute(routeId: string, previous: ProxyHubRouteSecret | null): Promise<void> {
    const name = previous?.manifest.hub ?? DEFAULT_PROXY_HUB;
    const current = this.store.getRoute(routeId);
    const sources = previous?.manifest.routes ?? current?.manifest.routes ?? [];
    await withMutationLocks(this.root, hubScopes(name, sources), async () => {
      if (previous) {
        this.store.attachRoute(routeId, previous.manifest, previous.token);
      } else {
        this.store.detachRoute(routeId);
      }
    });
  }

  async detachRoute(routeId: string, name = DEFAULT_PROXY_HUB): Promise<void> {
    const current = this.store.getRoute(routeId);
    await withMutationLocks(
      this.root,
      hubScopes(name, current?.manifest.routes ?? []),
      async () => {
        this.store.detachRoute(routeId);
      },
    );
    void this.syncCodexLiveConfig();
  }

  /** Start the singleton detached Hub process, reusing only a verified instance. */
  async ensureRunning(name = DEFAULT_PROXY_HUB): Promise<{
    endpoint: string;
    startedNow: boolean;
    pid: number;
    instanceId: string;
  }> {
    const result = await withMutationLocks(this.root, [`proxy/hub/${name}`], async () => {
      const config = await this.get(name);
      return this.ensureRunningWithConfig(config);
    });
    void this.syncCodexLiveConfig();
    return result;
  }

  private async ensureRunningWithConfig(config: ProxyHubConfig): Promise<{
    endpoint: string;
    startedNow: boolean;
    pid: number;
    instanceId: string;
  }> {
    const { name } = config;
    if (!config.enabled) {
      throw anypickError(`Proxy Hub hub:${name} is disabled.`, 'PROXY_DISABLED');
    }
    if (!config.sources.some((source) => source.enabled)) {
      throw anypickError(
        `Proxy Hub hub:${name} has no enabled sources. Add one before starting.`,
        'STATE_CONFLICT',
        {
          exitCode: ExitCode.CAPABILITY_CONFLICT,
          suggestions: [
            'In Tray, open Accounts → Model routing → Manage accounts, then enable a model account.',
            'If none are listed, add an OpenCode, Gemini, or Grok account under Manage.',
          ],
        },
      );
    }
    const endpoint = `http://${config.host}:${config.port}`;
    const pidPath = proxyHubPidPath(this.root, name);
    const logPath = proxyHubLogPath(this.root, name);
    const existing = await readPidRecord(pidPath);
    if (existing?.endpoint === endpoint && isProcessRunning(existing.pid)) {
      // Dev hub may run under `tsx watch`: mid-reload the pid stays up while
      // /health is briefly down. Wait long enough to ride that gap before
      // treating the process as dead and fighting it for the port.
      const healthy = await waitForHttp(`${endpoint}/health`, {
        requirePid: existing.pid,
        expectInstanceId: existing.instanceId,
        timeoutMs: 8_000,
      });
      if (healthy) {
        this.store.saveRuntime({
          name,
          endpoint,
          pid: existing.pid,
          instanceId: existing.instanceId,
          logPath,
          startedAt: existing.createdAt,
        });
        return {
          endpoint,
          startedNow: false,
          pid: existing.pid,
          instanceId: existing.instanceId,
        };
      }
    }

    // Stale pid file is common after a crashed tray/dev restart: the hub child
    // keeps the port while the record points at a dead pid. Re-attach when the
    // live listener is still our hub (verified via /health), never by port alone.
    const adopted = await this.adoptLiveHub(config, endpoint, pidPath, logPath);
    if (adopted) {
      return adopted;
    }

    if (!(await isListenPortFree(config.port, config.host))) {
      throw anypickError(
        `Proxy Hub failed to bind ${config.host}:${config.port}: the port is already in use and is not a AnyPick Proxy Hub for hub:${name}.`,
        'PROXY_START_FAILED',
        {
          suggestions: [
            `Stop whatever is listening on ${config.host}:${config.port}, or change the hub port.`,
            `If an old anypick hub was left running: lsof -iTCP:${config.port} -sTCP:LISTEN then kill that pid.`,
          ],
        },
      );
    }

    const launch = resolveAnyPickCliLaunch([
      'proxy',
      'serve',
      'hub',
      '--name',
      name,
      '--host',
      config.host,
      '--port',
      String(config.port),
    ]);
    if (!(await pathExists(launch.entry))) {
      throw anypickError(
        `AnyPick CLI entry not found at ${launch.entry}. Run: pnpm build`,
        'PROXY_BINARY_MISSING',
      );
    }
    const spawned = await spawnDetached(launch.command, launch.args, {
      logPath,
      pidPath,
      endpoint,
      provider: 'proxy-hub',
      account: name,
      env: {
        ...process.env,
        ANYPICK_HOME: this.root,
        // Child inherits watch policy for any nested re-exec.
        ...(launch.watch ? { ANYPICK_DEV_WATCH: process.env.ANYPICK_DEV_WATCH ?? '1' } : {}),
      },
    });
    // First bind under tsx watch can take longer than a cold dist start.
    const ready = await waitForHttp(`${endpoint}/health`, {
      requirePid: spawned.pid,
      expectInstanceId: spawned.instanceId,
      timeoutMs: launch.watch ? 15_000 : 5_000,
    });
    if (!ready || !isProcessRunning(spawned.pid)) {
      if (isProcessRunning(spawned.pid)) {
        try {
          process.kill(spawned.pid, 'SIGTERM');
        } catch {
          // The direct child is known, unlike an arbitrary pid record.
        }
      }
      // Race: another anypick process may have claimed the port first — adopt it.
      const raced = await this.adoptLiveHub(config, endpoint, pidPath, logPath);
      if (raced) {
        return raced;
      }
      const log = await readFile(logPath, 'utf8').catch(() => '');
      const tail = log.trim().slice(-800);
      throw anypickError(
        `Proxy Hub failed to bind ${config.host}:${config.port}.${tail ? `\n${tail}` : ''}`,
        'PROXY_START_FAILED',
      );
    }
    this.store.saveRuntime({
      name,
      endpoint,
      pid: spawned.pid,
      instanceId: spawned.instanceId,
      logPath,
      startedAt: new Date().toISOString(),
    });
    return { endpoint, startedNow: true, pid: spawned.pid, instanceId: spawned.instanceId };
  }

  /**
   * Reclaim a live hub whose pid record was lost or points at a dead process.
   * Identity comes from /health (service + hub name + instanceId), not from
   * "something is listening on the port".
   */
  private async adoptLiveHub(
    config: ProxyHubConfig,
    endpoint: string,
    pidPath: string,
    logPath: string,
  ): Promise<{ endpoint: string; startedNow: boolean; pid: number; instanceId: string } | null> {
    const health = await probeProxyHubHealth(endpoint, config.name);
    if (!health) {
      return null;
    }
    const listeners = await listenPidsOnPort(config.port, config.host);
    const pid = listeners.find((candidate) => isProcessRunning(candidate));
    if (pid == null) {
      return null;
    }
    writePidRecord(pidPath, {
      instanceId: health.instanceId,
      pid,
      endpoint,
      provider: 'proxy-hub',
      account: config.name,
      command: process.execPath,
    });
    this.store.saveRuntime({
      name: config.name,
      endpoint,
      pid,
      instanceId: health.instanceId,
      logPath,
      startedAt: new Date().toISOString(),
    });
    return { endpoint, startedNow: false, pid, instanceId: health.instanceId };
  }

  async stop(name = DEFAULT_PROXY_HUB): Promise<void> {
    await withMutationLocks(this.root, [`proxy/hub/${name}`], async () => {
      await stopPidFile(proxyHubPidPath(this.root, name), {
        processGroup: true,
      });
      this.store.clearRuntime(name);
    });
    void this.syncCodexLiveConfig();
  }

  async status(name = DEFAULT_PROXY_HUB): Promise<ProxyHubStatus> {
    const config = await this.get(name);
    const runtime = this.store.getRuntime(name);
    const cachedPreview = this.cachedPreview(config);
    const routeModels = new Set(
      this.store
        .listRouteSecrets(name)
        .flatMap((route) => route.manifest.routes.map((target) => target.model)),
    );
    const running = runtime?.pid != null && isRunning(runtime.pid);
    return {
      name,
      enabled: config.enabled,
      running,
      endpoint: running ? runtime?.endpoint : undefined,
      pid: running ? runtime?.pid : undefined,
      sourceCount: config.sources.filter((source) => source.enabled).length,
      modelCount: cachedPreview?.routes.length ?? routeModels.size,
      conflictCount: cachedPreview == null ? 0 : proxyHubIssueCount(cachedPreview),
      revision: config.revision,
      detail: running ? undefined : config.enabled ? 'stopped' : 'disabled',
    };
  }

  private async validateSources(sources: readonly ProxyHubSource[]): Promise<void> {
    for (const source of sources) {
      const provider = this.deps.accountRegistry.get(source.ref.provider);
      if (!provider.createProxyHubBackend) {
        throw anypickError(
          `${provider.name} cannot run behind Proxy Hub.`,
          'UNSUPPORTED_TRANSPORT',
          { exitCode: ExitCode.CAPABILITY_CONFLICT },
        );
      }
      if (source.ref.kind === 'account') {
        const account = await this.deps.accounts.get(source.ref.provider, source.ref.name);
        if (!account) {
          throw anypickError(
            `Account ${displayRef(source.ref)} was not found.`,
            'ACCOUNT_NOT_FOUND',
            {
              exitCode: ExitCode.NOT_FOUND,
            },
          );
        }
      } else {
        const pool = await this.deps.pools.get(source.ref.provider);
        if (!pool || pool.mode !== 'multi') {
          throw anypickError(
            `Proxy Hub source ${displayRef(source.ref)} needs an enabled multi-account pool.`,
            'POOL_NOT_ENABLED',
            { exitCode: ExitCode.CAPABILITY_CONFLICT },
          );
        }
      }
    }
  }

  private cachedPreview(config: ProxyHubConfig): ProxyHubPreview | undefined {
    const cached = this.previewCache.get(config.name);
    if (!cached || cached.revision !== config.revision || cached.expiresAt < Date.now()) {
      return undefined;
    }
    return cached.value;
  }

  /**
   * Read a versioned config, acquire its complete sorted scope set, then prove
   * it did not change before using it. A source edit that wins the small race
   * is retried with its new provider scopes instead of running discovery while
   * an unlisted provider account can mutate.
   */
  private async withStableConfig<T>(
    name: string,
    operation: (config: ProxyHubConfig) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const config = await this.get(name);
      const result = await withMutationLocks(
        this.root,
        hubScopes(name, config.sources),
        async () => {
          const latest = await this.get(name);
          if (latest.revision !== config.revision) {
            return { stable: false as const };
          }
          return { stable: true as const, value: await operation(latest) };
        },
      );
      if (result.stable) {
        return result.value;
      }
    }
    throw anypickError('Proxy Hub sources changed repeatedly. Please retry.', 'STATE_CONFLICT');
  }

  private async validateRoutesForClient(
    routes: readonly { source: ProxyHubSourceRef }[],
    client: ClientId,
  ): Promise<void> {
    for (const route of routes) {
      const adapter = await this.adapterForSource(route.source);
      const capability = adapter.transportFor(client);
      if (capability !== 'managed_builtin_proxy' && capability !== 'managed_external_proxy') {
        throw anypickError(
          `${displayRef(route.source)} cannot serve ${client} through Proxy Hub.`,
          'UNSUPPORTED_TRANSPORT',
          { exitCode: ExitCode.CAPABILITY_CONFLICT },
        );
      }
    }
  }

  private async adapterForSource(source: ProxyHubSourceRef) {
    const provider = this.deps.accountRegistry.get(source.provider);
    return source.kind === 'account'
      ? this.adapterForAccount(source.provider, source.name, provider)
      : (provider.poolSourceAdapter?.() ?? poolAdapterFor(source.provider, provider));
  }

  private async adapterForAccount(
    providerId: string,
    accountName: string,
    provider: Parameters<typeof accountAdapterFor>[0],
  ) {
    const account = await this.deps.accounts.get(providerId, accountName);
    if (!account) {
      throw anypickError(
        `Account ${providerId}/${accountName} was not found.`,
        'ACCOUNT_NOT_FOUND',
        {
          exitCode: ExitCode.NOT_FOUND,
        },
      );
    }
    return accountAdapterFor(provider, account);
  }
}

/** Live hub identity from /health — used to re-attach after a lost pid file. */
async function probeProxyHubHealth(
  endpoint: string,
  hubName: string,
): Promise<{ instanceId: string } | null> {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/u, '')}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(800),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      ok?: unknown;
      service?: unknown;
      hub?: unknown;
      instanceId?: unknown;
    };
    if (
      body.ok === true &&
      body.service === 'anypick-proxy-hub' &&
      body.hub === hubName &&
      typeof body.instanceId === 'string' &&
      body.instanceId.length > 0
    ) {
      return { instanceId: body.instanceId };
    }
    return null;
  } catch {
    return null;
  }
}

/** Count user decisions, not raw model rows, for compact status surfaces. */
export function proxyHubIssueCount(
  preview: Pick<ProxyHubPreview, 'conflicts' | 'sourceChoices'>,
): number {
  const modelOverlapGroups = new Set(
    preview.conflicts.map((conflict) =>
      conflict.candidates
        .map(serializeRef)
        .toSorted((left, right) => left.localeCompare(right))
        .join('\u0000'),
    ),
  );
  return modelOverlapGroups.size + preview.sourceChoices.length;
}

function dedupeSources(sources: readonly ProxyHubSource[]): ProxyHubSource[] {
  const byRef = new Map<string, ProxyHubSource>();
  for (const source of sources) {
    byRef.set(serializeRef(source.ref), { ref: source.ref, enabled: source.enabled });
  }
  return [...byRef.values()].toSorted((left, right) =>
    serializeRef(left.ref).localeCompare(serializeRef(right.ref)),
  );
}

function hubScopes(
  name: string,
  entries: readonly (ProxyHubSource | { source: ProxyHubSourceRef })[],
): string[] {
  return [
    `proxy/hub/${name}`,
    ...entries.map((entry) =>
      providerScope('ref' in entry ? entry.ref.provider : entry.source.provider),
    ),
  ];
}

function validOwners(
  owners: readonly ProxyHubModelOwner[],
  sources: readonly ProxyHubSource[],
): ProxyHubModelOwner[] {
  const enabled = new Set(
    sources.filter((source) => source.enabled).map((source) => serializeRef(source.ref)),
  );
  const byModel = new Map<string, ProxyHubModelOwner>();
  for (const owner of owners) {
    const model = owner.model.trim();
    if (model && enabled.has(serializeRef(owner.source))) {
      byModel.set(model, { model, source: owner.source });
    }
  }
  return [...byModel.values()].toSorted((left, right) => left.model.localeCompare(right.model));
}

function modelCandidates(preview: ProxyHubPreview, model: string): ProxyHubSourceRef[] {
  const sources = new Map<string, ProxyHubSourceRef>();
  for (const catalog of preview.catalogs) {
    if (catalog.models.includes(model)) {
      sources.set(serializeRef(catalog.source), catalog.source);
    }
  }
  return [...sources.values()];
}

function invalidModelOwner(models: readonly string[], source: ProxyHubSourceRef, reason: string) {
  const description = models.length === 1 ? models[0] : `${models.length} selected models`;
  return anypickError(
    `Cannot assign ${description} to ${displayRef(source)}: it ${reason}. Refresh conflicts and try again.`,
    'STATE_CONFLICT',
    { exitCode: ExitCode.CAPABILITY_CONFLICT },
  );
}

function modelsFromCatalog(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object'
            ? (entry as { id?: unknown }).id
            : undefined,
      )
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as { data?: unknown; models?: unknown };
  // OpenAI-shaped `data` first; some vendors emit `models` instead.
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!list) {
    return [];
  }
  return list
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? (entry as { id?: unknown }).id
          : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
