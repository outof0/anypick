import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import { ClientRegistry } from '../src/clients/registry';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { FakeProvider } from './helpers';

describe('proxy start realigns bound client BASE_URL', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-realign-'));
    home = await mkdtemp(join(tmpdir(), 'hotplug-realign-home-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('rewrites settings when applyProxyEndpoint is called after port change', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });

    // Seed a binding to a fake account-like gateway profile first is easier
    await app.profiles.create('proxy-src', {
      provider: 'openrouter',
      endpoint: 'http://127.0.0.1:4120',
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-5',
    });
    await app.bindingService.use('claude', {
      with: 'proxy-src',
      model: 'claude-sonnet-5',
    });

    const settingsPath = join(home, '.claude', 'settings.json');
    let doc = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(doc.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4120');

    // Simulate port bump realign (what startProxy does after allocate)
    await app.runtime.applyProxyEndpoint('claude', {
      endpoint: 'http://127.0.0.1:4125',
      apiKey: 'hotplug-proxy',
      defaultModel: 'claude-sonnet-5',
      accountRef: { provider: 'opencode', name: 'default' },
      label: 'proxy:opencode/default',
    });

    doc = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(doc.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4125');
  });

  it('reuses the persisted runtime token when a running proxy restores a saved binding', async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to reserve a test port');
    }
    const port = address.port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));

    const providers = new ProviderRegistry();
    const fake = new FakeProvider('opencode', join(root, 'live-opencode'), {
      supportsProxy: true,
      defaultProxyPort: port,
    });
    providers.register(fake);

    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({
      root,
      skipMigrate: true,
      accountRegistry: providers,
      clients,
    });

    try {
      await fake.setLive({ email: 'saved@example.com', token: 'upstream-token' });
      await app.accounts.save('opencode', 'default');
      app.bindings.upsertGlobal(
        'claude',
        {
          client: 'claude',
          source: { kind: 'account', provider: 'opencode', name: 'default' },
          model: { mode: 'explicit', id: 'mimo-v2.5-free' },
          transportPolicy: 'auto',
          clientOptions: {
            modelRoles: {
              default: 'mimo-v2.5-free',
              sonnet: 'mimo-v2.5-free',
              opus: 'mimo-v2.5-free',
              haiku: 'mimo-v2.5-free',
            },
          },
        },
        { kind: 'direct' },
      );

      const first = await app.proxy.enableProxy('opencode', 'default', { port, start: true });
      expect(first.started?.realignedClients).toContain('claude');

      const state = await app.accountStore.readProxyState('opencode', 'default');
      expect(state?.token).toHaveLength(64);
      const settingsPath = join(home, '.claude', 'settings.json');
      const drifted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>;
      };
      drifted.env.ANTHROPIC_AUTH_TOKEN = 'stale-token';
      await writeFile(settingsPath, JSON.stringify(drifted, null, 2), 'utf8');

      const reused = await app.proxy.startProxy('opencode', 'default');
      expect(reused.startedNow).toBe(false);
      expect(reused.realignedClients).toContain('claude');

      const repaired = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>;
      };
      expect(repaired.env.ANTHROPIC_AUTH_TOKEN).toBe(state?.token);
      expect(repaired.env.ANTHROPIC_MODEL).toBe('mimo-v2.5-free');
    } finally {
      await fake.dispose();
    }
  });
});
