import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/core/app';
import type { AnyPickApp } from '../src/core/app';
import { ClientRegistry } from '../src/clients/registry';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { buildCodexModelCatalog, codexProfileName, createCodexClient } from '../src/clients/codex';
import { pathExists } from '../src/utils/fs';
import { syntheticProxyProfile } from '../src/clients/isolation';
import { gatewayRef } from '../src/core/refs';

describe('profile use (switch + apply)', () => {
  let root: string;
  let home: string;
  let app: AnyPickApp;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-runtime-'));
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

  it('resets only AnyPick-managed Claude settings and removes its global route', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { USER_SETTING: 'keep-me' }, theme: 'dark' }),
    );
    await app.runtime.switchProfile('gw');
    app.bindings.upsertGlobal(
      'claude',
      {
        client: 'claude',
        source: gatewayRef('gw'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );

    await expect(app.bindingService.reset('claude')).resolves.toMatchObject({
      client: 'claude',
      removedGlobal: true,
    });
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
      env?: Record<string, string>;
      theme?: string;
      _anypickManaged?: unknown;
    };
    expect(settings).toMatchObject({ env: { USER_SETTING: 'keep-me' }, theme: 'dark' });
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(settings).not.toHaveProperty('_anypickManaged');
    expect(app.bindings.getGlobal('claude')).toBeNull();
  });

  it('keeps the global route when client cleanup fails', async () => {
    const failingRoot = await mkdtemp(join(tmpdir(), 'anypick-reset-failure-'));
    const failingHome = join(failingRoot, 'home');
    await mkdir(failingHome, { recursive: true });
    const clients = new ClientRegistry();
    const claude = createClaudeCodeClient(failingHome);
    clients.register({
      ...claude,
      reset: vi.fn(async () => {
        throw new Error('simulated cleanup failure');
      }),
    });
    const failingApp = createApp({ root: failingRoot, clients, bare: true });
    try {
      failingApp.bindings.upsertGlobal(
        'claude',
        {
          client: 'claude',
          source: gatewayRef('gw'),
          model: { mode: 'omitted' },
          transportPolicy: 'auto',
          clientOptions: {},
        },
        { kind: 'direct' },
      );

      await expect(failingApp.bindingService.reset('claude')).rejects.toThrow(
        'simulated cleanup failure',
      );
      expect(failingApp.bindings.getGlobal('claude')).not.toBeNull();
    } finally {
      failingApp.close();
      await rm(failingRoot, { recursive: true, force: true });
    }
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
  it('keeps the configured Codex catalog separate from runtime role models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-codex-catalog-'));
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
            defaultModel: 'provider/startup-only',
            sonnetModel: 'provider/sonnet-only',
            opusModel: 'provider/opus-only',
            haikuModel: 'provider/haiku-only',
          },
        },
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        anypickRoot: root,
      });

      const profileName = codexProfileName('gateway:openrouter');
      const config = await readFile(join(home, '.codex', `${profileName}.config.toml`), 'utf8');
      expect(config).toContain('model_catalog_json = ');
      expect(config).toContain('model = "provider/startup-only"');
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
      supported_reasoning_levels: [],
      supports_parallel_tool_calls: false,
      input_modalities: ['text'],
    });
    expect(catalog.models[0]).not.toHaveProperty('context_window');
    expect(catalog.models[0]).not.toHaveProperty('default_reasoning_level');
    expect(catalog.models[0]).not.toHaveProperty('apply_patch_tool_type');
  });

  it('publishes capabilities only when model metadata describes them', () => {
    const catalog = buildCodexModelCatalog([
      {
        slug: 'provider/described',
        contextWindow: 200_000,
        maxContextWindow: 400_000,
        autoCompactTokenLimit: 180_000,
        defaultReasoningLevel: 'high',
        supportedReasoningLevels: [{ effort: 'high', description: 'Provider default' }],
        inputModalities: ['text', 'image'],
        supportsParallelToolCalls: true,
        supportsSearchTool: true,
        supportsVerbosity: true,
        supportsImageDetailOriginal: true,
      },
    ]) as { models: Array<Record<string, unknown>> };
    expect(catalog.models[0]).toMatchObject({
      context_window: 200_000,
      max_context_window: 400_000,
      auto_compact_token_limit: 180_000,
      default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'high', description: 'Provider default' }],
      input_modalities: ['text', 'image'],
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      support_verbosity: true,
      supports_image_detail_original: true,
    });
  });

  it('adds the live /v1/models catalog from a local proxy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-codex-live-catalog-'));
    const home = join(root, 'home');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'proxy/fast',
                name: 'Proxy Fast',
                context_window: 200_000,
                auto_compact_token_limit: 168_000,
                input_modalities: ['text', 'image'],
                capabilities: { supports_parallel_tool_calls: true },
              },
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
          apiKey: 'anypick-secret',
        }),
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        anypickRoot: root,
      });

      const profileName = codexProfileName('proxy:gemini/work');
      const catalog = JSON.parse(
        await readFile(join(home, '.codex', `${profileName}.model-catalog.json`), 'utf8'),
      ) as {
        models: Array<{
          slug: string;
          display_name: string;
          context_window?: number;
          auto_compact_token_limit?: number;
          input_modalities?: string[];
          supports_parallel_tool_calls?: boolean;
        }>;
      };
      expect(catalog.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: 'proxy/fast', display_name: 'Proxy Fast' }),
          expect.objectContaining({ slug: 'proxy/thorough', display_name: 'Proxy Thorough' }),
        ]),
      );
      expect(catalog.models.find((model) => model.slug === 'proxy/fast')).toMatchObject({
        context_window: 200_000,
        auto_compact_token_limit: 168_000,
        input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4130/v1/models'),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer anypick-secret' }),
        }),
      );
    } finally {
      fetchMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the user config separate and gives each source its own provider identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-codex-user-model-'));
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
        anypickRoot: root,
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
        anypickRoot: root,
      });

      const grokProfile = codexProfileName('proxy:grok/work');
      const geminiProfile = codexProfileName('proxy:gemini/work');
      const [baseConfig, grokConfig, geminiConfig] = await Promise.all([
        readFile(join(home, '.codex', 'config.toml'), 'utf8'),
        readFile(join(home, '.codex', `${grokProfile}.config.toml`), 'utf8'),
        readFile(join(home, '.codex', `${geminiProfile}.config.toml`), 'utf8'),
      ]);
      expect(baseConfig).toContain('model = "gpt-5.6-terra"');
      expect(baseConfig).not.toContain('model_providers.anypick');
      expect(grokConfig).toContain(`model_provider = "${grokProfile}"`);
      expect(geminiConfig).toContain(`model_provider = "${geminiProfile}"`);
      expect(grokConfig).not.toContain(geminiProfile);
      expect(geminiConfig).not.toContain(grokProfile);
      expect(grokConfig).toMatch(/env_key = "ANYPICK_CODEX_.*_API_KEY"/);
      expect(geminiConfig).toMatch(/env_key = "ANYPICK_CODEX_.*_API_KEY"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('injects local proxy limits into Codex official compaction settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-codex-limits-'));
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
          apiKey: 'anypick-secret',
          defaultModel: 'deepseek-v4-flash-free',
        }),
        clientId: 'codex',
        dryRun: false,
        verbose: false,
        anypickRoot: root,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4122/models/deepseek-v4-flash-free'),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer anypick-secret' }),
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
