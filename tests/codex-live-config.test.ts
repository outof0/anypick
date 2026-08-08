/**
 * Live Codex config publishing (the `~/.codex/config.toml` managed block).
 *
 * While a proxy/gateway/hub is active the block *takes over* top-level
 * `model_provider` (and `model` when known). The user's previous values are
 * stashed and restored on native account / clear. A user-owned
 * `model_catalog_json` outside the managed block is still never overwritten.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderLiveManagedBlock,
  upsertLiveBlock,
  stripLiveBlock,
  buildLiveCatalog,
  hasTopLevelKeyOutsideLiveBlock,
  extractUserTopLevelDefaults,
  prepareConfigForLiveTakeover,
  restoreUserTopLevelDefaults,
  configTomlPath,
  codexLiveCatalogPath,
  codexUserDefaultsStashPath,
  codexLiveModePath,
  codexProfileName,
  LIVE_BEGIN,
  LIVE_END,
  type LiveCodexProvider,
  type CodexCatalogModel,
} from '../src/clients/codex';
import {
  syncCodexLiveConfig,
  clearCodexLiveConfig,
  restoreCodexLiveForNative,
  publishCodexLiveRoute,
  type CodexLiveConfigDeps,
} from '../src/core/codex-live-config';

const provider: LiveCodexProvider = {
  source: 'hub:default',
  endpoint: 'http://127.0.0.1:9123',
  token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  defaultModel: 'grok-code-fast',
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anypick-codex-live-'));
  await mkdir(join(home, '.codex'), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function routeModel(slug: string, displayName?: string): CodexCatalogModel {
  return {
    slug,
    displayName: displayName ?? slug,
  };
}

describe('renderLiveManagedBlock', () => {
  it('emits exactly one provider table pointing at the active route with an embedded token', () => {
    const block = renderLiveManagedBlock(provider, '/x/catalog.json');
    expect(block.root).toContain(LIVE_BEGIN);
    expect(block.root).toContain(LIVE_END);
    expect(block.providerTable).toMatch(/\[model_providers\.anypick-hub-default-/);
    // Codex appends `/responses` to base_url; the hub only serves `/v1/*`.
    expect(block.providerTable).toContain('base_url = "http://127.0.0.1:9123/v1"');
    expect(block.providerTable).toContain(
      'http_headers = { "Authorization" = "Bearer a1b2c3d4e5f60718293a4b5c6d7e8f90" }',
    );
    expect(block.providerTable).toContain('wire_api = "responses"');
  });

  it('takes over top-level model_provider and model inside the managed block', () => {
    const block = renderLiveManagedBlock(provider, '/x/catalog.json');
    const profileName = codexProfileName(provider.source);
    expect(block.root).toMatch(new RegExp(`^model_provider = "${profileName}"$`, 'm'));
    expect(block.root).toMatch(/^model = "grok-code-fast"$/m);
  });

  it('omits model when the route has no default', () => {
    const block = renderLiveManagedBlock(
      { ...provider, defaultModel: undefined },
      '/x/catalog.json',
    );
    expect(block.root).toMatch(/^model_provider = /m);
    expect(block.root).not.toMatch(/^model = /m);
  });

  it('scopes the catalog insert to the managed block only', () => {
    const withCatalog = renderLiveManagedBlock(provider, '/x/catalog.json', {
      includeCatalog: true,
    });
    const withoutCatalog = renderLiveManagedBlock(provider, '/x/catalog.json', {
      includeCatalog: false,
    });
    expect(withCatalog.root).toMatch(/^model_catalog_json\s*=/m);
    expect(withoutCatalog.root).not.toMatch(/^model_catalog_json\s*=/m);
  });

  it('does not double the /v1 suffix when the endpoint already carries it', () => {
    const block = renderLiveManagedBlock(
      { ...provider, endpoint: 'http://127.0.0.1:9123/v1' },
      '/x/catalog.json',
    );
    expect(block.providerTable).toContain('base_url = "http://127.0.0.1:9123/v1"');
  });
});

describe('upsertLiveBlock / stripLiveBlock round-trip', () => {
  it('inserts the block into empty content and removes it again', () => {
    const block = renderLiveManagedBlock(provider, '/x/catalog.json');
    const inserted = upsertLiveBlock('', block);
    expect(inserted).toContain(LIVE_BEGIN);
    expect(stripLiveBlock(inserted)).toBe('');
  });

  it('preserves unrelated TOML around the block', () => {
    const base = 'approval_policy = "on-request"\n';
    const block = renderLiveManagedBlock(provider, '/x/catalog.json');
    const inserted = upsertLiveBlock(base, block);
    expect(inserted).toContain('approval_policy = "on-request"');
    expect(stripLiveBlock(inserted)).toBe(base);
  });

  it('replaces a previous managed block instead of appending a second one', () => {
    const block = renderLiveManagedBlock(provider, '/x/catalog.json');
    const once = upsertLiveBlock('', block);
    const twice = upsertLiveBlock(once, renderLiveManagedBlock(provider, '/x/catalog.json'));
    expect(twice.match(new RegExp(LIVE_BEGIN, 'g'))?.length).toBe(1);
    expect(twice.match(/\[model_providers\.anypick-/g)?.length).toBe(1);
    expect(twice).toBe(once);
  });

  it('keeps root keys at root scope when the config ends inside a table', () => {
    // Regression: appending at EOF bound model_catalog_json to the trailing
    // [shell_environment_policy.set] table, so Codex never loaded the catalog.
    const base = [
      'approval_policy = "on-request"',
      '',
      '[shell_environment_policy.set]',
      'NODE_REPL_TRUSTED_CODE_PATHS = "/Users/x/.codex"',
      '',
    ].join('\n');
    const next = upsertLiveBlock(base, renderLiveManagedBlock(provider, '/x/catalog.json'));
    const lines = next.split('\n');
    const catalogAt = lines.findIndex((l) => l.startsWith('model_catalog_json ='));
    const firstTableAt = lines.findIndex((l) => l.startsWith('['));
    expect(catalogAt).toBeGreaterThanOrEqual(0);
    expect(catalogAt).toBeLessThan(firstTableAt);
    // The user's table key must not be swallowed by the marker.
    expect(next).toContain('NODE_REPL_TRUSTED_CODE_PATHS = "/Users/x/.codex"');
    expect(next).not.toMatch(/\S# >>> anypick/);
    expect(stripLiveBlock(next)).toBe(base);
  });

  it('round-trips repeatedly without drifting', () => {
    const base =
      'approval_policy = "on-request"\n\n[mcp_servers.figma]\nurl = "https://example.test"\n';
    const block = renderLiveManagedBlock(provider, '/x/catalog.json');
    const once = upsertLiveBlock(base, block);
    const thrice = upsertLiveBlock(upsertLiveBlock(once, block), block);
    expect(thrice).toBe(once);
    expect(stripLiveBlock(thrice)).toBe(base);
  });
});

describe('takeover / stash helpers', () => {
  it('extracts user top-level model and model_provider', () => {
    const content = 'model = "gpt-5.2"\nmodel_provider = "openai"\napproval_policy = "never"\n';
    const stash = extractUserTopLevelDefaults(content);
    expect(stash.had_model).toBe(true);
    expect(stash.had_model_provider).toBe(true);
    expect(stash.model).toBe('gpt-5.2');
    expect(stash.model_provider).toBe('openai');
  });

  it('records absent keys so restore does not invent them', () => {
    const stash = extractUserTopLevelDefaults('approval_policy = "never"\n');
    expect(stash.had_model).toBe(false);
    expect(stash.had_model_provider).toBe(false);
  });

  it('prepareConfigForLiveTakeover removes user model keys then upsert owns them', () => {
    const base = 'model = "gpt-5.2"\nmodel_provider = "openai"\napproval_policy = "never"\n';
    const prepared = prepareConfigForLiveTakeover(base);
    expect(prepared).not.toMatch(/^model\s*=/m);
    expect(prepared).not.toMatch(/^model_provider\s*=/m);
    expect(prepared).toContain('approval_policy = "never"');

    const next = upsertLiveBlock(prepared, renderLiveManagedBlock(provider, '/x/catalog.json'));
    // Exactly one model_provider — inside the managed block.
    expect(next.match(/^model_provider\s*=/gm)?.length).toBe(1);
    expect(next).toContain(LIVE_BEGIN);
    expect(next).toContain('model_provider = "');
  });

  it('restoreUserTopLevelDefaults puts stashed keys back after strip', () => {
    const base = 'model = "gpt-5.2"\nmodel_provider = "openai"\n';
    const stash = extractUserTopLevelDefaults(base);
    const taken = upsertLiveBlock(
      prepareConfigForLiveTakeover(base),
      renderLiveManagedBlock(provider, '/x/catalog.json'),
    );
    const restored = restoreUserTopLevelDefaults(taken, stash);
    expect(restored).toContain('model = "gpt-5.2"');
    expect(restored).toContain('model_provider = "openai"');
    expect(restored).not.toContain(LIVE_BEGIN);
    expect(restored).not.toContain('[model_providers.anypick-');
  });
});

describe('hasTopLevelKeyOutsideLiveBlock', () => {
  it('reports true for user keys outside the managed block', () => {
    const base = 'model = "gpt-5.2"\nmodel_catalog_json = "/user/catalog.json"\n';
    const block = renderLiveManagedBlock(provider, '/x/catalog.json', { includeCatalog: false });
    const content = upsertLiveBlock(base, block);
    expect(hasTopLevelKeyOutsideLiveBlock(content, 'model')).toBe(true);
    expect(hasTopLevelKeyOutsideLiveBlock(content, 'model_catalog_json')).toBe(true);
  });

  it('reports false when the only occurrence is inside the managed block', () => {
    const block = renderLiveManagedBlock(provider, '/x/catalog.json', { includeCatalog: true });
    const content = upsertLiveBlock('', block);
    expect(hasTopLevelKeyOutsideLiveBlock(content, 'model_catalog_json')).toBe(false);
    expect(hasTopLevelKeyOutsideLiveBlock(content, 'model')).toBe(false);
  });

  it('handles content with no managed block at all', () => {
    expect(hasTopLevelKeyOutsideLiveBlock('model = "gpt-5.2"\n', 'model')).toBe(true);
    expect(hasTopLevelKeyOutsideLiveBlock('model = "gpt-5.2"\n', 'model_provider')).toBe(false);
  });

  it('ignores a same-named key nested under a table', () => {
    const content = '[shell_environment_policy.set]\nmodel_catalog_json = "/nested.json"\n';
    expect(hasTopLevelKeyOutsideLiveBlock(content, 'model_catalog_json')).toBe(false);
  });
});

describe('buildLiveCatalog', () => {
  it('publishes only route models tagged with the live provider id', () => {
    const catalog = buildLiveCatalog([routeModel('grok-code-fast')], 'anypick-hub-default-abc');
    const models = catalog.models as Array<{ slug: string; provider?: string }>;
    const slugs = models.map((m) => m.slug);
    expect(slugs).toEqual(['grok-code-fast']);
    // Stock GPT ids must not appear — they drown Hub models and 404 on the Hub.
    expect(slugs.some((s) => s.startsWith('gpt-'))).toBe(false);
    expect(models[0]?.provider).toBe('anypick-hub-default-abc');
  });

  it('keeps the route display name', () => {
    const catalog = buildLiveCatalog(
      [routeModel('grok-code-fast', 'Routed Grok')],
      'anypick-hub-default-abc',
    );
    const entry = (catalog.models as Array<{ slug: string; display_name: string }>).find(
      (m) => m.slug === 'grok-code-fast',
    );
    expect(entry?.display_name).toBe('Routed Grok');
  });
});

describe('syncCodexLiveConfig', () => {
  function deps(): CodexLiveConfigDeps {
    return {
      hub: {
        getAttachedRoute: () => null,
        status: async () => ({
          name: 'default',
          enabled: true,
          running: false,
          sourceCount: 0,
          modelCount: 0,
          conflictCount: 0,
          revision: 0,
        }),
      },
      proxy: { listProxyRows: async () => [] },
      accounts: {
        getAccount: async () => null,
        readProxyState: async () => null,
      },
      accountRegistry: { get: () => undefined },
      home,
    };
  }

  it('clearCodexLiveConfig restores stashed defaults and drops the managed block', async () => {
    const configPath = configTomlPath(home);
    const catalogPath = codexLiveCatalogPath(home);
    await writeFile(configPath, 'model = "gpt-5.2"\nmodel_provider = "openai"\n', 'utf8');

    // Simulate a prior takeover so stash exists and managed block is present.
    await publishCodexLiveRoute(deps(), provider);

    const mid = await readFile(configPath, 'utf8');
    expect(mid).toContain(LIVE_BEGIN);
    expect(mid).toMatch(/^model_provider = "anypick-/m);

    await clearCodexLiveConfig(deps());

    const next = await readFile(configPath, 'utf8');
    expect(next).toContain('model = "gpt-5.2"');
    expect(next).toContain('model_provider = "openai"');
    expect(next).not.toContain(LIVE_BEGIN);
    await expect(readFile(catalogPath, 'utf8')).rejects.toThrow();
  });

  it('deletes the whole config file when stripping leaves nothing', async () => {
    const configPath = configTomlPath(home);
    // Empty user config + published block only.
    await publishCodexLiveRoute(deps(), { ...provider, defaultModel: undefined });
    await clearCodexLiveConfig(deps());

    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });

  it('sync with nothing resolvable clears a leftover managed block', async () => {
    const configPath = configTomlPath(home);
    await writeFile(configPath, 'model = "gpt-5.2"\n', 'utf8');
    // Manually seed a managed block without a sticky route / hub / proxy.
    const seeded = upsertLiveBlock(
      prepareConfigForLiveTakeover(await readFile(configPath, 'utf8')),
      renderLiveManagedBlock(provider, codexLiveCatalogPath(home)),
    );
    await writeFile(configPath, seeded, 'utf8');
    await writeFile(
      codexUserDefaultsStashPath(home),
      JSON.stringify({
        version: 1,
        had_model: true,
        had_model_provider: false,
        model: 'gpt-5.2',
      }),
      'utf8',
    );

    await syncCodexLiveConfig(deps());

    const next = await readFile(configPath, 'utf8');
    expect(next).toContain('model = "gpt-5.2"');
    expect(next).not.toContain(LIVE_BEGIN);
  });

  it('takes over top-level model_provider only when Codex binding is the Hub', async () => {
    const configPath = configTomlPath(home);
    await writeFile(configPath, 'model = "gpt-5.2"\nmodel_provider = "openai"\n', 'utf8');

    const d = deps();
    d.getCodexSource = () => ({ kind: 'proxy-hub', name: 'default' });
    d.hub.getAttachedRoute = () => ({
      routeId: 'global/codex',
      manifest: {
        version: 1,
        hub: 'default',
        revision: 0,
        client: 'codex' as const,
        protocol: 'openai' as const,
        routes: [
          {
            model: 'grok-code-fast',
            source: { kind: 'account', provider: 'grok', name: 'primary' },
            upstreamModel: 'grok-code-fast',
          },
        ],
      },
      token: provider.token,
    });
    d.hub.status = async () => ({
      name: 'default',
      enabled: true,
      running: true,
      endpoint: 'http://127.0.0.1:1',
      sourceCount: 1,
      modelCount: 1,
      conflictCount: 0,
      revision: 0,
    });

    await expect(syncCodexLiveConfig(d)).resolves.toBeUndefined();
    const next = await readFile(configPath, 'utf8');
    // User defaults stashed and removed from outside; managed block owns provider.
    expect(next).toContain('[model_providers.anypick-hub-default-');
    expect(next).toMatch(/^model_provider = "anypick-hub-default-/m);
    // Outside the managed block the user's openai assignment is gone.
    expect(hasTopLevelKeyOutsideLiveBlock(next, 'model_provider')).toBe(false);
    expect(hasTopLevelKeyOutsideLiveBlock(next, 'model')).toBe(false);
    // Stash file holds the previous defaults.
    const stashRaw = await readFile(codexUserDefaultsStashPath(home), 'utf8');
    const stash = JSON.parse(stashRaw) as {
      model?: string;
      model_provider?: string;
      had_model: boolean;
    };
    expect(stash.had_model).toBe(true);
    expect(stash.model).toBe('gpt-5.2');
    expect(stash.model_provider).toBe('openai');
  });

  it('ignores a leftover global/codex hub route when Codex binding is a different source', async () => {
    const configPath = configTomlPath(home);
    await writeFile(configPath, 'model = "gpt-5.2"\nmodel_provider = "openai"\n', 'utf8');

    const d = deps();
    // Binding says gemini account proxy — Claude may still hold a Hub route.
    d.getCodexSource = () => ({ kind: 'account', provider: 'gemini', name: 'stacktify' });
    d.hub.getAttachedRoute = () => ({
      routeId: 'global/codex',
      manifest: {
        version: 1,
        hub: 'default',
        revision: 0,
        client: 'codex' as const,
        protocol: 'openai' as const,
        routes: [
          {
            model: 'big-pickle',
            source: { kind: 'account', provider: 'opencode', name: 'default' },
            upstreamModel: 'big-pickle',
          },
        ],
      },
      token: provider.token,
    });
    d.hub.status = async () => ({
      name: 'default',
      enabled: true,
      running: true,
      endpoint: 'http://127.0.0.1:4680',
      sourceCount: 1,
      modelCount: 1,
      conflictCount: 0,
      revision: 0,
    });
    // gemini proxy not running → nothing to publish → clear.
    await syncCodexLiveConfig(d, { forceRouted: true });
    const next = await readFile(configPath, 'utf8');
    expect(next).not.toContain(LIVE_BEGIN);
    expect(next).not.toContain('hub-default');
    expect(next).toContain('model = "gpt-5.2"');
  });

  it('does not re-publish while mode is native even if Codex is bound to the Hub', async () => {
    const configPath = configTomlPath(home);
    await writeFile(configPath, 'model = "gpt-5.2"\nmodel_provider = "openai"\n', 'utf8');

    const d = deps();
    d.getCodexSource = () => ({ kind: 'proxy-hub', name: 'default' });
    d.hub.getAttachedRoute = () => ({
      routeId: 'global/codex',
      manifest: {
        version: 1,
        hub: 'default',
        revision: 0,
        client: 'codex' as const,
        protocol: 'openai' as const,
        routes: [],
      },
      token: provider.token,
    });
    d.hub.status = async () => ({
      name: 'default',
      enabled: true,
      running: true,
      endpoint: 'http://127.0.0.1:1',
      sourceCount: 0,
      modelCount: 0,
      conflictCount: 0,
      revision: 0,
    });

    // First take over, then switch to native.
    await syncCodexLiveConfig(d, { forceRouted: true });
    expect(await readFile(configPath, 'utf8')).toContain(LIVE_BEGIN);

    await restoreCodexLiveForNative(d);
    const afterNative = await readFile(configPath, 'utf8');
    expect(afterNative).toContain('model = "gpt-5.2"');
    expect(afterNative).toContain('model_provider = "openai"');
    expect(afterNative).not.toContain(LIVE_BEGIN);

    // Lifecycle re-sync must not undo native.
    await syncCodexLiveConfig(d);
    const stillNative = await readFile(configPath, 'utf8');
    expect(stillNative).toContain('model_provider = "openai"');
    expect(stillNative).not.toContain(LIVE_BEGIN);

    // Activation binding a proxy again force-routes.
    await syncCodexLiveConfig(d, { forceRouted: true });
    expect(await readFile(configPath, 'utf8')).toContain(LIVE_BEGIN);
    expect(await readFile(codexLiveModePath(home), 'utf8')).toContain('"routed"');
  });

  it('publishCodexLiveRoute writes gateway takeover and sticky route', async () => {
    const configPath = configTomlPath(home);
    await writeFile(configPath, 'model = "gpt-5.2"\n', 'utf8');

    await publishCodexLiveRoute(deps(), {
      source: 'gateway:openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      token: 'sk-test',
      defaultModel: 'openrouter/auto',
    });

    const next = await readFile(configPath, 'utf8');
    expect(next).toMatch(/^model_provider = "anypick-gateway-openrouter-/m);
    expect(next).toMatch(/^model = "openrouter\/auto"$/m);
    expect(next).toContain('base_url = "https://openrouter.ai/api/v1"');
  });
});
