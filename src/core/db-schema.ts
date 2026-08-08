import type { AnyPickDatabase } from './db';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  proxy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, name)
);

CREATE TABLE IF NOT EXISTS account_snapshot_files (
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (provider, account, path),
  FOREIGN KEY (provider, account)
    REFERENCES accounts(provider, name)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_active (
  provider TEXT PRIMARY KEY NOT NULL,
  account_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_state (
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (provider, account)
);

CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY NOT NULL,
  meta_json TEXT NOT NULL,
  secrets_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_state (
  client_id TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_bindings (
  client_id TEXT PRIMARY KEY NOT NULL,
  spec_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  managed_config_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_bindings (
  project_root TEXT NOT NULL,
  client_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_root, client_id)
);

CREATE TABLE IF NOT EXISTS source_resumes (
  source_ref TEXT NOT NULL,
  client_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_ref, client_id)
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operation_journal (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  affected_resources_json TEXT NOT NULL DEFAULT '[]',
  backup_paths_json TEXT NOT NULL DEFAULT '[]',
  params_json TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_leases (
  lease_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  account TEXT,
  port INTEGER NOT NULL,
  host TEXT NOT NULL DEFAULT '127.0.0.1',
  endpoint TEXT,
  owner_pid INTEGER NOT NULL,
  instance_id TEXT,
  binding_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  provider TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL DEFAULT 'single',
  enabled INTEGER NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL DEFAULT 'failover',
  host TEXT,
  port INTEGER,
  members_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- Cached vendor model lists. Advisory data: a miss or a stale row costs a
-- refetch, never correctness, so it is safe to delete this table at any time.
CREATE TABLE IF NOT EXISTS model_catalog_cache (
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider, endpoint)
);

-- The unified local Proxy Hub. Config and public runtime state intentionally
-- live apart from per-account proxy_state: one hub can serve many providers.
CREATE TABLE IF NOT EXISTS proxy_hubs (
  name TEXT PRIMARY KEY NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_hub_runtime (
  name TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (name) REFERENCES proxy_hubs(name) ON DELETE CASCADE
);

-- token_secret is owner-only material. It is never decoded into public status
-- types or included in the Tray/CLI snapshot surface.
CREATE TABLE IF NOT EXISTS proxy_hub_routes (
  route_id TEXT PRIMARY KEY NOT NULL,
  hub_name TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  token_secret TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (hub_name) REFERENCES proxy_hubs(name) ON DELETE CASCADE
);
`;

/**
 * Schema versioning.
 *
 * `SCHEMA` above is the *baseline* (version 1). It is applied idempotently with
 * `CREATE TABLE IF NOT EXISTS` so a fresh database is fully formed. `MIGRATIONS`
 * holds *ordered* DDL/backfill steps for every schema change *after* the
 * baseline. Each entry bumps `user_version` by one and is applied exactly once
 * per installed database, keyed off `PRAGMA user_version`.
 *
 * This exists because `IF NOT EXISTS` silently skips altered column types and
 * new constraints — without a versioned runner, the installed base would drift
 * from `SCHEMA` the first time a column changes. Add new steps here rather than
 * editing `SCHEMA` for anything that is not purely additive.
 */
export const BASELINE_VERSION = 1;

export interface SchemaMigration {
  /** Human label, used in logs. */
  name: string;
  /** Apply against an already-open database. Run inside a transaction by caller. */
  up(db: AnyPickDatabase): void;
}

function hasColumn(db: AnyPickDatabase, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) {
        return false;
      }
      return (entry as Record<string, unknown>).name === column;
    });
}

/** Migrations are applied in array order; index i corresponds to version i+2. */
export const MIGRATIONS: SchemaMigration[] = [
  {
    name: 'add source resume history',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_resumes (
          source_ref TEXT NOT NULL,
          client_id TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (source_ref, client_id)
        );
      `),
  },
  {
    name: 'add plugin registry',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugins (
          name TEXT PRIMARY KEY NOT NULL,
          path TEXT NOT NULL,
          version TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          digest TEXT NOT NULL,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `),
  },
  {
    // `instance_id` was originally added to the fresh-install schema without
    // a corresponding ALTER migration. Existing version-3 databases therefore
    // failed whenever lease code selected the column (doctor/startup reaping).
    name: 'add proxy lease instance identity',
    up: (db) => {
      if (!hasColumn(db, 'proxy_leases', 'instance_id')) {
        db.exec('ALTER TABLE proxy_leases ADD COLUMN instance_id TEXT');
      }
    },
  },
  {
    // Also present in the baseline SCHEMA so a fresh install is fully formed;
    // this step is what gives an already-installed database the table.
    name: 'add model catalog cache',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_catalog_cache (
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          models_json TEXT NOT NULL DEFAULT '[]',
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (provider, endpoint)
        );
      `),
  },
  {
    name: 'add proxy hub state and token-scoped routes',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS proxy_hubs (
          name TEXT PRIMARY KEY NOT NULL,
          config_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS proxy_hub_runtime (
          name TEXT PRIMARY KEY NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (name) REFERENCES proxy_hubs(name) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS proxy_hub_routes (
          route_id TEXT PRIMARY KEY NOT NULL,
          hub_name TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          token_secret TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (hub_name) REFERENCES proxy_hubs(name) ON DELETE CASCADE
        );
      `),
  },
];

/**
 * Apply `SCHEMA` (baseline) then any pending versioned migrations. Idempotent:
 * safe to call on every open. Reads/writes `PRAGMA user_version`.
 */
export function migrateSchema(db: AnyPickDatabase): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as
    | { user_version?: unknown }
    | undefined;
  let current = Number(versionRow?.user_version ?? 0);
  const target = BASELINE_VERSION + MIGRATIONS.length;

  // Opening a newer database with an older binary is unsafe: SQLite would
  // happily let this build write against tables whose invariants it does not
  // understand. Refuse before executing even idempotent DDL.
  if (current > target) {
    throw new Error(
      `anypick.db schema version ${current} is newer than this AnyPick build supports (${target}). Upgrade AnyPick before using this data directory.`,
    );
  }

  db.exec(SCHEMA);

  // Unversioned database (fresh, or created before the versioning runner
  // existed): the baseline SCHEMA above is exactly version BASELINE_VERSION.
  if (current < BASELINE_VERSION) {
    db.exec(`PRAGMA user_version = ${BASELINE_VERSION}`);
    current = BASELINE_VERSION;
  }

  for (let v = current; v < target; v++) {
    const migration = MIGRATIONS[v - BASELINE_VERSION];
    db.transaction(() => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
