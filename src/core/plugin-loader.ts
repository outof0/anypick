import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_API_VERSION,
  type AnyPickPlugin,
  type PluginLoadFailure,
  type PluginLoadResult,
  type PluginManifest,
  type PluginRecord,
} from '../types';
import { anypickError, ExitCode } from '../utils/errors';

export const PLUGIN_MANIFEST_FILE = 'anypick.plugin.json';

/** Plugin names are used as directory-independent keys and printed in receipts. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Directory names skipped when hashing a plugin package (dev debris / VCS). */
const DIGEST_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.DS_Store',
  '__pycache__',
]);

function fail(message: string, suggestions: string[] = []): never {
  throw anypickError(message, 'PLUGIN_INVALID', {
    exitCode: ExitCode.OPERATIONAL,
    suggestions,
  });
}

/**
 * Resolve the entry module inside `root`, refusing anything that escapes it.
 *
 * `main` comes from a file the user may have obtained from a third party, so a
 * `../../` entry must not be able to make AnyPick import an arbitrary module
 * from elsewhere on disk under the plugin's name.
 */
export function resolveEntry(root: string, main: string): string {
  if (isAbsolute(main)) {
    fail(`Plugin entry "${main}" must be a path relative to the plugin directory.`);
  }
  const entry = resolve(root, main);
  const rel = relative(root, entry);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail(`Plugin entry "${main}" resolves outside the plugin directory.`);
  }
  return entry;
}

export function parseManifest(raw: string, source: string): PluginManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`${source} is not valid JSON.`);
  }
  if (typeof data !== 'object' || data === null) {
    fail(`${source} must contain a JSON object.`);
  }
  const m = data as Record<string, unknown>;
  const name = m.name;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    fail(
      `${source} has an invalid "name". Use lowercase letters, digits, and hyphens (2-64 characters).`,
    );
  }
  if (typeof m.version !== 'string' || m.version.length === 0) {
    fail(`${source} is missing a "version" string.`);
  }
  if (typeof m.main !== 'string' || m.main.length === 0) {
    fail(`${source} is missing a "main" entry module path.`);
  }
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    fail(
      `Plugin ${name} targets AnyPick plugin API ${String(m.apiVersion)}; this build supports ${PLUGIN_API_VERSION}.`,
      [`Update the plugin, or use a AnyPick release that supports API ${String(m.apiVersion)}.`],
    );
  }
  return {
    name,
    version: m.version,
    description: typeof m.description === 'string' ? m.description : undefined,
    apiVersion: PLUGIN_API_VERSION,
    main: m.main,
  };
}

export async function readManifest(root: string): Promise<PluginManifest> {
  const path = join(root, PLUGIN_MANIFEST_FILE);
  try {
    return parseManifest(await readFile(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return fail(`No ${PLUGIN_MANIFEST_FILE} found in ${root}.`, [
    `A AnyPick plugin is a directory containing ${PLUGIN_MANIFEST_FILE}.`,
  ]);
}

/**
 * SHA-256 of one file. Kept for tests and migration diagnostics; trust pins use
 * `digestPluginPackage` so helper modules cannot change under a trusted entry.
 */
export async function digestEntry(entry: string): Promise<string> {
  const bytes = await readFile(entry);
  return createHash('sha256').update(bytes).digest('hex');
}

async function listPluginFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (DIGEST_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        // Only regular files contribute; broken symlinks fail at read time.
        const info = await stat(full).catch(() => null);
        if (info?.isFile()) {
          out.push(full);
        }
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * SHA-256 over the whole plugin package, not just the entry module.
 *
 * Format (stable, path-order sorted):
 *   for each relative POSIX path under the plugin root:
 *     path\\0 + byteLength\\0 + fileBytes
 *
 * Hashing only `main` would let a compromised helper module change while the
 * trusted entry stayed identical (ADR 0012). Manifest + every shipped file are
 * included so an install is a fixed artifact.
 */
export async function digestPluginPackage(root: string): Promise<string> {
  const files = await listPluginFiles(root);
  const rels = files
    .map((full) => ({
      full,
      rel: relative(root, full).split(sep).join('/'),
    }))
    .toSorted((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash('sha256');
  for (const { full, rel } of rels) {
    const bytes = await readFile(full);
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function isPlugin(value: unknown): value is AnyPickPlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { activate?: unknown }).activate === 'function'
  );
}

/**
 * Import one plugin's entry module and hand back its `activate`.
 *
 * The digest is checked *before* the import: once `import()` runs, arbitrary
 * module top-level code has already executed in a process holding credential
 * file handles, so verification after the fact would be theatre.
 */
async function loadOne(
  record: PluginRecord,
): Promise<{ manifest: PluginManifest; plugin: AnyPickPlugin }> {
  const manifest = await readManifest(record.path);
  if (manifest.name !== record.name) {
    fail(
      `Plugin at ${record.path} now calls itself "${manifest.name}" but is installed as "${record.name}".`,
      ['Remove and re-add the plugin.'],
    );
  }
  const entry = resolveEntry(record.path, manifest.main);
  // Package digest is checked *before* import: once import runs, top-level code
  // has already executed in a process holding credential file handles.
  const digest = await digestPluginPackage(record.path);
  if (digest !== record.digest) {
    throw anypickError(
      `Plugin ${record.name} has changed since you trusted it.`,
      'PLUGIN_UNTRUSTED',
      {
        exitCode: ExitCode.OPERATIONAL,
        suggestions: [
          `Review the change, then run: anypick plugin trust ${record.name}`,
          `Or remove it: anypick plugin remove ${record.name}`,
        ],
      },
    );
  }
  const mod: unknown = await import(pathToFileURL(entry).href);
  const exported = (mod as { default?: unknown }).default ?? mod;
  if (!isPlugin(exported)) {
    fail(`Plugin ${record.name} does not export an object with an "activate" function.`);
  }
  return { manifest, plugin: exported };
}

/**
 * Load every enabled plugin.
 *
 * A broken or tampered plugin is reported as a failure and skipped rather than
 * aborting startup: the framework's job is switching real logins, and one bad
 * third-party extension must not make `anypick` unusable (ADR 0012).
 */
export async function loadPlugins(records: PluginRecord[]): Promise<PluginLoadResult> {
  const loaded: PluginLoadResult['loaded'] = [];
  const failures: PluginLoadFailure[] = [];
  for (const record of records) {
    if (!record.enabled) {
      continue;
    }
    try {
      const { manifest, plugin } = await loadOne(record);
      loaded.push({ record, manifest, plugin });
    } catch (err) {
      failures.push({
        name: record.name,
        path: record.path,
        reason: err instanceof Error ? err.message : String(err),
        untrusted:
          typeof (err as { code?: unknown }).code === 'string' &&
          (err as { code: string }).code === 'PLUGIN_UNTRUSTED',
      });
    }
  }
  return { loaded, failures };
}

/** `ANYPICK_NO_PLUGINS=1` skips loading entirely, for bisecting a bad plugin. */
export function pluginsDisabledByEnv(): boolean {
  const v = process.env.ANYPICK_NO_PLUGINS;
  return v === '1' || v === 'true';
}
