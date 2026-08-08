import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import {
  compatibleAppsForGateway,
  gatewayProfileModelRoles,
  loadGateways,
  suggestModelsForGateway,
} from '../src/tui/model';
import { CatalogRegistry, registerBuiltinCatalog } from '../src/catalog/providers';

/**
 * Role defaults and suggestions come from the catalog entry itself, so these
 * helpers need a registry. Passing none is legal (an unknown gateway yields no
 * opinion) — these tests cover the registered path.
 */
const catalog = new CatalogRegistry();
registerBuiltinCatalog(catalog);

describe('gateway model helpers', () => {
  it('gatewayProfileModelRoles fills Claude roles from defaults', () => {
    const roles = gatewayProfileModelRoles(
      { meta: { provider: 'openrouter', defaultModel: 'claude-sonnet-5' } },
      catalog,
    );
    expect(roles.default).toBe('claude-sonnet-5');
    expect(roles.sonnet).toBeTruthy();
    expect(roles.opus).toBeTruthy();
    expect(roles.haiku).toBeTruthy();
  });

  it('suggestModelsForGateway returns unique ids', () => {
    const s = suggestModelsForGateway('openrouter', catalog);
    expect(s.length).toBeGreaterThan(3);
    expect(new Set(s).size).toBe(s.length);
  });
});

describe('loadGateways', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-gw-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('only lists clients compatible with the selected gateway protocol', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const custom = await app.profiles.create('custom-work', {
      provider: 'custom',
      endpoint: 'https://gateway.example/v1',
      apiKey: 'sk-test',
    });
    const openai = await app.profiles.create('openai-work', {
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    expect(compatibleAppsForGateway(app, custom).map((row) => row.clientId)).toContain('claude');
    expect(compatibleAppsForGateway(app, openai).map((row) => row.clientId)).not.toContain(
      'claude',
    );
  });

  it('lists created gateways with model summary', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await app.profiles.create('or-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-5',
      sonnetModel: 'claude-sonnet-5',
      opusModel: 'claude-opus-4-8',
      haikuModel: 'claude-haiku-4-5',
    });

    const rows = await loadGateways(app);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('or-work');
    expect(rows[0].hasApiKey).toBe(true);
    expect(rows[0].modelSummary).toMatch(/claude-sonnet-5/);
    expect(rows[0].endpointShort).toContain('openrouter.ai');
  });
});
