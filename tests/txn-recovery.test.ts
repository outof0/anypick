import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createAppReady } from '../src/core/app';
import { ClientRegistry } from '../src/clients/registry';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { recoveryDir, clientRecoveryDir } from '../src/core/paths';
import { ClientStateStore } from '../src/core/client-state-store';
import { createHash } from 'node:crypto';

// TXN-01: durable write-ahead recovery.
// - Crash backups live in the owner-only AnyPick recovery dir (not the system
//   temp dir) with collision-free hashed filenames, so concurrent activations
//   or two targets sharing a basename never clobber each other.
// - A simulated crash mid-activation leaves a journal entry whose recorded
//   backup restores the exact prior config file on recovery.

describe('TXN-01 recovery storage + restore', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-txn-'));
    home = await mkdtemp(join(tmpdir(), 'anypick-txn-home-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function seedGateway(app: Awaited<ReturnType<typeof createAppReady>>): Promise<void> {
    await app.profiles.create('openrouter-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-5',
    });
  }

  it('stores crash backups in the owner-only recovery dir with hashed collision-free names', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });
    await seedGateway(app);

    const clientState = new ClientStateStore(root, app.db);
    const settingsPath = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ env: { PRIOR: 'restore-me' } }), {
      mode: 0o600,
    });
    await clientState.write({
      clientId: 'claude',
      mode: 'profile',
      profileName: 'openrouter-work',
      updatedAt: new Date().toISOString(),
      managedPaths: [settingsPath],
      managedEnvKeys: [],
    });

    // apply backs up the prior managed path before overwriting.
    await app.runtime.apply('openrouter-work', 'claude', { proxyEndpoint: 'http://127.0.0.1:1' });

    // Backup went into the owner-only recovery dir, not /tmp.
    const recDir = clientRecoveryDir(root, 'claude');
    const files = await readdir(recDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const recRoot = recoveryDir(root);
    expect(recDir.startsWith(recRoot)).toBe(true);

    // Hashed name: sha1(target) prefix + basename, collision-free.
    const expectedHash = createHash('sha1').update(settingsPath).digest('hex').slice(0, 16);
    expect(files.some((f) => f.startsWith(`${expectedHash}-`))).toBe(true);
    expect(files.every((f) => f.endsWith(basename(settingsPath)))).toBe(true);

    // The backup content equals the prior config exactly.
    const bak = files.find((f) => f.startsWith(`${expectedHash}-`))!;
    const bakContent = await readFile(join(recDir, bak), 'utf8');
    expect(JSON.parse(bakContent)).toEqual({ env: { PRIOR: 'restore-me' } });
  });

  it('restores the exact prior config file after a simulated crash + restart', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });
    await seedGateway(app);

    const clientState = new ClientStateStore(root, app.db);
    const settingsPath = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ env: { PRIOR: 'restore-me' } }), {
      mode: 0o600,
    });
    await clientState.write({
      clientId: 'claude',
      mode: 'profile',
      profileName: 'openrouter-work',
      updatedAt: new Date().toISOString(),
      managedPaths: [settingsPath],
      managedEnvKeys: [],
    });

    // The activation took its prior-state backup (test 1), then a crash leaves
    // the live file in a partially-written / wrong state (simulating mid-write).
    await app.runtime.apply('openrouter-work', 'claude', { proxyEndpoint: 'http://127.0.0.1:1' });
    await writeFile(settingsPath, JSON.stringify({ env: { BROKEN: 'partial' } }), { mode: 0o600 });

    // Locate the recorded backup (what the activation journal persisted before
    // mutating the live file).
    const recDir = clientRecoveryDir(root, 'claude');
    const files = await readdir(recDir);
    const expectedHash = createHash('sha1').update(settingsPath).digest('hex').slice(0, 16);
    const bak = files.find((f) => f.startsWith(`${expectedHash}-`))!;
    const backup = join(recDir, bak);

    // Fabricate an incomplete (crashed) activation journal entry with the backup.
    const entry = app.journal.create('activate:persistent', {
      affectedResources: ['client/claude', 'gateway/openrouter-work'],
      backupPaths: [`${backup}=>${settingsPath}`],
      params: { client: 'claude', source: 'gateway/openrouter-work', mode: 'persistent' },
      state: 'executing',
    });

    // Fresh app instance — startup recovery reads the same journal/backups.
    const app2 = await createAppReady({ root, skipMigrate: true, clients });
    expect(app2.journal.get(entry.id)?.state).toBe('rolled_back');
    // Exact prior file restored.
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      env: { PRIOR: 'restore-me' },
    });
  });

  it('two targets with the same basename back up without collision', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });

    await seedGateway(app);

    // Two distinct managed files sharing the basename.
    const a = join(home, '.claude', 'settings.json');
    const b = join(home, '.config', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.config'), { recursive: true });
    await writeFile(a, JSON.stringify({ env: { WHICH: 'a' } }), { mode: 0o600 });
    await writeFile(b, JSON.stringify({ env: { WHICH: 'b' } }), { mode: 0o600 });

    // register both as managed paths on the client state, then trigger a backup
    const clientState = new ClientStateStore(root, app.db);
    await clientState.write({
      clientId: 'claude',
      mode: 'profile',
      profileName: 'openrouter-work',
      updatedAt: new Date().toISOString(),
      managedPaths: [a, b],
      managedEnvKeys: [],
    });
    // Force a backup by re-applying (apply backs up prior managed paths).
    await app.runtime.apply('openrouter-work', 'claude', { proxyEndpoint: 'http://127.0.0.1:1' });

    const recDir = clientRecoveryDir(root, 'claude');
    const files = await readdir(recDir);
    // Two distinct hashes → two distinct files despite identical basename.
    const hashes = new Set(files.map((f) => f.split('-')[0]));
    expect(hashes.size).toBe(2);
    expect(files).toHaveLength(2);
  });
});
