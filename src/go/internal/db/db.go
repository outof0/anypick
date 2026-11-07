package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"github.com/outof0/anypick/go/internal/anyerr"
)

// DB wraps database/sql with the narrow surface core needs (the Go equivalent
// of AnyPickDatabase). Each group of tables has exactly one owning package;
// see TableOwners in tables.go for the enforced registry.
type DB struct {
	*sql.DB
}

// Open opens (creating if needed) anypick.db under root with WAL, FK
// enforcement, and owner-only permissions, then runs migrations.
func Open(root string) (*DB, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, anyerr.Wrapf(err, "create data root", "FS_PATH")
	}
	path := filepath.Join(root, "anypick.db")
	d, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, anyerr.Wrapf(err, "open anypick.db", "DB_OPEN")
	}
	// modernc/sqlite serializes writes; a single connection keeps
	// BEGIN IMMEDIATE transactions and flock-free consistency simple.
	d.SetMaxOpenConns(1)
	wrapped := &DB{DB: d}
	if err := wrapped.MigrateSchema(); err != nil {
		_ = d.Close()
		return nil, err
	}
	// Best effort: tighten file permissions like openDatabase in TS.
	_ = os.Chmod(path, 0o600)
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Chmod(path+suffix, 0o600)
	}
	return wrapped, nil
}

// MigrateSchema applies the baseline SCHEMA then pending versioned migrations.
// Refuses to open a database written by a newer build.
func (d *DB) MigrateSchema() error {
	var current int
	if err := d.QueryRow("PRAGMA user_version").Scan(&current); err != nil {
		return anyerr.Wrapf(err, "read user_version", "DB_OPEN")
	}
	target := BaselineVersion + len(migrations)

	// Opening a newer database with an older binary is unsafe: refuse before
	// executing even idempotent DDL.
	if current > target {
		return anyerr.Newf(
			fmt.Sprintf(
				"anypick.db schema version %d is newer than this AnyPick build supports (%d). Upgrade AnyPick before using this data directory.",
				current, target),
			"SCHEMA_NEWER",
			anyerr.WithExitCode(anyerr.Operational),
		)
	}

	if _, err := d.Exec(schema); err != nil {
		return anyerr.Wrapf(err, "apply baseline schema", "DB_MIGRATE")
	}

	if current < BaselineVersion {
		if _, err := d.Exec(fmt.Sprintf("PRAGMA user_version = %d", BaselineVersion)); err != nil {
			return anyerr.Wrapf(err, "set baseline user_version", "DB_MIGRATE")
		}
		current = BaselineVersion
	}

	for v := current; v < target; v++ {
		m := migrations[v-BaselineVersion]
		tx, err := d.BeginTx(context.Background(), nil)
		if err != nil {
			return anyerr.Wrapf(err, "begin migration", "DB_MIGRATE")
		}
		// The migration MUST run on the transaction's connection: with
		// MaxOpenConns(1) executing against the pool would wait on the very
		// transaction holding the only slot.
		if err := m.up(tx); err != nil {
			_ = tx.Rollback()
			return anyerr.Wrapf(err, "migration "+m.name, "DB_MIGRATE")
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", v+1)); err != nil {
			_ = tx.Rollback()
			return anyerr.Wrapf(err, "bump user_version", "DB_MIGRATE")
		}
		if err := tx.Commit(); err != nil {
			return anyerr.Wrapf(err, "commit migration", "DB_MIGRATE")
		}
	}
	for _, m := range migrations {
		if !m.repair {
			continue
		}
		if err := m.up(d); err != nil {
			return anyerr.Wrapf(err, "repair "+m.name, "DB_MIGRATE")
		}
	}
	return nil
}

// InTransaction runs fn inside one transaction, rolling back on error — the
// equivalent of db.transaction() in TS. Nested use is not supported (matches
// the TS boundary: only stores call this).
func (d *DB) InTransaction(fn func(tx *sql.Tx) error) error {
	return d.InTransactionContext(context.Background(), fn)
}

// InTransactionContext is the context-aware variant. Callers that have a
// request context should prefer this so cancellation/timeout can unblock the
// single pooled connection (MaxOpenConns(1)).
func (d *DB) InTransactionContext(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ExecContext / QueryContext / QueryRowContext are the context-aware
// equivalents of the embedded sql.DB methods. Stores should prefer these and
// thread the caller's context so a cancelled request does not head-block the
// single pooled connection (MaxOpenConns(1) — P0). The bare Exec/Query/QueryRow
// remain for migrations and call sites without a request context.
func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return d.DB.ExecContext(ctx, query, args...)
}

func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.DB.QueryContext(ctx, query, args...)
}

func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return d.DB.QueryRowContext(ctx, query, args...)
}
