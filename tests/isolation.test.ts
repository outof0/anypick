import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  createTempRuntimeRoot,
  materializeIsolatablePaths,
  resolveSafeDestination,
  syntheticProxyProfile,
} from '../src/clients/isolation';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { codexProfileName, createCodexClient } from '../src/clients/codex';
import { createKiroClient } from '../src/clients/kiro';
import { ClientRegistry } from '../src/clients/registry';
import { pathExists, readJsonFile } from '../src/utils/fs';
import { gatewayTransportFor } from '../src/sources/gateway-adapters';
import type { ResolvedClientPlan, SourceAdapter } from '../src/types';
import { accountRef } from '../src/core/refs';

describe('isolation path safety', () => {
  it('rejects destination path traversal', () => {
    expect(() => resolveSafeDestination('/tmp/rt', '../escape')).toThrow(/escapes/);
    expect(() => resolveSafeDestination('/tmp/rt', 'a/../../b')).toThrow(/escapes/);
    expect(() => resolveSafeDestination('/tmp/rt', '/abs')).toThrow(/relative/);
  });

  it('accepts nested relative destinations', () => {
    expect(resolveSafeDestination('/tmp/rt', '.claude/settings.json')).toContain('settings.json');
  });

  it('refuses to copy symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iso-sym-'));
    try {
      const target = join(root, 'secret.txt');
      const link = join(root, 'link.txt');
      await writeFile(target, 'secret', { mode: 0o600 });
      await symlink(target, link);
      const runtime = await createTempRuntimeRoot('iso-test-');
      await expect(
        materializeIsolatablePaths(runtime, [
          {
            sourcePath: link,
            destinationPath: 'out.txt',
            kind: 'file',
            required: true,
          },
        ]),
      ).rejects.toThrow(/symlink/);
      await rm(runtime, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('client isolation capabilities', () => {
  it('all three clients report supportsIsolatedHome and implement methods', async () => {
    for (const client of [createClaudeCodeClient(), createCodexClient(), createKiroClient()]) {
      expect(client.capabilities?.supportsIsolatedHome).toBe(true);
      expect(client.listIsolatablePaths).toBeTypeOf('function');
      expect(client.createIsolatedRuntime).toBeTypeOf('function');
      expect(client.applyPersistent).toBeTypeOf('function');
      const paths = await client.listIsolatablePaths!({ home: homedir() });
      expect(Array.isArray(paths)).toBe(true);
    }
  });
});

describe('claude isolated runtime does not touch live settings', () => {
  let liveHome: string;
  let hotplugRoot: string;

  beforeEach(async () => {
    liveHome = await mkdtemp(join(tmpdir(), 'claude-live-'));
    hotplugRoot = await mkdtemp(join(tmpdir(), 'claude-hotplug-'));
    await mkdir(join(liveHome, '.claude'), { recursive: true });
    await writeFile(
      join(liveHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { KEEP_ME: 'yes' }, other: true }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await rm(liveHome, { recursive: true, force: true });
    await rm(hotplugRoot, { recursive: true, force: true });
  });

  it('writes only into temp home', async () => {
    const client = createClaudeCodeClient(liveHome);
    const liveBefore = await readFile(join(liveHome, '.claude', 'settings.json'), 'utf8');

    const adapter: SourceAdapter = {
      sourceRef: accountRef('grok', 'work'),
      capabilities: {
        sourceKind: 'account',
        provider: 'grok',
        nativeClients: [],
        protocols: ['openai', 'anthropic'],
        canRefresh: false,
        supportsModelDiscovery: false,
      },
      transportFor: () => 'managed_builtin_proxy',
    };

    const plan: ResolvedClientPlan = {
      clientId: 'claude',
      source: {
        ref: accountRef('grok', 'work'),
        kind: 'account',
        adapter,
        display: 'grok/work',
      },
      transport: {
        capability: 'managed_builtin_proxy',
        protocol: 'anthropic',
        endpoint: 'http://127.0.0.1:18080',
      },
      model: { mode: 'omitted' },
      mode: 'ephemeral',
      dryRun: false,
      verbose: false,
      hotplugRoot,
    };

    const paths = await client.listIsolatablePaths!({ home: liveHome });
    const runtime = await client.createIsolatedRuntime!(plan, paths);

    try {
      const liveAfter = await readFile(join(liveHome, '.claude', 'settings.json'), 'utf8');
      expect(liveAfter).toBe(liveBefore);

      const isoSettings = join(runtime.environment.HOME, '.claude', 'settings.json');
      expect(await pathExists(isoSettings)).toBe(true);
      const doc = await readJsonFile<Record<string, unknown>>(isoSettings);
      const env = doc.env as Record<string, string>;
      expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18080');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
      expect(runtime.environment.HOME).toBeTruthy();
    } finally {
      await runtime.cleanup();
      expect(await pathExists(runtime.directory)).toBe(false);
    }
  });
});

describe('applyPersistent injects proxy endpoint (account path)', () => {
  it('claude applyPersistent sets ANTHROPIC_BASE_URL', async () => {
    const liveHome = await mkdtemp(join(tmpdir(), 'claude-persist-'));
    const hotplugRoot = await mkdtemp(join(tmpdir(), 'hotplug-persist-'));
    try {
      const client = createClaudeCodeClient(liveHome);
      const plan: ResolvedClientPlan = {
        clientId: 'claude',
        source: {
          ref: accountRef('grok', 'work'),
          kind: 'account',
          adapter: {
            sourceRef: accountRef('grok', 'work'),
            capabilities: {
              sourceKind: 'account',
              provider: 'grok',
              nativeClients: [],
              protocols: ['anthropic', 'openai'],
              canRefresh: false,
              supportsModelDiscovery: false,
            },
            transportFor: () => 'managed_builtin_proxy',
          },
          display: 'grok/work',
        },
        transport: {
          capability: 'managed_builtin_proxy',
          protocol: 'anthropic',
          endpoint: 'http://127.0.0.1:9999',
        },
        model: { mode: 'omitted' },
        mode: 'persistent',
        profile: syntheticProxyProfile({
          name: 'proxy:grok/work',
          endpoint: 'http://127.0.0.1:9999',
          apiKey: 'hotplug-proxy',
        }),
        dryRun: false,
        verbose: false,
        hotplugRoot,
      };

      await client.applyPersistent!(plan);
      const doc = await readJsonFile<{ env: Record<string, string> }>(
        join(liveHome, '.claude', 'settings.json'),
      );
      expect(doc.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
      expect(doc.env.ANTHROPIC_AUTH_TOKEN).toBe('hotplug-proxy');
    } finally {
      await rm(liveHome, { recursive: true, force: true });
      await rm(hotplugRoot, { recursive: true, force: true });
    }
  });
});

describe('Codex isolated profile selection', () => {
  it('passes the source-specific Codex profile to the launched process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-profile-runtime-'));
    try {
      const client = createCodexClient(join(root, 'live-home'));
      const plan: ResolvedClientPlan = {
        clientId: 'codex',
        source: {
          ref: accountRef('grok', 'work'),
          kind: 'account',
          adapter: {
            sourceRef: accountRef('grok', 'work'),
            capabilities: {
              sourceKind: 'account',
              provider: 'grok',
              nativeClients: [],
              protocols: ['openai'],
              canRefresh: false,
              supportsModelDiscovery: false,
            },
            transportFor: () => 'managed_builtin_proxy',
          },
          display: 'grok/work',
        },
        transport: {
          capability: 'managed_builtin_proxy',
          protocol: 'openai',
          endpoint: 'https://grok.example/v1',
        },
        model: { mode: 'explicit', id: 'grok-4' },
        mode: 'ephemeral',
        profile: syntheticProxyProfile({
          name: 'proxy:grok/work',
          endpoint: 'https://grok.example/v1',
          apiKey: 'grok-token',
          defaultModel: 'grok-4',
        }),
        dryRun: false,
        verbose: false,
        hotplugRoot: root,
      };

      const runtime = await client.createIsolatedRuntime!(plan, []);
      try {
        expect(runtime.args).toEqual(['--profile', codexProfileName('proxy:grok/work')]);
        expect(Object.keys(runtime.environment)).toContain('CODEX_HOME');
        expect(
          Object.keys(runtime.environment).some((key) => key.startsWith('HOTPLUG_CODEX_')),
        ).toBe(true);
      } finally {
        await runtime.cleanup();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('gatewayTransportFor', () => {
  const clients = new ClientRegistry();
  clients.register(createClaudeCodeClient('/tmp/hotplug-test-claude'));
  const catalogProvider = {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'test',
    apiStyle: 'openai' as const,
  };

  it('returns direct only for known providers with protocol overlap', () => {
    expect(gatewayTransportFor('claude', ['anthropic'], { catalogProvider, clients })).toBe(
      'direct',
    );
    expect(gatewayTransportFor('claude', ['anthropic'], { catalogProvider, clients })).toBe(
      'direct',
    );
  });

  it('returns unsupported for protocol mismatch', () => {
    expect(gatewayTransportFor('claude', ['openai'], { catalogProvider, clients })).toBe(
      'unsupported',
    );
  });

  it('supports custom gateways with Anthropic protocol overlap', () => {
    const customProvider = { ...catalogProvider, id: 'custom', apiStyle: 'custom' as const };
    expect(
      gatewayTransportFor('claude', ['openai', 'anthropic'], {
        catalogProvider: customProvider,
        clients,
      }),
    ).toBe('direct');
  });

  it('returns unsupported for unknown provider id (no || truthy bypass)', () => {
    expect(gatewayTransportFor('claude', ['anthropic'], { clients })).toBe('unsupported');
  });
});
