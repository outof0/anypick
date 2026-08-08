/**
 * Proxy lifecycle ownership (start/stop/status/logs) and multi-account pool
 * management for account-backed proxies.
 *
 * This was extracted from AccountService so that proxy concerns live in their
 * own collaborator: a Provider owns *where* live auth lives and how to
 * snapshot/restore it; this service owns *how a running proxy for that account
 * is orchestrated*. Client-config realignment (writing BASE_URL into bound
 * clients) is injected as RealignProxyClientsDeps rather than imported, so the
 * proxy service stays below the binding/runtime subsystems.
 *
 * Listen-port selection lives in `ProxyPortAllocator` (proxy-ports.ts), and the
 * lease table is a constructor dependency — both were previously inlined here,
 * which made this class impossible to construct in a test without also standing
 * up the whole app graph.
 */

import type {
  AccountProxyConfig,
  Provider,
  ProviderProxyPool,
  ProxyContext,
  ProxyHandle,
  ProxyStatus,
} from '../types';
import { HotplugError } from '../utils/errors';
import { normalizeAccountName } from '../utils/slug';
import { ensureDir, pathExists } from '../utils/fs';
import {
  followFile,
  isListenPortFree,
  isProcessRunning,
  readPidFile,
  readPidRecord,
} from '../utils/process';
import type { ProviderRegistry } from './registry';
import type { AccountStore } from './store';
import type { LeaseStore } from './lease-store';
import { accountSnapshotDir } from './paths';
import { PoolStore, poolRuntimeDir } from './pool-store';
import {
  realignClientsToAccountProxy,
  type RealignProxyClientsDeps,
} from './realign-proxy-clients';
import { providerCanProxy } from './capabilities';
import { ProxyPortAllocator, validatePort } from './proxy-ports';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { assertLoopbackHost } from '../utils/network';
import { withMutationLock } from './mutation-lock';

/** Best-effort port extraction from an endpoint like http://127.0.0.1:8080. */
function portFromEndpoint(endpoint: string): number {
  const m = /:(\d+)(?:\/|$)/.exec(endpoint);
  return m ? Number(m[1]) : 8080;
}

/**
 * A single-account proxy is never a pool member, so pool options must not reach
 * it. Older versions persisted `authDirs` onto the primary account's config and
 * nothing removed them when the pool went back to single mode; `authDirs` then
 * takes precedence over the account's own snapshot dir, so the proxy serves
 * whichever account happened to be primary. Dropping them on read retires those
 * records without a migration.
 */
function withoutPoolOptions(config: AccountProxyConfig): AccountProxyConfig {
  if (!config.options) {
    return { ...config };
  }
  const { pool: _pool, authDirs: _authDirs, ...options } = config.options;
  return { ...config, options };
}

/**
 * Owns proxy lifecycle and multi-account pools.
 * Constructed by the app composition root and exposed as `app.proxy`.
 */
export class ProxyService {
  readonly pools: PoolStore;
  /**
   * Optional dependency used when a proxy starts: realign bound clients'
   * BASE_URLs to the new endpoint. Injected at construction (composition time)
   * rather than wired afterwards, so the service has no upward dependency on
   * the app graph.
   */
  private readonly realign?: RealignProxyClientsDeps;
  /**
   * Lease table. Every proxy started through this service records a lease keyed
   * to the owning process, so `reapStaleLeases` can stop orphaned proxies on the
   * next startup — not just proxies started by the activation pipeline.
   *
   * Optional so a caller can build a proxy service without lease bookkeeping,
   * but supplied at construction: it used to be wired by `setLeaseStore()` after
   * the fact, which meant the service was observably half-built between the two
   * calls and could not be constructed in a test without replaying that dance.
   */
  private readonly leases?: LeaseStore;
  /** Listen-port allocation (see proxy-ports.ts). */
  private readonly ports: ProxyPortAllocator;

  constructor(
    private readonly store: AccountStore,
    private readonly registry: ProviderRegistry,
    pools?: PoolStore,
    realign?: RealignProxyClientsDeps,
    leases?: LeaseStore,
  ) {
    this.pools = pools ?? new PoolStore(store.root, store.db);
    this.realign = realign;
    this.leases = leases;
    this.ports = new ProxyPortAllocator(registry, store);
  }

