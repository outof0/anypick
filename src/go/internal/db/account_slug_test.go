package db

import (
	"encoding/json"
	"strconv"
	"testing"
)

func TestOpenRenamesLegacyAccountKey(t *testing.T) {
	dir := t.TempDir()
	database := openDB(t, dir)
	insertLegacyAccount(t, database)
	// Rewind to just before the slug migration, wherever it now sits in the
	// list; later migrations re-run harmlessly (IF NOT EXISTS).
	if _, err := database.Exec("PRAGMA user_version = " + strconv.Itoa(versionBefore(t, "slug account primary keys"))); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openDB(t, dir)
	defer reopened.Close()

	var name, meta string
	if err := reopened.QueryRow(
		`SELECT name, meta_json FROM accounts WHERE provider = 'codex'`).Scan(&name, &meta); err != nil {
		t.Fatal(err)
	}
	if name != "personal" {
		t.Fatalf("accounts.name = %q", name)
	}
	var doc struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(meta), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Name != "personal" {
		t.Fatalf("meta name = %q", doc.Name)
	}
	var blob string
	if err := reopened.QueryRow(
		`SELECT content FROM account_snapshot_files WHERE provider = 'codex' AND account = 'personal' AND path = 'auth.json'`).Scan(&blob); err != nil {
		t.Fatal(err)
	}
	if blob != "token" {
		t.Fatalf("snapshot = %q", blob)
	}
	assertColumn(t, reopened, `SELECT account_name FROM provider_active WHERE provider = 'codex'`, "personal")
	assertColumn(t, reopened, `SELECT account FROM proxy_state WHERE provider = 'codex'`, "personal")
	var state string
	if err := reopened.QueryRow(`SELECT state_json FROM proxy_state WHERE provider = 'codex'`).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if !json.Valid([]byte(state)) || !containsAccountName(state, "personal") {
		t.Fatalf("proxy state = %s", state)
	}
	assertColumn(t, reopened, `SELECT account FROM proxy_leases WHERE provider = 'codex'`, "personal")
	assertColumn(t, reopened, `SELECT account FROM proxy_hub_sources WHERE provider = 'codex'`, "personal")
	var members string
	if err := reopened.QueryRow(`SELECT members_json FROM pools WHERE provider = 'codex'`).Scan(&members); err != nil {
		t.Fatal(err)
	}
	if !containsAccountName(members, "personal") || containsAccountName(members, "Personal") {
		t.Fatalf("pool members = %s", members)
	}
	var leftover int
	if err := reopened.QueryRow(
		`SELECT COUNT(*) FROM accounts WHERE provider = 'codex' AND name = 'Personal'`).Scan(&leftover); err != nil {
		t.Fatal(err)
	}
	if leftover != 0 {
		t.Fatalf("legacy row still present")
	}
}

func TestRenameSkipsWhenSlugRowAlreadyExists(t *testing.T) {
	database := openDB(t, t.TempDir())
	defer database.Close()
	insertLegacyAccount(t, database)
	if _, err := database.Exec(
		`INSERT INTO accounts (provider, name, meta_json, proxy_json, created_at, updated_at)
		 VALUES ('codex', 'personal', '{"name":"personal"}', '{}', 't', 't')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(
		`INSERT INTO account_snapshot_files (provider, account, path, content)
		 VALUES ('codex', 'personal', 'auth.json', 'slug-token')`); err != nil {
		t.Fatal(err)
	}
	if err := renameUnsluggedAccountKeys(database); err != nil {
		t.Fatal(err)
	}
	var legacy, slugBlob string
	if err := database.QueryRow(
		`SELECT content FROM account_snapshot_files WHERE provider = 'codex' AND account = 'Personal'`).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy != "token" {
		t.Fatalf("legacy snapshot = %q", legacy)
	}
	if err := database.QueryRow(
		`SELECT content FROM account_snapshot_files WHERE provider = 'codex' AND account = 'personal'`).Scan(&slugBlob); err != nil {
		t.Fatal(err)
	}
	if slugBlob != "slug-token" {
		t.Fatalf("slug snapshot = %q", slugBlob)
	}
}

func openDB(t *testing.T, dir string) *DB {
	t.Helper()
	database, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func insertLegacyAccount(t *testing.T, database *DB) {
	t.Helper()
	stmts := []string{
		`INSERT INTO accounts (provider, name, meta_json, proxy_json, created_at, updated_at)
		 VALUES ('codex', 'Personal', '{"name":"Personal","provider":"codex"}', '{}', 't', 't')`,
		`INSERT INTO account_snapshot_files (provider, account, path, content)
		 VALUES ('codex', 'Personal', 'auth.json', 'token')`,
		`INSERT INTO provider_active (provider, account_name) VALUES ('codex', 'Personal')`,
		`INSERT INTO proxy_state (provider, account, state_json)
		 VALUES ('codex', 'Personal', '{"accountName":"Personal","token":"sek"}')`,
		`INSERT INTO proxy_leases (lease_id, provider, account, port, owner_pid, created_at, updated_at)
		 VALUES ('lease-1', 'codex', 'Personal', 1, 1, 't', 't')`,
		`INSERT INTO proxy_hubs (name, config_json, created_at, updated_at)
		 VALUES ('hub', '{}', 't', 't')`,
		`INSERT INTO proxy_hub_sources (hub_name, position, kind, provider, account)
		 VALUES ('hub', 0, 'account', 'codex', 'Personal')`,
		`INSERT INTO pools (provider, mode, enabled, strategy, members_json, updated_at)
		 VALUES ('codex', 'single', 1, 'failover', '[{"account":"Personal","enabled":true}]', 't')`,
	}
	for _, stmt := range stmts {
		if _, err := database.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
}

func assertColumn(t *testing.T, database *DB, query, want string) {
	t.Helper()
	var got string
	if err := database.QueryRow(query).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("%s = %q", query, got)
	}
}

func containsAccountName(raw, name string) bool {
	var probe any
	if json.Unmarshal([]byte(raw), &probe) != nil {
		return false
	}
	switch doc := probe.(type) {
	case map[string]any:
		return doc["accountName"] == name
	case []any:
		for _, item := range doc {
			member, ok := item.(map[string]any)
			if ok && member["account"] == name {
				return true
			}
		}
	}
	return false
}

// versionBefore is the user_version a database has just before the named
// migration runs.
func versionBefore(t *testing.T, name string) int {
	t.Helper()
	for i, m := range migrations {
		if m.name == name {
			return BaselineVersion + i
		}
	}
	t.Fatalf("no migration named %q", name)
	return 0
}
