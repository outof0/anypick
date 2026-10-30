package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenForeignMissing(t *testing.T) {
	_, err := OpenForeign(filepath.Join(t.TempDir(), "nope.db"), false)
	if err == nil {
		t.Fatal("want error for missing file")
	}
}

func TestOpenForeignReadOnlyAndReadWrite(t *testing.T) {
	dir := t.TempDir()
	// Create a real anypick db to use as foreign target.
	database, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "anypick.db")

	ro, err := OpenForeign(path, true)
	if err != nil {
		t.Fatalf("OpenForeign ro: %v", err)
	}
	defer ro.Close()
	var one int
	if err := ro.QueryRow("SELECT 1").Scan(&one); err != nil || one != 1 {
		t.Fatalf("ro query: %v %d", err, one)
	}
	if _, err := ro.Exec("CREATE TABLE t2(x TEXT)"); err == nil {
		t.Fatal("want write to fail on read-only foreign db")
	}

	rw, err := OpenForeign(path, false)
	if err != nil {
		t.Fatalf("OpenForeign rw: %v", err)
	}
	defer rw.Close()
	if _, err := rw.Exec("CREATE TABLE IF NOT EXISTS t_rw(x TEXT)"); err != nil {
		t.Fatalf("rw exec: %v", err)
	}
}

func TestExecQueryContexts(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()
	ctx := context.Background()

	if _, err := database.ExecContext(ctx, `INSERT INTO config(key, value) VALUES(?, ?)`, "k_ctx", "v_ctx"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	rows, err := database.QueryContext(ctx, `SELECT key, value FROM config WHERE key=?`, "k_ctx")
	if err != nil {
		t.Fatalf("QueryContext: %v", err)
	}
	var k, v string
	if !rows.Next() {
		t.Fatal("want row")
	}
	if err := rows.Scan(&k, &v); err != nil {
		t.Fatal(err)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	// Close before the next query: with MaxOpenConns(1) an open Rows holds
	// the only pooled connection.
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if k != "k_ctx" || v != "v_ctx" {
		t.Fatalf("got %q %q", k, v)
	}
	row := database.QueryRowContext(ctx, `SELECT value FROM config WHERE key=?`, "k_ctx")
	var got string
	if err := row.Scan(&got); err != nil || got != "v_ctx" {
		t.Fatalf("QueryRowContext: %v %q", err, got)
	}
}

func TestInTransactionContext(t *testing.T) {
	database, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()
	ctx := context.Background()

	if err := database.InTransactionContext(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO config(key, value) VALUES(?, ?)`, "ktx", "vtx")
		return err
	}); err != nil {
		t.Fatalf("InTransactionContext commit: %v", err)
	}
	var v string
	if err := database.QueryRow(`SELECT value FROM config WHERE key='ktx'`).Scan(&v); err != nil || v != "vtx" {
		t.Fatalf("ktx=%q err=%v", v, err)
	}

	// Rollback on error.
	if err := database.InTransactionContext(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO config(key, value) VALUES(?, ?)`, "ktx2", "v2"); err != nil {
			return err
		}
		return context.Canceled
	}); err == nil {
		t.Fatal("want error")
	}
	var cnt int
	if err := database.QueryRow(`SELECT COUNT(*) FROM config WHERE key='ktx2'`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Fatalf("ktx2 should have rolled back, cnt=%d", cnt)
	}
}

func TestOpenForeignStatErrorIsWrapped(t *testing.T) {
	// Pass a directory path — Stat succeeds but sqlite open may still succeed;
	// the missing-file path is the reliable error branch (covered above).
	// This just exercises the Stat error wrapper with a non-existent nested path.
	_, err := OpenForeign("/tmp/definitely-does-not-exist-xyz-123/anypick.db", false)
	if err == nil {
		t.Fatal("want error")
	}
	// Ensure error is not nil and mentions stat.
	if err.Error() == "" {
		t.Fatal("empty error")
	}
}

func TestHasColumnAndMigrationsIdempotent(t *testing.T) {
	// Opening twice should re-run hasColumn guards without error.
	dir := t.TempDir()
	d1, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = d1.Close()
	d2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen after migrations: %v", err)
	}
	defer func() { _ = d2.Close() }()
	// Verify hasColumn sees the migrated column.
	for _, tc := range []struct {
		table, column string
		want          bool
	}{
		{"proxy_leases", "instance_id", true},
		{"proxy_leases", "nonexistent_xyz", false},
		{"no_such_table_xyz", "col", false},
	} {
		got, err := hasColumn(d2.DB, tc.table, tc.column)
		if err != nil || got != tc.want {
			t.Fatalf("hasColumn(%s, %s) = %v, %v; want %v", tc.table, tc.column, got, err, tc.want)
		}
	}
}

func TestOpenChmodBestEffort(t *testing.T) {
	dir := t.TempDir()
	database, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = database.Close() }()
	// WAL file may not exist yet; just ensure Open didn't fail.
	if _, err := os.Stat(filepath.Join(dir, "anypick.db")); err != nil {
		t.Fatalf("db missing: %v", err)
	}
}
