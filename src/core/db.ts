import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getHotplugRoot } from './paths';
import { migrateSchema } from './db-schema';
export { BASELINE_VERSION, MIGRATIONS, migrateSchema } from './db-schema';

/**
 * Database boundary.
 *
 * `node:sqlite` is an experimental Node API and may change before 1.0. Every
 * other module depends only on the `HotplugDatabase` interface defined here; the
 * concrete `node:sqlite` binding is confined to this file (the only module that
 * imports `node:sqlite`). To swap the backend, implement `HotplugDatabase` with
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

export interface HotplugDatabase {
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

/** Adapter wrapping the experimental `node:sqlite` binding behind HotplugDatabase. */
class NodeSqliteDatabase implements HotplugDatabase {
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

/** Path to the SQLite database under the hotplug root. */
export function dbPath(root?: string): string {
  return join(getHotplugRoot(root), 'hotplug.db');
}

/**
 * Open (or create) the hotplug SQLite database.
 * File permissions are tightened to 0600 when possible.
 */
export function openDatabase(root?: string): HotplugDatabase {
  const path = dbPath(root);
  const hotplugRoot = dirname(path);
  mkdirSync(hotplugRoot, { recursive: true, mode: 0o700 });
  try {
    chmodSync(hotplugRoot, 0o700);
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
 * changes, no hotplug schema. Providers need this to read or rewrite the stores
 * their upstream CLI owns (kiro-cli's `auth_kv`), and routing it through here
 * keeps `node:sqlite` confined to this module.
 *
 * Throws when the file is missing or is not a database; callers decide whether
 * that means "not logged in" or a real failure.
 */
export function openForeignDatabase(path: string, readOnly = false): HotplugDatabase {
  return new NodeSqliteDatabase(new DatabaseSync(path, { readOnly }));
}

export function getMeta(db: HotplugDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: HotplugDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getConfigValue(db: HotplugDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setConfigValue(db: HotplugDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
