package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestWriteGrokSessionReplacesAtomically covers the portable half of the
// on-disk contract for writeGrokSession: valid JSON afterwards, other sessions
// in the shared file preserved, owner-only mode, and no staging file left
// behind.
//
// authPath is the real ~/.grok/auth.json and x.ai rotates the refresh token on
// every redemption, so this runs while serving traffic rather than during a
// user action. An in-place write interrupted by SIGKILL leaves the login empty
// with nothing to recover from — Backup copies live->snapshot, never the
// reverse (invariant #4, ADR 0004). The assertion that actually proves the
// rename is the inode check in grok_auth_atomic_unix_test.go.
func TestWriteGrokSessionReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	authPath := filepath.Join(dir, "auth.json")

	// An unrelated session that must survive: writeGrokSession overwrites one
	// key inside a file several sessions share.
	if err := os.WriteFile(authPath, []byte(`{"other-session":{"access_token":"keep-me"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	s := grokSession{
		storageKey: "grok-session",
		raw: map[string]json.RawMessage{
			"access_token":  json.RawMessage(`"rotated"`),
			"refresh_token": json.RawMessage(`"rotated-refresh"`),
		},
	}
	if err := writeGrokSession(authPath, s); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("auth.json is not valid JSON after the write: %v\n%s", err, data)
	}
	if string(got["grok-session"]) == "" {
		t.Fatalf("rotated session missing: %s", data)
	}
	if !strings.Contains(string(data), "keep-me") {
		t.Fatalf("unrelated session destroyed by the write: %s", data)
	}

	// A staging file surviving a successful write would mean the rename did
	// not happen.
	leftovers, err := filepath.Glob(filepath.Join(dir, ".grok-auth-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("staging file left behind: %v", leftovers)
	}

	info, err := os.Stat(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		perm := info.Mode().Perm()
		t.Fatalf("auth.json mode = %v, want 0600", perm)
	}
}
