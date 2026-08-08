import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_API_VERSION,
  type HotplugPlugin,
  type PluginLoadFailure,
  type PluginLoadResult,
  type PluginManifest,
  type PluginRecord,
} from '../types';
import { hotplugError, ExitCode } from '../utils/errors';

export const PLUGIN_MANIFEST_FILE = 'hotplug.plugin.json';

/** Plugin names are used as directory-independent keys and printed in receipts. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function fail(message: string, suggestions: string[] = []): never {
  throw hotplugError(message, 'PLUGIN_INVALID', {
    exitCode: ExitCode.OPERATIONAL,
    suggestions,
  });
}

/**
 * Resolve the entry module inside `root`, refusing anything that escapes it.
 *
 * `main` comes from a file the user may have obtained from a third party, so a
 * `../../` entry must not be able to make Hotplug import an arbitrary module
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
      `Plugin ${name} targets Hotplug plugin API ${String(m.apiVersion)}; this build supports ${PLUGIN_API_VERSION}.`,
      [`Update the plugin, or use a Hotplug release that supports API ${String(m.apiVersion)}.`],
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
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    fail(`No ${PLUGIN_MANIFEST_FILE} found in ${root}.`, [
      `A Hotplug plugin is a directory containing ${PLUGIN_MANIFEST_FILE}.`,
    ]);
  }
  return parseManifest(raw, path);
}

/** SHA-256 of the entry module, the value compared against the trusted digest. */
export async function digestEntry(entry: string): Promise<string> {
  const bytes = await readFile(entry);
  return createHash('sha256').update(bytes).digest('hex');
}

function isPlugin(value: unknown): value is HotplugPlugin {
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
): Promise<{ manifest: PluginManifest; plugin: HotplugPlugin }> {
  const manifest = await readManifest(record.path);
  if (manifest.name !== record.name) {
    fail(
      `Plugin at ${record.path} now calls itself "${manifest.name}" but is installed as "${record.name}".`,
      ['Remove and re-add the plugin.'],
    );
  }
  const entry = resolveEntry(record.path, manifest.main);
  const digest = await digestEntry(entry);
  if (digest !== record.digest) {
    throw hotplugError(
      `Plugin ${record.name} has changed since you trusted it.`,
      'PLUGIN_UNTRUSTED',
      {
        exitCode: ExitCode.OPERATIONAL,
        suggestions: [
          `Review the change, then run: hotplug plugin trust ${record.name}`,
          `Or remove it: hotplug plugin remove ${record.name}`,
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
 * third-party extension must not make `hotplug` unusable (ADR 0012).
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

/** `HOTPLUG_NO_PLUGINS=1` skips loading entirely, for bisecting a bad plugin. */
export function pluginsDisabledByEnv(): boolean {
  const v = process.env.HOTPLUG_NO_PLUGINS;
  return v === '1' || v === 'true';
}
