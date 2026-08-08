/**
 * Real activation rollback (C1): when a mutating step fails after a proxy has
 * been started and a lease created, the executor must stop the proxy, release
 * the lease, and report the failure as fully rolled back (mutated: false).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady, type HotplugApp } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import { ClientRegistry } from '../src/clients/registry';
import { CatalogRegistry } from '../src/catalog/providers';
import { openDatabase } from '../src/core/db';
import { executeActivation } from '../src/core/activation-executor';
import { FakeProvider } from './helpers';
import { accountRef } from '../src/core/refs';
import { hotplugError } from '../src/utils/errors';
import type {
  ActivationPlan,
  ClientAdapter,
  PlanStep,
  ResolvedSource,
  SourceAdapter,
} from '../src/types';

async function seedAccount(app: HotplugApp, provider: string, name: string): Promise<void> {
  const { snapshotDir } = await app.accountStore.prepareSnapshot(provider, name);
  await writeFile(join(snapshotDir, 'auth.json'), JSON.stringify({ token: 't' }), {
    mode: 0o600,
  });
  await app.accountStore.writeMeta({
    name,
    provider,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Client whose apply throws, so an activation fails after the proxy starts. */
function throwingClient(): ClientAdapter {
  return {
    id: 'thrower',
    name: 'Thrower',
    description: 'test client that fails apply',
    supportedApiStyles: ['openai', 'anthropic'],
    capabilities: {
      id: 'thrower',
      acceptedProtocols: ['openai', 'anthropic'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: false,
      supportsPersistentConfig: true,
    },
    async validate() {},
    async apply() {
      throw hotplugError('simulated client apply failure', 'TEST_APPLY_FAILED', {
        exitCode: 1,
      });
    },
    async reset() {},
    async inspect() {
      return { present: false, configPaths: [] };
    },
  };
}

function accountProxyAdapter(provider: string, name: string): SourceAdapter {
  return {
    sourceRef: accountRef(provider, name),
    capabilities: {
      sourceKind: 'account',
      provider,
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
      supportsModelDiscovery: false,
      requiresNativeAuthWrite: false,
    },
    transportFor: () => 'managed_builtin_proxy',
  };
}

describe('activation rollback', () => {
  let root: string;
  let app: HotplugApp;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-rollback-'));
    const accountRegistry = new ProviderRegistry();
    const clients = new ClientRegistry();
    const catalog = new CatalogRegistry();
    const db = openDatabase(root);
    const fake = new FakeProvider('p', join(root, 'live', 'p'), { supportsProxy: true });
    accountRegistry.register(fake);
    clients.register(throwingClient());
    app = await createAppReady({ root, bare: true, accountRegistry, clients, catalog, db });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stops the proxy and releases the lease when a later step fails', async () => {
    await seedAccount(app, 'p', 'work');
    await app.proxy.enableProxy('p', 'work', {});

    const resolved: ResolvedSource = {
      kind: 'account',
      ref: accountRef('p', 'work'),
      adapter: accountProxyAdapter('p', 'work'),
      display: 'p/work',
    };
    const steps: PlanStep[] = [{ kind: 'StartProxy' }, { kind: 'WriteClientConfig' }];
    const plan: ActivationPlan = {
      mode: 'persistent',
      client: 'thrower',
      resolvedSource: resolved,
      transport: {
        capability: 'managed_builtin_proxy',
        protocol: 'anthropic',
        managedProxy: { provider: 'p', account: 'work', port: 0, leaseId: 'pending' },
        endpoint: 'http://127.0.0.1:0',
      },
      model: { mode: 'omitted' },
      steps,
      rollback: [],
      warnings: [],
    };

    await expect(executeActivation(plan, app, {})).rejects.toThrow(
      /simulated client apply failure/,
    );

    // Proxy was started then stopped → no live server on the port.
    const status = await app.proxy.proxyStatus('p', 'work');
    expect(status.running).toBe(false);

    // Lease created for the activation was released on rollback.
    expect(app.leases.list()).toHaveLength(0);

    // Journal records the failure and that it was rolled back.
    const incomplete = app.journal.listIncomplete();
    // rolled_back entries are not "incomplete"
    expect(incomplete).toHaveLength(0);
    const recent = app.journal.listRecent(5);
    expect(recent.some((e) => e.state === 'rolled_back')).toBe(true);
  });

  it('reports mutated:false when rollback fully restored state', async () => {
    await seedAccount(app, 'p', 'work');
    await app.proxy.enableProxy('p', 'work', {});

    const resolved: ResolvedSource = {
      kind: 'account',
      ref: accountRef('p', 'work'),
      adapter: accountProxyAdapter('p', 'work'),
      display: 'p/work',
    };
    const plan: ActivationPlan = {
      mode: 'persistent',
      client: 'thrower',
      resolvedSource: resolved,
      transport: {
        capability: 'managed_builtin_proxy',
        protocol: 'anthropic',
        managedProxy: { provider: 'p', account: 'work', port: 0, leaseId: 'pending' },
        endpoint: 'http://127.0.0.1:0',
      },
      model: { mode: 'omitted' },
      steps: [{ kind: 'StartProxy' }, { kind: 'WriteClientConfig' }],
      rollback: [],
      warnings: [],
    };

    try {
      await executeActivation(plan, app, {});
      throw new Error('expected activation to fail');
    } catch (err) {
      // Fully rolled back → no live state left changed.
      expect((err as { mutated?: boolean }).mutated).toBe(false);
    }
  });
});
