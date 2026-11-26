package provider

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
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

func TestGrokSavedQuotaUsesTheSavedSession(t *testing.T) {
	home, savedHome := t.TempDir(), t.TempDir()
	t.Setenv("GROK_AUTH_PATH", filepath.Join(home, ".grok", "auth.json"))
	writeGrokLiveSession(t, home, "grok-live", "", "live-user")
	writeGrokLiveSession(t, savedHome, "grok-saved", "", "saved-user")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer grok-saved" || r.Header.Get("x-userid") != "saved-user" {
			t.Error("Grok quota request did not use the saved account")
		}
		_, _ = w.Write([]byte(`{"config":{"creditUsagePercent":20}}`))
	}))
	defer server.Close()
	original := grokUsageEndpoint
	grokUsageEndpoint = server.URL
	t.Cleanup(func() { grokUsageEndpoint = original })

	dir := filepath.Join(savedHome, ".grok")
	reader := newGrok(home)
	usage, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(dir))
	if err != nil || usage == nil || len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 80 {
		t.Fatalf("Grok quota = %+v, err = %v", usage, err)
	}

	writeGrokLiveSession(t, savedHome, "expired", time.Unix(1, 0).UTC().Format(time.RFC3339), "saved-user")
	if _, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(dir)); !errors.Is(err, ErrQuotaLoginRequired) {
		t.Fatalf("expired saved session: %v", err)
	}
}

func TestOpenCodeSavedQuotaUsesTheSavedPlatformKey(t *testing.T) {
	live, saved := t.TempDir(), t.TempDir()
	t.Setenv("OPENCODE_DATA_DIR", live)
	writeOpenCodePlatformKey(t, live, "sk-live")
	writeOpenCodePlatformKey(t, saved, "sk-saved")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-saved" {
			t.Error("OpenCode quota request did not use the saved key")
		}
		_, _ = w.Write([]byte(`{"usage":{"weekly":{"percent":20}}}`))
	}))
	defer server.Close()
	original := openCodeUsageEndpoint
	openCodeUsageEndpoint = server.URL
	t.Cleanup(func() { openCodeUsageEndpoint = original })

	reader := newOpenCode(t.TempDir())
	usage, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(saved))
	if err != nil || usage == nil || len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 80 {
		t.Fatalf("OpenCode quota = %+v, err = %v", usage, err)
	}
	if err := os.WriteFile(filepath.Join(saved, "auth.json"), []byte(`{"openai":{"access":"oauth-only"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(saved)); !errors.Is(err, ErrSavedQuotaUnavailable) {
		t.Fatalf("OAuth-only OpenCode quota: %v", err)
	}
}

func TestGeminiSavedQuotaUsesTheRecordedSource(t *testing.T) {
	home, savedHome := t.TempDir(), t.TempDir()
	now := time.Now()
	writeGeminiCLICredential(t, home, "live-access", "live-refresh", now.Add(time.Hour))
	writeGeminiCLICredential(t, savedHome, "saved-cli", "saved-refresh", now.Add(time.Hour))
	dir := filepath.Join(savedHome, ".gemini")
	writeAntigravityMirror(t, dir, antigravityCredentialFiles[0], "saved-ide-refresh", "ide@example.test", "")
	t.Setenv("GEMINI_OAUTH_SOURCE", geminiCliOAuthSource)
	t.Setenv("ANTIGRAVITY_OAUTH_FILE", filepath.Join(home, ".gemini", geminiCliCredentialFiles[0]))
	t.Setenv("GEMINI_TOKEN_ENDPOINT", "https://example.test")
	server := &codeAssistQuotaServer{buckets: []map[string]interface{}{
		{"modelId": "models/gemini-2.5-pro", "remainingFraction": 0.8},
	}}
	server.start(t)
	reader := newGemini(home)
	if _, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(dir)); !errors.Is(err, ErrSavedQuotaUnavailable) {
		t.Fatalf("snapshot with two sources and no selection: %v", err)
	}
	marker := filepath.Join(dir, ".env")
	if err := os.WriteFile(marker, []byte("GEMINI_OAUTH_SOURCE=antigravity\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	usage, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(dir))
	if err != nil || usage == nil || len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 80 {
		t.Fatalf("Gemini quota = %+v, err = %v", usage, err)
	}
	metadata, _ := server.loadBody["metadata"].(map[string]interface{})
	if server.authorize != "Bearer ya29.mirror" || metadata["ideType"] != "ANTIGRAVITY" {
		t.Fatal("Gemini quota request did not use the saved Antigravity source")
	}
	if err := os.WriteFile(marker, []byte("GEMINI_OAUTH_SOURCE=gemini-cli\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeGeminiCLICredential(t, savedHome, "expired", "saved-refresh", now.Add(-time.Hour))
	if _, err := reader.ReadSavedQuota(context.Background(), snapshotFilesAt(dir)); !errors.Is(err, ErrQuotaLoginRequired) {
		t.Fatalf("expired Gemini access token: %v", err)
	}
	if server.loadCalls != 1 {
		t.Fatalf("Code Assist called %d times, want one saved quota read", server.loadCalls)
	}
}

func TestCodexLiveQuotaDoesNotUseAMixedDocumentAPIKeyToMatchOAuth(t *testing.T) {
	for _, mode := range []string{"chatgpt", ""} {
		name := mode
		if name == "" {
			name = "legacy"
		}
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("CODEX_HOME", home)
			auth := filepath.Join(home, "auth.json")
			t.Setenv("CODEX_AUTH_PATH", auth)
			prefix := ""
			if mode != "" {
				prefix = `"auth_mode":"chatgpt",`
			}
			if err := os.WriteFile(auth, []byte("{"+prefix+`"OPENAI_API_KEY":"same-key","tokens":{"account_id":"live","access_token":"live-oauth"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			saved := t.TempDir()
			if err := os.WriteFile(filepath.Join(saved, "auth.json"), []byte("{"+prefix+`"OPENAI_API_KEY":"same-key","tokens":{"account_id":"saved","access_token":"saved-oauth"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Error("quota sent OAuth for a different account with the same API key")
			}))
			defer server.Close()
			t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", server.URL)
			reader := newCodex(home)
			if match, known, err := reader.SnapshotMatchesLive(saved); err != nil || !known || match {
				t.Fatalf("mixed Codex Current match = %v, known = %v, err = %v", match, known, err)
			}
			usage, err := reader.LiveQuotaForSnapshot(context.Background(), snapshotFilesAt(saved))
			if err != nil || usage != nil {
				t.Fatalf("mixed Codex quota = %+v, err = %v", usage, err)
			}
		})
	}
}
