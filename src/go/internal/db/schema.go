// Package db owns the SQLite schema for ~/.anypick/anypick.db.
//
// Schema versioning keys off PRAGMA user_version.
package db

import "database/sql"

const schema = `
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

-- Named client routes are separate from the one active global binding. Codex
-- CLI profiles use this table to remember which AnyPick source each native
-- profile file represents.
CREATE TABLE IF NOT EXISTS client_profiles (
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, name)
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

CREATE TABLE IF NOT EXISTS provider_model_roles (
  provider_id TEXT PRIMARY KEY NOT NULL,
  roles_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
`

// BaselineVersion is the fresh-install schema version.
const BaselineVersion = 1

// execer is satisfied by both *sql.DB and *sql.Tx, letting migrations run on
// the transaction's connection.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
}

type migration struct {
	name string
	up   func(execer) error
}

func hasColumn(d execer, table, column string) bool {
	rows, err := d.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false
	}
	defer rows.Close()
	idx := -1
	cols, _ := rows.Columns()
	for i, c := range cols {
		if c == "name" {
			idx = i
		}
	}
	if idx < 0 {
		return false
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return false
		}
		if s, ok := vals[idx].(string); ok && s == column {
			return true
		}
	}
	return false
}

// migrations applies in array order; index i corresponds to version i+2.
var migrations = []migration{
	{
		name: "add source resume history",
		up: func(d execer) error {
			_, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS source_resumes (
          source_ref TEXT NOT NULL,
          client_id TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (source_ref, client_id)
        );`)
			return err
		},
	},
	{
		name: "add plugin registry",
		up: func(d execer) error {
			_, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS plugins (
          name TEXT PRIMARY KEY NOT NULL,
          path TEXT NOT NULL,
          version TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          digest TEXT NOT NULL,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );`)
			return err
		},
	},
	{
		// instance_id was originally added to the fresh-install schema without
		// an ALTER migration; existing v3 databases fail on lease selects
		// without this guard.
		name: "add proxy lease instance identity",
		up: func(d execer) error {
			if !hasColumn(d, "proxy_leases", "instance_id") {
				_, err := d.Exec("ALTER TABLE proxy_leases ADD COLUMN instance_id TEXT")
				return err
			}
			return nil
		},
	},
	{
		name: "add model catalog cache",
		up: func(d execer) error {
			_, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS model_catalog_cache (
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          models_json TEXT NOT NULL DEFAULT '[]',
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (provider, endpoint)
        );`)
			return err
		},
	},
	{
		name: "add proxy hub state and token-scoped routes",
		up: func(d execer) error {
			_, err := d.Exec(`
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
        );`)
			return err
		},
	},
	{
		name: "add provider model-role defaults",
		up: func(d execer) error {
			_, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS provider_model_roles (
          provider_id TEXT PRIMARY KEY NOT NULL,
          roles_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );`)
			return err
		},
	},
	{
		name: "relational hub sources",
		up: func(d execer) error {
			if _, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS proxy_hub_sources (
          hub_name TEXT NOT NULL,
          position INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'account',
          provider TEXT,
          account TEXT,
          pool TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (hub_name, position),
          FOREIGN KEY (hub_name) REFERENCES proxy_hubs(name) ON DELETE CASCADE,
          FOREIGN KEY (provider, account) REFERENCES accounts(provider, name) ON DELETE CASCADE
        );`); err != nil {
				return err
			}
			return backfillHubSources(d)
		},
	},
	{
		name: "slug account primary keys",
		up:   renameUnsluggedAccountKeys,
	},
	{
		// No foreign key to accounts: history outlives a removed account, and
		// a cascade would silently rewrite what was spent (ADR-0037).
		name: "add usage history",
		up: func(d execer) error {
			_, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at_ms INTEGER NOT NULL,
          route TEXT NOT NULL,
          provider TEXT NOT NULL,
          account TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          status INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          reported INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events(at_ms);`)
			return err
		},
	},
	{
		// Discovery filters change what a provider publishes; rows cached
		// under an older filter must read as absent (catalog.ModelCatalogRules).
		name: "add model catalog rules version",
		up: func(d execer) error {
			if !hasColumn(d, "model_catalog_cache", "rules_version") {
				_, err := d.Exec("ALTER TABLE model_catalog_cache ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 0")
				return err
			}
			return nil
		},
	},
}
