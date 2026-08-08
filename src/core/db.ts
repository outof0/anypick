import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { anypickDbPath, getAnyPickRoot } from './paths';
import { migrateSchema } from './db-schema';
export { BASELINE_VERSION, MIGRATIONS, migrateSchema } from './db-schema';

/**
 * Database boundary.
 *
 * `node:sqlite` is an experimental Node API and may change before 1.0. Every
 * other module depends only on the `AnyPickDatabase` interface defined here; the
 * concrete `node:sqlite` binding is confined to this file (the only module that
 * imports `node:sqlite`). To swap the backend, implement `AnyPickDatabase` with
 * another engine and change `openDatabase` and `openForeignDatabase` alone.
 */
/**
 * Result of a mutating statement. SQLite reports these for every `run()`, so
 * the shape is known even though row shapes are not — typing it keeps
 * `.changes` checks honest at ~20 call sites across the stores.
 */
export interface SqlRunResult {
  /** Rows inserted, updated, or deleted by this statement. */
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  /**
   * Row shapes are genuinely dynamic (each query selects different columns), so
   * `get`/`all` surface `any` rather than leaking the concrete `node:sqlite`
   * binding. Callers assert the shape they expect. `run` is different: its
   * result shape is fixed by SQLite, so it is typed.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
  run(...params: unknown[]): SqlRunResult;
}

export interface AnyPickDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
  /**
   * Run `fn` inside a SQLite transaction. Commits on success; rolls back if
   * `fn` throws or rejects. Nested calls are not supported (SQLite has a single
   * implicit transaction level) — callers must not nest.
   */
  transaction<T>(fn: () => T): T;
}

/** Adapter wrapping the experimental `node:sqlite` binding behind AnyPickDatabase. */
class NodeSqliteDatabase implements AnyPickDatabase {
  constructor(private readonly inner: DatabaseSync) {}

