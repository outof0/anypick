package db

import (
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
