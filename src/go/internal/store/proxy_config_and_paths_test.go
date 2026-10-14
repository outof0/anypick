package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/outof0/anypick/go/internal/db"
)

func TestProxyConfigRoundTrip(t *testing.T) {
	s := testStore(t)
	// Missing row -> default (disabled)
	cfg, err := s.GetProxyConfig(context.Background(), "grok", "nope")
	if err != nil {
		t.Fatalf("GetProxyConfig missing: %v", err)
	}
	if cfg.Enabled {
		t.Fatalf("want default disabled, got %+v", cfg)
	}
	// Create account then set/get
	snap, _, _ := s.PrepareSnapshot("grok", "p1")
	_ = os.WriteFile(filepath.Join(snap, "f"), []byte("x"), 0o600)
	if err := s.WriteMetaContext(context.Background(), meta("grok", "p1"), snap); err != nil {
		t.Fatal(err)
	}
	want := ProxyConfig{Enabled: true, Port: 4100, Host: "127.0.0.1"}
	if err := s.SetProxyConfigContext(context.Background(), "grok", "p1", want); err != nil {
		t.Fatalf("SetProxyConfig: %v", err)
	}
	got, err := s.GetProxyConfig(context.Background(), "grok", "p1")
	if err != nil || !got.Enabled || got.Port != 4100 {
		t.Fatalf("GetProxyConfig = %+v %v", got, err)
	}
	// Context variants
	if _, err := s.GetProxyConfig(context.Background(), "grok", "p1"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProxyConfigContext(context.Background(), "grok", "p1", want); err != nil {
		t.Fatal(err)
	}
}

func TestSetProxyConfigMissingAccount(t *testing.T) {
	s := testStore(t)
	if err := s.SetProxyConfigContext(context.Background(), "grok", "ghost", ProxyConfig{Enabled: true}); err == nil {
		t.Fatal("want ACCOUNT_NOT_FOUND for missing account")
	}
}

func TestGetProxyConfigCorruptJSON(t *testing.T) {
	root := t.TempDir()
	database, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	s := New(root, database)
	snap, _, _ := s.PrepareSnapshot("grok", "c1")
	_ = os.WriteFile(filepath.Join(snap, "f"), []byte("x"), 0o600)
	if err := s.WriteMetaContext(context.Background(), meta("grok", "c1"), snap); err != nil {
		t.Fatal(err)
	}
	// Corrupt proxy_json directly
	if _, err := database.DB.Exec(`UPDATE accounts SET proxy_json='not-json' WHERE provider='grok' AND name='c1'`); err != nil {
		t.Fatal(err)
	}
	cfg, err := s.GetProxyConfig(context.Background(), "grok", "c1")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled {
		t.Fatalf("corrupt should degrade to disabled, got %+v", cfg)
	}
}

func TestStagedFilePath(t *testing.T) {
	dir := t.TempDir()
	// valid
	if p, err := stagedFilePath(dir, "a/b.txt"); err != nil || p == "" {
		t.Fatalf("valid: %v %q", err, p)
	}
	// escapes
	cases := []string{"", "../escape", "/abs", "C:/win", `a\b/c`, "a/../.."}
	failed := 0
	for _, c := range cases {
		// Empty and mixed separators / absolute should error; plain relative dot-dot escape may be caught by Rel check
		_, err := stagedFilePath(dir, c)
		if err != nil {
			failed++
		}
	}
	if failed < 3 {
		t.Fatalf("expected several stagedFilePath rejections, got %d", failed)
	}
	// UNC
	if _, err := stagedFilePath(dir, `\\server\share`); err == nil {
		t.Fatal("want error for UNC")
	}
}

func TestValidateImportFileKeyAndWindows(t *testing.T) {
	if err := validateImportFileKey("ok/file.txt"); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	if err := validateImportFileKey(""); err == nil {
		t.Fatal("empty should error")
	}
	if err := validateImportFileKey(string([]byte{0})); err == nil {
		t.Fatal("nul byte should error")
	}
	for _, absolute := range []string{"/abs", `\abs`} {
		if err := validateImportFileKey(absolute); err == nil {
			t.Fatalf("absolute path %q should error", absolute)
		}
	}
	if err := validateImportFileKey("C:\\windows\\path"); err == nil {
		t.Fatal("windows drive should error")
	}
	if err := validateImportFileKey(`a\b/c`); err == nil {
		t.Fatal("mixed separators should error")
	}
	if !isWindowsAbsolute(`C:\x`) || !isWindowsAbsolute(`\\host`) {
		t.Fatal("isWindowsAbsolute false negative")
	}
	if isWindowsAbsolute("rel/path") {
		t.Fatal("isWindowsAbsolute false positive")
	}
	if got := quote("hi"); got != `"hi"` {
		t.Fatalf("quote = %q", got)
	}
}

func TestHasPathPrefixAndDiscard(t *testing.T) {
	root := t.TempDir()
	if hasPathPrefix(root, root) {
		t.Fatal("equal should be false")
	}
	child := filepath.Join(root, "child", "file")
	if !hasPathPrefix(child, root) {
		t.Fatalf("child should have prefix")
	}
	if hasPathPrefix("/tmp/other", root) {
		t.Fatal("other prefix false positive")
	}
	s := testStore(t)
	// Outside staging -> FS_PATH error
	if err := s.DiscardPreparedSnapshot("/tmp/not-staging"); err == nil {
		t.Fatal("want FS_PATH for outside staging")
	}
	if err := s.DiscardPreparedSnapshot(s.Root); err == nil {
		t.Fatal("want error for root itself")
	}
	// Inside staging but not tracked still removes (best-effort)
	staging := filepath.Join(s.Root, ".anypick", "staging")
	_ = os.MkdirAll(staging, 0o700)
	tmp := filepath.Join(staging, "tmpdir")
	_ = os.MkdirAll(tmp, 0o700)
	// Mark as prepared so delete is tracked
	snap, _, _ := s.PrepareSnapshot("grok", "x")
	// snap is inside staging; discarding it should succeed
	if err := s.DiscardPreparedSnapshot(snap); err != nil {
		t.Fatalf("DiscardPreparedSnapshot: %v", err)
	}
	if _, err := os.Stat(snap); !os.IsNotExist(err) {
		t.Fatalf("snap not removed: %v", err)
	}
}

func TestStoreListAndActiveHelpers(t *testing.T) {
	s := testStore(t)
	// List empty
	list, err := s.ListAccounts(context.Background(), "grok")
	if err != nil || len(list) != 0 {
		t.Fatalf("ListAccounts empty = %v %v", list, err)
	}
	list2, err := s.ListAccounts(context.Background(), "grok")
	if err != nil || len(list2) != 0 {
		t.Fatalf("ListAccounts empty with context = %v %v", list2, err)
	}
	// Create two accounts
	for _, name := range []string{"a", "b"} {
		snap, _, _ := s.PrepareSnapshot("grok", name)
		_ = os.WriteFile(filepath.Join(snap, "f"), []byte("x"), 0o600)
		if err := s.WriteMetaContext(context.Background(), meta("grok", name), snap); err != nil {
			t.Fatal(err)
		}
	}
	list, _ = s.ListAccounts(context.Background(), "grok")
	if len(list) != 2 {
		t.Fatalf("ListAccounts = %d want 2", len(list))
	}
	// Active helpers
	if err := s.SetActiveContext(context.Background(), "grok", "a"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetActive(context.Background(), "grok"); got != "a" {
		t.Fatalf("GetActive = %q", got)
	}
	if err := s.ClearActiveContext(context.Background(), "grok"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetActive(context.Background(), "grok"); got != "" {
		t.Fatalf("after ClearActive = %q", got)
	}
	if err := s.ClearActiveContext(context.Background(), "grok"); err != nil {
		t.Fatal(err)
	}
}
