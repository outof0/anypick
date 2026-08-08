import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ProxyContext, ProxyHandle, ProxyStatus } from '../types';
import { ensureDir, pathExists, readJsonFile } from '../utils/fs';
import { AnyPickError } from '../utils/errors';
import { assertLoopbackHost } from '../utils/network';
import {
  isProcessRunning,
  readPidFile,
  spawnDetached,
  stopPidFile,
  waitForHttp,
} from '../utils/process';
import { listZenGoCredentials } from './opencode-proxy/auth';
import { resolveAnyPickCliLaunch } from './opencode-cli-entry';

export interface OpenCodeProxyLifecycleOptions {
  authPath: string;
  compatibility: string;
  defaultPort: number;
}

export async function startOpenCodeProxy(
  ctx: ProxyContext,
  opts: OpenCodeProxyLifecycleOptions,
): Promise<ProxyHandle> {
  const host = ctx.config.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const port = ctx.config.port ?? opts.defaultPort;
  const authMode = ctx.config.options?.authMode;
  if (
    authMode !== undefined &&
    authMode !== 'auto' &&
    authMode !== 'public' &&
    authMode !== 'api'
  ) {
    throw new AnyPickError('OpenCode auth mode must be auto, public, or api.', 'INVALID_USAGE');
  }
  await ensureDir(ctx.runtimeDir);
  const logPath = join(ctx.runtimeDir, 'proxy.log');
  const pidPath = join(ctx.runtimeDir, 'proxy.pid');
  await writeFile(logPath, '', { mode: 0o600 });

  const poolDirs = Array.isArray(ctx.config.options?.authDirs)
    ? (ctx.config.options.authDirs as unknown[]).filter(
        (dir): dir is string => typeof dir === 'string' && dir.trim().length > 0,
      )
    : [];
  const poolAuthPaths = poolDirs.map((dir) => join(dir, 'auth.json'));
  const poolAccountNames = Array.isArray(ctx.config.options?.quotaGuardAccountNames)
    ? (ctx.config.options.quotaGuardAccountNames as unknown[]).filter(
        (name): name is string => typeof name === 'string' && name.trim().length > 0,
      )
    : [];
  // A pool must be isolated from whichever unrelated account happens to be
  // live in ~/.local/share/opencode. Its configured member order is the
  // credential failover order.
  const authPath =
    poolAuthPaths[0] ??
    ((await pathExists(opts.authPath)) ? opts.authPath : join(ctx.snapshotDir, 'auth.json'));

  if (authMode !== 'public' && !(await pathExists(authPath))) {
    throw new AnyPickError(
      'No OpenCode auth available. Run: opencode auth login  then  anypick add account opencode --current --name <name>',
      'NO_LIVE_AUTH',
    );
  }

  // Proxy needs a Zen/Go API key (oauth-only accounts cannot drive this proxy)
  try {
    const data = await readJsonFile<Record<string, unknown>>(authPath);
    if (authMode === 'api' && listZenGoCredentials(data).length === 0) {
      throw new AnyPickError(
        'OpenCode proxy needs a Zen/Go API key in auth.json (opencode auth login → OpenCode Zen or Go). OAuth providers (ChatGPT, etc.) are activated via anypick use, not this proxy.',
        'NO_LIVE_AUTH',
      );
    }
  } catch (err) {
    if (err instanceof AnyPickError) {
      throw err;
    }
    // unreadable — let proxy process fail with clearer log
  }

  // Optional single-upstream override (tests). Default: dual zen+go, route by model.
  const upstream =
    (typeof ctx.config.options?.upstream === 'string' ? ctx.config.options.upstream : undefined) ??
    process.env.OPENCODE_PROXY_UPSTREAM ??
    undefined;

  const subArgs = [
    'proxy',
    'serve',
    'opencode',
    '--port',
    String(port),
    '--host',
    host,
    '--auth-mode',
    authMode ?? 'auto',
  ];
  if (authMode !== 'public') {
    subArgs.push('--auth-path', authPath);
  }
  if (poolAuthPaths.length > 1) {
    // auth-path already contains the primary member. Do not repeat it: the
    // account-name vector must remain exactly aligned with the credential ring.
    subArgs.push('--auth-paths', poolAuthPaths.slice(1).join(','));
  }
  if (poolAccountNames.length > 0) {
    subArgs.push('--auth-account-names', poolAccountNames.join(','));
  }
  const quotaGuard = ctx.config.options?.quotaGuard;
  if (quotaGuard && typeof quotaGuard === 'object' && !Array.isArray(quotaGuard)) {
    const policy = quotaGuard as Record<string, unknown>;
    if (policy.enabled === true) {
      subArgs.push('--quota-guard');
      if (typeof policy.cooldownMs === 'number' && Number.isFinite(policy.cooldownMs)) {
        subArgs.push(
          '--quota-guard-cooldown-ms',
          String(Math.max(1_000, Math.floor(policy.cooldownMs))),
        );
      }
      subArgs.push('--quota-guard-state', join(ctx.runtimeDir, 'quota-guard.json'));
    }
  }
  if (upstream) {
    subArgs.push('--upstream', upstream);
  }
  const modelMetadataUrl = ctx.config.options?.modelMetadataUrl;
  if (modelMetadataUrl === false) {
    subArgs.push('--model-metadata-url', 'none');
  } else if (typeof modelMetadataUrl === 'string' && modelMetadataUrl.trim()) {
    subArgs.push('--model-metadata-url', modelMetadataUrl.trim());
  }

  const launch = resolveAnyPickCliLaunch(subArgs);
  if (!(await pathExists(launch.entry))) {
    throw new AnyPickError(
      `AnyPick CLI entry not found at ${launch.entry}. Run: pnpm build`,
      'PROXY_BINARY_MISSING',
    );
  }

  const endpoint = `http://${host}:${port}`;
  const { pid, instanceId } = await spawnDetached(launch.command, launch.args, {
    logPath,
    pidPath,
    endpoint,
    provider: 'opencode',
    account: ctx.accountName,
    env: {
      ...process.env,
      OPENCODE_AUTH_PATH: authPath,
      ...(ctx.token ? { ANYPICK_PROXY_TOKEN: ctx.token } : {}),
      ANYPICK_PROXY_LOG: logPath,
      ...(launch.watch ? { ANYPICK_DEV_WATCH: process.env.ANYPICK_DEV_WATCH ?? '1' } : {}),
    },
  });

  const ready = await waitForHttp(`${endpoint}/health`, {
    timeoutMs: launch.watch ? 15_000 : 5_000,
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
    // Only stop the child we just spawned (our pid file) — not whatever held the port
    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    throw new AnyPickError(
      `OpenCode proxy failed to bind ${host}:${port} (port busy or crash). AnyPick will try the next free port on retry.${tail ? `\n${tail}` : ''}`,
      'PROXY_START_FAILED',
    );
  }

  return {
    endpoint,
    compatibility: opts.compatibility,
    pid,
    instanceId,
    token: ctx.token,
    logPath,
  };
}

export async function stopOpenCodeProxy(ctx: ProxyContext): Promise<void> {
  await stopPidFile(join(ctx.runtimeDir, 'proxy.pid'));
}

export async function openCodeProxyStatus(
  ctx: ProxyContext,
  compatibility: string,
  defaultPort: number,
): Promise<ProxyStatus> {
  const pidPath = join(ctx.runtimeDir, 'proxy.pid');
  const logPath = join(ctx.runtimeDir, 'proxy.log');
  const pid = await readPidFile(pidPath);
  const running = pid != null && isProcessRunning(pid);
  const host = ctx.config.host ?? '127.0.0.1';
  const port = ctx.config.port ?? defaultPort;

  let detail: string | undefined;
  if (!running) {
    detail = ctx.config.enabled ? 'stopped · zen+go by model' : 'disabled';
  } else {
    try {
      const endpoint = `http://${host}:${port}`;
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const h = (await res.json()) as {
          credential?: { models?: { total?: number; zen?: number; goOnly?: number } };
        };
        const m = h.credential?.models;
        detail = m
          ? `zen+go · ${m.total ?? '?'} models (${m.zen ?? '?'} zen, ${m.goOnly ?? '?'} go-only)`
          : 'zen+go · route by model';
      } else {
        detail = 'running';
      }
    } catch {
      detail = 'running';
    }
  }

  return {
    enabled: ctx.config.enabled,
    running,
    port,
    host,
    endpoint: running ? `http://${host}:${port}` : undefined,
    compatibility,
    pid: running ? (pid ?? undefined) : undefined,
    logPath: (await pathExists(logPath)) ? logPath : undefined,
    detail,
  };
}

export async function readOpenCodeProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
  const logPath = join(ctx.runtimeDir, 'proxy.log');
  if (!(await pathExists(logPath))) {
    return '(no log file yet)';
  }
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(logPath, 'utf8');
  const all = raw.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}
