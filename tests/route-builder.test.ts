import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinCatalog, CatalogRegistry } from '../src/catalog/providers';
import { ClientRegistry, registerBuiltinClients } from '../src/clients';
import { buildClientRows } from '../src/cli/launcher-model';
import { createAppReady, type AnyPickApp } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import {
  loadCompatibleSources,
  modelSuggestionsForRoute,
  routeNeedsModelSelection,
  routePlanLines,
} from '../src/tui/model';
import { accountProviderPriority, buildTraySnapshot } from '../src/tray/snapshot';
import type { TrayActionTarget, TrayProxyActionTarget } from '../src/tray/snapshot-types';
import { buildTrayUsage } from '../src/tray/snapshot-usage';
import { FakeProvider } from './helpers';

describe('app route builder', () => {
  let root: string | undefined;
  let app: AnyPickApp | undefined;

  afterEach(async () => {
    app?.close();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prioritizes native account pickers for Codex and Claude before Gemini', () => {
    expect(
      [
        { providerId: 'gemini', sourceId: 'gemini-cli' },
        { providerId: 'claude', sourceId: 'claude-code' },
        { providerId: 'codex', sourceId: 'codex' },
      ].map(accountProviderPriority),
    ).toEqual([2, 1, 0]);
  });

  it('only lists source/client pairs accepted by transportFor', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-routes-'));
    const providers = new ProviderRegistry();
    const proxyProvider = new FakeProvider('borrowable', join(root, 'live', 'borrowable'), {
      withProxy: true,
      defaultProxyPort: 0,
    });
    const nativeOnly = new FakeProvider('native-only', join(root, 'live', 'native-only'));
    providers.register(proxyProvider);
    providers.register(nativeOnly);
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

    await proxyProvider.setLive({ email: 'proxy@example.test', token: 'secret' });
    await app.accounts.save('borrowable', 'work');
    await nativeOnly.setLive({ email: 'native@example.test', token: 'secret' });
    await app.accounts.save('native-only', 'personal');

    const rows = await loadCompatibleSources(app, 'codex');
    expect(rows.map((row) => row.label)).toContain('borrowable · work');
    expect(rows.map((row) => row.label)).not.toContain('native-only · personal');
  });

  it('shows an active native Codex login instead of reporting not connected', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-native-client-'));
    const providers = new ProviderRegistry();
    const codex = new FakeProvider('codex', join(root, 'live', 'codex'));
    providers.register(codex);
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
    await codex.setLive({ email: 'native@example.test', token: 'secret' });
    await app.accounts.save('codex', 'personal');

    const row = (await buildClientRows(app)).find((client) => client.clientId === 'codex');
    expect(row).toMatchObject({
      status: 'native',
      source: 'native login',
      nativeIdentity: 'native@example.test',
    });
    const tray = await buildTraySnapshot(app, 0);
    expect(tray.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: 'Codex', source: 'codex · personal', status: 'native' }),
      ]),
    );
    expect(JSON.stringify(tray)).not.toContain('secret');

    const nativeTargets = new Map<string, TrayActionTarget | TrayProxyActionTarget>();
    const trayWithActions = await buildTraySnapshot(app, 0, {
      revision: 3,
      register: (target) => {
        const id = `native-${nativeTargets.size}`;
        nativeTargets.set(id, target);
        return id;
      },
    });
    const nativeAction = trayWithActions.actions.find(
      (candidate) => candidate.client === 'Codex' && candidate.kind === 'native',
    );
    expect(nativeAction).toMatchObject({
      label: 'codex · personal',
      presentation: 'app-route',
      selected: true,
      enabled: true,
      routeKind: 'direct-account',
      upstreamProviderId: 'codex',
      upstreamSourceLabel: 'codex · personal',
    });
    expect(nativeTargets.get(nativeAction!.id)).toEqual({
      clientId: 'codex',
      source: 'account/codex/personal',
    });
    expect(JSON.stringify(trayWithActions)).not.toContain('account/codex/personal');

    vi.spyOn(app.accounts, 'liveUsage').mockResolvedValue({
      windows: [
        { label: '5h', remainingPercent: 82, resetsAtMs: Date.now() + 3_600_000 },
        { label: 'weekly', remainingPercent: 61 },
      ],
    });
    await expect(buildTrayUsage(app)).resolves.toEqual([
      expect.objectContaining({
        client: 'Codex',
        account: 'personal',
        windows: expect.arrayContaining([
          expect.objectContaining({ label: '5h', remainingPercent: 82 }),
          expect.objectContaining({ label: 'weekly', remainingPercent: 61 }),
        ]),
      }),
    ]);

    const source = (await loadCompatibleSources(app, 'codex')).find(
      (candidate) => candidate.ref.kind === 'account',
    );
    expect(source).toMatchObject({ category: 'native', transport: 'direct' });
    expect(routeNeedsModelSelection(source!)).toBe(false);
    const plan = await app.bindingService.use('codex', {
      with: source!.value,
      dryRun: true,
      verbose: true,
    });
    expect(routePlanLines(plan.plan, {}, { nativeAccount: true }).join('\n')).not.toMatch(
      /^Model\s/m,
    );

    await app.bindingService.use('codex', { with: source!.value });
    await codex.setLive({ email: 'other@example.test', token: 'other-secret' });
    await app.accounts.save('codex', 'other');
    const driftedTray = await buildTraySnapshot(app, 0);
    expect(driftedTray.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: 'Codex', source: 'codex · other', status: 'attention' }),
      ]),
    );
    expect(
      driftedTray.actions.find(
        (candidate) => candidate.client === 'Codex' && candidate.label === 'codex · other',
      ),
    ).toMatchObject({ selected: true });
    expect(
      driftedTray.actions.find(
        (candidate) => candidate.client === 'Codex' && candidate.label === 'codex · personal',
      ),
    ).toMatchObject({ selected: false });
    expect(JSON.stringify(driftedTray)).not.toContain('other-secret');
  });

  it('keeps non-routing clients in the native-account tray section', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-native-only-tray-'));
    const providers = new ProviderRegistry();
    const gemini = new FakeProvider('gemini', join(root, 'live', 'gemini'));
    providers.register(gemini);
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
    await gemini.setLive({ email: 'gemini@example.test', token: 'secret' });
    await app.accounts.save('gemini', 'personal');

    const hidden = await buildTraySnapshot(app, 0, undefined, {
      isNativeSourceInstalled: async () => false,
    });
    expect(hidden.actions.some((action) => action.client === 'Gemini')).toBe(false);

    const tray = await buildTraySnapshot(app, 0, undefined, {
      isNativeSourceInstalled: async () => true,
    });
    const geminiActions = tray.actions.filter((action) => action.client === 'Gemini');
    expect(geminiActions).toEqual([
      expect.objectContaining({
        label: 'gemini · personal',
        kind: 'native',
        presentation: 'native-account',
        selected: true,
      }),
    ]);
  });

  it('surfaces provider-only accounts like Grok under native-account actions', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-provider-only-tray-'));
    const providers = new ProviderRegistry();
    const grok = new FakeProvider('grok', join(root, 'live', 'grok'));
    providers.register(grok);
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
    await grok.setLive({ email: 'grok@example.test', token: 'secret' });
    await app.accounts.save('grok', 'work');

    const tray = await buildTraySnapshot(app, 0);
    const grokActions = tray.actions.filter((action) => action.clientId === 'grok');
    expect(grokActions).toEqual([
      expect.objectContaining({
        clientId: 'grok',
        sourceId: 'grok',
        label: 'grok · work',
        kind: 'native',
        presentation: 'native-account',
        selected: true,
      }),
    ]);
  });

  it('offers every configured gateway model and renders a secret-free plan summary', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-route-models-'));
    app = await createAppReady({ root, skipMigrate: true });
    await app.profiles.create('router-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'must-not-appear',
      defaultModel: 'anthropic/claude-sonnet-4',
      models: {
        startup: 'anthropic/claude-sonnet-4',
        gpt: 'openai/gpt-5.6-sol',
        gemini: 'google/gemini-3.1-pro',
      },
    });

    const source = (await loadCompatibleSources(app, 'codex')).find(
      (row) => row.label === 'router-work',
    );
    expect(source).toBeDefined();
    expect(source).toMatchObject({ category: 'gateway' });
    expect(routeNeedsModelSelection(source!)).toBe(true);
    const models = await modelSuggestionsForRoute(app, source!);
    expect(models.suggestions).toEqual(
      expect.arrayContaining([
        'anthropic/claude-sonnet-4',
        'openai/gpt-5.6-sol',
        'google/gemini-3.1-pro',
      ]),
    );

    const result = await app.bindingService.use('codex', {
      with: source!.value,
      model: 'openai/gpt-5.6-sol',
      modelRoles: { default: 'openai/gpt-5.6-sol' },
      dryRun: true,
      verbose: true,
    });
    const summary = routePlanLines(result.plan, { default: 'openai/gpt-5.6-sol' }).join('\n');
    expect(summary).toContain('router-work');
    expect(summary).toContain('openai/gpt-5.6-sol');
    expect(summary).not.toContain('must-not-appear');

    await app.bindingService.use('codex', {
      with: source!.value,
      model: 'openai/gpt-5.6-sol',
      modelRoles: { default: 'openai/gpt-5.6-sol' },
    });
    await app.bindingService.use('claude', {
      with: source!.value,
      model: 'anthropic/claude-sonnet-4',
      modelRoles: {
        default: 'anthropic/claude-sonnet-4',
        opus: 'openai/gpt-5.6-sol',
      },
    });
    const targets = new Map<string, TrayActionTarget | TrayProxyActionTarget>();
    const tray = await buildTraySnapshot(app, 1, {
      revision: 7,
      register: (target) => {
        const id = `00000000-0000-4000-8000-${String(targets.size).padStart(12, '0')}`;
        targets.set(id, target);
        return id;
      },
    });
    expect(tray.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: 'Codex',
          source: 'router-work',
          model: 'openai/gpt-5.6-sol',
          status: 'ready',
        }),
      ]),
    );
    const action = tray.actions.find(
      (candidate) => candidate.client === 'Codex' && candidate.label === 'router-work',
    );
    expect(action).toMatchObject({
      kind: 'gateway',
      presentation: 'app-route',
      selected: true,
      enabled: true,
      routeKind: 'gateway',
      // Current binding model surfaces for display; switch is still one source action.
      modelId: 'openai/gpt-5.6-sol',
      upstreamProviderId: 'openrouter',
      upstreamSourceLabel: 'router-work',
    });
    expect(action?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(tray.revision).toBe(7);
    // Selected source re-emits the active binding (not a per-model fan-out list).
    expect(targets.get(action!.id)).toEqual({
      clientId: 'codex',
      source: 'gateway/router-work',
      model: 'openai/gpt-5.6-sol',
      modelRoles: { default: 'openai/gpt-5.6-sol' },
    });
    // One Switch action for this gateway — models live under Configure Models.
    expect(
      tray.actions.filter(
        (candidate) => candidate.client === 'Codex' && candidate.label === 'router-work',
      ),
    ).toHaveLength(1);
    const claudeModels = tray.clientModelConfigs.find(
      (candidate) => candidate.clientId === 'claude',
    );
    expect(claudeModels).toMatchObject({
      sourceLabel: 'router-work',
      editable: true,
      defaultModel: 'anthropic/claude-sonnet-4',
      modelRoles: {
        default: 'anthropic/claude-sonnet-4',
        opus: 'openai/gpt-5.6-sol',
      },
    });
    // Configure Models lists the gateway catalog (configured + live when
    // available). Switch itself is still one source action above.
    expect(claudeModels?.options.map((option) => option.modelId)).toEqual(
      expect.arrayContaining([
        'anthropic/claude-sonnet-4',
        'google/gemini-3.1-pro',
        'openai/gpt-5.6-sol',
      ]),
    );
    expect(
      targets.get(
        claudeModels!.options.find((option) => option.modelId === 'google/gemini-3.1-pro')!
          .actionId,
      ),
    ).toEqual({
      clientId: 'claude',
      source: 'gateway/router-work',
      model: 'google/gemini-3.1-pro',
    });
    expect(JSON.stringify(tray)).not.toContain('must-not-appear');
    expect(JSON.stringify(tray)).not.toContain('openrouter.ai');
    expect(JSON.stringify(tray)).not.toContain('gateway/router-work');
  });
});
