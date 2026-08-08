/**
 * Scoped file locks for concurrent mutations (spec §23.3).
 *
 * Lock file content: `{ "pid": number, "startedAt": string }`
 * Stale locks (dead owner PID) are stolen after a brief wait.
 */

import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isProcessRunning } from './process';
import { anypickError, ExitCode } from './errors';

export interface LockInfo {
  pid: number;
  startedAt: string;
  /** Random ownership nonce prevents PID-reuse ABA on release. */
  ownerId?: string;
}

export interface WithFileLockOptions {
  /** Max wait for another holder (ms). Default 5000. */
  timeoutMs?: number;
  /** Poll interval while waiting (ms). Default 25. */
  pollMs?: number;
  /** Human label for errors. */
  resource?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const data = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof data.pid === 'number' && data.pid > 0) {
      return {
        pid: data.pid,
        startedAt: typeof data.startedAt === 'string' ? data.startedAt : '',
        ownerId: typeof data.ownerId === 'string' ? data.ownerId : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** True when lock file is absent or owner process is dead. */
export async function isLockStale(lockPath: string): Promise<boolean> {
  const info = await readLockInfo(lockPath);
  if (!info) {
    // corrupt or unreadable — treat as stale so doctor can delete
    try {
      await readFile(lockPath);
      return true;
    } catch {
      return true; // missing
    }
  }
  return !isProcessRunning(info.pid);
}

/**
 * Acquire an exclusive lock via O_EXCL create, run fn, release.
 * Retries while another live process holds the lock.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: WithFileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 25;
  const resource = opts.resource ?? lockPath;
  const deadline = Date.now() + timeoutMs;

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownerId = randomUUID();

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      const info: LockInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ownerId,
      };
      try {
        await handle.writeFile(JSON.stringify(info) + '\n', { encoding: 'utf8' });
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code !== 'EEXIST') {
        throw err;
      }

      const info = await readLockInfo(lockPath);
      if (info && !isProcessRunning(info.pid)) {
        // Stale — remove and retry
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw anypickError(
          `Resource locked: ${resource}` +
            (info ? ` (held by pid ${info.pid})` : '') +
            '. Retry after the other anypick process finishes.',
          'STATE_CONFLICT',
          {
            exitCode: ExitCode.CAPABILITY_CONFLICT,
            details: { lockPath, ownerPid: info?.pid },
          },
        );
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const info = await readLockInfo(lockPath);
      // Only release if we still own it
      if (info?.ownerId === ownerId) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Atomically write a file under an exclusive lock sibling (`path.lock`).
 */
export async function writeFileLocked(path: string, content: string, mode = 0o600): Promise<void> {
  await withFileLock(`${path}.lock`, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, { mode, flag: 'wx' });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
}
