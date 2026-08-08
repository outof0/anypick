import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { DOCTOR_FIX_ALLOWLIST, DOCTOR_FIX_FORBIDDEN } from '../src/core/doctor';
import { pathExists } from '../src/utils/fs';
import { gatewayRef } from '../src/core/refs';
import { ClientRegistry } from '../src/clients/registry';
import { createClaudeCodeClient } from '../src/clients/claude-code';

describe('doctor fix allowlist contract', () => {
  it('has exactly 7 allowlisted kinds', () => {
    expect(DOCTOR_FIX_ALLOWLIST).toHaveLength(7);
    expect(DOCTOR_FIX_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'delete_stale_lock',
        'delete_stale_pid',
        'stop_orphan_proxy',
        'delete_temp_overlay',
        'repair_permissions',
        'rebuild_caches',
        'complete_journal_rollback',
      ]),
    );
  });

  it('has exactly 13 forbidden kinds', () => {
    expect(DOCTOR_FIX_FORBIDDEN).toHaveLength(13);
    expect(DOCTOR_FIX_FORBIDDEN).toContain('modify_native_auth');
    expect(DOCTOR_FIX_FORBIDDEN).toContain('mutate_binding');
    expect(DOCTOR_FIX_FORBIDDEN).toContain('replace_api_key');
  });
});

describe('doctor --fix behavior', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-doctor-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('deletes stale proxy PID when process is gone', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    // Create a fake account dir with stale pid
    const pidPath = join(root, 'providers', 'grok', 'accounts', 'work', 'runtime', 'proxy.pid');
    await mkdir(join(pidPath, '..'), { recursive: true });
    // PID that is almost certainly not running
    await writeFile(pidPath, '999999\n', { mode: 0o600 });

    const report = await app.doctor.run();
    const stale = report.checks.filter((c) => c.fixable === 'delete_stale_pid' && !c.ok);
    // May or may not find via scan depending on account registry paths —
    // exercise applyFixes directly
    const plan = {
      actions: [
        {
          id: 'delete_stale_pid:test',
          kind: 'delete_stale_pid' as const,
          description: 'stale pid',
          target: pidPath,
        },
      ],
      manual: [],
    };
    const result = await app.doctor.applyFixes(plan, { dryRun: false, yes: true });
    expect(result.applied[0]?.ok).toBe(true);
    expect(await pathExists(pidPath)).toBe(false);
    void stale;
  });

  it('refuses non-allowlisted fix kinds', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const plan = {
      actions: [
        {
          id: 'evil',
          // cast to bypass TS — runtime must still refuse
          kind: 'modify_native_auth' as unknown as 'delete_stale_pid',
          description: 'evil',
          target: '/tmp/x',
        },
      ],
      manual: [],
    };
    // Force bad kind through
    (plan.actions[0] as { kind: string }).kind = 'modify_native_auth';
    const result = await app.doctor.applyFixes(plan, {
      dryRun: false,
      yes: true,
    });
    expect(result.applied.some((a) => !a.ok || a.message.includes('Refused'))).toBe(true);
  });

  it('repair_permissions and rebuild_caches are allowlisted and runnable', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const plan = {
      actions: [
        {
          id: 'repair_permissions:root',
          kind: 'repair_permissions' as const,
          description: 'perms',
          target: root,
        },
        {
          id: 'rebuild_caches:root',
          kind: 'rebuild_caches' as const,
          description: 'cache',
          target: root,
        },
      ],
      manual: [],
    };
    const result = await app.doctor.applyFixes(plan, { dryRun: false, yes: true });
    expect(result.applied.every((a) => a.ok)).toBe(true);
    expect(await pathExists(join(root, 'cache', 'doctor-rebuild.json'))).toBe(true);
  });

  it('planFixes puts client issues in manual forbidden, not auto actions', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    // Inject a synthetic check path by running plan on empty root — mostly empty
    const plan = await app.doctor.planFixes();
    for (const a of plan.actions) {
      expect(DOCTOR_FIX_ALLOWLIST).toContain(a.kind);
    }
    for (const m of plan.manual) {
      expect(DOCTOR_FIX_FORBIDDEN).toContain(m.kind);
    }
  });

  it('dry-run fix does not delete files', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const pidPath = join(root, 'providers', 'x', 'accounts', 'a', 'runtime', 'proxy.pid');
    await mkdir(join(pidPath, '..'), { recursive: true });
    await writeFile(pidPath, '999998\n', { mode: 0o600 });
    const result = await app.doctor.applyFixes(
      {
        actions: [
          {
            id: 't',
            kind: 'delete_stale_pid',
            description: 'pid',
            target: pidPath,
          },
        ],
        manual: [],
      },
      { dryRun: true },
    );
    expect(result.applied[0]?.message).toMatch(/dry-run/i);
    expect(await pathExists(pidPath)).toBe(true);
  });

  it('restores journaled file backups before marking a crashed operation rolled back', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const live = join(root, 'client-settings.json');
    const backup = join(root, 'recovery', 'settings.before.json');
    await mkdir(join(backup, '..'), { recursive: true });
    await writeFile(backup, '{"before":true}', { mode: 0o600 });
    await writeFile(live, '{"broken":true}', { mode: 0o600 });
    const journal = app.journal.create('activate:persistent', {
      affectedResources: ['client/claude'],
      backupPaths: [`${backup}=>${live}`],
      state: 'executing',
    });

    const result = await app.doctor.applyFixes(
      {
        actions: [
          {
            id: `complete_journal_rollback:${journal.id}`,
            kind: 'complete_journal_rollback',
            description: 'restore test journal',
            target: `journal:${journal.id}`,
          },
        ],
        manual: [],
      },
      { dryRun: false, yes: true },
    );

    expect(result.applied[0]?.ok).toBe(true);
    expect(await readFile(live, 'utf8')).toBe('{"before":true}');
    expect(app.journal.get(journal.id)?.state).toBe('rolled_back');
  });
});

describe('use --save decoupled from idempotency', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-save-'));
    home = await mkdtemp(join(tmpdir(), 'hotplug-save-home-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('creates preset even when binding already active', async () => {
    // Use an isolated claude client so apply() writes into a temp home,
    // never the developer's real ~/.claude/settings.json.
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });

    // openrouter is dual-protocol → compatible with claude
    await app.profiles.create('gw-save-test', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'anthropic/claude-sonnet-4',
    });

    // Seed binding to force already-active path without full apply side effects
    app.bindings.upsertGlobal(
      'claude',
      {
        client: 'claude',
        source: gatewayRef('gw-save-test'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );

    // First call establishes "already active" for same bindingSpec
    const first = await app.bindingService.use('claude', {
      with: 'gw-save-test',
    });
    // May or may not be alreadyActive depending on apply side effects; force equal binding
    void first;

    // Ensure no preset yet
    if (app.presets.exists('my-preset')) {
      app.presets.remove('my-preset');
    }

    // Second use with same source + --save must create preset even if already active
    const result = await app.bindingService.use('claude', {
      with: 'gw-save-test',
      save: 'my-preset',
    });

    expect(result.savedPreset).toBe('my-preset');
    expect(app.presets.exists('my-preset')).toBe(true);
    const preset = app.presets.getByName('my-preset')!;
    expect(preset.spec.client).toBe('claude');
    expect(preset.spec.source).toEqual(gatewayRef('gw-save-test'));
  });
});
