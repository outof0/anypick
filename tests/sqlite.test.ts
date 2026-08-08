import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createAppReady } from '../src/core/app';
import {
  BASELINE_VERSION,
  MIGRATIONS,
  migrateLegacyRootIfPristine,
  openDatabase,
} from '../src/core/db';
import { migrateFilesystemIfNeeded } from '../src/core/migrate-fs';
import { AccountStore } from '../src/core/store';
import {
  accountMetaPath,
  accountSnapshotDir,
  activePointerPath,
  anypickDbPath,
  profileMetaPath,
  profileSecretsPath,
} from '../src/core/paths';
import { createTestEnv } from './helpers';

describe('SQLite storage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-sqlite-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists accounts and snapshots in anypick.db', async () => {
    const { service, fakes, store } = await createTestEnv(['fake']);
    // override store root already set by helper
    const live = fakes.fake;
    await live.setLive({ email: 'a@x.com', token: 't1' });
    await service.save('fake', 'work');

    // reopen fresh store on same root (fresh db connection)
    const store2 = new AccountStore(store.root, openDatabase(store.root));
    const account = await store2.requireAccount('fake', 'work');
    expect(account.meta.identity).toBe('a@x.com');

    const snapPath = join(account.snapshotDir, 'auth.json');
    const raw = JSON.parse(await readFile(snapPath, 'utf8')) as {
      email: string;
    };
    expect(raw.email).toBe('a@x.com');

    // DB file exists
    const { pathExists } = await import('../src/utils/fs');
    expect(await pathExists(join(store.root, 'anypick.db'))).toBe(true);
  });

  it('uses the AnyPick database name for every configured root', () => {
    expect(anypickDbPath(join(root, 'custom-root'))).toBe(join(root, 'custom-root', 'anypick.db'));
  });

  it('copies a populated pre-rename root over a bootstrap-only AnyPick root', async () => {
    const legacyRoot = join(root, 'legacy');
    const anypickRoot = join(root, 'anypick');
    const legacy = createApp({ root: legacyRoot });
    await legacy.profiles.create('work', {
      provider: 'custom',
      endpoint: 'https://example.com',
      apiKey: 'secret',
      defaultModel: 'example-model',
    });
    legacy.close();
    const bootstrap = createApp({ root: anypickRoot });
    bootstrap.close();

    expect(migrateLegacyRootIfPristine(anypickRoot, legacyRoot)).toBe(true);

    const migrated = createApp({ root: anypickRoot, skipMigrate: true });
    await expect(migrated.profiles.get('work')).resolves.toMatchObject({
      meta: { endpoint: 'https://example.com' },
      secrets: { apiKey: 'secret' },
    });
    migrated.close();
    expect(await readFile(join(legacyRoot, 'anypick.db'))).toBeDefined();
  });

  it('persists profiles and secrets', async () => {
    const app = createApp({ root });
    await app.profiles.create('gw', {
      provider: 'custom',
      endpoint: 'https://example.com',
      apiKey: 'sk-secret',
      defaultModel: 'claude-sonnet-5',
      sonnetModel: 'claude-sonnet-5',
    });

    const app2 = createApp({ root, skipMigrate: true });
    const p = await app2.profiles.get('gw');
    expect(p.meta.defaultModel).toBe('claude-sonnet-5');
    expect(p.secrets.apiKey).toBe('sk-secret');
  });

  it('migrates legacy filesystem layout into SQLite', async () => {
    // Seed legacy FS layout
    const meta = {
      name: 'work',
      provider: 'codex',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      identity: 'me@x.com',
    };
    await mkdir(accountSnapshotDir(root, 'codex', 'work'), { recursive: true });
    await writeFile(accountMetaPath(root, 'codex', 'work'), JSON.stringify(meta, null, 2));
    await writeFile(
      join(accountSnapshotDir(root, 'codex', 'work'), 'auth.json'),
      JSON.stringify({ token: 'abc' }),
      { mode: 0o600 },
    );
    await mkdir(join(root, 'providers', 'codex'), { recursive: true });
    await writeFile(activePointerPath(root, 'codex'), 'work\n');

    await mkdir(join(root, 'profiles', 'or'), { recursive: true });
    await writeFile(
      profileMetaPath(root, 'or'),
      JSON.stringify({
        name: 'or',
        provider: 'openrouter',
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        models: {},
        endpoint: 'https://openrouter.ai/api/v1',
      }),
    );
    await writeFile(profileSecretsPath(root, 'or'), JSON.stringify({ apiKey: 'sk-or' }), {
      mode: 0o600,
    });

    const db = openDatabase(root);
    const result = await migrateFilesystemIfNeeded(db, root);
    expect(result.migrated).toBe(true);
    expect(result.accounts).toBe(1);
    expect(result.profiles).toBe(1);

    const app = createApp({ root, db, skipMigrate: true });
    const account = await app.accountStore.requireAccount('codex', 'work');
    expect(account.meta.identity).toBe('me@x.com');
    const auth = JSON.parse(await readFile(join(account.snapshotDir, 'auth.json'), 'utf8')) as {
      token: string;
    };
    expect(auth.token).toBe('abc');
    expect(await app.accountStore.getActive('codex')).toBe('work');

    const profile = await app.profiles.get('or');
    expect(profile.secrets.apiKey).toBe('sk-or');

    // second migrate is no-op
    const again = await migrateFilesystemIfNeeded(db, root);
    expect(again.migrated).toBe(false);
  });

  it('uses the legacy directory key rather than untrusted account metadata paths', async () => {
    await mkdir(accountSnapshotDir(root, 'fake', 'safe'), { recursive: true });
    await writeFile(
      accountMetaPath(root, 'fake', 'safe'),
      JSON.stringify({
        name: '../../outside',
        provider: 'another-provider',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await writeFile(
      join(accountSnapshotDir(root, 'fake', 'safe'), 'auth.json'),
      '{"token":"safe"}',
    );

    const db = openDatabase(root);
    await migrateFilesystemIfNeeded(db, root);
    const app = createApp({ root, db, skipMigrate: true });
    const account = await app.accountStore.requireAccount('fake', 'safe');

    expect(account.meta.name).toBe('safe');
    expect(account.meta.provider).toBe('fake');
    expect(account.snapshotDir).toBe(accountSnapshotDir(root, 'fake', 'safe'));
  });

  it('createAppReady migrates and ensures config', async () => {
    const app = await createAppReady({ root });
    const cfg = await app.config.read();
    expect(cfg.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(cfg.defaultClient).toBe('claude');
  });

  it('migration runner applies baseline and records user_version', async () => {
    const db = openDatabase(root);
    const target = BASELINE_VERSION + MIGRATIONS.length;
    // Fresh DB starts fully migrated, including all additive schema changes.
    const v0 = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
    expect(v0).toBe(target);
    // Idempotent: re-opening does not change version or throw.
    const db2 = openDatabase(root);
    const v1 = Number(db2.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
    expect(v1).toBe(target);
  });

  it('migration runner advances user_version for pending migrations', async () => {
    const { migrateSchema } = await import('../src/core/db');
    const db = openDatabase(root);
    // Simulate an older installed base by forcing user_version below target.
    db.exec('PRAGMA user_version = 0');
    // Re-run the runner; it should advance to the current target version.
    migrateSchema(db);
    const target = BASELINE_VERSION + MIGRATIONS.length;
    const v = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
    expect(v).toBe(target);
  });

  it('repairs a version-3 proxy leases table that lacks instance_id', async () => {
    const db = openDatabase(root);
    db.exec('DROP TABLE proxy_leases');
    db.exec(`
      CREATE TABLE proxy_leases (
        lease_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        account TEXT,
        port INTEGER NOT NULL,
        host TEXT NOT NULL DEFAULT '127.0.0.1',
        endpoint TEXT,
        owner_pid INTEGER NOT NULL,
        binding_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 3;
    `);
    db.close();

    const migrated = openDatabase(root);
    const columns = migrated
      .prepare('PRAGMA table_info(proxy_leases)')
      .all()
      .map((row: { name: string }) => row.name);
    expect(columns).toContain('instance_id');
    expect(Number(migrated.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(
      BASELINE_VERSION + MIGRATIONS.length,
    );
  });

  it('refuses a database created by a newer AnyPick build before modifying it', async () => {
    const db = openDatabase(root);
    const futureVersion = BASELINE_VERSION + MIGRATIONS.length + 1;
    db.exec(`PRAGMA user_version = ${futureVersion}`);
    db.close();

    expect(() => openDatabase(root)).toThrow(/newer than this AnyPick build supports/);
  });
});
