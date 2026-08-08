import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Account,
  AccountMeta,
  LiveAuthStatus,
  Provider,
  ProxyContext,
  ProxyHandle,
  ProxyStatus,
  SourceAdapter,
} from '../types';
import { grokAccountAdapter, poolAdapterFor } from '../sources/account-adapters';
import { backupRequiredFile, pathExists, readJsonFile, restoreRequiredFile } from '../utils/fs';
import {
  isProcessRunning,
  readPidFile,
  spawnDetached,
  stopPidFile,
  waitForHttp,
} from '../utils/process';
import { HotplugError } from '../utils/errors';
import { snapshotMatchesLiveDefault } from './auth-fingerprint';
import { ensureDir } from '../utils/fs';
import { writeFile } from 'node:fs/promises';
import { assertLoopbackHost } from '../utils/network';
import { rolesFromLiveDiscovery } from './model-policy';

/**
 * xAI Grok CLI / Grok Build
 *
 * Live auth: ~/.grok/auth.json (OIDC)
 *
 * Built-in dual-protocol proxy:
 *   OpenAI  (/v1/chat/completions)  → Codex
 *   Anthropic (/v1/messages)        → Claude Code
 * Injects CLI OIDC token and forwards to cli-chat-proxy.grok.com.
 * No external binary required.
 */
const DEFAULT_PORT = 8080;

export class GrokProvider implements Provider {
  readonly id = 'grok';
  readonly name = 'xAI Grok';
  readonly shortName = 'Grok';
  readonly description =
    'Manages ~/.grok/auth.json + OpenAI/Anthropic compat proxy (Codex + Claude)';
  readonly defaultProxyPort = DEFAULT_PORT;
  readonly proxyCompatibility = 'OpenAI + Anthropic API';

  // Grok accounts can be entitled to different catalogs, so the model list comes
  // from the running proxy's /v1/models rather than a release-pinned map here.
  roleDefaults(): Record<string, string> {
    return rolesFromLiveDiscovery();
  }

  constructor(private readonly home = homedir()) {}

  sourceAdapter(account: Account): SourceAdapter {
    return grokAccountAdapter(account);
  }

  poolSourceAdapter(): SourceAdapter {
    return poolAdapterFor(this.id, this);
  }

  private get authPath(): string {
    return process.env.GROK_AUTH_PATH ?? join(this.home, '.grok', 'auth.json');
  }

  async detectLive(): Promise<LiveAuthStatus> {
    const path = this.authPath;
    if (!(await pathExists(path))) {
      return { present: false };
    }
    try {
      const data = await readJsonFile<Record<string, unknown>>(path);
      const sessions = Object.values(data).filter((v) => v && typeof v === 'object') as Record<
        string,
        unknown
      >[];
      if (sessions.length === 0) {
        return { present: false };
      }
      const identity = firstEmail(sessions);
      return { present: true, identity };
    } catch {
      return { present: true, details: 'auth.json present (unreadable)' };
    }
  }

  async backup(
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const dest = join(destDir, 'auth.json');
    await backupRequiredFile(this.authPath, dest, 'Grok auth.json');
    try {
      const data = await readJsonFile<Record<string, unknown>>(dest);
      const sessions = Object.values(data).filter((v) => v && typeof v === 'object') as Record<
        string,
        unknown
      >[];
      return { identity: firstEmail(sessions) };
    } catch {
      return {};
    }
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
    try {
      const data = await readJsonFile<Record<string, unknown>>(path);
      const sessions = Object.values(data).filter((v) => v && typeof v === 'object') as Record<
        string,
        unknown
      >[];
      return { identity: firstEmail(sessions) };
    } catch {
      return {};
    }
  }