  /**
   * Record a lease for a freshly started proxy owned by this process, replacing
   * any prior lease for the same provider/account. No-op when no lease store is
   * wired. Best-effort: lease bookkeeping must never fail a proxy start.
   */
  private recordLease(
    provider: string,
    account: string | undefined,
    handle: ProxyHandle,
    forcedOwnerPid?: number,
  ): string | undefined {
    if (!this.leases) {
      return undefined;
    }
    try {
      const previous = this.leases.findByProviderAccount(provider, account);
      // Preserve a live supervisor (tray) owner. Legacy leases used the child
      // proxy PID itself; those are deliberately replaced by the real owner.
      const ownerPid =
        forcedOwnerPid ??
        (previous && previous.ownerPid !== handle.pid && isProcessRunning(previous.ownerPid)
          ? previous.ownerPid
          : process.pid);
      this.leases.releaseByProviderAccount(provider, account);
      const lease = this.leases.create({
        provider,
        account,
        port: portFromEndpoint(handle.endpoint),
        endpoint: handle.endpoint,
        ownerPid,
        instanceId: handle.instanceId,
      });
      handle.leaseId = lease.leaseId;
      return lease.leaseId;
    } catch {
      // lease bookkeeping is best-effort
      return undefined;
    }
  }

  /** Release the lease for a stopped proxy. No-op without a lease store. */
  private releaseLease(provider: string, account?: string): void {
    if (!this.leases) {
      return;
    }
    try {
      this.leases.releaseByProviderAccount(provider, account);
    } catch {
      // best-effort
    }
  }

  provider(id: string): Provider {
    return this.registry.get(id);
  }

  listProviders(): Provider[] {
    return this.registry.list();
  }

  // ── Multi-account proxy pool (opt-in; default is single) ────────

  async getPool(providerId: string): Promise<ProviderProxyPool> {
    this.requireProxyProvider(providerId);
    const accounts = await this.store.listAccounts(providerId);
    return this.pools.syncMembers(
      providerId,
      accounts.map((a) => a.meta.name),
    );
  }

  /** Opt-in multi-account pool for a provider. */
  async enablePoolMulti(
    providerId: string,
    opts: { port?: number; host?: string; start?: boolean } = {},
  ): Promise<{ pool: ProviderProxyPool; started?: ProxyHandle }> {
    const provider = this.requireProxyProvider(providerId);
    const accounts = await this.store.listAccounts(providerId);
    if (accounts.length === 0) {
      throw new HotplugError(`No saved logins for ${providerId}. Save one first.`, 'NO_ACCOUNTS');
    }
    const port = validatePort(opts.port ?? provider.defaultProxyPort ?? 8080);
    assertLoopbackHost(opts.host ?? '127.0.0.1');
    const pool = await this.pools.enableMulti(
      providerId,
      accounts.map((a) => a.meta.name),
      { port, host: opts.host ?? '127.0.0.1' },
    );
    let started: ProxyHandle | undefined;
    if (opts.start !== false) {
      started = await this.startPoolProxy(providerId);
    }
    return { pool, started };
  }

  /** Back to per-account proxies (default). Stops pool process if running. */
  async disablePoolMulti(providerId: string): Promise<ProviderProxyPool> {
    this.requireProxyProvider(providerId);
    try {
      await this.stopPoolProxy(providerId);
    } catch {
      // ignore
    }
    return this.pools.disableMulti(providerId);
  }

  async setPoolMemberEnabled(
    providerId: string,
    account: string,
    enabled: boolean,
  ): Promise<ProviderProxyPool> {
    this.requireProxyProvider(providerId);
    const name = normalizeAccountName(account);
    await this.store.requireAccount(providerId, name);
    const pool = await this.pools.setMemberEnabled(providerId, name, enabled);
    // Hot-reload pool if multi + running
    if (pool.mode === 'multi' && pool.enabled) {
      const st = await this.poolProxyStatus(providerId);
      if (st.running) {
        await this.startPoolProxy(providerId);
      }
    }
    return pool;
  }

