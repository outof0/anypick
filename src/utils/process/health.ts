import { isProcessRunning } from './pid';

export interface VerifyHealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Require this exact instance id echoed by the health endpoint (PROC-01). */
  expectInstanceId?: string;
  /** When set, the check fails if this pid is no longer alive. */
  requirePid?: number;
}

/**
 * Poll a health endpoint and (optionally) verify the child's identity by
 * matching the instance id it echoes. A mismatch means the PID is alive but
 * belongs to a different process — we must NOT treat it as owned (PROC-01).
 *
 * The endpoint should respond with JSON containing `{ instanceId }`. When
 * `expectInstanceId` is set, only a matching echo counts as ready.
 */
export async function verifyProcessHealth(
  endpoint: string,
  opts: VerifyHealthOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (opts.requirePid != null && !isProcessRunning(opts.requirePid)) {
      return false;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(500),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        await sleep(intervalMs);
        continue;
      }
      if (opts.expectInstanceId == null) {
        return true;
      }
      const body = (await res.json()) as { instanceId?: unknown };
      if (body.instanceId === opts.expectInstanceId) {
        return true;
      }
      // Alive but wrong identity → fail closed, do not retry-loop forever.
      return false;
    } catch {
      await sleep(intervalMs);
    }
  }
  return false;
}

/**
 * True if nothing is currently listening on host:port.
 * Uses a temporary bind probe (same as OS EADDRINUSE check).
 */
export async function isListenPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (port === 0) {
    return true;
  }
  const net = await import('node:net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/** Poll until port is free or timeout. */
export async function waitForPortFree(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 3000,
): Promise<boolean> {
  if (port === 0) {
    return true;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isListenPortFree(port, host)) {
      return true;
    }
    await sleep(50);
  }
  return isListenPortFree(port, host);
}

export async function waitForHttp(
  endpoint: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    /** When set, HTTP ready only counts if this pid is still alive (avoids EADDRINUSE ghost). */
    requirePid?: number;
    /** When set, the endpoint must echo this exact instance id to count as ready. */
    expectInstanceId?: string;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (opts.requirePid != null && !isProcessRunning(opts.requirePid)) {
      return false;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(500),
        headers: { accept: 'application/json' },
      });
      // Any HTTP response means the server is up (even 404).
      void res;
      if (opts.requirePid != null && !isProcessRunning(opts.requirePid)) {
        return false;
      }
      // Identity gate (PROC-01): a live but wrong-identity process is not ours.
      if (opts.expectInstanceId != null) {
        let echoedId: unknown;
        try {
          const body = (await res.clone().json()) as { instanceId?: unknown };
          echoedId = body.instanceId;
        } catch {
          echoedId = undefined;
        }
        if (echoedId !== opts.expectInstanceId) {
          return false;
        }
      }
      return true;
    } catch {
      await sleep(intervalMs);
    }
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort PIDs listening on host:port (loopback proxies).
 * Used to re-attach a pid record after a stale file left a live hub orphaned.
 * Returns [] when lsof/ss is unavailable or nothing is listening.
 */
export async function listenPidsOnPort(port: number, host = '127.0.0.1'): Promise<number[]> {
  if (!Number.isInteger(port) || port <= 0) {
    return [];
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP@${host}:${port}`, '-sTCP:LISTEN', '-t'],
      { timeout: 2000, encoding: 'utf8' },
    );
    return [
      ...new Set(
        stdout
          .split(/\r?\n/u)
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && isProcessRunning(pid)),
      ),
    ];
  } catch {
    // Fall through — try ss on Linux if lsof is missing.
  }
  try {
    const { stdout } = await execFileAsync('ss', ['-lptn', `sport = :${port}`], {
      timeout: 2000,
      encoding: 'utf8',
    });
    const pids: number[] = [];
    for (const match of stdout.matchAll(/pid=(\d+)/gu)) {
      const pid = Number.parseInt(match[1] ?? '', 10);
      if (Number.isInteger(pid) && pid > 0 && isProcessRunning(pid)) {
        pids.push(pid);
      }
    }
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

/**
 * Resolve a binary from PATH (and optional extra candidates).
 */
