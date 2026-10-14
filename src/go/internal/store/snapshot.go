package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/paths"
)

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// stagedFilePath validates a relative key and resolves it inside stagingRoot,
// refusing escapes.
func stagedFilePath(stagingRoot, relKey string) (string, error) {
	if err := validateImportFileKey(relKey); err != nil {
		return "", err
	}
	normalized := filepath.Clean(strings.ReplaceAll(relKey, "\\", "/"))
	abs := filepath.Join(stagingRoot, normalized)
	rel, err := filepath.Rel(stagingRoot, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", anyerr.Newf(
			"Import file path escapes the staging root: "+relKey+".", "IMPORT_FORMAT")
	}
	return abs, nil
}

func validateImportFileKey(key string) error {
	if key == "" || strings.ContainsRune(key, 0) {
		return anyerr.Newf("Invalid import file path: "+quote(key)+".", "IMPORT_FORMAT")
	}
	slashKey := strings.ReplaceAll(key, `\`, "/")
	if path.IsAbs(slashKey) || filepath.IsAbs(key) {
		return anyerr.Newf("Import file path must be relative: "+key+".", "IMPORT_FORMAT")
	}
	if isWindowsAbsolute(key) {
		return anyerr.Newf("Import file path must be relative: "+key+".", "IMPORT_FORMAT")
	}
	if strings.Contains(key, "\\") && strings.Contains(key, "/") {
		return anyerr.Newf("Import file path mixes path separators: "+key+".", "IMPORT_FORMAT")
	}
	return nil
}

// isWindowsAbsolute rejects drive letters / UNC on every host, since
// filepath.IsAbs only recognizes the current platform's form.
func isWindowsAbsolute(key string) bool {
	if len(key) >= 3 && isLetter(key[0]) && key[1] == ':' && (key[2] == '\\' || key[2] == '/') {
		return true
	}
	return strings.HasPrefix(key, "\\\\")
}

func isLetter(b byte) bool { return unicode.IsUpper(rune(b)) || unicode.IsLower(rune(b)) }

// IngestSnapshotDir replaces this account's BLOB rows with the directory
// contents. Caller runs inside a transaction.
func IngestSnapshotDir(tx *sql.Tx, providerID, name, snapDir string) error {
	if _, err := tx.Exec(
		`DELETE FROM account_snapshot_files WHERE provider = ? AND account = ?`,
		providerID, name); err != nil {
		return err
	}
	if _, err := os.Stat(snapDir); os.IsNotExist(err) {
		return nil
	}
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			full := filepath.Join(dir, entry.Name())
			rel := entry.Name()
			if prefix != "" {
				rel = prefix + "/" + entry.Name()
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			switch {
			case info.IsDir():
				if err := walk(full, rel); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				content, err := os.ReadFile(full)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(
					`INSERT INTO account_snapshot_files (provider, account, path, content)
					 VALUES (?, ?, ?, ?)`,
					providerID, name, strings.ReplaceAll(rel, "\\", "/"), content); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(snapDir, "")
}

// CopySnapshotFiles writes the committed snapshot BLOBs for one account into
// dest. The canonical cache is left alone, so a later materialize cannot
// destroy the copy a cancelled login still has to restore (ADR 0004).
func (s *AccountStore) CopySnapshotFiles(ctx context.Context, providerID, name, dest string) error {
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return err
	}
	rows, err := s.DB.QueryContext(ctx,
		`SELECT path, content FROM account_snapshot_files WHERE provider = ? AND account = ?`,
		providerID, name)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var rel string
		var content []byte
		if err := rows.Scan(&rel, &content); err != nil {
			return err
		}
		to, err := stagedFilePath(dest, rel)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(to, content, 0o600); err != nil {
			return err
		}
	}
	return rows.Err()
}

// MaterializeSnapshot rebuilds the on-disk snapshot cache from committed BLOB
// rows. Path traversal and collisions are rejected.
func MaterializeSnapshot(root string, d *sql.DB, providerID, name string) error {
	snap := paths.AccountSnapshotDir(root, providerID, name)
	if err := os.MkdirAll(snap, 0o700); err != nil {
		return err
	}
	rows, err := d.Query(
		`SELECT path, content FROM account_snapshot_files WHERE provider = ? AND account = ?`,
		providerID, name)
	if err != nil {
		return err
	}
	type dest struct {
		path string
		to   string
		data []byte
	}
	var destinations []dest
	for rows.Next() {
		var p string
		var content []byte
		if err := rows.Scan(&p, &content); err != nil {
			rows.Close()
			return err
		}
		to, err := stagedFilePath(snap, p)
		if err != nil {
			rows.Close()
			return anyerr.Newf(
				"Snapshot contains an unsafe file path: "+quote(p)+".", "SNAPSHOT_INVALID")
		}
		destinations = append(destinations, dest{path: p, to: to, data: content})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	seen := make([]string, 0, len(destinations))
	for _, dd := range destinations {
		rel := strings.TrimPrefix(strings.ReplaceAll(dd.path, "\\", "/"), "./")
		for _, existing := range seen {
			if rel == existing ||
				strings.HasPrefix(rel, existing+"/") ||
				strings.HasPrefix(existing, rel+"/") {
				return anyerr.New("Snapshot contains colliding file paths.", "SNAPSHOT_INVALID")
			}
		}
		seen = append(seen, rel)
	}

	entries, err := os.ReadDir(snap)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(snap, entry.Name())); err != nil {
			return err
		}
	}
	for _, dd := range destinations {
		if err := os.MkdirAll(filepath.Dir(dd.to), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(dd.to, dd.data, fs.FileMode(0o600)); err != nil {
			return err
		}
	}
	return nil
}