  async startPoolProxy(providerId: string): Promise<ProxyHandle> {
    const provider = this.requireProxyProvider(providerId);
    const pool = await this.getPool(providerId);
    if (pool.mode !== 'multi') {
      throw new HotplugError(
        `Pool multi-mode is off for ${providerId} (default is single account). Enable with: hotplug proxy pool enable ${providerId}`,
        'POOL_NOT_ENABLED',
      );
    }
    const enabled = pool.members.filter((m) => m.enabled);
    if (enabled.length === 0) {
      throw new HotplugError(
        `No enabled accounts in ${providerId} pool. Enable a member first.`,
        'POOL_EMPTY',
      );
    }

    const host = pool.host ?? '127.0.0.1';
    assertLoopbackHost(host);
    const port = validatePort(pool.port ?? provider.defaultProxyPort ?? 8080);

    // Persist enabled + port
    await this.pools.set({
      ...pool,
      enabled: true,
      host,
      port,
    });

    // Use first enabled account's proxy process; for Gemini pass all auth dirs
    const primary = enabled[0];
    const config: AccountProxyConfig = {
      enabled: true,
      host,
      port,
    };

    // Ensure primary account proxy config matches pool port. The pool's auth
    // dirs stay out of it: they are absolute paths under the data root and this
    // record outlives both the data root (there is no ~/.rotate migration) and
    // the pool itself, after which the primary's own single-account proxy would
    // still be handed --auth-dirs, which wins over its snapshot dir.
    await this.store.setProxyConfig(providerId, primary.account, config);

    // Route pool runtime to shared dir for pid when multi
    const runtimeDir = poolRuntimeDir(this.store.root, providerId);
    await ensureDir(runtimeDir);

    if (!provider.startProxy) {
      throw new HotplugError('PROXY_NOT_IMPLEMENTED', 'PROXY_NOT_IMPLEMENTED');
    }

    // Stop previous pool / primary proxy
    try {
      await this.stopPoolProxy(providerId);
    } catch {
      // ignore
    }
    try {
      await this.stopProxyInternal(provider, primary.account);
    } catch {
      // ignore
    }

    const priorState = await this.store.readProxyState(providerId, primary.account);
    const poolToken =
      priorState?.token && priorState.token.length > 0
        ? priorState.token
        : randomBytes(32).toString('hex');
    const ctx: ProxyContext = {
      providerId,
      accountName: primary.account,
      snapshotDir: accountSnapshotDir(this.store.root, providerId, primary.account),
      runtimeDir,
      config: {
        ...config,
        options: {
          pool: true,
          authDirs: enabled.map((m) => accountSnapshotDir(this.store.root, providerId, m.account)),
        },
      },
      token: poolToken,
    };
    const handle = await provider.startProxy(ctx);
    await this.store.writeProxyState(providerId, primary.account, {
      accountName: primary.account,
      endpoint: handle.endpoint,
      compatibility: handle.compatibility ?? provider.proxyCompatibility,
      pid: handle.pid,
      logPath: handle.logPath,
      startedAt: new Date().toISOString(),
      token: poolToken,
    });
    this.recordLease(providerId, undefined, handle);
    handle.startedNow = true;
    return handle;
  }

  async stopPoolProxy(providerId: string): Promise<void> {
    const provider = this.requireProxyProvider(providerId);
    const pool = await this.pools.getOrDefault(providerId);
    const primary = pool.members.find((m) => m.enabled)?.account;
    const runtimeDir = poolRuntimeDir(this.store.root, providerId);
    if (provider.stopProxy && primary) {
      const config = await this.store.getProxyConfig(providerId, primary);
      await provider.stopProxy({
        providerId,
        accountName: primary,
        snapshotDir: accountSnapshotDir(this.store.root, providerId, primary),
        runtimeDir,
        config: { ...config, enabled: false },
      });
    }
    this.releaseLease(providerId, undefined);
  }

  async poolProxyStatus(providerId: string): Promise<ProxyStatus> {
    const provider = this.requireProxyProvider(providerId);
    const pool = await this.pools.getOrDefault(providerId);
    const primary = pool.members.find((m) => m.enabled)?.account;
    if (!primary || pool.mode !== 'multi') {
      return {
        enabled: pool.mode === 'multi' && pool.enabled,
        running: false,
        detail: pool.mode === 'single' ? 'single-account mode' : 'no enabled members',
      };
    }
    const runtimeDir = poolRuntimeDir(this.store.root, providerId);
    const config = await this.store.getProxyConfig(providerId, primary);
    if (provider.proxyStatus) {
      return provider.proxyStatus({
        providerId,
        accountName: primary,
        snapshotDir: accountSnapshotDir(this.store.root, providerId, primary),
        runtimeDir,
        config: {
          ...config,
          enabled: pool.enabled,
          host: pool.host ?? config.host,
          port: pool.port ?? config.port,
        },
      });
    }
    return {
      enabled: pool.enabled,
      running: false,
    };
  }

  // ── Proxy commands ──────────────────────────────────────────────

  requireProxyProvider(providerId: string): Provider {
    const provider = this.registry.get(providerId);
    if (!providerCanProxy(provider)) {
      throw new HotplugError(
        `Provider "${providerId}" does not support a compatibility proxy.`,
        'PROXY_UNSUPPORTED',
      );
    }
    return provider;
  }

  async enableProxy(
    providerId: string,
    name: string,
    opts: {
      port?: number;
      host?: string;
      start?: boolean;
      /** Provider options merge (e.g. opencode plan: zen|go). */
      options?: Record<string, unknown>;
    } = {},
  ): Promise<{ config: AccountProxyConfig; started?: ProxyHandle }> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = normalizeAccountName(name);
    await this.store.requireAccount(providerId, accountName);

    const existing = await this.store.getProxyConfig(providerId, accountName);
    const port = await this.ports.resolve(provider, {
      requested: opts.port,
      existing: existing.port,
      providerId,
      accountName,
    });
    const config: AccountProxyConfig = {
      ...existing,
      enabled: true,
      port,
      host: opts.host ?? existing.host ?? '127.0.0.1',
      options: opts.options != null ? { ...existing.options, ...opts.options } : existing.options,
    };
    assertLoopbackHost(config.host ?? '127.0.0.1');
    await this.store.setProxyConfig(providerId, accountName, config);

