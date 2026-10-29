package db

import (
	"database/sql"
	"errors"
	"strconv"
	"testing"
)

// Rows cached before discovery rules were versioned keep their models and
// read as version 0, so a provider whose filter never changed loses nothing.
func TestOpenAddsModelCatalogRulesVersion(t *testing.T) {
	dir := t.TempDir()
	database := openDB(t, dir)
	if _, err := database.Exec(`ALTER TABLE model_catalog_cache DROP COLUMN rules_version`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(
		`INSERT INTO model_catalog_cache (provider, endpoint, models_json, fetched_at)
		 VALUES ('grok-api', 'account/grok/work', '["grok-4.7"]', '2026-09-18T06:44:20.574Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("PRAGMA user_version = " + strconv.Itoa(
		versionBefore(t, "add model catalog rules version"))); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openDB(t, dir)
	defer reopened.Close()
	var models string
	var rules int
	if err := reopened.QueryRow(
		`SELECT models_json, rules_version FROM model_catalog_cache WHERE provider = 'grok-api'`).Scan(&models, &rules); err != nil {
		t.Fatal(err)
	}
	if models != `["grok-4.7"]` || rules != 0 {
		t.Fatalf("row = %s rules %d", models, rules)
	}
}

// A development build can leave user_version at the current number without
// a column a guarded migration adds. The counter alone must not hide that:
// with rules_version gone every model cache read fails and discovery falls
// back to static lists.
func TestOpenRepairsGuardedColumnsMissingAtCurrentVersion(t *testing.T) {
	for _, tc := range []struct{ table, column string }{
		{"model_catalog_cache", "rules_version"},
		{"proxy_leases", "instance_id"},
	} {
		t.Run(tc.column, func(t *testing.T) {
			dir := t.TempDir()
			database := openDB(t, dir)
			if _, err := database.Exec("ALTER TABLE " + tc.table + " DROP COLUMN " + tc.column); err != nil {
				t.Fatal(err)
			}
			if err := database.Close(); err != nil {
				t.Fatal(err)
			}

			reopened := openDB(t, dir)
			defer reopened.Close()
			var version int
			if err := reopened.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
				t.Fatal(err)
			}
			if version != CurrentSchemaVersion() {
				t.Fatalf("user_version = %d, want %d", version, CurrentSchemaVersion())
			}
			if ok, err := hasColumn(reopened, tc.table, tc.column); err != nil || !ok {
				t.Fatalf("%s.%s not restored at the current schema version (err %v)", tc.table, tc.column, err)
			}
		})
	}
}

type failingQuery struct{ execs int }

func (f *failingQuery) Exec(string, ...any) (sql.Result, error) { f.execs++; return nil, nil }
func (f *failingQuery) Query(string, ...any) (*sql.Rows, error) {
	return nil, errors.New("disk I/O error")
}

// A read failure is not a missing column: repairing on it would issue an
// ALTER against a column that exists and fail the open.
func TestAddColumnIfMissingReturnsReadErrors(t *testing.T) {
	f := &failingQuery{}
	if err := addColumnIfMissing(f, "model_catalog_cache", "rules_version", "rules_version INTEGER"); err == nil {
		t.Fatal("want the read error")
	}
	if f.execs != 0 {
		t.Fatalf("ALTER attempted %d times after a failed read", f.execs)
	}
}
