import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from '../src/utils/fs';
import { modelRolesFromClientOptions } from '../src/clients/model-roles';
import { syntheticProxyProfile } from '../src/clients/isolation';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { createAppReady } from '../src/core/app';
import { gatewayRef } from '../src/core/refs';

describe('claude apply with role models', () => {
  let home: string;
  let hotplugRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hotplug-claude-home-'));
    hotplugRoot = await mkdtemp(join(tmpdir(), 'hotplug-root-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(hotplugRoot, { recursive: true, force: true });
  });

  it('writes ANTHROPIC_* model env for all roles', async () => {
    const client = createClaudeCodeClient(home);
    const profile = syntheticProxyProfile({
      name: 'proxy:grok/work',
      endpoint: 'http://127.0.0.1:9090',
      apiKey: 'hotplug-proxy',
      modelRoles: {
        default: 'grok-4.5',
        sonnet: 'grok-4.5',
        opus: 'grok-4.5',
        haiku: 'grok-4.3',
      },
    });
    await client.apply({
      profile,
      clientId: 'claude',
      dryRun: false,
      verbose: false,
      hotplugRoot,
      proxyEndpoint: 'http://127.0.0.1:9090',
    });

    const settingsPath = join(home, '.claude', 'settings.json');
    expect(await pathExists(settingsPath)).toBe(true);
    const doc = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env?: Record<string, string>;
    };
    expect(doc.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9090');
    expect(doc.env?.ANTHROPIC_MODEL).toBe('grok-4.5');
    expect(doc.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('grok-4.5');
    expect(doc.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('grok-4.5');
    expect(doc.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('grok-4.3');
  });

  it('leaves auto-compaction on Claude Code auto for role models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const client = createClaudeCodeClient(home);
      const profile = syntheticProxyProfile({
        name: 'proxy:opencode/default',
        endpoint: 'http://127.0.0.1:4122',
        apiKey: 'hotplug-secret',
        modelRoles: {
          default: 'deepseek-v4-flash-free',
          sonnet: 'deepseek-v4-flash-free',
          opus: 'kimi-k3',
          haiku: 'mimo-v2.5-free',
        },
      });
      const applied = await client.apply({
        profile,
        clientId: 'claude',
        dryRun: false,
        verbose: false,
        hotplugRoot,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      const settingsPath = join(home, '.claude', 'settings.json');
      const doc = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>;
        _hotplugManaged?: { keys?: string[] };
      };
      expect(doc.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(doc.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
      expect(doc._hotplugManaged?.keys).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      expect(applied.managedEnvKeys).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('removes a previously Hotplug-managed auto-compact window', async () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' },
        _hotplugManaged: {
          keys: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
          updatedAt: new Date().toISOString(),
        },
      }),
      'utf8',
    );

    const client = createClaudeCodeClient(home);
    const profile = syntheticProxyProfile({
      name: 'proxy:opencode/default',
      endpoint: 'http://127.0.0.1:4122',
      apiKey: 'hotplug-secret',
      defaultModel: 'deepseek-v4-flash-free',
    });
    const applied = await client.apply({
      profile,
      clientId: 'claude',
      dryRun: false,
      verbose: false,
      hotplugRoot,
    });

    const doc = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env: Record<string, string>;
      _hotplugManaged?: { keys?: string[] };
    };
    expect(doc.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(doc._hotplugManaged?.keys).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(applied.managedEnvKeys).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  it('preserves an explicit user auto-compact window without probing metadata', async () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } }),
      'utf8',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    try {
      const client = createClaudeCodeClient(home);
      const profile = syntheticProxyProfile({
        name: 'proxy:opencode/default',
        endpoint: 'http://127.0.0.1:4122',
        apiKey: 'hotplug-secret',
        defaultModel: 'deepseek-v4-flash-free',
      });
      await client.apply({
        profile,
        clientId: 'claude',
        dryRun: false,
        verbose: false,
        hotplugRoot,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      const doc = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>;
        _hotplugManaged?: { keys?: string[] };
      };
      expect(doc.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
      expect(doc._hotplugManaged?.keys).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('bindingService.use persists modelRoles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-roles-bind-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores clientOptions.modelRoles on global binding', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await app.profiles.create('or-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-5',
    });

    const roles = {
      default: 'claude-sonnet-5',
      sonnet: 'claude-sonnet-5',
      opus: 'claude-opus-4-8',
      haiku: 'claude-haiku-4-5',
    };

    await app.bindingService.use('claude', {
      with: 'or-work',
      modelRoles: roles,
    });

    const row = app.bindingService.current('claude')[0];
    expect(row?.binding?.spec.model).toEqual({
      mode: 'explicit',
      id: 'claude-sonnet-5',
    });
    expect(modelRolesFromClientOptions(row?.binding?.spec.clientOptions)).toEqual(roles);
  });

  it('keeps a source-scoped resume setup after the client moves elsewhere', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await app.profiles.create('or-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'hy3-free',
    });
    await app.profiles.create('other-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-5.6-sol',
    });

    const rememberedRoles = {
      default: 'hy3-free',
      sonnet: 'hy3-free',
      opus: 'hy3-free',
      haiku: 'hy3-free',
    };
    await app.bindingService.use('claude', {
      with: 'or-work',
      modelRoles: rememberedRoles,
    });
    await app.bindingService.use('claude', {
      with: 'other-work',
      model: 'gpt-5.6-sol',
    });

    const resumes = app.bindings.listSourceResumes(gatewayRef('or-work'));
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.client).toBe('claude');
    expect(resumes[0]?.spec.model).toEqual({
      mode: 'explicit',
      id: 'hy3-free',
    });
    expect(modelRolesFromClientOptions(resumes[0]?.spec.clientOptions)).toEqual(rememberedRoles);
  });

  it('re-syncs ~/.claude/settings.json on already-active use (drift repair)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hotplug-claude-home-'));
    try {
      const { ClientRegistry } = await import('../src/clients/registry');
      const clients = new ClientRegistry();
      clients.register(createClaudeCodeClient(home));
      const app = await createAppReady({ root, skipMigrate: true, clients });
      await app.profiles.create('or-work', {
        provider: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-test',
        defaultModel: 'claude-sonnet-5',
      });

      await app.bindingService.use('claude', {
        with: 'or-work',
        model: 'claude-sonnet-5',
      });

      const settingsPath = join(home, '.claude', 'settings.json');
      const ok = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>;
      };
      expect(ok.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api/v1');

      // Drift: something else overwrote settings (like user / Claude UI)
      ok.env.ANTHROPIC_BASE_URL = 'https://wrong.example/v1';
      ok.env.ANTHROPIC_AUTH_TOKEN = 'sk-wrong';
      await writeFile(settingsPath, JSON.stringify(ok, null, 2), 'utf8');

      // Same binding → alreadyActive, but must repair settings.json
      const again = await app.bindingService.use('claude', {
        with: 'or-work',
        model: 'claude-sonnet-5',
      });
      expect(again.alreadyActive).toBe(true);

      const fixed = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>;
      };
      expect(fixed.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api/v1');
      expect(fixed.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