    let started: ProxyHandle | undefined;
    const active = await this.store.getActive(providerId);
    const shouldStart = opts.start !== false && active === accountName;
    if (shouldStart) {
      started = await this.startProxyInternal(provider, accountName, config);
    }

    return { config, started };
  }

  /** Restore a previously captured config without starting a process. Scoped
   * ephemeral runs use this to avoid leaving an account auto-proxy enabled. */
  async restoreProxyConfig(
    providerId: string,
    name: string,
    config: AccountProxyConfig,
  ): Promise<void> {
    const accountName = normalizeAccountName(name);
    await this.store.requireAccount(providerId, accountName);
    await this.store.setProxyConfig(providerId, accountName, config);
  }

  /**
   * Update proxy listen port/host without toggling enabled.
   * Restarts the proxy if it is currently running.
   */
  async configureProxy(
    providerId: string,
    name: string,
    opts: {
      port?: number;
      host?: string;
      restart?: boolean;
      /** Provider options merge (e.g. opencode plan: zen|go). */
      options?: Record<string, unknown>;
    } = {},
  ): Promise<{
    config: AccountProxyConfig;
    restarted?: ProxyHandle;
    wasRunning: boolean;
  }> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = normalizeAccountName(name);
    await this.store.requireAccount(providerId, accountName);

    if (opts.port == null && opts.host == null && opts.options == null) {
      throw new HotplugError(
        'Pass --port and/or --host to configure the proxy.',
        'PROXY_CONFIG_EMPTY',
      );
    }

    const existing = await this.store.getProxyConfig(providerId, accountName);
    let port: number;
    if (opts.port != null) {
      port = validatePort(opts.port);
      await this.ports.assertAvailable(port, providerId, accountName);
    } else if (existing.port != null) {
      port = existing.port;
    } else {
      port = await this.ports.allocateFrom(
        provider.defaultProxyPort ?? 8080,
        providerId,
        accountName,
      );
    }

    const config: AccountProxyConfig = {
      ...existing,
      port,
      host: opts.host ?? existing.host ?? '127.0.0.1',
      options: opts.options != null ? { ...existing.options, ...opts.options } : existing.options,
    };
    assertLoopbackHost(config.host ?? '127.0.0.1');
    await this.store.setProxyConfig(providerId, accountName, config);

    const before = await this.proxyStatus(providerId, accountName);
    const wasRunning = before.running;
    let restarted: ProxyHandle | undefined;
    if (wasRunning && opts.restart !== false) {
      await this.stopProxyInternal(provider, accountName);
      restarted = await this.startProxyInternal(provider, accountName, config);
    }

    return { config, restarted, wasRunning };
  }

  async disableProxy(providerId: string, name: string): Promise<AccountProxyConfig> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = normalizeAccountName(name);
    await this.store.requireAccount(providerId, accountName);

    const existing = await this.store.getProxyConfig(providerId, accountName);
    const config: AccountProxyConfig = { ...existing, enabled: false };
    await this.store.setProxyConfig(providerId, accountName, config);

    await this.stopProxyInternal(provider, accountName);
    return config;
  }

  async startProxy(
    providerId: string,
    name?: string,
    opts: { port?: number; host?: string } = {},
  ): Promise<ProxyHandle> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = name
      ? normalizeAccountName(name)
      : await this.requireActiveName(providerId);

    const account = await this.store.requireAccount(providerId, accountName);
    assertLoopbackHost(opts.host ?? account.proxy.host ?? '127.0.0.1');
    if (!account.proxy.enabled) {
      throw new HotplugError(
        `Proxy is not enabled for ${providerId}/${accountName}. Run: hotplug proxy enable ${providerId} ${accountName}`,
        'PROXY_DISABLED',
      );
    }

    let config = account.proxy;
    if (opts.port != null || opts.host != null) {
      let port: number;
      if (opts.port != null) {
        port = validatePort(opts.port);
        await this.ports.assertAvailable(port, providerId, accountName);
      } else if (config.port != null) {
        port = config.port;
      } else {
        port = await this.ports.allocateFrom(
          provider.defaultProxyPort ?? 8080,
          providerId,
          accountName,
        );
      }
      config = {
        ...config,
        port,
        host: opts.host ?? config.host ?? '127.0.0.1',
      };
      await this.store.setProxyConfig(providerId, accountName, config);
    } else if (config.port == null) {
      // Legacy configs without a port: allocate and persist so restarts stay stable
      const port = await this.ports.resolve(provider, {
        providerId,
        accountName,
      });
      config = { ...config, port, host: config.host ?? '127.0.0.1' };
      await this.store.setProxyConfig(providerId, accountName, config);
    }

    return this.startProxyInternal(provider, accountName, config);
  }

  async stopProxy(providerId: string, name?: string): Promise<void> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = name
      ? normalizeAccountName(name)
      : await this.requireActiveName(providerId);
    await this.store.requireAccount(providerId, accountName);
    await this.stopProxyInternal(provider, accountName);
  }

  async proxyStatus(providerId: string, name?: string): Promise<ProxyStatus> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = name
      ? normalizeAccountName(name)
      : await this.requireActiveName(providerId);

    const account = await this.store.requireAccount(providerId, accountName);
    const ctx = this.buildProxyContext(providerId, accountName, account.proxy);
    const host = account.proxy.host ?? '127.0.0.1';
    const port = account.proxy.port ?? provider.defaultProxyPort ?? undefined;

    let status: ProxyStatus;
    if (provider.proxyStatus) {
      status = await provider.proxyStatus(ctx);
    } else {
      // Default: pid file + saved state
      const pid = await readPidFile(this.store.pidPath(providerId, accountName));
      const running = pid != null && isProcessRunning(pid);
      const state = await this.store.readProxyState(providerId, accountName);
      const logPath = this.store.logPath(providerId, accountName);

      status = {
        enabled: account.proxy.enabled,
        running,
        endpoint: running ? state?.endpoint : undefined,
        compatibility: running
          ? (state?.compatibility ?? provider.proxyCompatibility)
          : provider.proxyCompatibility,
        pid: running ? (pid ?? undefined) : undefined,
        logPath: (await pathExists(logPath)) ? logPath : undefined,
        detail: running ? undefined : account.proxy.enabled ? 'stopped' : 'disabled',
      };
    }

    // Always surface configured bind address (even when stopped). When the
    // provider selected a different port (for example after a collision),
    // proxy_state is authoritative while that exact process is alive. TUI and
    // client realignment must probe the endpoint the child actually owns.
    status.port = port;
    status.host = host;
    if (status.running && status.pid != null) {
      const runtimeState = await this.store.readProxyState(providerId, accountName);
      if (runtimeState?.pid === status.pid && runtimeState.endpoint) {
        status.endpoint = runtimeState.endpoint;
        status.port = portFromEndpoint(runtimeState.endpoint);
        try {
          status.host = new URL(runtimeState.endpoint).hostname;
        } catch {
          // Keep the configured host for malformed legacy state.
        }
      }
    }
    if (!status.endpoint && status.running && port != null) {
      status.endpoint = `http://${host}:${port}`;
    }
    return status;
  }

  async proxyLogs(providerId: string, name?: string, lines = 50): Promise<string> {
    const provider = this.requireProxyProvider(providerId);
    const accountName = name
      ? normalizeAccountName(name)
      : await this.requireActiveName(providerId);

    const account = await this.store.requireAccount(providerId, accountName);
    const ctx = this.buildProxyContext(providerId, accountName, account.proxy);

    if (provider.readProxyLogs) {
      return provider.readProxyLogs(ctx, lines);
    }

    const logPath = this.store.logPath(providerId, accountName);
    if (!(await pathExists(logPath))) {
      return '(no log file yet)';
    }
    const raw = await readFile(logPath, 'utf8');
    const all = raw.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  }

  /**
   * Stream proxy logs live (tail -f style). Calls `onLine` for each new line
   * and resolves when `signal` aborts. Returns immediately if no log file yet.
   */
  async proxyLogsFollow(
    providerId: string,
    name: string | undefined,
    onLine: (line: string) => void,
    opts: { lines?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const accountName = name
      ? normalizeAccountName(name)
      : await this.requireActiveName(providerId);
    const logPath = this.store.logPath(providerId, accountName);

    if (!(await pathExists(logPath))) {
      onLine('(waiting for log file…)');
    }

    // Print the current tail first so the user has context.
    if (opts.lines && (await pathExists(logPath))) {
      const raw = await readFile(logPath, 'utf8');
      const all = raw
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter(Boolean);
      for (const l of all.slice(Math.max(0, all.length - opts.lines))) {
        onLine(l);
      }
    }

    const onAbort = () => {};
    opts.signal?.addEventListener('abort', onAbort);

    try {
      await followFile(logPath, onLine, opts.signal);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * List proxy-capable accounts (for `hotplug proxy` / status).
   * If provider omitted → all proxy providers. If name omitted → active or all enabled.
   */
  async listProxyRows(providerId?: string): Promise<
    Array<{
      provider: string;
      name: string;
      active: boolean;
      status: ProxyStatus;
    }>
  > {
    const providers = providerId
      ? [this.requireProxyProvider(providerId)]
      : this.registry.list().filter((p) => providerCanProxy(p));

    const rows = [];
    for (const p of providers) {
      const active = await this.store.getActive(p.id);
      const accounts = await this.store.listAccounts(p.id);
      for (const a of accounts) {
        // Show active always; others only if proxy enabled or running
        const status = await this.proxyStatus(p.id, a.meta.name).catch(
          (): ProxyStatus => ({
            enabled: a.proxy.enabled,
            running: false,
            detail: 'unavailable',
          }),
        );
        if (a.meta.name === active || a.proxy.enabled || status.running) {
          rows.push({
            provider: p.id,
            name: a.meta.name,
            active: a.meta.name === active,
            status,
          });
        }
      }
    }
    return rows;
  }

  /**
   * Start proxies. No args → active account on each proxy provider (if enabled).
   */
  async startProxies(
    providerId?: string,
    name?: string,
  ): Promise<
    Array<{
      provider: string;
      name: string;
      ok: boolean;
      endpoint?: string;
      realignedClients?: string[];
      error?: string;
    }>
  > {
    const targets = await this.resolveProxyTargets(providerId, name, {
      requireEnabled: true,
      preferActive: !name,
    });
    const out: Array<{
      provider: string;
      name: string;
      ok: boolean;
      endpoint?: string;
      realignedClients?: string[];
      error?: string;
    }> = [];
    for (const t of targets) {
      try {
        const handle = await this.startProxy(t.provider, t.name);
        out.push({
          provider: t.provider,
          name: t.name,
          ok: true,
          endpoint: handle.endpoint,
          realignedClients: handle.realignedClients,
        });
      } catch (err) {
        out.push({
          provider: t.provider,
          name: t.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async stopProxies(
    providerId?: string,
    name?: string,
  ): Promise<Array<{ provider: string; name: string; ok: boolean; error?: string }>> {
    const targets = await this.resolveProxyTargets(providerId, name, {
      requireEnabled: false,
      preferActive: !name,
      runningOnly: !name && !providerId,
    });
    const out = [];
    for (const t of targets) {
      try {
        await this.stopProxy(t.provider, t.name);
        out.push({ provider: t.provider, name: t.name, ok: true });
      } catch (err) {
        out.push({
          provider: t.provider,
          name: t.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /** Transfer all currently running proxy leases to a long-lived supervisor. */
  async adoptRunningProxies(ownerPid = process.pid): Promise<number> {
    let adopted = 0;
    for (const row of await this.listProxyRows()) {
      const { status } = row;
      if (!status.running || status.pid == null || !status.endpoint) {
        continue;
      }
      this.recordLease(
        row.provider,
        row.name,
        {
          endpoint: status.endpoint,
          compatibility: status.compatibility,
          pid: status.pid,
          logPath: status.logPath,
        },
        ownerPid,
      );
      adopted += 1;
    }
    for (const provider of this.registry.list().filter((item) => providerCanProxy(item))) {
      try {
        const status = await this.poolProxyStatus(provider.id);
        if (!status.running || status.pid == null || !status.endpoint) {
          continue;
        }
        this.recordLease(
          provider.id,
          undefined,
          {
            endpoint: status.endpoint,
            compatibility: status.compatibility,
            pid: status.pid,
            logPath: status.logPath,
          },
          ownerPid,
        );
        adopted += 1;
      } catch {
        // Provider has no configured pool.
      }
    }
    return adopted;
  }

  // ── Internals (also used by AccountService for switch/stash/delete) ──

  /** Stop a proxy during account lifecycle ops (switch/stash/delete). */
  async stopProxyForAccount(provider: Provider, accountName: string): Promise<void> {
    await this.stopProxyInternal(provider, accountName);
  }

  /** Start a proxy as part of account switch (when enabled). */
  async startProxyForAccount(
    provider: Provider,
    accountName: string,
    config: AccountProxyConfig,
  ): Promise<{ endpoint?: string; running: boolean; error?: string }> {
    if (!providerCanProxy(provider) || !config.enabled) {
      return { running: false };
    }
    try {
      const handle = await this.startProxyInternal(provider, accountName, config);
      return {
        endpoint: handle.endpoint,
        running: true,
      };
    } catch (err) {
      return {
        running: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async resolveProxyTargets(
    providerId: string | undefined,
    name: string | undefined,
    opts: {
      requireEnabled: boolean;
      preferActive: boolean;
      runningOnly?: boolean;
    },
  ): Promise<Array<{ provider: string; name: string }>> {
    if (providerId && name) {
      this.requireProxyProvider(providerId);
      await this.store.requireAccount(providerId, normalizeAccountName(name));
      return [{ provider: providerId, name: normalizeAccountName(name) }];
    }

    if (providerId) {
      const p = this.requireProxyProvider(providerId);
      if (opts.preferActive) {
        const active = await this.store.getActive(p.id);
        if (active) {
          const acc = await this.store.requireAccount(p.id, active);
          if (!opts.requireEnabled || acc.proxy.enabled) {
            return [{ provider: p.id, name: active }];
          }
        }
      }
      const accounts = await this.store.listAccounts(p.id);
      return accounts
        .filter((a) => !opts.requireEnabled || a.proxy.enabled)
        .map((a) => ({ provider: p.id, name: a.meta.name }));
    }

    // All proxy providers
    const providers = this.registry.list().filter((p) => providerCanProxy(p));
    const targets: Array<{ provider: string; name: string }> = [];
    for (const p of providers) {
      if (opts.runningOnly) {
        const accounts = await this.store.listAccounts(p.id);
        for (const account of accounts) {
          const status = await this.proxyStatus(p.id, account.meta.name);
          if (status.running) {
            targets.push({ provider: p.id, name: account.meta.name });
          }
        }
        continue;
      }
      const active = await this.store.getActive(p.id);
      if (active) {
        const acc = await this.store.getAccount(p.id, active);
        if (!acc) {
          continue;
        }
        if (!opts.requireEnabled || acc.proxy.enabled) {
          targets.push({ provider: p.id, name: active });
        }
      }
    }
    return targets;
  }

  private async requireActiveName(providerId: string): Promise<string> {
    const active = await this.store.getActive(providerId);
    if (!active) {
      throw new HotplugError(
        `No active account for "${providerId}". Pass an account name.`,
        'NO_ACTIVE_ACCOUNT',
      );
    }
    return active;
  }

  private buildProxyContext(
    providerId: string,
    accountName: string,
    config: AccountProxyConfig,
    token?: string,
  ): ProxyContext {
    return {
      providerId,
      accountName,
      snapshotDir: accountSnapshotDir(this.store.root, providerId, accountName),
      runtimeDir: this.store.runtimeDir(providerId, accountName),
      config,
      token,
    };
  }

  private async startProxyInternal(
    provider: Provider,
    accountName: string,
    config: AccountProxyConfig,
  ): Promise<ProxyHandle> {
    return withMutationLock(this.store.root, `proxy/${provider.id}/${accountName}`, () =>
      this.startProxyInternalUnlocked(provider, accountName, config),
    );
  }

  private async startProxyInternalUnlocked(
    provider: Provider,
    accountName: string,
    config: AccountProxyConfig,
  ): Promise<ProxyHandle> {
    if (!provider.startProxy) {
      throw new HotplugError(
        `Provider "${provider.id}" declares proxy support but does not implement startProxy().`,
        'PROXY_NOT_IMPLEMENTED',
      );
    }

    let effective = withoutPoolOptions(config);
    const host = effective.host ?? '127.0.0.1';
    assertLoopbackHost(host);
    let port = effective.port ?? provider.defaultProxyPort ?? 8080;
    const pidPath = this.store.pidPath(provider.id, accountName);
    const existingPid = await readPidFile(pidPath);
    const previousState = await this.store.readProxyState(provider.id, accountName);

    // Per-instance high-entropy secret (PROXY-01). Reuse a prior token so a
    // process-reuse realign binds clients to the already-running child's secret.
    const proxyToken =
      previousState?.token && previousState.token.length > 0
        ? previousState.token
        : randomBytes(32).toString('hex');

    // Already healthy on our pid → reuse process, still realign clients (port/config drift)
    if (existingPid != null && isProcessRunning(existingPid) && port !== 0) {
      const candidates = [previousState?.endpoint, `http://${host}:${port}`].filter(
        (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
      );
      for (const candidate of candidates) {
        try {
          const { waitForHttp } = await import('../utils/process');
          const ok = await waitForHttp(candidate, {
            timeoutMs: 800,
            requirePid: existingPid,
          });
          if (!ok) {
            continue;
          }
          const actual = new URL(candidate);
          const actualHost = actual.hostname === '::1' ? '[::1]' : actual.hostname;
          const actualPort = Number(actual.port);
          if (actualPort > 0 && (actualPort !== port || actualHost !== host)) {
            port = actualPort;
            effective = { ...effective, port, host: actualHost };
            await this.store.setProxyConfig(provider.id, accountName, effective);
          }
          const handle: ProxyHandle = {
            endpoint: candidate,
            compatibility: provider.proxyCompatibility,
            pid: existingPid,
            logPath: this.store.logPath(provider.id, accountName),
            startedNow: false,
            token: proxyToken,
          };
          await this.store.writeProxyState(provider.id, accountName, {
            accountName,
            endpoint: handle.endpoint,
            compatibility: handle.compatibility,
            pid: handle.pid,
            logPath: handle.logPath,
            startedAt: new Date().toISOString(),
            token: proxyToken,
          });
          handle.realignedClients = await this.realignBoundClients(
            provider.id,
            accountName,
            handle.endpoint,
            proxyToken,
          );
          this.recordLease(provider.id, accountName, handle);
          return handle;
        } catch {
          // Try the next known endpoint before replacing the child.
        }
      }
      // Only stop *our* pid file process (never foreign listeners)
      await this.stopProxyInternalUnlocked(provider, accountName);
    } else if (existingPid != null) {
      // Stale pid file
      await this.stopProxyInternalUnlocked(provider, accountName);
    }

    // Port taken (by anyone) → bump to next free port. Never kill foreign processes.
    if (port !== 0 && !(await isListenPortFree(port, host))) {
      const next = await this.ports.allocateFrom(port + 1, provider.id, accountName);
      effective = { ...effective, port: next, host };
      await this.store.setProxyConfig(provider.id, accountName, effective);
      port = next;
    } else if (effective.port == null) {
      effective = { ...effective, port, host };
      await this.store.setProxyConfig(provider.id, accountName, effective);
    }

    const ctx = this.buildProxyContext(provider.id, accountName, effective, proxyToken);
    const handle = await provider.startProxy(ctx);

    // Child died immediately — don't claim success on someone else's health endpoint
    if (handle.pid != null && !isProcessRunning(handle.pid)) {
      // Port race: try once more on next free port
      if (port !== 0) {
        const next = await this.ports.allocateFrom(port + 1, provider.id, accountName);
        effective = { ...effective, port: next, host };
        await this.store.setProxyConfig(provider.id, accountName, effective);
        const retry = await provider.startProxy(
          this.buildProxyContext(provider.id, accountName, effective, proxyToken),
        );
        if (retry.pid != null && isProcessRunning(retry.pid)) {
          await this.store.writeProxyState(provider.id, accountName, {
            accountName,
            endpoint: retry.endpoint,
            compatibility: retry.compatibility ?? provider.proxyCompatibility,
            pid: retry.pid,
            logPath: retry.logPath ?? this.store.logPath(provider.id, accountName),
            startedAt: new Date().toISOString(),
            token: proxyToken,
          });
          retry.startedNow = true;
          retry.token = proxyToken;
          this.recordLease(provider.id, accountName, retry);
          retry.realignedClients = await this.realignBoundClients(
            provider.id,
            accountName,
            retry.endpoint,
            proxyToken,
          );
          return retry;
        }
      }
      throw new HotplugError(
        `Proxy for ${provider.id}/${accountName} failed to bind (tried port ${port}). Check: hotplug proxy logs ${provider.id} ${accountName}`,
        'PROXY_START_FAILED',
      );
    }

    await this.store.writeProxyState(provider.id, accountName, {
      accountName,
      endpoint: handle.endpoint,
      compatibility: handle.compatibility ?? provider.proxyCompatibility,
      pid: handle.pid,
      logPath: handle.logPath ?? this.store.logPath(provider.id, accountName),
      startedAt: new Date().toISOString(),
      token: proxyToken,
    });

    handle.startedNow = true;
    this.recordLease(provider.id, accountName, handle);

    handle.realignedClients = await this.realignBoundClients(
      provider.id,
      accountName,
      handle.endpoint,
      proxyToken,
    );
    return handle;
  }

  /** Rewrite bound clients' BASE_URL to the live proxy endpoint. */
  private async realignBoundClients(
    providerId: string,
    accountName: string,
    endpoint: string,
    token?: string,
  ): Promise<string[]> {
    if (!this.realign) {
      return [];
    }
    try {
      return await realignClientsToAccountProxy(
        this.realign,
        providerId,
        accountName,
        endpoint,
        token,
      );
    } catch {
      return [];
    }
  }

  private async stopProxyInternal(provider: Provider, accountName: string): Promise<void> {
    return withMutationLock(this.store.root, `proxy/${provider.id}/${accountName}`, () =>
      this.stopProxyInternalUnlocked(provider, accountName),
    );
  }

  private async stopProxyInternalUnlocked(provider: Provider, accountName: string): Promise<void> {
    const config = await this.store.getProxyConfig(provider.id, accountName);
    const ctx = this.buildProxyContext(provider.id, accountName, config);

    const pidPath = this.store.pidPath(provider.id, accountName);
    const before = await readPidRecord(pidPath);
    if (provider.stopProxy) {
      await provider.stopProxy(ctx);
    } else {
      // Generic pid-file stop if provider did not implement stopProxy
      const { stopPidFile } = await import('../utils/process');
      await stopPidFile(this.store.pidPath(provider.id, accountName));
    }

    // A provider may fail closed when it cannot verify PID ownership. Do not
    // erase state/leases in that case: an orphaned credential-bearing proxy is
    // safer to diagnose than to forget.
    if (before && isProcessRunning(before.pid)) {
      // In-process providers (including the test fake) share the CLI PID, so
      // PID liveness alone cannot tell whether their server has stopped.
      // Ask a provider-specific status probe when available; detached providers
      // still fail closed if their recorded process remains alive.
      const status = provider.proxyStatus ? await provider.proxyStatus(ctx) : undefined;
      if (!status || status.running) {
        throw new HotplugError(
          `Could not verify that the ${provider.name} proxy stopped (pid ${before.pid}).`,
          {
            code: 'PROXY_STOP_UNVERIFIED',
            suggestions: ['Run hotplug doctor to inspect the proxy record before retrying.'],
          },
        );
      }
    }

    await this.store.clearProxyState(provider.id, accountName);
    this.releaseLease(provider.id, accountName);
  }
}
