import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path to the built CLI (`dist/cli.js`) for detached re-exec.
 * Prefer this only when the parent is already a compiled package entry.
 */
export function resolveCliEntry(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const primary = join(here, '..', 'cli.js');
  if (existsSync(primary)) {
    return primary;
  }
  const fromSrc = join(here, '..', '..', 'dist', 'cli.js');
  if (existsSync(fromSrc)) {
    return fromSrc;
  }
  return primary;
}

export interface AnyPickCliLaunch {
  command: string;
  args: string[];
  /** CLI entry file (`.ts` in dev, `dist/cli.js` in package). */
  entry: string;
  /** True when the child is supervised by `tsx watch` (dev hot-reload). */
  watch: boolean;
}

export interface ResolveAnyPickCliLaunchOptions {
  /**
   * Force watch on/off. Default: on for TypeScript entries unless
   * `ANYPICK_DEV_WATCH=0` (matches `scripts/dev.mjs`).
   */
  watch?: boolean;
}

/**
 * How to re-exec the AnyPick CLI as a detached child.
 *
 * When the parent is running TypeScript via `pnpm dev` / tray-from-source,
 * spawn through `tsx watch` so edits under `src/` restart the child without a
 * manual stop/start. Package installs (`dist/cli.js`) stay plain Node — no
 * watch, no tsx dependency at runtime.
 *
 * The recorded pid is the long-lived `tsx watch` supervisor (stable across
 * reloads). `ANYPICK_INSTANCE_ID` is in the env and survives each restart so
 * health identity checks keep matching.
 */
export function resolveAnyPickCliLaunch(
  subArgs: string[],
  opts: ResolveAnyPickCliLaunchOptions = {},
): AnyPickCliLaunch {
  const tsEntry = preferTypeScriptCliEntry();
  if (tsEntry) {
    const watch = opts.watch ?? shouldWatchDetachedDev();
    if (watch) {
      return {
        command: process.execPath,
        args: [
          resolveTsxCli(),
          'watch',
          '--clear-screen=false',
          '--exclude',
          '**/dist/**',
          '--exclude',
          '**/node_modules/**',
          tsEntry,
          ...subArgs,
        ],
        entry: tsEntry,
        watch: true,
      };
    }
    return {
      command: process.execPath,
      args: ['--import', 'tsx', tsEntry, ...subArgs],
      entry: tsEntry,
      watch: false,
    };
  }
  const cli = resolveCliEntry();
  return {
    command: process.execPath,
    args: [cli, ...subArgs],
    entry: cli,
    watch: false,
  };
}

/** Same policy as `scripts/dev.mjs` for long-running supervisors. */
export function shouldWatchDetachedDev(): boolean {
  if (process.env.ANYPICK_DEV_WATCH === '0') {
    return false;
  }
  if (process.env.ANYPICK_DEV_WATCH === '1') {
    return true;
  }
  // TypeScript entry implies local dev (`pnpm dev` / tray from source).
  return true;
}

function preferTypeScriptCliEntry(): string | null {
  const candidates = [process.env.ANYPICK_TRAY_CLI_ENTRY, process.argv[1]];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) {
      continue;
    }
    const entry = resolve(raw.trim());
    if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && existsSync(entry)) {
      return entry;
    }
  }
  return null;
}

function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('tsx/cli');
}