  /**
   * Delete local Grok auth.json only — does NOT revoke OIDC tokens server-side.
   */
  async clearLive(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    for (const p of [this.authPath, `${this.authPath}.lock`]) {
      try {
        await rm(p, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Refresh OIDC tokens inside a snapshot dir (auth.json).
   */
  async refreshAuth(
    authDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const path = join(authDir, 'auth.json');
    if (!(await pathExists(path))) {
      throw new Error(`No auth.json in ${authDir}`);
    }
    const { loadGrokSession, refreshSession } = await import('./grok-proxy/auth');
    const session = await loadGrokSession(path);
    const updated = await refreshSession(path, session);
    return { identity: updated.email };
  }

  async snapshotMatchesLive(snapshotDir: string): Promise<boolean> {
    return snapshotMatchesLiveDefault('grok', snapshotDir);
  }

  // ── Built-in proxy ──────────────────────────────────────────────

  async startProxy(ctx: ProxyContext): Promise<ProxyHandle> {
    const host = ctx.config.host ?? '127.0.0.1';
    assertLoopbackHost(host);
    const port = ctx.config.port ?? DEFAULT_PORT;
    const mainJs = resolveProxyMain();
    if (!(await pathExists(mainJs))) {
      throw new HotplugError(
        `Grok proxy entry not found at ${mainJs}. Run: pnpm build`,
        'PROXY_BINARY_MISSING',
      );
    }

    await ensureDir(ctx.runtimeDir);
    const logPath = join(ctx.runtimeDir, 'proxy.log');
    const pidPath = join(ctx.runtimeDir, 'proxy.pid');
    await writeFile(logPath, '', { mode: 0o600 });

    // Prefer live auth (already restored on switch); fall back to snapshot.
    const authPath = (await pathExists(this.authPath))
      ? this.authPath
      : join(ctx.snapshotDir, 'auth.json');

    if (!(await pathExists(authPath))) {
      throw new HotplugError(
        'No Grok auth available to start proxy. Save/login first.',
        'NO_LIVE_AUTH',
      );
    }

    const clientVersion =
      (typeof ctx.config.options?.clientVersion === 'string'
        ? ctx.config.options.clientVersion
        : undefined) ??
      process.env.GROK_CLIENT_VERSION ??
      '0.2.101';

    const upstream =
      (typeof ctx.config.options?.upstream === 'string'
        ? ctx.config.options.upstream
        : undefined) ??
      process.env.GROK_PROXY_UPSTREAM ??
      'https://cli-chat-proxy.grok.com';

    const endpoint = `http://${host}:${port}`;
    const { pid, instanceId } = await spawnDetached(
      process.execPath,
      [
        mainJs,
        '--port',
        String(port),
        '--host',
        host,
        '--auth-path',
        authPath,
        '--upstream',
        upstream,
        '--client-version',
        clientVersion,
      ],
      {
        logPath,
        pidPath,
        endpoint,
        provider: 'grok',
        account: ctx.accountName,
        env: {
          ...process.env,
          GROK_AUTH_PATH: authPath,
          ...(ctx.token ? { HOTPLUG_PROXY_TOKEN: ctx.token } : {}),
          HOTPLUG_PROXY_LOG: logPath,
        },
      },
    );

    const ready = await waitForHttp(`${endpoint}/health`, {
      timeoutMs: 5000,
      requirePid: pid,
      expectInstanceId: instanceId,
    });

    if (!ready || !isProcessRunning(pid)) {
      const { readFile } = await import('node:fs/promises');
      let tail = '';
      try {
        const raw = await readFile(logPath, 'utf8');
        tail = raw.split(/\r?\n/).slice(-20).join('\n');
      } catch {
        // ignore
      }
      if (isProcessRunning(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
      throw new HotplugError(
        `Grok proxy failed to bind ${host}:${port}.${tail ? `\n${tail}` : ''}`,
        'PROXY_START_FAILED',
      );
    }

    return {
      endpoint,
      compatibility: this.proxyCompatibility,
      pid,
      instanceId,
      token: ctx.token,
      logPath,
    };
  }

  async stopProxy(ctx: ProxyContext): Promise<void> {
    await stopPidFile(join(ctx.runtimeDir, 'proxy.pid'));
  }

  async proxyStatus(ctx: ProxyContext): Promise<ProxyStatus> {
    const pidPath = join(ctx.runtimeDir, 'proxy.pid');
    const logPath = join(ctx.runtimeDir, 'proxy.log');
    const pid = await readPidFile(pidPath);
    const running = pid != null && isProcessRunning(pid);
    const host = ctx.config.host ?? '127.0.0.1';
    const port = ctx.config.port ?? DEFAULT_PORT;

    return {
      enabled: ctx.config.enabled,
      running,
      endpoint: running ? `http://${host}:${port}` : undefined,
      compatibility: this.proxyCompatibility,
      pid: running ? (pid ?? undefined) : undefined,
      logPath: (await pathExists(logPath)) ? logPath : undefined,
      detail: running ? undefined : ctx.config.enabled ? 'stopped' : 'disabled',
    };
  }

  async readProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
    const logPath = join(ctx.runtimeDir, 'proxy.log');
    if (!(await pathExists(logPath))) {
      return '(no log file yet)';
    }
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(logPath, 'utf8');
    return raw.split(/\r?\n/).slice(-lines).join('\n');
  }
}

function resolveProxyMain(): string {
  // dist/providers/grok.js → dist/providers/grok-proxy/main.js
  // When running via tsx from src/, fall back to dist build output.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const primary = join(here, 'grok-proxy', 'main.js');
  if (existsSync(primary)) {
    return primary;
  }
  const fromSrc = join(here, '..', '..', 'dist', 'providers', 'grok-proxy', 'main.js');
  if (existsSync(fromSrc)) {
    return fromSrc;
  }
  return primary;
}

function firstEmail(sessions: Record<string, unknown>[]): string | undefined {
  for (const s of sessions) {
    if (typeof s.email === 'string' && s.email) {
      return s.email;
    }
    if (typeof s.user_id === 'string' && s.user_id) {
      return s.user_id;
    }
  }
  return undefined;
}

export const grokProvider = new GrokProvider();
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
