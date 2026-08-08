import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ProxyContext, ProxyHandle, ProxyStatus } from '../types';
import { ensureDir, pathExists, readJsonFile } from '../utils/fs';
import { HotplugError } from '../utils/errors';
import { assertLoopbackHost } from '../utils/network';
import {
  isProcessRunning,
  readPidFile,
  spawnDetached,
  stopPidFile,
  waitForHttp,
} from '../utils/process';
import { listZenGoCredentials } from './opencode-proxy/auth';
import { resolveCliEntry } from './opencode-cli-entry';

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
    throw new HotplugError('OpenCode auth mode must be auto, public, or api.', 'INVALID_USAGE');
  }
  const cliJs = resolveCliEntry();
  if (!(await pathExists(cliJs))) {
    throw new HotplugError(
      `Hotplug CLI entry not found at ${cliJs}. Run: pnpm build`,
      'PROXY_BINARY_MISSING',
    );
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
  // A pool must be isolated from whichever unrelated account happens to be
  // live in ~/.local/share/opencode. Its configured member order is the
  // credential failover order.
  const authPath =
    poolAuthPaths[0] ??
    ((await pathExists(opts.authPath)) ? opts.authPath : join(ctx.snapshotDir, 'auth.json'));

  if (authMode !== 'public' && !(await pathExists(authPath))) {
    throw new HotplugError(
      'No OpenCode auth available. Run: opencode auth login  then  hotplug add account opencode --current --name <name>',
      'NO_LIVE_AUTH',
    );
  }

  // Proxy needs a Zen/Go API key (oauth-only accounts cannot drive this proxy)
  try {
    const data = await readJsonFile<Record<string, unknown>>(authPath);
    if (authMode === 'api' && listZenGoCredentials(data).length === 0) {
      throw new HotplugError(
        'OpenCode proxy needs a Zen/Go API key in auth.json (opencode auth login → OpenCode Zen or Go). OAuth providers (ChatGPT, etc.) are activated via hotplug use, not this proxy.',
        'NO_LIVE_AUTH',
      );
    }
  } catch (err) {
    if (err instanceof HotplugError) {
      throw err;
    }
    // unreadable — let proxy process fail with clearer log
  }

  // Optional single-upstream override (tests). Default: dual zen+go, route by model.
  const upstream =
    (typeof ctx.config.options?.upstream === 'string' ? ctx.config.options.upstream : undefined) ??
    process.env.OPENCODE_PROXY_UPSTREAM ??
    undefined;

  const args = [
    cliJs,
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
    args.push('--auth-path', authPath);
  }
  if (poolAuthPaths.length > 0) {
    args.push('--auth-paths', poolAuthPaths.join(','));
  }
  if (upstream) {
    args.push('--upstream', upstream);
  }
  const modelMetadataUrl = ctx.config.options?.modelMetadataUrl;
  if (modelMetadataUrl === false) {
    args.push('--model-metadata-url', 'none');
  } else if (typeof modelMetadataUrl === 'string' && modelMetadataUrl.trim()) {
    args.push('--model-metadata-url', modelMetadataUrl.trim());
  }

  const endpoint = `http://${host}:${port}`;
  const { pid, instanceId } = await spawnDetached(process.execPath, args, {
    logPath,
    pidPath,
    endpoint,
    provider: 'opencode',
    account: ctx.accountName,
    env: {
      ...process.env,
      OPENCODE_AUTH_PATH: authPath,
      ...(ctx.token ? { HOTPLUG_PROXY_TOKEN: ctx.token } : {}),
      HOTPLUG_PROXY_LOG: logPath,
    },
  });

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
    // Only stop the child we just spawned (our pid file) — not whatever held the port
    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    throw new HotplugError(
      `OpenCode proxy failed to bind ${host}:${port} (port busy or crash). Hotplug will try the next free port on retry.${tail ? `\n${tail}` : ''}`,
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
