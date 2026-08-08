import { spawn } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import { writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureDir, pathExists } from '../fs';
import { dirname } from 'node:path';
import { sleep, verifyProcessHealth } from './health';

export const PID_RECORD_VERSION = 1 as const;

/**
 * How far a process start time may sit from the pid record's `createdAt` and
 * still count as the process we spawned. `ps` reports whole seconds, and the
 * record is written moments after the fork, so this only has to absorb spawn
 * latency — it is deliberately far smaller than any realistic PID-reuse gap.
 */
const START_TIME_TOLERANCE_MS = 60_000;

/**
 * Budget for one ownership proof: a loopback health probe plus, for a
 * third-party child, a `ps` fork.
 *
 * Deliberately not derived from `graceMs`. That is how long a caller will wait
 * for a cooperative exit; this is how long the *proof* may take, and on a loaded
 * machine the probe alone can exceed a second. Folding the two together let a
 * caller asking for a fast kill make ownership unprovable, and an unprovable
 * stop fails closed — leaking a live proxy that still holds its port.
 */
const VERIFY_OWNERSHIP_TIMEOUT_MS = 5000;

/**
 * Structured ownership record replacing the old numeric PID file (PROC-01).
 *
 * A numeric PID is not verifiable: PID reuse (ABA) could make AnyPick signal an
 * unrelated live process. The structured record carries a random instance id,
 * so a process is only ever treated as owned after its health endpoint echoes
 * the matching instance id — not merely after the PID is alive.
 */
export interface PidRecord {
  recordVersion: number;
  instanceId: string;
  pid: number;
  endpoint?: string;
  provider?: string;
  account?: string;
  command?: string;
  createdAt: string;
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Append stdout/stderr here. */
  logPath: string;
  /** Write the owner-only structured record here. */
  pidPath: string;
  /** Endpoint the child will serve a health check on (for identity verify). */
  endpoint?: string;
  /** Provider/account owning the process (recorded, never trusted as proof). */
  provider?: string;
  account?: string;
}

/**
 * Spawn a long-running process detached from the CLI.
 * stdout/stderr are appended to logPath; an owner-only structured record is
 * written to pidPath (mode 0o600). Returns the child pid and its instance id.
 */
export async function spawnDetached(
  command: string,
  args: string[],
  opts: SpawnDetachedOptions,
): Promise<{ pid: number; instanceId: string }> {
  await ensureDir(dirname(opts.logPath));
  await ensureDir(dirname(opts.pidPath));

  const logFd = await open(opts.logPath, 'a');

  const instanceId = randomUUID();

  // Inject the instance id into the child's env so the proxy can echo it at
  // /health. Identity verification (not just pid liveness) is what lets us
  // treat a process as genuinely ours (PROC-01, ABA-safe).
  const childEnv: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    ANYPICK_INSTANCE_ID: instanceId,
  };

  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: childEnv,
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
  });

  child.unref();
  await logFd.close();

  if (child.pid == null) {
    throw new Error(`Failed to spawn ${command}`);
  }

  try {
    writePidRecord(opts.pidPath, {
      instanceId,
      pid: child.pid,
      endpoint: opts.endpoint,
      provider: opts.provider,
      account: opts.account,
      command,
    });
  } catch (err) {
    // The caller cannot later discover an unrecorded detached child. This PID
    // came directly from this spawn, so cleanup is safe even without a health
    // endpoint/record verification.
    signalProcess(child.pid, 'SIGTERM', true);
    throw err;
  }

  return { pid: child.pid, instanceId };
}

/**
 * Write an owner-only (0o600) structured pid record. Any failure throws rather
 * than leaving a half-written, world-readable record.
 */
export function writePidRecord(
  pidPath: string,
  record: Omit<PidRecord, 'recordVersion' | 'createdAt'>,
): void {
  const full: PidRecord = {
    recordVersion: PID_RECORD_VERSION,
    createdAt: new Date().toISOString(),
    ...record,
  };
  // Write atomically to a sibling, then rename over the target.
  const tmp = `${pidPath}.${randomUUID()}.tmp`;
  writeFileSyncAtomic(tmp, JSON.stringify(full), pidPath);
}

