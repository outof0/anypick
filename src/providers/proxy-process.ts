/**
 * Shared helpers for providers that run an external proxy binary.
 * Core never imports this — only provider implementations do.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ProxyContext, ProxyHandle, ProxyStatus } from '../types';
import { ensureDir, pathExists } from '../utils/fs';
import {
  isProcessRunning,
  readPidFile,
  resolveBinary,
  spawnDetached,
  stopPidFile,
  waitForHttp,
} from '../utils/process';
import { AnyPickError } from '../utils/errors';
import { assertLoopbackHost } from '../utils/network';

export interface ExternalProxyOptions {
  /** Binary names to search on PATH. */
  binaries: string[];
  /** Extra absolute paths to try. */
  extraPaths?: string[];
  /** Build argv for the binary. */
  buildArgs: (ctx: ProxyContext, port: number, host: string) => string[];
  /** Default port when config.port is unset. */
  defaultPort: number;
  /** Default host when config.host is unset. */
  defaultHost?: string;
  /** Compatibility label returned to the user. */
  compatibility: string;
  /** Optional env overrides. */
  env?: (ctx: ProxyContext) => NodeJS.ProcessEnv;
  /**
   * How long to wait for the HTTP listener (ms).
   *
   * Generous by default: `waitForHttp` gives up as soon as `requirePid` dies, so
   * a real failure still reports immediately and this budget only covers a
   * process that is starting slowly. Too small a value turns a loaded machine
   * into a spurious PROXY_START_FAILED after the child has already been killed.
   */
  readyTimeoutMs?: number;
  /** Friendly name for error messages. */
  label: string;
}

function pidPath(ctx: ProxyContext): string {
  return join(ctx.runtimeDir, 'proxy.pid');
}

function logPath(ctx: ProxyContext): string {
  return join(ctx.runtimeDir, 'proxy.log');
}

export async function startExternalProxy(
  ctx: ProxyContext,
  opts: ExternalProxyOptions,
): Promise<ProxyHandle> {
  const host = ctx.config.host ?? opts.defaultHost ?? '127.0.0.1';
  assertLoopbackHost(host);
  const port = ctx.config.port ?? opts.defaultPort;

  const bin = await resolveBinary(opts.binaries, opts.extraPaths ?? []);
  if (!bin) {
    throw new AnyPickError(
      `${opts.label} proxy binary not found (looked for: ${opts.binaries.join(', ')}). Install it and ensure it is on PATH.`,
      'PROXY_BINARY_MISSING',
    );
  }

  await ensureDir(ctx.runtimeDir);
  // Truncate log on fresh start
  const { writeFile } = await import('node:fs/promises');
  await writeFile(logPath(ctx), '', { mode: 0o600 });

  const args = opts.buildArgs(ctx, port, host);
  const endpoint = `http://${host}:${port}`;
  const { pid } = await spawnDetached(bin, args, {
    logPath: logPath(ctx),
    pidPath: pidPath(ctx),
    env: opts.env ? opts.env(ctx) : process.env,
    endpoint,
    provider: ctx.providerId,
    account: ctx.accountName,
  });

  const ready = await waitForHttp(endpoint, {
    timeoutMs: opts.readyTimeoutMs ?? 15_000,
    requirePid: pid,
  });

  const alive = isProcessRunning(pid);
  if (!ready || !alive) {
    await stopFreshSpawn(pid);
    const log = await safeReadLog(logPath(ctx), 30);
    // A binary that exits without writing anything is almost always the wrong
    // entry point — a package-manager shim left pointing at a library entry
    // rather than the CLI. Naming the resolved path is what makes that
    // findable; the port and label alone do not.
    const cause = alive
      ? 'it is still running but never answered the readiness probe'
      : 'it exited immediately';
    const detail = log ? `\n${log}` : '\n(no output was written to the log)';
    throw new AnyPickError(
      `${opts.label} proxy failed to start on ${host}:${port} — ${cause}.\n` +
        `Ran: ${bin} ${args.join(' ')}${detail}`,
      {
        code: 'PROXY_START_FAILED',
        suggestions: alive
          ? [`Check whether something else holds ${host}:${port}.`]
          : [`Run \`${bin} --version\` by hand — if it prints nothing, reinstall it.`],
      },
    );
  }

  return {
    endpoint,
    compatibility: opts.compatibility,
    pid,
    logPath: logPath(ctx),
  };
}

/** Cleanup for a PID obtained in this start call (not a persisted PID lookup). */
async function stopFreshSpawn(pid: number): Promise<void> {
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGTERM');
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  const deadline = Date.now() + 1000;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!isProcessRunning(pid)) {
    return;
  }
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export async function stopExternalProxy(ctx: ProxyContext): Promise<void> {
  // A third-party binary does not echo ANYPICK_INSTANCE_ID, so ownership is
  // proved from the process start time instead (see StopPidFileOptions).
  await stopPidFile(pidPath(ctx), { expectInstanceId: false });
}

export async function statusExternalProxy(
  ctx: ProxyContext,
  opts: { compatibility?: string },
): Promise<ProxyStatus> {
  const pid = await readPidFile(pidPath(ctx));
  const running = pid != null && isProcessRunning(pid);
  const host = ctx.config.host ?? '127.0.0.1';
  const port = ctx.config.port;
  const log = logPath(ctx);

  return {
    enabled: ctx.config.enabled,
    running,
    endpoint: running && port != null ? `http://${host}:${port}` : undefined,
    compatibility: opts.compatibility,
    pid: running ? (pid ?? undefined) : undefined,
    logPath: (await pathExists(log)) ? log : undefined,
    detail: running ? undefined : ctx.config.enabled ? 'stopped' : 'disabled',
  };
}

export async function readExternalProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
  return safeReadLog(logPath(ctx), lines);
}

async function safeReadLog(path: string, lines: number): Promise<string> {
  if (!(await pathExists(path))) {
    return '(no log file yet)';
  }
  try {
    const raw = await readFile(path, 'utf8');
    const all = raw.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch {
    return '(unable to read log)';
  }
}
