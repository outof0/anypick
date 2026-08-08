/**
 * Isolated temporary client runtime helpers (spec §9.7.1).
 *
 * Rules:
 * - owner-only temp directory (0o700)
 * - copy only explicit allowlist entries from listIsolatablePaths
 * - reject path traversal, destinations outside temp root, unsafe symlinks
 * - never recursively copy a full home directory
 */

import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { IsolatablePath, IsolatedClientRuntime } from '../types';
import { hotplugError, ExitCode } from '../utils/errors';
import { pathExists } from '../utils/fs';

// Moved to core so core does not take value imports from the clients package.
export { syntheticProxyProfile } from '../core/profile-synth';

export async function createTempRuntimeRoot(prefix = 'hotplug-client-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await chmod(root, 0o700);
  } catch {
    // best-effort on platforms without chmod
  }
  return root;
}

/**
 * Validate destinationPath stays inside runtimeRoot (no `..` escape).
 */
export function resolveSafeDestination(runtimeRoot: string, destinationPath: string): string {
  if (!destinationPath || destinationPath.includes('\0')) {
    throw hotplugError(`Invalid isolation destination: ${destinationPath}`, 'INVALID_USAGE', {
      exitCode: ExitCode.INVALID_USAGE,
    });
  }
  if (isAbsolute(destinationPath)) {
    throw hotplugError(
      `Isolation destination must be relative: ${destinationPath}`,
      'INVALID_USAGE',
      { exitCode: ExitCode.INVALID_USAGE },
    );
  }
  const normalized = normalize(destinationPath);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.endsWith(`${sep}..`)
  ) {
    throw hotplugError(
      `Isolation destination escapes runtime root: ${destinationPath}`,
      'INVALID_USAGE',
      { exitCode: ExitCode.INVALID_USAGE },
    );
  }
  const abs = resolve(runtimeRoot, normalized);
  const rel = relative(resolve(runtimeRoot), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw hotplugError(
      `Isolation destination escapes runtime root: ${destinationPath}`,
      'INVALID_USAGE',
      { exitCode: ExitCode.INVALID_USAGE },
    );
  }
  return abs;
}

/**
 * Reject symlinks that would escape the allowlist source policy.
 * Policy: do not follow symlinks when copying; fail if source is a symlink.
 */
export async function assertSafeSource(sourcePath: string): Promise<void> {
  try {
    const st = await lstat(sourcePath);
    if (st.isSymbolicLink()) {
      throw hotplugError(`Isolation refuses to copy symlink: ${sourcePath}`, 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      // ENOENT handled by caller via required flag
      throw err;
    }
    throw err;
  }
}

/**
 * Copy allowlisted isolatable paths into runtimeRoot.
 * Missing optional paths are skipped; missing required paths fail.
 */
export async function materializeIsolatablePaths(
  runtimeRoot: string,
  paths: readonly IsolatablePath[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of paths) {
    const dest = resolveSafeDestination(runtimeRoot, entry.destinationPath);
    const exists = await pathExists(entry.sourcePath);
    if (!exists) {
      if (entry.required) {
        throw hotplugError(
          `Required client path missing for isolation: ${entry.sourcePath}`,
          'MISSING_DEPENDENCY',
          { exitCode: ExitCode.MISSING_DEPENDENCY },
        );
      }
      continue;
    }
    await assertSafeSource(entry.sourcePath);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });

    if (entry.kind === 'directory') {
      await cp(entry.sourcePath, dest, {
        recursive: true,
        // do not follow symlinks
        verbatimSymlinks: true,
        filter: async (src) => {
          try {
            const st = await lstat(src);
            if (st.isSymbolicLink()) {
              return false;
            }
            return true;
          } catch {
            return false;
          }
        },
      });
      // cp preserves the source tree's modes verbatim for directory contents,
      // so clamp every copied file/dir to owner-only (0o600 / 0o700) after the
      // copy. Symlinks are already excluded by the filter above.
      await clampModeRecursively(dest);
    } else {
      const { copyFile, chmod: chmodFile } = await import('node:fs/promises');
      await copyFile(entry.sourcePath, dest);
      try {
        // never more permissive than 0o600 for files
        const srcStat = await stat(entry.sourcePath);
        const mode = srcStat.mode & 0o777;
        const restrictive = mode & 0o600; // drop group/other write/exec at least
        await chmodFile(dest, restrictive || 0o600);
      } catch {
        // ignore
      }
    }
    copied.push(dest);
  }
  return copied;
}

/**
 * Walk a copied subtree and clamp every entry to owner-only permissions.
 * Files cap at 0o600 (drop all group/other bits); directories at 0o700.
 * Used after `cp` since it preserves the source tree's modes verbatim and
 * would otherwise carry world/group-readable secrets into the isolated home.
 */
async function clampModeRecursively(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await clampModeRecursively(full);
      try {
        await chmod(full, 0o700);
      } catch {
        // ignore best-effort
      }
    } else if (entry.isFile()) {
      try {
        const st = await stat(full);
        const mode = st.mode & 0o777;
        await chmod(full, mode & 0o600 || 0o600);
      } catch {
        // ignore best-effort
      }
    }
    // symlinks are skipped (excluded by the copy filter)
  }
}

export function makeIsolatedRuntime(
  directory: string,
  environment: Record<string, string>,
): IsolatedClientRuntime {
  let cleaned = false;
  return {
    directory,
    environment,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
