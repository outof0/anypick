import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AnyPickError } from './errors';

/** Expand ~ and normalize a path. */
export function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  // AnyPick stores credentials, snapshots, and proxy logs below this tree.
  // New directories are owner-only even under a permissive umask.
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

/**
 * Read a JSON file and decode through a versioned record decoder (DATA-02).
 * The decoder validates the shape and rejects corrupt/future-version data
 * with a structured error carrying the file path (no secret values).
 */
export async function readAndDecodeJsonFile<T>(
  path: string,
  decoder: (v: unknown, key: string) => { ok: true; value: T } | { ok: false; error: string },
): Promise<T> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt JSON in ${path}`);
  }
  const result = decoder(parsed, path);
  if (result.ok) {
    return result.value;
  }
  throw new Error(`Corrupt record in ${path}: ${result.error}`);
}

export async function writeJsonFile(path: string, data: unknown, mode = 0o600): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, mode);
}

/**
 * Copy a single file, creating parent dirs. Preserves mode when possible.
 * Returns false if source is missing.
 */
export async function copyFileSafe(src: string, dest: string, mode = 0o600): Promise<boolean> {
  if (!(await pathExists(src))) {
    return false;
  }
  await ensureDir(dirname(dest));
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await copyFile(src, tmp);
    const { chmod } = await import('node:fs/promises');
    await chmod(tmp, mode);
    const handle = await open(tmp, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return true;
}

/**
 * Write text atomically with restrictive permissions.
 */
export async function writeTextFile(path: string, content: string, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Copy live file into snapshot, or throw a clear error if missing.
 */
export async function backupRequiredFile(
  livePath: string,
  destPath: string,
  label: string,
): Promise<void> {
  const ok = await copyFileSafe(livePath, destPath);
  if (!ok) {
    throw new AnyPickError(`No live ${label} found at ${livePath}. Log in first, then save.`, {
      code: 'NO_LIVE_AUTH',
      suggestions: [`Sign in with the official tool, then try again.`],
    });
  }
}

/**
 * Restore a snapshot file to a live path (required).
 */
export async function restoreRequiredFile(
  srcPath: string,
  livePath: string,
  label: string,
): Promise<void> {
  if (!(await pathExists(srcPath))) {
    throw new Error(`Snapshot is missing ${label}: ${srcPath}`);
  }
  await copyFileSafe(srcPath, livePath, 0o600);
}

export async function listSubdirs(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .toSorted();
}

export async function removePath(path: string): Promise<void> {
  if (existsSync(path)) {
    await rm(path, { recursive: true, force: true });
  }
}

export async function emptyDir(path: string): Promise<void> {
  await removePath(path);
  await ensureDir(path);
}
