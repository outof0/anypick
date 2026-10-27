package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A saved Codex account's windows are read from its snapshot's auth.json, with
// that account's own token, not the live login's.
func TestCodexSnapshotUsageReadsTheSavedAccount(t *testing.T) {
	var sawToken string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawToken = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"rate_limit":{"primary_window":{"used_percent":40,"reset_after_seconds":3600,"limit_window_seconds":18000}}}`))
	}))
	t.Cleanup(stub.Close)
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", stub.URL)

	snap := t.TempDir()
	if err := os.WriteFile(filepath.Join(snap, "auth.json"),
		[]byte(`{"tokens":{"access_token":"saved-account-token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	usage, err := newCodex(t.TempDir()).SnapshotUsage(context.Background(), snap)
	if err != nil {
		t.Fatal(err)
	}
	if sawToken != "Bearer saved-account-token" {
		t.Fatalf("usage was read with %q, want the saved account's token", sawToken)
	}
	if len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 60 || usage.Windows[0].ResetsAtMs == nil {
		t.Fatalf("windows = %+v", usage.Windows)
	}
}

func TestCodexUsageEndpointHookIsLoopbackOnly(t *testing.T) {
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", "https://example.test/usage")
	snap := t.TempDir()
	_ = os.WriteFile(filepath.Join(snap, "auth.json"), []byte(`{"tokens":{"access_token":"x"}}`), 0o600)
	if _, err := newCodex(t.TempDir()).SnapshotUsage(context.Background(), snap); err == nil {
		t.Fatal("a non-loopback test hook was accepted; a token would have been sent there")
	}
}
