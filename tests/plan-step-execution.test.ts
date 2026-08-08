/**
 * Plan steps must do what the plan advertises.
 *
 * ValidateCredential, WaitForHealth and VerifyEffectiveState were once pushed by
 * the planner, printed by `--dry-run`, and implemented nowhere: `runStep` fell
 * through to a shared no-op branch. A golden snapshot asserted the step *names*
 * were present, so the suite stayed green while the behaviour was absent.
 *
 * These tests assert observable effects instead of step names, so deleting an
 * implementation fails here rather than merely changing a snapshot.
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
import { InMemoryEventSink } from '../src/core/events';
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

/** Client that applies successfully but reports nothing present afterwards. */
function unverifiableClient(present: boolean): ClientAdapter {
  return {
    id: 'probe',
    name: 'Probe',
    description: 'test client with controllable inspect()',
    supportedApiStyles: ['openai', 'anthropic'],
    capabilities: {
      id: 'probe',
      acceptedProtocols: ['openai', 'anthropic'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: false,
      supportsPersistentConfig: true,
    },
    async validate() {},
    async apply() {
      return { managedPaths: [], managedEnvKeys: [] };
    },
    async reset() {},
    async inspect() {
      return {
        present,
        configPaths: [],
        issues: present ? undefined : ['nothing was written'],
      };
    },
  };
}

function directAdapter(provider: string, name: string, canRefresh: boolean): SourceAdapter {
  return {
    sourceRef: accountRef(provider, name),
    capabilities: {
      sourceKind: 'account',
      provider,
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh,
      supportsModelDiscovery: false,
      requiresNativeAuthWrite: false,
    },
    transportFor: () => 'direct',
  };
}

function planWith(steps: PlanStep[], resolved: ResolvedSource): ActivationPlan {
  return {
    mode: 'persistent',
    client: 'probe',
    resolvedSource: resolved,
    transport: { capability: 'direct', protocol: 'anthropic' },
    model: { mode: 'omitted' },
    steps,
    rollback: [],
    warnings: [],
  };
}

describe('plan step execution', () => {
  let root: string;
  let app: HotplugApp;
  let events: InMemoryEventSink;

  async function makeApp(clientPresent: boolean): Promise<void> {
    const accountRegistry = new ProviderRegistry();
    const clients = new ClientRegistry();
    const catalog = new CatalogRegistry();
    const db = openDatabase(root);
    accountRegistry.register(new FakeProvider('p', join(root, 'live', 'p')));
    clients.register(unverifiableClient(clientPresent));
    events = new InMemoryEventSink();
    app = await createAppReady({
      root,
      bare: true,
      accountRegistry,
      clients,
      catalog,
      db,
      events,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-steps-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('ValidateCredential', () => {
    it('fails before mutating when the account has no credential snapshot', async () => {
      await makeApp(true);
      // Snapshots live in SQLite (account_snapshot_files) and are materialized to
      // disk on read, so the absence of credentials is a missing-rows condition —
      // deleting the directory would just cause it to be recreated.
      await seedAccount(app, 'p', 'ghost');
      app.db.prepare('DELETE FROM account_snapshot_files WHERE provider = ?').run('p');

      const resolved: ResolvedSource = {
        kind: 'account',
        ref: accountRef('p', 'ghost'),
        adapter: directAdapter('p', 'ghost', false),
        display: 'p/ghost',
      };
      const plan = planWith(
        [{ kind: 'ValidateCredential' }, { kind: 'CommitGlobalBinding' }],
        resolved,
      );
      plan.bindingSpec = {
        client: 'probe',
        source: accountRef('p', 'ghost'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      };
      plan.provenance = { kind: 'direct' };

      await expect(executeActivation(plan, app, {})).rejects.toThrow(/credential snapshot/i);

      // The binding step never ran, so nothing was committed.
      expect(app.bindings.getGlobal('probe')).toBeFalsy();
    });

    it('passes for an account with a populated snapshot', async () => {
      await makeApp(true);
      await seedAccount(app, 'p', 'work');

      const resolved: ResolvedSource = {
        kind: 'account',
        ref: accountRef('p', 'work'),
        adapter: directAdapter('p', 'work', false),
        display: 'p/work',
      };
      const plan = planWith([{ kind: 'ValidateCredential' }], resolved);

      await expect(executeActivation(plan, app, {})).resolves.toBeDefined();
    });
  });

  describe('WaitForHealth', () => {
    it('fails when the advertised proxy endpoint is not serving', async () => {
      await makeApp(true);
      await seedAccount(app, 'p', 'work');

      const resolved: ResolvedSource = {
        kind: 'account',
        ref: accountRef('p', 'work'),
        adapter: directAdapter('p', 'work', false),
        display: 'p/work',
      };
      const plan = planWith([{ kind: 'WaitForHealth' }], resolved);
      // Port 9 (discard) is reserved and never serves HTTP.
      plan.transport = {
        capability: 'managed_builtin_proxy',
        protocol: 'anthropic',
        endpoint: 'http://127.0.0.1:9',
      };

      await expect(executeActivation(plan, app, { healthTimeoutMs: 300 })).rejects.toThrow(
        /not responding/i,
      );
    });

    it('is a no-op when the plan has no proxy endpoint', async () => {
      await makeApp(true);
      await seedAccount(app, 'p', 'work');

      const resolved: ResolvedSource = {
        kind: 'account',
        ref: accountRef('p', 'work'),
        adapter: directAdapter('p', 'work', false),
        display: 'p/work',
      };
      const plan = planWith([{ kind: 'WaitForHealth' }], resolved);

      await expect(executeActivation(plan, app, {})).resolves.toBeDefined();
    });
  });

  describe('VerifyEffectiveState', () => {
    it('emits a degraded-state event when the client reports nothing written', async () => {
      await makeApp(false);
      await seedAccount(app, 'p', 'work');

      const resolved: ResolvedSource = {
        kind: 'account',
        ref: accountRef('p', 'work'),
        adapter: directAdapter('p', 'work', false),
        display: 'p/work',
      };
      const plan = planWith([{ kind: 'VerifyEffectiveState' }], resolved);

      await executeActivation(plan, app, {});

      const codes = events.list().map((e) => e.code);
      expect(codes).toContain('effective_state_mismatch');
    });

    it('stays silent when the client confirms its configuration', async () => {
      await makeApp(true);
      await seedAccount(app, 'p', 'work');

      const resolved: ResolvedSource = {
        kind: 'account',
        ref: accountRef('p', 'work'),
        adapter: directAdapter('p', 'work', false),
        display: 'p/work',
      };
      const plan = planWith([{ kind: 'VerifyEffectiveState' }], resolved);

      await executeActivation(plan, app, {});

      const codes = events.list().map((e) => e.code);
      expect(codes).not.toContain('effective_state_mismatch');
    });
  });
});
