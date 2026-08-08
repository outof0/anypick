import { resolve } from 'node:path';
import type { PluginRecord } from '../types';
import { anypickError, ExitCode } from '../utils/errors';
import { withMutationLock } from './mutation-lock';
import { digestPluginPackage, readManifest } from './plugin-loader';
import type { PluginStore } from './plugin-store';

/** All plugin mutations serialize on one scope: the set is read as a whole at startup. */
const PLUGIN_SCOPE = 'plugins';

function nowIso(): string {
  return new Date().toISOString();
}

function notFound(name: string): never {
  throw anypickError(`No plugin named "${name}" is installed.`, 'PLUGIN_NOT_FOUND', {
    exitCode: ExitCode.NOT_FOUND,
    suggestions: ['List installed plugins: anypick plugin list'],
  });
}

/**
 * Install, trust, and enable plugins.
 *
 * Adding a plugin never enables it. A plugin runs in-process alongside code that
 * reads and rewrites real credential files, so becoming loadable is a separate,
 * explicit decision from being present on disk (ADR 0012).
 */
export class PluginService {
  constructor(
    private readonly store: PluginStore,
    private readonly root: string,
  ) {}

  list(): PluginRecord[] {
    return this.store.list();
  }

  get(name: string): PluginRecord | null {
    return this.store.get(name);
  }

  /** Read the manifest at `dir`, record it disabled, and pin its package digest. */
  async add(dir: string): Promise<PluginRecord> {
    const path = resolve(dir);
    const manifest = await readManifest(path);
    const digest = await digestPluginPackage(path);
    return withMutationLock(this.root, PLUGIN_SCOPE, async () => {
      const existing = this.store.get(manifest.name);
      if (existing && existing.path !== path) {
        throw anypickError(
          `A different plugin directory is already installed as "${manifest.name}".`,
          'PLUGIN_CONFLICT',
          {
            exitCode: ExitCode.OPERATIONAL,
            details: { installedPath: existing.path },
            suggestions: [`Remove the existing one first: anypick plugin remove ${manifest.name}`],
          },
        );
      }
      const record: PluginRecord = {
        name: manifest.name,
        path,
        version: manifest.version,
        // Re-adding an already-enabled plugin from the same path keeps it
        // enabled; the freshly computed digest re-trusts the current code.
        enabled: existing?.enabled ?? false,
        digest,
        addedAt: existing?.addedAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      this.store.upsert(record);
      return record;
    });
  }

  async remove(name: string): Promise<void> {
    await withMutationLock(this.root, PLUGIN_SCOPE, async () => {
      if (!this.store.remove(name)) {
        notFound(name);
      }
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<PluginRecord> {
    return withMutationLock(this.root, PLUGIN_SCOPE, async () => {
      const existing = this.store.get(name);
      if (!existing) {
        notFound(name);
      }
      const record: PluginRecord = { ...existing, enabled, updatedAt: nowIso() };
      this.store.upsert(record);
      return record;
    });
  }

  /**
   * Re-pin the package digest to the code currently on disk.
   *
   * This is the acknowledgement step after a plugin's code changes — an upgrade,
   * a `git pull`, or something the user did not expect. It reports the old and
   * new digest so the caller can show what is being approved.
   */
  async trust(name: string): Promise<{ record: PluginRecord; previousDigest: string }> {
    const existing = this.store.get(name);
    if (!existing) {
      notFound(name);
    }
    const manifest = await readManifest(existing.path);
    const digest = await digestPluginPackage(existing.path);
    return withMutationLock(this.root, PLUGIN_SCOPE, async () => {
      const record: PluginRecord = {
        ...existing,
        version: manifest.version,
        digest,
        updatedAt: nowIso(),
      };
      this.store.upsert(record);
      return { record, previousDigest: existing.digest };
    });
  }
}
