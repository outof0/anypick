import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { ClientRegistry } from '../src/clients/registry';
import type { ClientAdapter } from '../src/types';

describe('environment-overlay ephemeral runtime', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('executes a provider-neutral environment overlay instead of silently ignoring its plan step', async () => {
    let cleaned = false;
    const client: ClientAdapter = {
      id: 'overlay-client',
      name: 'Overlay client',
      description: 'test-only environment overlay client',
      supportedApiStyles: ['openai'],
      capabilities: {
        id: 'overlay-client',
        acceptedProtocols: ['openai'],
        supportsEnvironmentOverlay: true,
        supportsIsolatedHome: false,
        supportsPersistentConfig: false,
      },
      async validate() {},
      async apply() {
        return { managedPaths: [], managedEnvKeys: [] };
      },
      async reset() {},
      async inspect() {
        return { installed: true, present: true, configPaths: [] };
      },
      async createEnvironmentOverlay() {
        return {
          directory: '/tmp/hotplug-overlay-test',
          environment: { HOTPLUG_OVERLAY: '1' },
          async cleanup() {
            cleaned = true;
          },
        };
      },
    };
    const clients = new ClientRegistry();
    clients.register(client);
    root = await mkdtemp(join(tmpdir(), 'hotplug-overlay-'));
    const app = await createAppReady({ root, skipMigrate: true, clients });
    await app.profiles.create('overlay-gateway', {
      provider: 'custom',
      endpoint: 'https://example.test/v1',
      apiKey: 'test-key',
    });

    const result = await app.bindingService.runPrepare('overlay-client', {
      with: 'overlay-gateway',
    });

    expect(result.plan.steps.map((step) => step.kind)).toContain('CreateEnvironmentOverlay');
    expect(result.isolated?.environment).toEqual({ HOTPLUG_OVERLAY: '1' });
    await result.cleanup?.();
    expect(cleaned).toBe(true);
  });
});
