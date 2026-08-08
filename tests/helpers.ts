import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type {
  AccountMeta,
  LiveAuthStatus,
  Provider,
  ProxyContext,
  ProxyHandle,
  ProxyStatus,
} from '../src/types';
import { AccountStore } from '../src/core/store';
import { openDatabase } from '../src/core/db';
import { ProviderRegistry } from '../src/core/registry';
import { AccountService } from '../src/core/service';
import { backupRequiredFile, pathExists, restoreRequiredFile } from '../src/utils/fs';
import { writeFile as writeFileFs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writePidRecord } from '../src/utils/process';

/**
 * Fake provider that reads/writes a single auth.json under a temp "live" dir.
 */
export class FakeProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly description = 'test provider';
  readonly defaultProxyPort?: number;
  readonly proxyCompatibility = 'Test API';

  /** In-process servers keyed by account name (for proxy tests). */
  private servers = new Map<string, Server>();

  /** When set, `backup` throws — used to inject DATA-01 snapshot-save faults. */
  backupShouldFail = false;

  /** The context of the most recent `startProxy`, for asserting what reached it. */
  lastProxyContext?: ProxyContext;

  // Optional proxy lifecycle — only set when constructed with withProxy/supportsProxy
  startProxy?: (ctx: ProxyContext) => Promise<ProxyHandle>;
  stopProxy?: (ctx: ProxyContext) => Promise<void>;
  proxyStatus?: (ctx: ProxyContext) => Promise<ProxyStatus>;
  readProxyLogs?: (ctx: ProxyContext, lines?: number) => Promise<string>;

  constructor(
    id: string,
    private readonly liveDir: string,
    opts: { supportsProxy?: boolean; withProxy?: boolean; defaultProxyPort?: number } = {},
  ) {
    this.id = id;
    this.name = id;
    const withProxy = opts.withProxy ?? opts.supportsProxy ?? false;
    this.defaultProxyPort = opts.defaultProxyPort ?? (withProxy ? 18080 : undefined);
    if (withProxy) {
      this.startProxy = (ctx) => this.runStartProxy(ctx);
      this.stopProxy = (ctx) => this.runStopProxy(ctx);
      this.proxyStatus = (ctx) => this.runProxyStatus(ctx);
      this.readProxyLogs = (ctx, lines) => this.runReadProxyLogs(ctx, lines);
    }
  }

  get authPath(): string {
    return join(this.liveDir, 'auth.json');
  }

  async setLive(data: Record<string, unknown>): Promise<void> {
    await mkdir(this.liveDir, { recursive: true });
    await writeFile(this.authPath, JSON.stringify(data), { mode: 0o600 });
  }

  async readLive(): Promise<Record<string, unknown> | null> {
    if (!(await pathExists(this.authPath))) {
      return null;
    }
    return JSON.parse(await readFile(this.authPath, 'utf8')) as Record<string, unknown>;
  }

  async clearLive(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    try {
      await rm(this.authPath, { force: true });
    } catch {
      // ignore
    }
  }

  async detectLive(): Promise<LiveAuthStatus> {
    if (!(await pathExists(this.authPath))) {
      return { present: false };
    }
    const data = await this.readLive();
    return {
      present: true,
      identity: typeof data?.email === 'string' ? data.email : undefined,
    };
  }

  async backup(
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    if (this.backupShouldFail) {
      throw new Error('Injected backup failure (DATA-01 fault injection)');
    }
    await backupRequiredFile(this.authPath, join(destDir, 'auth.json'), 'auth');
    const data = await this.readLive();
    return {
      identity: typeof data?.email === 'string' ? data.email : undefined,
    };
  }

  async restore(srcDir: string): Promise<void> {
    await restoreRequiredFile(join(srcDir, 'auth.json'), this.authPath, 'auth.json');
  }

  async describeSnapshot(
    srcDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const path = join(srcDir, 'auth.json');
    if (!(await pathExists(path))) {
      return {};
    }
    const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return {
      identity: typeof data.email === 'string' ? data.email : undefined,
    };
  }

  private async runStartProxy(ctx: ProxyContext): Promise<ProxyHandle> {
    this.lastProxyContext = ctx;
    await this.runStopProxy(ctx);
    const port = ctx.config.port ?? 0; // 0 = ephemeral
    const host = ctx.config.host ?? '127.0.0.1';

    const instanceId = randomUUID();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (url.pathname === '/' || url.pathname === '/health')
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: ctx.accountName, url: req.url, instanceId }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, account: ctx.accountName, url: req.url }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('Failed to bind proxy');
    }

    this.servers.set(ctx.accountName, server);
    const endpoint = `http://${host}:${addr.port}`;

    // Structured, owner-only pid record (PROC-01).
    await mkdir(ctx.runtimeDir, { recursive: true });
    writePidRecord(join(ctx.runtimeDir, 'proxy.pid'), {
      instanceId,
      pid: process.pid,
      endpoint,
      provider: ctx.providerId,
      account: ctx.accountName,
    });
    await writeFileFs(
      join(ctx.runtimeDir, 'proxy.log'),
      `started ${endpoint} for ${ctx.accountName}\n`,
    );

    // Stash actual port on the server object for status
    (server as Server & { __endpoint?: string }).__endpoint = endpoint;

    return {
      endpoint,
      compatibility: this.proxyCompatibility,
      pid: process.pid,
      instanceId,
      logPath: join(ctx.runtimeDir, 'proxy.log'),
    };
  }

  private async runStopProxy(ctx: ProxyContext): Promise<void> {
    const server = this.servers.get(ctx.accountName);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.servers.delete(ctx.accountName);
    }
    const { rm } = await import('node:fs/promises');
    try {
      await rm(join(ctx.runtimeDir, 'proxy.pid'), { force: true });
    } catch {
      // ignore
    }
  }

  private async runProxyStatus(ctx: ProxyContext): Promise<ProxyStatus> {
    const server = this.servers.get(ctx.accountName);
    const running = Boolean(server);
    const endpoint = server ? (server as Server & { __endpoint?: string }).__endpoint : undefined;
    return {
      enabled: ctx.config.enabled,
      running,
      endpoint,
      compatibility: this.proxyCompatibility,
      pid: running ? process.pid : undefined,
      logPath: join(ctx.runtimeDir, 'proxy.log'),
      detail: running ? undefined : ctx.config.enabled ? 'stopped' : 'disabled',
    };
  }

  private async runReadProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
    const path = join(ctx.runtimeDir, 'proxy.log');
    if (!(await pathExists(path))) {
      return '(no log file yet)';
    }
    const raw = await readFile(path, 'utf8');
    return raw.split(/\r?\n/).slice(-lines).join('\n');
  }

  async refreshAuth(
    authDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const path = join(authDir, 'auth.json');
    if (!(await pathExists(path))) {
      throw new Error(`No auth.json in ${authDir}`);
    }
    const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    data.token = `refreshed-${Date.now()}`;
    data.refreshed = true;
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    return {
      identity: typeof data.email === 'string' ? data.email : undefined,
    };
  }

  async dispose(): Promise<void> {
    for (const name of this.servers.keys()) {
      await this.runStopProxy({
        providerId: this.id,
        accountName: name,
        snapshotDir: '',
        runtimeDir: join(this.liveDir, 'runtime', name),
        config: { enabled: false },
      });
    }
  }
}

export async function createTestEnv(
  providerIds: string[] = ['fake'],
  opts: { supportsProxy?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'hotplug-test-'));
  const liveRoot = join(root, 'live');
  const storeRoot = join(root, 'store');
  const store = new AccountStore(storeRoot, openDatabase(storeRoot));
  const registry = new ProviderRegistry();
  const fakes: Record<string, FakeProvider> = {};

  for (const id of providerIds) {
    const fake = new FakeProvider(id, join(liveRoot, id), {
      supportsProxy: opts.supportsProxy,
    });
    fakes[id] = fake;
    registry.register(fake);
  }

  const service = new AccountService(store, registry);
  return { root, store, storeRoot, registry, service, fakes };
}
