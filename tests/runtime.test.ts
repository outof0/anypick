import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/core/app';
import type { HotplugApp } from '../src/core/app';
import { ClientRegistry } from '../src/clients/registry';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { buildCodexModelCatalog, codexProfileName, createCodexClient } from '../src/clients/codex';
import { pathExists } from '../src/utils/fs';
import { syntheticProxyProfile } from '../src/clients/isolation';

describe('profile use (switch + apply)', () => {
  let root: string;
  let home: string;
  let app: HotplugApp;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-runtime-'));
    home = join(root, 'home');
    await mkdir(home, { recursive: true });

    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    clients.register(createCodexClient(home));

    app = createApp({ root, clients });

    await app.profiles.create('gw', {
      provider: 'custom',
      apiKey: 'sk-test',
      endpoint: 'https://api.tuongtacfree.vn',
      defaultModel: 'claude-sonnet-5',
      sonnetModel: 'claude-sonnet-5',
      opusModel: 'claude-opus-4-8',
      haikuModel: 'claude-haiku-4-5',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('profile use applies models from profile to default client', async () => {
    const result = await app.runtime.switchProfile('gw');
    expect(result.profileName).toBe('gw');
    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].clientId).toBe('claude');

    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
      env: Record<string, string>;
    };

    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://api.tuongtacfree.vn');
    expect(settings.env.ANTHROPIC_MODEL).toBe('claude-sonnet-5');
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5');
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-8');
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5');
    expect(settings.env.OPENAI_API_KEY).toBeUndefined();

    expect(await app.runtime.activeProfile()).toBe('gw');
  });

  it('profile use --all applies to every client', async () => {
    const result = await app.runtime.switchProfile('gw', { allClients: true });
    expect(result.clients.map((c) => c.clientId).toSorted()).toEqual(['claude', 'codex']);
    expect(await pathExists(join(home, '.claude', 'settings.json'))).toBe(true);
    const codexConfig = await readFile(
      join(home, '.codex', `${codexProfileName('gw')}.config.toml`),
      'utf8',
    );
    expect(codexConfig).toContain('wire_api = "responses"');
    expect(codexConfig).toContain('supports_websockets = false');
  });

  it('clears dual-auth and OPENAI leakage on switch', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: 'old',
            ANTHROPIC_API_KEY: 'conflict',
            OPENAI_API_KEY: 'leak',
          },
        },
        null,
        2,
      ),
    );

    await app.runtime.switchProfile('gw');
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
      env: Record<string, string>;
    };

    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(settings.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('supports dry-run without writing', async () => {
    const result = await app.runtime.switchProfile('gw', { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(await pathExists(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(await app.runtime.activeProfile()).toBeNull();
  });
});

describe('bareModelId', () => {
  it('strips gateway provider prefixes for Claude Code', async () => {
    const { bareModelId } = await import('../src/clients/claude-code');
    expect(bareModelId('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(bareModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('Codex source-scoped profiles', () => {
  it('creates a Codex-compatible catalog for configured gateway models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hotplug-codex-catalog-'));
    const home = join(root, 'home');
    try {
      const client = createCodexClient(home);
      await client.apply({
        profile: {
          ...syntheticProxyProfile({
            name: 'gateway:openrouter',
            endpoint: 'https://openrouter.example/v1',
            apiKey: 'gateway-key',
            defaultModel: 'fast',
          }),
          meta: {
            ...syntheticProxyProfile({
              name: 'gateway:openrouter',
              endpoint: 'https://openrouter.example/v1',
              apiKey: 'gateway-key',
              defaultModel: 'fast',
            }).meta,
            models: {
              fast: 'provider/fast',
              thorough: 'provider/thorough',
            },
          },
        },
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        hotplugRoot: root,
      });

      const profileName = codexProfileName('gateway:openrouter');
      const config = await readFile(join(home, '.codex', `${profileName}.config.toml`), 'utf8');
      expect(config).toContain('model_catalog_json = ');
      const catalog = JSON.parse(
        await readFile(join(home, '.codex', `${profileName}.model-catalog.json`), 'utf8'),
      ) as { models: Array<{ slug: string; display_name: string }> };
      expect(catalog.models.map((model) => model.slug)).toEqual([
        'provider/fast',
        'provider/thorough',
      ]);
      expect(catalog.models[0]?.display_name).toBe('fast (provider/fast)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the official catalog shape required by Codex', () => {
    const catalog = buildCodexModelCatalog([{ slug: 'provider/model' }]) as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models[0]).toMatchObject({
      slug: 'provider/model',
      visibility: 'list',
      shell_type: 'shell_command',
      context_window: 32_768,
    });
  });

  it('adds the live /v1/models catalog from a local proxy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hotplug-codex-live-catalog-'));
    const home = join(root, 'home');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'proxy/fast', name: 'Proxy Fast' },
              { id: 'proxy/thorough', name: 'Proxy Thorough' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });

    try {
      const client = createCodexClient(home);
      await client.apply({
        profile: syntheticProxyProfile({
          name: 'proxy:gemini/work',
          endpoint: 'http://127.0.0.1:4130',
          apiKey: 'hotplug-secret',
        }),
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        hotplugRoot: root,
      });

      const profileName = codexProfileName('proxy:gemini/work');
      const catalog = JSON.parse(
        await readFile(join(home, '.codex', `${profileName}.model-catalog.json`), 'utf8'),
      ) as { models: Array<{ slug: string; display_name: string }> };
      expect(catalog.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: 'proxy/fast', display_name: 'Proxy Fast' }),
          expect.objectContaining({ slug: 'proxy/thorough', display_name: 'Proxy Thorough' }),
        ]),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4130/v1/models'),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer hotplug-secret' }),
        }),
      );
    } finally {
      fetchMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the user config separate and gives each source its own provider identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hotplug-codex-user-model-'));
    const home = join(root, 'home');
    try {
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(
        join(home, '.codex', 'config.toml'),
        'model = "gpt-5.6-terra"\n\n[features]\nfast_mode = true\n',
      );

      const client = createCodexClient(home);
      await client.apply({
        profile: syntheticProxyProfile({
          name: 'proxy:grok/work',
          endpoint: 'https://grok.example/v1',
          apiKey: 'grok-key',
          defaultModel: 'grok/default',
        }),
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        hotplugRoot: root,
      });

      await client.apply({
        profile: syntheticProxyProfile({
          name: 'proxy:gemini/work',
          endpoint: 'https://gemini.example/v1',
          apiKey: 'gemini-key',
          defaultModel: 'gemini/default',
        }),
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        hotplugRoot: root,
      });

      const grokProfile = codexProfileName('proxy:grok/work');
      const geminiProfile = codexProfileName('proxy:gemini/work');
      const [baseConfig, grokConfig, geminiConfig] = await Promise.all([
        readFile(join(home, '.codex', 'config.toml'), 'utf8'),
        readFile(join(home, '.codex', `${grokProfile}.config.toml`), 'utf8'),
        readFile(join(home, '.codex', `${geminiProfile}.config.toml`), 'utf8'),
      ]);
      expect(baseConfig).toContain('model = "gpt-5.6-terra"');
      expect(baseConfig).not.toContain('model_providers.hotplug');
      expect(grokConfig).toContain(`model_provider = "${grokProfile}"`);
      expect(geminiConfig).toContain(`model_provider = "${geminiProfile}"`);
      expect(grokConfig).not.toContain(geminiProfile);
      expect(geminiConfig).not.toContain(grokProfile);
      expect(grokConfig).toMatch(/env_key = "HOTPLUG_CODEX_.*_API_KEY"/);
      expect(geminiConfig).toMatch(/env_key = "HOTPLUG_CODEX_.*_API_KEY"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('injects local proxy limits into Codex official compaction settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hotplug-codex-limits-'));
    const home = join(root, 'home');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'deepseek-v4-flash-free',
          context_window: 200_000,
          auto_compact_token_limit: 180_000,
          max_output_tokens: 128_000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    try {
      const client = createCodexClient(home);
      await client.apply({
        profile: syntheticProxyProfile({
          name: 'proxy:opencode/default',
          endpoint: 'http://127.0.0.1:4122',
          apiKey: 'hotplug-secret',
          defaultModel: 'deepseek-v4-flash-free',
        }),
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        hotplugRoot: root,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4122/models/deepseek-v4-flash-free'),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer hotplug-secret' }),
        }),
      );
      const profileName = codexProfileName('proxy:opencode/default');
      const config = await readFile(join(home, '.codex', `${profileName}.config.toml`), 'utf8');
      expect(config).toContain('model_context_window = 200000');
      // OpenCode caps generated output at 32k, so Codex compacts at 200k - 32k.
      expect(config).toContain('model_auto_compact_token_limit = 168000');
    } finally {
      fetchMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
