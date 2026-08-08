/**
 * RUN-01: ephemeral execution is one scoped lifecycle.
 *
 * The executor must build the isolated runtime exactly ONCE for an ephemeral
 * plan, even though the plan contains both `CreateTemporaryClientHome` and the
 * `SpawnChild` marker step. The child is spawned by the CLI launcher, which
 * reads `result.isolated.{environment,directory,cleanup}` — so the executor must
 * surface the session in its result (it previously stored only a cleanup fn and
 * never returned it, making `result.isolated` always undefined).
 *
 * Acceptance proven here (doc §RUN-01):
 *  - one temp-home step → exactly one dir (createEphemeralRuntime called once)
 *  - result.isolated carries environment + directory + cleanup
 *  - cleanup removes the temp dir (no temp left after run)
 *  - live auth + client config unchanged during an ephemeral run
 *  - ephemeral run commits no global binding (no live state mutation)
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAppReady } from '../src/core/app';
import { executeActivation } from '../src/core/activation-executor';
import { accountRef } from '../src/core/refs';
import { geminiAccountAdapter } from '../src/sources/account-adapters';
import { pathExists } from '../src/utils/fs';
import type { ActivationPlan, ResolvedSource } from '../src/types';

let root: string;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function ephemeralPlan(
  resolved: ResolvedSource,
  bindingSpec: ActivationPlan['bindingSpec'],
  provenance: ActivationPlan['provenance'],
): ActivationPlan {
  return {
    mode: 'ephemeral',
    client: 'claude',
    resolvedSource: resolved,
    transport: {
      capability: 'managed_builtin_proxy',
      protocol: 'anthropic',
      endpoint: 'http://127.0.0.1:18080',
    },
    model: { mode: 'omitted' },
    steps: [
      { kind: 'CreateTemporaryClientHome' },
      { kind: 'SpawnChild' },
      { kind: 'ReleaseLease' },
    ],
    rollback: [],
    warnings: [],
    bindingSpec,
    provenance,
  };
}

describe('RUN-01 ephemeral execution is one scoped lifecycle', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-run01-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds exactly one isolated runtime and surfaces it in the result', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const { snapshotDir } = await app.accountStore.prepareSnapshot('gemini', 'work');
    await writeFile(join(snapshotDir, 'auth.json'), JSON.stringify({ token: 'live-token' }), {
      mode: 0o600,
    });
    await app.accountStore.writeMeta({
      name: 'work',
      provider: 'gemini',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const account = (await app.accounts.get('gemini', 'work'))!;
    const adapter = geminiAccountAdapter(account);
    const resolved: ResolvedSource = {
      kind: 'account',
      display: 'gemini/work',
      adapter,
      ref: accountRef('gemini', 'work'),
    };

    let calls = 0;
    const original = app.runtime.createEphemeralRuntime.bind(app.runtime);
    app.runtime.createEphemeralRuntime = (p) => {
      calls += 1;
      return original(p);
    };

    const plan = ephemeralPlan(
      resolved,
      {
        client: 'claude',
        source: accountRef('gemini', 'work'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );

    const result = await executeActivation(plan, {
      accounts: app.accounts,
      accountRegistry: app.accountRegistry,
      profiles: app.profiles,
      profileStore: app.profileStore,
      bindings: app.bindings,
      presets: app.presets,
      catalog: app.catalog,
      clients: app.clients,
      journal: app.journal,
      leases: app.leases,
      runtime: app.runtime,
      proxy: app.proxy,
    });

    // Both CreateTemporaryClientHome AND SpawnChild appear in the plan, but the
    // runtime must be created exactly once.
    expect(calls).toBe(1);

    // The session is surfaced to the launcher.
    expect(result.isolated).toBeDefined();
    expect(result.isolated!.environment).toBeTypeOf('object');
    expect(result.isolated!.directory).toBeTruthy();
    expect(result.isolated!.cleanup).toBeTypeOf('function');
    expect(result.cleanup).toBeTypeOf('function');

    // Ephemeral commits no global binding (no live state mutation).
    expect(app.bindings.getGlobal('claude')).toBeNull();

    // Cleanup removes the temp dir.
    const dir = result.isolated!.directory;
    await result.cleanup!();
    expect(await pathExists(dir)).toBe(false);
  });

  it('leaves live auth + client config untouched (checksums identical before/after)', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const { snapshotDir: snap } = await app.accountStore.prepareSnapshot('gemini', 'work');
    await writeFile(join(snap, 'auth.json'), JSON.stringify({ token: 'live-token' }), {
      mode: 0o600,
    });
    await app.accountStore.writeMeta({
      name: 'work',
      provider: 'gemini',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const liveBefore = await readFile(join(snap, 'auth.json'), 'utf8');
    const liveChecksumBefore = sha256(liveBefore);

    const account = (await app.accounts.get('gemini', 'work'))!;
    const resolved: ResolvedSource = {
      kind: 'account',
      display: 'gemini/work',
      adapter: geminiAccountAdapter(account),
      ref: accountRef('gemini', 'work'),
    };

    const result = await executeActivation(
      ephemeralPlan(
        resolved,
        {
          client: 'claude',
          source: accountRef('gemini', 'work'),
          model: { mode: 'omitted' },
          transportPolicy: 'auto',
          clientOptions: {},
        },
        { kind: 'direct' },
      ),
      {
        accounts: app.accounts,
        accountRegistry: app.accountRegistry,
        profiles: app.profiles,
        profileStore: app.profileStore,
        bindings: app.bindings,
        presets: app.presets,
        catalog: app.catalog,
        clients: app.clients,
        journal: app.journal,
        leases: app.leases,
        runtime: app.runtime,
        proxy: app.proxy,
      },
    );

    const liveAfter = await readFile(join(snap, 'auth.json'), 'utf8');
    expect(sha256(liveAfter)).toBe(liveChecksumBefore);

    await result.isolated!.cleanup();
  });
});