  prepare(sql: string): SqlStatement {
    const stmt = this.inner.prepare(sql);
    return {
      get: (...params: unknown[]) => stmt.get(...(params as Parameters<typeof stmt.get>)),
      all: (...params: unknown[]) => stmt.all(...(params as Parameters<typeof stmt.all>)),
      run: (...params: unknown[]) => stmt.run(...(params as Parameters<typeof stmt.run>)),
    };
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.inner.exec('BEGIN');
    try {
      const result = fn();
      this.inner.exec('COMMIT');
      return result;
    } catch (err) {
      this.inner.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.inner.close();
  }
}

/** Path to the SQLite database under the anypick root. */
export function dbPath(root?: string): string {
  return anypickDbPath(getAnyPickRoot(root));
}

const BOOTSTRAP_FILES = new Set([
  'anypick.db',
  'anypick.db-shm',
  'anypick.db-wal',
  '.migrate.lock',
]);
const SYSTEM_TABLE_PREFIX = 'sqlite_';
const BOOTSTRAP_TABLES = new Set(['config', 'meta']);

function hasUserData(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(path, { readOnly: true });
    const database = source;
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as {
      name: string;
    }[];
    return tables.some(({ name }) => {
      if (name.startsWith(SYSTEM_TABLE_PREFIX) || BOOTSTRAP_TABLES.has(name)) {
        return false;
      }
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`)
        .get() as { count?: number | bigint } | undefined;
      return Number(row?.count ?? 0) > 0;
    });
  } catch {
    // A malformed or inaccessible destination is not safe to overwrite.
    return true;
  } finally {
    source?.close();
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Copy the pre-rename data root into the AnyPick root exactly once.
 *
 * This runs only while the destination is the bootstrap database created by an
 * interrupted first launch. The source remains intact, and the SQLite snapshot
 * is produced with VACUUM INTO so WAL-backed changes are captured consistently.
 */
export function migrateLegacyRootIfPristine(root: string, legacyRoot: string): boolean {
  if (!existsSync(legacyRoot)) {
    return false;
  }
  const destinationFiles = existsSync(root) ? readdirSync(root) : [];
  if (
    destinationFiles.some((file) => !BOOTSTRAP_FILES.has(file)) ||
    hasUserData(anypickDbPath(root))
  ) {
    return false;
  }

  // The original database remains authoritative during the rename. A partial
  // first launch can create an AnyPick-named database alongside it, but that
  // bootstrap file must never win over the saved account store.
  const sourceDb = ['hotplug.db', 'anypick.db']
    .map((file) => join(legacyRoot, file))
    .find((file) => existsSync(file));
  if (!sourceDb || !hasUserData(sourceDb)) {
    return false;
  }

  const stagingRoot = `${root}.migration-${process.pid}-${Date.now()}`;
  const backupRoot = `${root}.bootstrap-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  try {
    cpSync(legacyRoot, stagingRoot, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => {
        const file = basename(source);
        return !['anypick.db', 'anypick.db-shm', 'anypick.db-wal', 'hotplug.db'].includes(file);
      },
    });
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const snapshot = new DatabaseSync(sourceDb);
    try {
      snapshot.exec(`VACUUM INTO ${quoteSqlString(join(stagingRoot, 'anypick.db'))}`);
    } finally {
      snapshot.close();
    }
    chmodSync(stagingRoot, 0o700);
    chmodSync(join(stagingRoot, 'anypick.db'), 0o600);
    if (existsSync(join(root, '.migrate.lock'))) {
      cpSync(join(root, '.migrate.lock'), join(stagingRoot, '.migrate.lock'));
    } else {
      writeFileSync(join(stagingRoot, '.migrate.lock'), '', { mode: 0o600 });
    }
    if (existsSync(root)) {
      renameSync(root, backupRoot);
    }
    try {
      renameSync(stagingRoot, root);
    } catch (error) {
      if (existsSync(backupRoot)) {
        renameSync(backupRoot, root);
      }
      throw error;
    }
    return true;
  } catch (error) {
    if (existsSync(stagingRoot)) {
      renameSync(stagingRoot, `${stagingRoot}.failed`);
    }
    throw error;
  }
}

/**
 * Open (or create) the anypick SQLite database.
 * File permissions are tightened to 0600 when possible.
 */
export function openDatabase(root?: string): AnyPickDatabase {
  const path = dbPath(root);
  const anypickRoot = dirname(path);
  mkdirSync(anypickRoot, { recursive: true, mode: 0o700 });
  try {
    chmodSync(anypickRoot, 0o700);
  } catch {
    // Windows / some FS may not support chmod
  }
  const inner = new DatabaseSync(path);
  const db = new NodeSqliteDatabase(inner);
  try {
    // Apply baseline schema + any pending versioned migrations.
    migrateSchema(db);
  } catch (err) {
    // In particular, a forward-incompatible schema must not leave a live
    // descriptor behind every time a caller retries startup.
    inner.close();
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / some FS may not support chmod
  }
  // Best-effort WAL sidecar permissions
  for (const suffix of ['-wal', '-shm']) {
    const side = `${path}${suffix}`;
    if (existsSync(side)) {
      try {
        chmodSync(side, 0o600);
      } catch {
        // ignore
      }
    }
  }
  return db;
}

/**
 * Open another application's SQLite file — no migrations, no permission
 * changes, no anypick schema. Providers need this to read or rewrite the stores
 * their upstream CLI owns (kiro-cli's `auth_kv`), and routing it through here
 * keeps `node:sqlite` confined to this module.
 *
 * Throws when the file is missing or is not a database; callers decide whether
 * that means "not logged in" or a real failure.
 */
export function openForeignDatabase(path: string, readOnly = false): AnyPickDatabase {
  return new NodeSqliteDatabase(new DatabaseSync(path, { readOnly }));
}

export function getMeta(db: AnyPickDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: AnyPickDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getConfigValue(db: AnyPickDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setConfigValue(db: AnyPickDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
