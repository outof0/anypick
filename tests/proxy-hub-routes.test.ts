import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogRegistry, registerBuiltinCatalog } from '../src/catalog/providers';
import { ClientRegistry, registerBuiltinClients } from '../src/clients';
import { createAppReady, type AnyPickApp } from '../src/core/app';
import { compileProxyHubRoutes } from '../src/core/proxy-hub-routes';
import { proxyHubIssueCount } from '../src/core/proxy-hub-service';
import { proxyHubLogPath } from '../src/core/paths';
import { ProviderRegistry } from '../src/core/registry';
import type { ProxyHubConfig, ProxyHubSourceRef } from '../src/types';
import { buildTraySnapshot } from '../src/tray/snapshot';
import type { TrayActionTarget, TrayProxyActionTarget } from '../src/tray/snapshot-types';
import { resolveTrayProxyLogs } from '../src/tray/supervisor-logs';
import { setTrayHubSourceEnabled } from '../src/tray/supervisor-mutations';
import { FakeProvider } from './helpers';

const openCode: ProxyHubSourceRef = { kind: 'account', provider: 'opencode', name: 'work' };
const gemini: ProxyHubSourceRef = { kind: 'account', provider: 'gemini', name: 'personal' };

function hubConfig(overrides: Partial<ProxyHubConfig> = {}): ProxyHubConfig {
  return {
    name: 'default',
    enabled: true,
    host: '127.0.0.1',
    port: 4680,
    sources: [
      { ref: openCode, enabled: true },
      { ref: gemini, enabled: true },
    ],
    modelOwners: [],
    revision: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('Proxy Hub routes', () => {
  let root: string | undefined;
  let app: AnyPickApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    app?.close();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never assigns a colliding model until the user selects its owner', () => {
    const catalogs = [
      { source: openCode, catalogId: 'opencode', models: ['shared-model', 'opencode-only'] },
      { source: gemini, catalogId: 'gemini', models: ['shared-model', 'gemini-only'] },
    ];

    const unresolved = compileProxyHubRoutes(hubConfig(), catalogs);
    expect(unresolved.routes).toEqual([
      expect.objectContaining({ model: 'gemini-only', source: gemini }),
      expect.objectContaining({ model: 'opencode-only', source: openCode }),
    ]);
    expect(unresolved.conflicts).toEqual([
      expect.objectContaining({
        kind: 'model-overlap',
        model: 'shared-model',
        catalogIds: ['gemini', 'opencode'],
        candidates: expect.arrayContaining([gemini, openCode]),
      }),
    ]);
    expect(unresolved.sourceChoices).toEqual([]);

    const resolved = compileProxyHubRoutes(
      hubConfig({ modelOwners: [{ model: 'shared-model', source: gemini }] }),
      catalogs,
    );
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.sourceChoices).toEqual([]);
    expect(resolved.routes).toContainEqual(
      expect.objectContaining({
        model: 'shared-model',
        source: gemini,
        upstreamModel: 'shared-model',
      }),
    );
  });

  it('counts grouped decisions instead of inflating status by model rows', () => {
    const models = Array.from({ length: 54 }, (_, index) => `shared-${index + 1}`);
    expect(
      proxyHubIssueCount({
        conflicts: models.map((model) => ({
          kind: 'model-overlap',
          model,
          catalogIds: ['gemini', 'opencode'],
          candidates: [gemini, openCode],
        })),
        sourceChoices: [],
      }),
    ).toBe(1);
  });

  it('aggregates accounts in one adapter catalog into one explicit source choice', () => {
    const personal: ProxyHubSourceRef = {
      kind: 'account',
      provider: 'opencode',
      name: 'personal',
    };
    const config = hubConfig({
      sources: [
        { ref: openCode, enabled: true },
        { ref: personal, enabled: true },
      ],
    });
    const catalogs = [
      {
        source: openCode,
        catalogId: 'opencode',
        models: ['shared-model', 'work-only'],
      },
      {
        source: personal,
        catalogId: 'opencode',
        models: ['shared-model', 'personal-only'],
      },
    ];

    const compiled = compileProxyHubRoutes(config, catalogs);
    const reordered = compileProxyHubRoutes(config, catalogs.toReversed());

    expect(compiled.conflicts).toEqual([]);
    expect(reordered).toEqual(compiled);
    expect(compiled.sourceChoices).toEqual([
      {
        kind: 'source-choice',
        catalogId: 'opencode',
        models: ['shared-model'],
        candidates: [personal, openCode],
      },
    ]);
    expect(compiled.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'personal-only', source: personal }),
        expect.objectContaining({ model: 'work-only', source: openCode }),
      ]),
    );
    expect(compiled.routes).not.toContainEqual(expect.objectContaining({ model: 'shared-model' }));

    const explicitlyOwned = compileProxyHubRoutes(
      { ...config, modelOwners: [{ model: 'shared-model', source: openCode }] },
      catalogs,
    );
    expect(explicitlyOwned.routes).toContainEqual(
      expect.objectContaining({ model: 'shared-model', source: openCode }),
    );
    expect(explicitlyOwned.sourceChoices).toEqual([]);
  });

  it('detects a conflict by adapter catalog identity even when source provider ids match', () => {
    const personal: ProxyHubSourceRef = {
      kind: 'account',
      provider: 'opencode',
      name: 'personal',
    };
    const config = hubConfig({
      sources: [
        { ref: openCode, enabled: true },
        { ref: personal, enabled: true },
      ],
    });

    const compiled = compileProxyHubRoutes(config, [
      { source: openCode, catalogId: 'opencode-zen', models: ['shared-model'] },
      { source: personal, catalogId: 'opencode-enterprise', models: ['shared-model'] },
    ]);

    expect(compiled.routes).toEqual([]);
    expect(compiled.conflicts).toEqual([
      {
        kind: 'model-overlap',
        model: 'shared-model',
        catalogIds: ['opencode-enterprise', 'opencode-zen'],
        candidates: [personal, openCode],
      },
    ]);
    expect(compiled.sourceChoices).toEqual([]);
  });

  it('plans one Hub endpoint and token-scoped route attachment for an app', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-plan-'));
    app = await createAppReady({ root, skipMigrate: true });
    const config = await app.hub.get();
    await app.hub.save({ ...config, enabled: true });

    const result = await app.bindingService.use('codex', {
      with: 'hub:default',
      model: 'any-model-id',
      dryRun: true,
    });

    expect(result.plan.transport.endpoint).toBe('http://127.0.0.1:4680');
    expect(result.plan.steps.map((step) => step.kind)).toEqual(
      expect.arrayContaining([
        'EnsureProxyHub',
        'AttachProxyHubRoute',
        'WaitForHubHealth',
        'ValidateProxyHubRoute',
      ]),
    );
  });

  it('publishes only safe Hub state and opaque start controls to the tray', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-tray-'));
    app = await createAppReady({ root, skipMigrate: true });
    const config = await app.hub.get();
    await app.hub.save({ ...config, enabled: true });
    const targets = new Map<string, unknown>();

    const tray = await buildTraySnapshot(app, 0, {
      revision: 1,
      register(target) {
        const id = `action-${targets.size}`;
        targets.set(id, target);
        return id;
      },
    });
    const hub = tray.proxies.find((proxy) => proxy.providerId === 'proxy-hub');

    expect(hub).toMatchObject({
      id: 'proxy-hub/default',
      label: 'Proxy Hub',
      running: false,
      enabled: true,
      logsAvailable: true,
      sourceCount: 0,
      modelCount: 0,
    });
    expect(targets.get(hub!.toggleActionId)).toEqual({ operation: 'hub-start', name: 'default' });
    expect(targets.get(hub!.testActionId!)).toEqual({ operation: 'hub-test', name: 'default' });
    expect(tray.hubSources).toEqual([]);
    expect(tray.hubConflicts).toEqual([]);
    expect(tray.logSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'proxy-hub/default',
          providerId: 'proxy-hub',
          name: 'default',
        }),
        expect.objectContaining({
          id: 'tray-supervisor/main',
          providerId: 'tray-supervisor',
          name: 'main',
        }),
      ]),
    );
    expect(tray.logSources.find((source) => source.providerId === 'proxy-hub')?.id).toBe(hub!.id);
    expect(JSON.stringify(tray)).not.toContain('token');
  });

  it('offers each uniquely routed Hub model as a direct client apply action in the tray', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-tray-actions-'));
    const providers = new ProviderRegistry();
    const source = new FakeProvider('hub-source', join(root, 'live', 'hub-source'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    source.createProxyHubBackend = async () => ({
      endpoint: 'http://127.0.0.1:1',
      close: async () => {},
    });
    providers.register(source);
    const clients = new ClientRegistry();
    registerBuiltinClients(clients);
    const catalog = new CatalogRegistry();
    registerBuiltinCatalog(catalog);
    app = await createAppReady({
      root,
      bare: true,
      skipMigrate: true,
      accountRegistry: providers,
      clients,
      catalog,
    });
    await source.setLive({ email: 'hub@example.test', token: 'secret' });
    await app.accounts.save('hub-source', 'work');
    const config = await app.hub.get();
    const sourceRef: ProxyHubSourceRef = {
      kind: 'account',
      provider: 'hub-source',
      name: 'work',
    };
    const saved = await app.hub.save({
      ...config,
      enabled: true,
      sources: [{ ref: sourceRef, enabled: true }],
    });
    const preview = vi.spyOn(app.hub, 'preview').mockResolvedValue({
      config: saved,
      catalogs: [
        { source: sourceRef, catalogId: 'hub-source', models: ['model-one', 'model-two'] },
      ],
      routes: [
        { model: 'model-one', source: sourceRef, upstreamModel: 'model-one' },
        { model: 'model-two', source: sourceRef, upstreamModel: 'model-two' },
      ],
      conflicts: [],
      sourceChoices: [],
      unavailable: [],
    });
    const targets = new Map<string, TrayActionTarget | TrayProxyActionTarget>();

    const tray = await buildTraySnapshot(app, 0, {
      revision: 1,
      register(target) {
        const id = `action-${targets.size}`;
        targets.set(id, target);
        return id;
      },
    });
    const action = tray.actions.find(
      (candidate) => candidate.client === 'Codex' && candidate.routeKind === 'hub',
    );

    expect(action).toMatchObject({
      kind: 'gateway',
      presentation: 'app-route',
      selected: false,
      enabled: true,
      routeKind: 'hub',
      // Soft default is first uniquely-routed model; full catalog stays on Hub.
      modelId: 'model-one',
      upstreamProviderId: 'proxy-hub',
    });
    expect(targets.get(action!.id)).toEqual({
      clientId: 'codex',
      source: 'hub/default',
      model: 'model-one',
      modelRoles: {
        default: 'model-one',
        list2: 'model-one',
        list3: 'model-one',
        list4: 'model-one',
        list5: 'model-one',
      },
    });
    // One Switch action per client for Hub — not one per model.
    expect(tray.actions.filter((a) => a.client === 'Codex' && a.routeKind === 'hub')).toHaveLength(
      1,
    );
    const claudeModels = tray.clientModelConfigs.find(
      (candidate) => candidate.clientId === 'claude',
    );
    expect(claudeModels).toMatchObject({
      client: 'Claude',
      editable: false,
      roles: [
        { id: 'default', label: 'Default' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
        { id: 'haiku', label: 'Haiku' },
      ],
      modelRoles: {},
      options: [],
    });
    expect(tray.hubSources).toEqual([
      expect.objectContaining({
        id: 'hub-source/work',
        providerId: 'hub-source',
        name: 'work',
        enabled: true,
        status: 'ready',
        modelCount: 2,
      }),
    ]);
    expect(tray.logSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'hub-source/work',
          providerId: 'hub-source',
          name: 'work',
        }),
      ]),
    );
    expect(JSON.stringify(tray)).not.toContain('secret');

    await setTrayHubSourceEnabled(app, 'hub-source', 'work', false);
    await expect(app.hub.get()).resolves.toMatchObject({
      enabled: false,
      sources: [{ ref: sourceRef, enabled: false }],
    });
    await setTrayHubSourceEnabled(app, 'hub-source', 'work', true);
    await expect(app.hub.get()).resolves.toMatchObject({
      enabled: true,
      sources: [{ ref: sourceRef, enabled: true }],
    });
    const latest = await app.hub.get();
    preview.mockResolvedValue({
      config: latest,
      catalogs: [],
      routes: [],
      conflicts: [],
      sourceChoices: [],
      unavailable: [{ source: sourceRef, reason: 'catalog unavailable' }],
    });
    const unavailableTray = await buildTraySnapshot(app, 0);
    expect(unavailableTray.hubSources).toEqual([
      expect.objectContaining({
        name: 'work',
        status: 'unavailable',
        modelCount: 0,
        warning: 'catalog unavailable',
      }),
    ]);
  });

  it('groups 54 identical candidate conflicts behind two opaque bulk-owner actions', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-conflict-groups-'));
    const providers = new ProviderRegistry();
    const source = new FakeProvider('hub-source', join(root, 'live', 'hub-source'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    source.createProxyHubBackend = async () => ({
      endpoint: 'http://127.0.0.1:1',
      close: async () => {},
    });
    providers.register(source);
    const clients = new ClientRegistry();
    registerBuiltinClients(clients);
    const catalog = new CatalogRegistry();
    registerBuiltinCatalog(catalog);
    app = await createAppReady({
      root,
      bare: true,
      skipMigrate: true,
      accountRegistry: providers,
      clients,
      catalog,
    });
    await source.setLive({ email: 'work@example.test', token: 'work-secret' });
    await app.accounts.save('hub-source', 'work');
    await source.setLive({ email: 'personal@example.test', token: 'personal-secret' });
    await app.accounts.save('hub-source', 'personal');
    const work = { kind: 'account' as const, provider: 'hub-source', name: 'work' };
    const personal = { kind: 'account' as const, provider: 'hub-source', name: 'personal' };
    const config = await app.hub.get();
    const saved = await app.hub.save({
      ...config,
      enabled: true,
      sources: [
        { ref: work, enabled: true },
        { ref: personal, enabled: true },
      ],
    });
    const shared = Array.from({ length: 54 }, (_, index) => `shared-${index + 1}`);
    const preview = vi.spyOn(app.hub, 'preview').mockResolvedValue({
      config: saved,
      catalogs: [
        { source: work, catalogId: 'hub-source-work', models: [...shared, 'work-only'] },
        { source: personal, catalogId: 'hub-source-personal', models: shared },
      ],
      routes: [{ model: 'work-only', source: work, upstreamModel: 'work-only' }],
      conflicts: shared.map((model) => ({
        kind: 'model-overlap' as const,
        model,
        catalogIds: ['hub-source-personal', 'hub-source-work'],
        candidates: [work, personal],
      })),
      sourceChoices: [],
      unavailable: [],
    });
    const targets = new Map<string, TrayActionTarget | TrayProxyActionTarget>();

    const tray = await buildTraySnapshot(app, 0, {
      revision: 7,
      register(target) {
        const id = `action-${targets.size}`;
        targets.set(id, target);
        return id;
      },
    });

    expect(preview).toHaveBeenCalledTimes(1);
    expect(tray.hubConflicts).toHaveLength(1);
    expect(tray.hubConflicts[0].models).toHaveLength(54);
    expect(tray.hubConflicts[0].candidates).toHaveLength(2);
    for (const candidate of tray.hubConflicts[0].candidates) {
      expect(targets.get(candidate.actionId)).toMatchObject({
        operation: 'hub-own-models',
        name: 'default',
        models: tray.hubConflicts[0].models,
      });
    }
    expect(tray.hubSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'work', status: 'ready', modelCount: 55 }),
        expect.objectContaining({ name: 'personal', status: 'ready', modelCount: 54 }),
      ]),
    );
    expect(
      tray.actions.find((action) => action.client === 'Claude' && action.routeKind === 'hub'),
    ).toMatchObject({
      routeKind: 'hub',
      upstreamProviderId: 'proxy-hub',
      enabled: true,
    });
    // Switch is source-first: model catalog lives on Configure Models options.
    expect(
      tray.actions.filter((action) => action.client === 'Claude' && action.routeKind === 'hub'),
    ).toHaveLength(1);
    expect(JSON.stringify(tray)).not.toContain('work-secret');
    expect(JSON.stringify(tray)).not.toContain('personal-secret');
  });

  it('derives catalog identity from the source adapter for multiple accounts', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-same-catalog-'));
    const providers = new ProviderRegistry();
    const source = new FakeProvider('hub-source', join(root, 'live', 'hub-source'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    source.createProxyHubBackend = async (ctx) => ({
      endpoint:
        ctx.source.kind === 'account' && ctx.source.name === 'personal'
          ? 'http://127.0.0.1:4202'
          : 'http://127.0.0.1:4201',
      close: async () => {},
    });
    providers.register(source);
    app = await createAppReady({
      root,
      bare: true,
      skipMigrate: true,
      accountRegistry: providers,
    });
    await source.setLive({ email: 'work@example.test', token: 'work-secret' });
    await app.accounts.save('hub-source', 'work');
    await source.setLive({ email: 'personal@example.test', token: 'personal-secret' });
    await app.accounts.save('hub-source', 'personal');
    const work = { kind: 'account' as const, provider: 'hub-source', name: 'work' };
    const personal = { kind: 'account' as const, provider: 'hub-source', name: 'personal' };
    const config = await app.hub.get();
    await app.hub.save({
      ...config,
      enabled: true,
      sources: [
        { ref: work, enabled: true },
        { ref: personal, enabled: true },
      ],
    });
    const shared = Array.from({ length: 54 }, (_, index) => `shared-${index + 1}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const accountOnly = String(input).includes(':4202') ? 'personal-only' : 'work-only';
        return new Response(
          JSON.stringify({ data: [...shared, accountOnly].map((id) => ({ id })) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const preview = await app.hub.refreshPreview();

    expect(preview.catalogs.map((catalog) => catalog.catalogId)).toEqual([
      'hub-source',
      'hub-source',
    ]);
    expect(preview.conflicts).toEqual([]);
    expect(preview.routes).toHaveLength(2);
    expect(preview.routes).not.toContainEqual(expect.objectContaining({ model: 'shared-1' }));
    expect(preview.sourceChoices).toEqual([
      {
        kind: 'source-choice',
        catalogId: 'hub-source',
        models: shared.toSorted(),
        candidates: [personal, work],
      },
    ]);

    const owned = await app.hub.setModelOwners('default', shared, work);
    expect(owned.modelOwners).toHaveLength(54);
    const resolved = await app.hub.refreshPreview();
    expect(resolved.sourceChoices).toEqual([]);
    expect(resolved.routes).toHaveLength(56);
    expect(resolved.routes).toContainEqual(
      expect.objectContaining({ model: 'shared-1', source: work }),
    );
  });

  it('persists a bulk owner choice once and rejects stale or non-conflicting candidates', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-bulk-owner-'));
    const providers = new ProviderRegistry();
    const sourceA = new FakeProvider('source-a', join(root, 'live', 'source-a'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    const sourceB = new FakeProvider('source-b', join(root, 'live', 'source-b'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    sourceA.createProxyHubBackend = async () => ({
      endpoint: 'http://127.0.0.1:4101',
      close: async () => {},
    });
    sourceB.createProxyHubBackend = async () => ({
      endpoint: 'http://127.0.0.1:4102',
      close: async () => {},
    });
    providers.register(sourceA);
    providers.register(sourceB);
    app = await createAppReady({
      root,
      bare: true,
      skipMigrate: true,
      accountRegistry: providers,
    });
    await sourceA.setLive({ email: 'a@example.test', token: 'a-secret' });
    await app.accounts.save('source-a', 'work');
    await sourceB.setLive({ email: 'b@example.test', token: 'b-secret' });
    await app.accounts.save('source-b', 'work');
    const refA = { kind: 'account' as const, provider: 'source-a', name: 'work' };
    const refB = { kind: 'account' as const, provider: 'source-b', name: 'work' };
    const config = await app.hub.get();
    const saved = await app.hub.save({
      ...config,
      enabled: true,
      sources: [
        { ref: refA, enabled: true },
        { ref: refB, enabled: true },
      ],
    });
    const shared = Array.from({ length: 54 }, (_, index) => `shared-${index + 1}`);
    const catalogs = new Map([
      ['4101', [...shared, 'a-only']],
      ['4102', [...shared, 'b-only']],
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const key = String(input).includes(':4101') ? '4101' : '4102';
        return new Response(JSON.stringify({ data: catalogs.get(key)!.map((id) => ({ id })) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const owned = await app.hub.setModelOwners('default', shared, refA);
    expect(owned.revision).toBe(saved.revision + 1);
    expect(owned.modelOwners).toHaveLength(54);
    expect(owned.modelOwners).toEqual(
      expect.arrayContaining(shared.map((model) => ({ model, source: refA }))),
    );

    await expect(app.hub.setModelOwners('default', ['a-only'], refA)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    catalogs.set('4102', ['b-only']);
    await expect(app.hub.setModelOwners('default', ['shared-1'], refB)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    await expect(app.hub.get()).resolves.toMatchObject({ revision: owned.revision });
  });

  it('returns a bounded tail of the Hub log', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-logs-'));
    app = await createAppReady({ root, skipMigrate: true });
    const logPath = proxyHubLogPath(root, 'default');
    await mkdir(dirname(logPath), { recursive: true });
    const lines = Array.from({ length: 205 }, (_, index) => `line-${index + 1}`);
    await writeFile(logPath, lines.join('\n'), 'utf8');

    await expect(app.hub.logs('default', 3)).resolves.toBe('line-203\nline-204\nline-205');
    expect((await app.hub.logs('default', 500)).split('\n')).toHaveLength(200);
    await writeFile(logPath, 'only-line\n', 'utf8');
    await expect(app.hub.logs('default', 1)).resolves.toBe('only-line');
    await expect(app.hub.logs('../tray', 3)).rejects.toMatchObject({ code: 'INVALID_USAGE' });
  });

  it('returns exact Tray states for stopped, empty, ready, and failed Hub logs', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-tray-logs-'));
    app = await createAppReady({ root, skipMigrate: true });
    const logPath = proxyHubLogPath(root, 'default');
    const request = {
      version: 1 as const,
      requestId: 'hub-logs',
      providerId: 'proxy-hub',
      name: 'default',
      lines: 80,
    };

    await expect(resolveTrayProxyLogs(app, request)).resolves.toEqual({
      version: 1,
      requestId: 'hub-logs',
      proxyId: 'proxy-hub/default',
      state: 'not-running',
      text: 'Proxy Hub is not running. Start it to create logs.',
    });

    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, '', 'utf8');
    const config = await app.hub.get();
    await app.hub.save(config);
    app.hubStore.saveRuntime({
      name: 'default',
      endpoint: 'http://127.0.0.1:4680',
      pid: process.pid,
      instanceId: 'test-instance',
      logPath,
      startedAt: '2026-08-03T00:00:00.000Z',
    });
    await expect(resolveTrayProxyLogs(app, request)).resolves.toMatchObject({
      proxyId: 'proxy-hub/default',
      state: 'empty',
      text: 'Proxy Hub is running. No log entries yet.',
    });

    await writeFile(logPath, 'route model-a -> account/source 200 12ms\n', 'utf8');
    await expect(resolveTrayProxyLogs(app, request)).resolves.toMatchObject({
      proxyId: 'proxy-hub/default',
      state: 'ready',
      text: 'route model-a -> account/source 200 12ms',
    });

    await rm(logPath);
    await mkdir(logPath);
    await expect(resolveTrayProxyLogs(app, request)).resolves.toMatchObject({
      proxyId: 'proxy-hub/default',
      state: 'error',
      text: 'Could not read Proxy Hub logs. Refresh and try again.',
    });
  });

  it('drops Hub sources and model owners when the saved account is deleted', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-forget-account-'));
    const providers = new ProviderRegistry();
    const source = new FakeProvider('hub-source', join(root, 'live', 'hub-source'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    source.createProxyHubBackend = async () => ({
      endpoint: 'http://127.0.0.1:1',
      close: async () => {},
    });
    providers.register(source);
    app = await createAppReady({
      root,
      bare: true,
      skipMigrate: true,
      accountRegistry: providers,
    });
    await source.setLive({ email: 'keep@example.test', token: 'keep-secret' });
    await app.accounts.save('hub-source', 'keep');
    await source.setLive({ email: 'drop@example.test', token: 'drop-secret' });
    await app.accounts.save('hub-source', 'drop');

    const keep: ProxyHubSourceRef = { kind: 'account', provider: 'hub-source', name: 'keep' };
    const drop: ProxyHubSourceRef = { kind: 'account', provider: 'hub-source', name: 'drop' };
    const config = await app.hub.get();
    await app.hub.save({
      ...config,
      enabled: true,
      sources: [
        { ref: keep, enabled: true },
        { ref: drop, enabled: true },
      ],
      modelOwners: [
        { model: 'shared-model', source: drop },
        { model: 'keep-model', source: keep },
      ],
    });

    await app.accounts.delete('hub-source', 'drop');

    const after = await app.hub.get();
    expect(after.sources).toEqual([{ ref: keep, enabled: true }]);
    expect(after.modelOwners).toEqual([{ model: 'keep-model', source: keep }]);
  });
});
