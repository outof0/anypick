package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeOpenCodePlatformKey(t *testing.T, dir, key string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]interface{}{
		"opencode-go": map[string]string{"type": "api", "key": key},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOpenCodeLiveUsageReadsZenQuota(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_DATA_DIR", dir)
	writeOpenCodePlatformKey(t, dir, "sk-live")

	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"usage": map[string]interface{}{
				"rolling": map[string]interface{}{
					"percent":  25,
					"resetsAt": "2026-09-15T22:00:00Z",
				},
				"weekly": map[string]interface{}{"percent": 80},
			},
		})
	}))
	defer server.Close()
	original := openCodeUsageEndpoint
	openCodeUsageEndpoint = server.URL
	defer func() { openCodeUsageEndpoint = original }()

	usage, err := newOpenCode(t.TempDir()).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 2 {
		t.Fatalf("windows = %+v", usage)
	}
	if usage.Windows[0].Label != "5 hours" || usage.Windows[0].RemainingPercent != 75 {
		t.Fatalf("rolling window = %+v", usage.Windows[0])
	}
	if usage.Windows[0].ResetsAtMs == nil {
		t.Fatal("resetsAt must survive as a reset instant")
	}
	if usage.Windows[1].Label != "Weekly" || usage.Windows[1].RemainingPercent != 20 {
		t.Fatalf("weekly window = %+v", usage.Windows[1])
	}
	if authorization != "Bearer sk-live" {
		t.Fatalf("Authorization = %q", authorization)
	}
}

func TestOpenCodeLiveUsageWithoutPlatformKeyIsEmpty(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_DATA_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "auth.json"),
		[]byte(`{"openai":{"type":"oauth","access":"token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer server.Close()
	original := openCodeUsageEndpoint
	openCodeUsageEndpoint = server.URL
	defer func() { openCodeUsageEndpoint = original }()

	usage, err := newOpenCode(t.TempDir()).LiveUsage(context.Background())
	if err != nil || usage != nil {
		t.Fatalf("usage = %+v err=%v, want nothing", usage, err)
	}
	if called {
		t.Fatal("an OAuth-only login has no Zen/Go quota to read")
	}
}

func TestParseOpenCodeUsageIgnoresMalformedWindows(t *testing.T) {
	usage, err := parseOpenCodeUsage([]byte(`{"usage":{
		"rolling":{"percent":"half"},
		"weekly":{"percent":-5},
		"monthly":{"percent":120}
	}}`))
	if err != nil {
		t.Fatalf("parseOpenCodeUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 2 {
		t.Fatalf("windows = %+v", usage)
	}
	// Percent is *used*, so the complement is clamped to 0..100.
	if usage.Windows[0].Label != "Weekly" || usage.Windows[0].RemainingPercent != 100 {
		t.Fatalf("negative used = %+v", usage.Windows[0])
	}
	if usage.Windows[1].Label != "Monthly" || usage.Windows[1].RemainingPercent != 0 {
		t.Fatalf("over-100 used = %+v", usage.Windows[1])
	}
}

func TestOpenCodeSavedAccountDoesNotAcquireQuotaFromAnotherLiveDBKey(t *testing.T) {
	live, saved := t.TempDir(), t.TempDir()
	t.Setenv("OPENCODE_DATA_DIR", live)
	writeOpenCodePlatformKey(t, live, "sk-mirror")
	writeOpenCodePlatformKey(t, saved, "sk-mirror")
	seedOpenCodeCredentialDB(t, live, map[string]string{"opencode-go": "sk-current-db"})
	reader := newOpenCode(t.TempDir())
	match, known, err := reader.SnapshotMatchesLive(saved)
	if err != nil || !known || match {
		t.Fatalf("stale OpenCode mirror = %v, known = %v, err = %v", match, known, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a quota request was sent using the wrong OpenCode account")
	}))
	defer server.Close()
	original := openCodeUsageEndpoint
	openCodeUsageEndpoint = server.URL
	t.Cleanup(func() { openCodeUsageEndpoint = original })
	usage, err := reader.LiveQuotaForSnapshot(context.Background(), snapshotFilesAt(saved))
	if err != nil || usage != nil {
		t.Fatalf("quota for mismatched OpenCode platform key = %+v, err = %v", usage, err)
	}
}

func TestOpenCodeLiveQuotaUsesTheExplicitAuthPathWithoutADatabase(t *testing.T) {
	live, overridden, saved := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("OPENCODE_DATA_DIR", live)
	t.Setenv("OPENCODE_AUTH_PATH", filepath.Join(overridden, "auth.json"))
	writeOpenCodePlatformKey(t, live, "sk-default")
	writeOpenCodePlatformKey(t, overridden, "sk-selected")
	writeOpenCodePlatformKey(t, saved, "sk-selected")
	reader := newOpenCode(t.TempDir())
	match, known, err := reader.SnapshotMatchesLive(saved)
	if err != nil || !known || !match {
		t.Fatalf("explicit OpenCode auth path match = %v, known = %v, err = %v", match, known, err)
	}
}