function writeFileSyncAtomic(tmp: string, contents: string, target: string): void {
  // Synchronous so the record is durable before spawnDetached returns.
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // best-effort; rename already applied 0o600 on POSIX
  }
}

/**
 * Read a structured pid record. Returns null when:
 *  - the file is absent,
 *  - it is not valid JSON or is missing required fields (corrupt/partial),
 *  - it is a legacy numeric PID file (untrusted — fail closed so PID reuse
 *    cannot make us signal an unrelated live process).
 */
export async function readPidRecord(pidPath: string): Promise<PidRecord | null> {
  if (!(await pathExists(pidPath))) {
    return null;
  }
  let raw: string;
  try {
    raw = (await readFile(pidPath, 'utf8')).trim();
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  // Legacy numeric record: never trust it as a pid.
  if (/^\d+\s*$/.test(raw)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPidRecord(parsed)) {
    return null;
  }
  return parsed;
}

function isPidRecord(v: unknown): v is PidRecord {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const r = v as Record<string, unknown>;
  return (
    typeof r.instanceId === 'string' &&
    r.instanceId.length > 0 &&
    typeof r.pid === 'number' &&
    Number.isInteger(r.pid) &&
    r.pid > 0 &&
    typeof r.recordVersion === 'number'
  );
}

/**
 * Backward-compatible pid reader. Prefers the structured record; returns its
 * pid. Legacy numeric files are UNTRUSTED and yield null (fail closed).
 */
export async function readPidFile(pidPath: string): Promise<number | null> {
  const rec = await readPidRecord(pidPath);
  return rec ? rec.pid : null;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StopPidFileOptions {
  /** Time allowed for SIGTERM cleanup before SIGKILL. */
  graceMs?: number;
  /** Detached processes own a process group; signal it so grandchildren exit too. */
  processGroup?: boolean;
  /**
   * Verify the recorded instance id through the child's health endpoint before
   * signalling. Defaults to true; only supervisors with a separate ownership
   * channel (for example the macOS tray state file) may opt out explicitly.
   */
  verifyHealth?: boolean;
  /**
   * Whether the child echoes ANYPICK_INSTANCE_ID from /health. Defaults to true.
   *
   * A third-party binary cannot, so demanding it would leave every external
   * proxy unstoppable. Ownership is then proved from the process start time
   * instead: the record is written at spawn, so a live process whose start time
   * matches `createdAt` cannot be a recycled PID — reuse only happens after the
   * original exits, which is necessarily later. This is a different proof of
   * the same fact, not a relaxation of PROC-01.
   */
  expectInstanceId?: boolean;
}

/** Wall-clock start of a live process, or null if it cannot be determined. */
export async function processStartedAt(pid: number): Promise<number | null> {
  if (process.platform === 'win32') {
    return null;
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 2000,
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals, processGroup: boolean): boolean {
  if (processGroup && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // The process may not be a group leader (legacy runtime); fall back to its PID.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is still the process that was proven owned before SIGTERM.
 *
 * Prefers the start time captured while the child was demonstrably ours: it
 * stays valid through a shutdown that has already closed the health listener.
 * Falls back to the health proof only when the platform cannot report a start
 * time (Windows), and fails closed when neither is available (PROC-01).
 */
async function stillSameProcess(
  pid: number,
  ownedStartedAt: number | null,
  verifyViaHealth: () => Promise<boolean>,
): Promise<boolean> {
  if (ownedStartedAt == null) {
    return verifyViaHealth();
  }
  const current = await processStartedAt(pid);
  if (current == null) {
    return false;
  }
  return Math.abs(current - ownedStartedAt) <= START_TIME_TOLERANCE_MS;
}

/**
 * Stop a process recorded in pidPath. Returns true if a signal was sent.
 * Waits until the process is gone (or force-kills) so the listen port can free.
 *
 * PROC-01 (fail closed): if the record is absent or unverifiable, stopPidFile
 * returns false and signals nothing — it must never kill a process it cannot
 * prove it owns (PID reuse / ABA).
 */
export async function stopPidFile(
  pidPath: string,
  opts: StopPidFileOptions = {},
): Promise<boolean> {
  const rec = await readPidRecord(pidPath);
  if (rec == null) {
    return false;
  }
  const pid = rec.pid;

  // A syntactically valid PID record is not proof of ownership: the PID may
  // have been recycled since the record was written. Built-in proxies echo
  // ANYPICK_INSTANCE_ID from /health, so require that identity match before any
  // signal. If the endpoint/health check is unavailable, fail closed and leave
  // the record for doctor/recovery rather than risking an unrelated process.
  const byInstanceId = opts.expectInstanceId !== false;
  let healthEndpoint: string | undefined;
  const verifyOwned = async (timeoutMs: number): Promise<boolean> => {
    if (opts.verifyHealth === false) {
      return true;
    }
    if (!healthEndpoint) {
      return false;
    }
    const healthy = await verifyProcessHealth(healthEndpoint, {
      ...(byInstanceId ? { expectInstanceId: rec.instanceId } : {}),
      requirePid: pid,
      timeoutMs,
      intervalMs: 50,
    });
    if (!healthy || byInstanceId) {
      return healthy;
    }
    const startedAt = await processStartedAt(pid);
    if (startedAt == null) {
      return false;
    }
    return Math.abs(startedAt - Date.parse(rec.createdAt)) <= START_TIME_TOLERANCE_MS;
  };

  if (opts.verifyHealth !== false) {
    if (!rec.endpoint || !rec.instanceId) {
      return false;
    }
    try {
      const url = new URL(rec.endpoint);
      if (url.pathname === '' || url.pathname === '/') {
        url.pathname = '/health';
      } else if (!url.pathname.endsWith('/health')) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/health`;
      }
      healthEndpoint = url.toString();
    } catch {
      return false;
    }
    const owned = await verifyOwned(VERIFY_OWNERSHIP_TIMEOUT_MS);
    if (!owned) {
      return false;
    }
  }

  let signaled = false;
  if (isProcessRunning(pid)) {
    // Re-check immediately before signalling. A process can exit and its PID
    // be recycled during the initial health probe.
    if (!(await verifyOwned(VERIFY_OWNERSHIP_TIMEOUT_MS))) {
      return false;
    }
    // Ownership is proven here, while the child is still serving. Capture its
    // start time now: escalation below cannot re-prove ownership through
    // /health, because a child that honors SIGTERM closes its listener first
    // and would then look unowned while it is still shutting down. Start time
    // is the same PROC-01 proof that survives that window — a recycled PID
    // necessarily starts later than the process it replaced.
    const ownedStartedAt = await processStartedAt(pid);
    signaled = signalProcess(pid, 'SIGTERM', opts.processGroup ?? true);
    // Wait for graceful exit
    const deadline = Date.now() + (opts.graceMs ?? 3000);
    while (isProcessRunning(pid) && Date.now() < deadline) {
      await sleep(50);
    }
    if (isProcessRunning(pid)) {
      // Never escalate to SIGKILL after a PID-reuse window without proving the
      // same instance still owns the endpoint.
      if (
        !(await stillSameProcess(pid, ownedStartedAt, () =>
          verifyOwned(VERIFY_OWNERSHIP_TIMEOUT_MS),
        ))
      ) {
        return signaled;
      }
      signalProcess(pid, 'SIGKILL', opts.processGroup ?? true);
      const killDeadline = Date.now() + 1000;
      while (isProcessRunning(pid) && Date.now() < killDeadline) {
        await sleep(25);
      }
    }
  }

  // Never discard the only ownership record while the process is still alive.
  if (!isProcessRunning(pid) && existsSync(pidPath)) {
    try {
      await unlink(pidPath);
    } catch {
      // ignore
    }
  }
  return signaled;
}
