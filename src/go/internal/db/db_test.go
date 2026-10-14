package db

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/outof0/anypick/go/internal/anyerr"
)

func TestOpenCreatesFileAndMigrates(t *testing.T) {
	root := t.TempDir()
	database, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = database.Close() }()

	path := filepath.Join(root, "anypick.db")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("anypick.db not created: %v", err)
	}
	info, _ := os.Stat(path)
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("anypick.db perm=%o want 600", info.Mode().Perm())
	}

	var version int
	if err := database.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("user_version: %v", err)
	}
	want := BaselineVersion + len(migrations)
	if version != want {
		t.Fatalf("user_version=%d want %d", version, want)
	}

	// Baseline tables exist.
	for _, tbl := range []string{"accounts", "global_bindings", "presets", "proxy_leases", "proxy_hubs"} {
		var name string
		err := database.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("table %q missing: %v", tbl, err)
		}
	}

	// Re-open same root is idempotent.
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	database2, err := Open(root)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	defer func() { _ = database2.Close() }()
	var version2 int
	if err := database2.QueryRow("PRAGMA user_version").Scan(&version2); err != nil {
		t.Fatal(err)
	}
	if version2 != want {
		t.Fatalf("reopen version=%d want %d", version2, want)
	}
}

func TestOpenRefusesNewerSchema(t *testing.T) {
	root := t.TempDir()
	database, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	_ = database.Close()

	// Bump user_version beyond what this build supports.
	raw, err := sql.Open("sqlite", filepath.Join(root, "anypick.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("PRAGMA user_version = 9999"); err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()

	_, err = Open(root)
	if err == nil {
		t.Fatal("want error opening newer schema, got nil")
	}
	var ae *anyerr.Error
	if !errors.As(err, &ae) {
		t.Fatalf("want *anyerr.Error, got %T %v", err, err)
	}
	if ae.Code != "SCHEMA_NEWER" {
		t.Fatalf("Code=%q want SCHEMA_NEWER", ae.Code)
	}
	if ae.ExitCode != anyerr.Operational {
		t.Fatalf("ExitCode=%v want Operational", ae.ExitCode)
	}
}

func TestInTransactionCommitAndRollback(t *testing.T) {
	root := t.TempDir()
	database, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()

	// Commit path.
	if err := database.InTransaction(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO config(key, value) VALUES(?, ?)`, "k1", "v1")
		return err
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	var v string
	if err := database.QueryRow(`SELECT value FROM config WHERE key='k1'`).Scan(&v); err != nil || v != "v1" {
		t.Fatalf("k1=%q err=%v want v1", v, err)
	}

	// Rollback path: error returned from fn should not persist.
	if err := database.InTransaction(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO config(key, value) VALUES(?, ?)`, "k2", "v2"); err != nil {
			return err
		}
		return errors.New("boom")
	}); err == nil || err.Error() != "boom" {
		t.Fatalf("want boom error, got %v", err)
	}
	var cnt int
	if err := database.QueryRow(`SELECT COUNT(*) FROM config WHERE key='k2'`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Fatalf("k2 persisted after rollback, count=%d", cnt)
	}
}

func TestOpenCreatesRootIfMissing(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "root")
	database, err := Open(root)
	if err != nil {
		t.Fatalf("Open nested root: %v", err)
	}
	defer func() { _ = database.Close() }()
	if _, err := os.Stat(filepath.Join(root, "anypick.db")); err != nil {
		t.Fatalf("db not created under nested root: %v", err)
	}
}
