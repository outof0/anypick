/**
 * The plugin contract, exercised the way a third-party author would.
 *
 * These tests write a real plugin directory to a temp dir and let Hotplug
 * `import()` it, because the parts most likely to regress — digest pinning,
 * disabled-by-default, entry path containment — only exist on the boundary
 * between the registry row and the module loader. A mocked loader would pass
 * while the boundary was broken (ADR 0012).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_API_VERSION } from '../src/index';
import { createApp, createAppReady, type HotplugApp } from '../src/testing';
import type { LoadedPlugin } from '../src/types';
import { loadPlugins, parseManifest, resolveEntry } from '../src/core/plugin-loader';
import { PluginService } from '../src/core/plugin-service';
import { PluginStore } from '../src/core/plugin-store';
import { openDatabase } from '../src/core/db';
import { migrateSchema } from '../src/core/db-schema';

const ENTRY_SOURCE = `
export default {
  activate(ctx) {
    ctx.registerCatalogProvider({
      id: 'acme-cloud',
      name: 'ACME Cloud',
      defaultEndpoint: 'https://acme.test/v1',
      models: ['acme-large'],
    });
  },
};
`;

async function writePlugin(
  dir: string,
  overrides: { name?: string; version?: string; main?: string; apiVersion?: number } = {},
  entry = ENTRY_SOURCE,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const main = overrides.main ?? 'index.mjs';
  await writeFile(
    join(dir, 'hotplug.plugin.json'),
    JSON.stringify({
      name: overrides.name ?? 'acme-plugin',
      version: overrides.version ?? '1.0.0',
      apiVersion: overrides.apiVersion ?? PLUGIN_API_VERSION,
      main,
    }),
  );
  if (!main.includes('..')) {
    await writeFile(join(dir, main), entry);
  }
  return dir;
}

describe('plugin manifest validation', () => {
  it('refuses an entry that escapes the plugin directory', () => {
    expect(() => resolveEntry('/plugins/acme', '../../evil.mjs')).toThrow(
      /outside the plugin directory/,
    );
    expect(() => resolveEntry('/plugins/acme', '/etc/passwd')).toThrow(/relative to the plugin/);
  });

  it('accepts a nested entry inside the directory', () => {
    expect(resolveEntry('/plugins/acme', 'dist/index.mjs')).toBe('/plugins/acme/dist/index.mjs');
  });

  it('rejects a mismatched API version with an actionable message', () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ name: 'acme', version: '1.0.0', main: 'i.mjs', apiVersion: 999 }),
        'manifest',
      ),
    ).toThrow(/plugin API 999/);
  });

  it('rejects names that are not usable as registry keys', () => {
    for (const name of ['ACME', 'a', '-acme', 'acme plugin']) {
      expect(() =>
        parseManifest(
          JSON.stringify({ name, version: '1.0.0', main: 'i.mjs', apiVersion: PLUGIN_API_VERSION }),
          'manifest',
        ),
      ).toThrow(/invalid "name"/);
    }
  });
});

describe('plugin registry', () => {
  let root: string;
  let pluginDir: string;
  let service: PluginService;
  let store: PluginStore;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-plugins-'));
    pluginDir = await writePlugin(join(root, 'acme'));
    db = openDatabase(root);
    migrateSchema(db);
    store = new PluginStore(db);
    service = new PluginService(store, root);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('adds a plugin disabled, so presence on disk is not permission to run', async () => {
    const record = await service.add(pluginDir);
    expect(record.name).toBe('acme-plugin');
    expect(record.enabled).toBe(false);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadPlugins(store.list())).loaded).toHaveLength(0);
  });

  it('loads an enabled plugin and applies its registrations', async () => {
    await service.add(pluginDir);
    await service.setEnabled('acme-plugin', true);
    const result = await loadPlugins(store.list());
    expect(result.failures).toEqual([]);
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0].manifest.name).toBe('acme-plugin');
  });

  it('refuses a plugin whose entry changed after it was trusted', async () => {
    await service.add(pluginDir);
    await service.setEnabled('acme-plugin', true);
    await writeFile(join(pluginDir, 'index.mjs'), `${ENTRY_SOURCE}\n// tampered\n`);

    const result = await loadPlugins(store.list());
    expect(result.loaded).toHaveLength(0);
    expect(result.failures[0].untrusted).toBe(true);
    expect(result.failures[0].reason).toMatch(/has changed since you trusted it/);
  });

  it('trust re-pins the digest and reports what was replaced', async () => {
    const added = await service.add(pluginDir);
    await service.setEnabled('acme-plugin', true);
    await writeFile(join(pluginDir, 'index.mjs'), `${ENTRY_SOURCE}\n// reviewed\n`);

    const { record, previousDigest } = await service.trust('acme-plugin');
    expect(previousDigest).toBe(added.digest);
    expect(record.digest).not.toBe(added.digest);
    expect(record.enabled).toBe(true);
    expect((await loadPlugins(store.list())).loaded).toHaveLength(1);
  });

  it('reports a broken plugin as a failure instead of throwing', async () => {
    const broken = await writePlugin(
      join(root, 'broken'),
      { name: 'broken-plugin' },
      'export default { notAnActivate: true };\n',
    );
    await service.add(broken);
    await service.setEnabled('broken-plugin', true);

    const result = await loadPlugins(store.list());
    expect(result.loaded).toHaveLength(0);
    expect(result.failures[0].untrusted).toBe(false);
    expect(result.failures[0].reason).toMatch(/"activate" function/);
  });

  it('refuses to install a second directory under an installed name', async () => {
    await service.add(pluginDir);
    const impostor = await writePlugin(join(root, 'impostor'));
    await expect(service.add(impostor)).rejects.toThrow(/already installed as/);
  });

  it('re-adding the same directory keeps it enabled and re-pins the digest', async () => {
    await service.add(pluginDir);
    await service.setEnabled('acme-plugin', true);
    await writeFile(join(pluginDir, 'index.mjs'), `${ENTRY_SOURCE}\n// v2\n`);

    const record = await service.add(pluginDir);
    expect(record.enabled).toBe(true);
    expect((await loadPlugins(store.list())).loaded).toHaveLength(1);
  });

  it('remove reports a missing plugin instead of succeeding silently', async () => {
    await expect(service.remove('nope')).rejects.toThrow(/No plugin named "nope"/);
  });
});

describe('plugin activation through createAppReady', () => {
  let root: string;
  let app: HotplugApp | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-plugin-app-'));
  });

  afterEach(async () => {
    app?.close();
    app = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('registers a catalog provider contributed by an enabled plugin', async () => {
    const dir = await writePlugin(join(root, 'acme'));
    const bootstrap = await createAppReady({ root });
    await bootstrap.plugins.add(dir);
    await bootstrap.plugins.setEnabled('acme-plugin', true);
    bootstrap.close();

    app = await createAppReady({ root });
    expect(app.pluginRuntime.failures).toEqual([]);
    expect(app.pluginRuntime.loaded.map((l) => l.record.name)).toEqual(['acme-plugin']);
    expect(app.catalog.get('acme-cloud')?.name).toBe('ACME Cloud');
  });

  it('surfaces an untrusted plugin as a doctor finding rather than a crash', async () => {
    const dir = await writePlugin(join(root, 'acme'));
    const bootstrap = await createAppReady({ root });
    await bootstrap.plugins.add(dir);
    await bootstrap.plugins.setEnabled('acme-plugin', true);
    bootstrap.close();
    await writeFile(join(dir, 'index.mjs'), `${ENTRY_SOURCE}\n// tampered\n`);

    app = await createAppReady({ root });
    expect(app.pluginRuntime.loaded).toHaveLength(0);
    expect(app.catalog.has('acme-cloud')).toBe(false);

    const report = await app.doctor.run();
    const finding = report.checks.find((c) => c.id === 'plugin:acme-plugin');
    expect(finding?.ok).toBe(false);
    expect(finding?.suggestions).toContain('hotplug plugin trust acme-plugin');
  });

  it('rolls back a plugin that throws after partial registration', async () => {
    const plugin: LoadedPlugin = {
      record: {
        name: 'partial-plugin',
        path: root,
        version: '1.0.0',
        enabled: true,
        digest: 'a'.repeat(64),
        addedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      manifest: {
        name: 'partial-plugin',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        main: 'x.mjs',
      },
      plugin: {
        activate(ctx) {
          ctx.registerCatalogProvider({
            id: 'should-not-survive',
            name: 'Partial',
            description: 'partial setup',
            apiStyle: 'openai',
          });
          throw new Error('setup failed');
        },
      },
    };
    app = createApp({ root, bare: true, plugins: [plugin] });

    expect(app.catalog.has('should-not-survive')).toBe(false);
    expect(app.pluginRuntime.loaded).toEqual([]);
    expect(app.pluginRuntime.failures[0]?.reason).toContain('setup failed');
  });

  it('disposes loaded plugins once in reverse activation order', () => {
    const disposed: string[] = [];
    const makePlugin = (name: string): LoadedPlugin => ({
      record: {
        name,
        path: root,
        version: '1.0.0',
        enabled: true,
        digest: 'a'.repeat(64),
        addedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      manifest: { name, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'x.mjs' },
      plugin: { activate() {}, dispose: () => disposed.push(name) },
    });
    app = createApp({ root, bare: true, plugins: [makePlugin('first'), makePlugin('second')] });

    app.close();
    app.close();
    expect(disposed).toEqual(['second', 'first']);
  });
});
