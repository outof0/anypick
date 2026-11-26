package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeGrokLiveSession(t *testing.T, home, accessToken, expiresAt, userID string) {
	t.Helper()
	dir := filepath.Join(home, ".grok")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := map[string]interface{}{
		"key":            accessToken,
		"refresh_token":  "1//refresh",
		"oidc_issuer":    "https://auth.x.ai",
		"oidc_client_id": "client",
	}
	if expiresAt != "" {
		entry["expires_at"] = expiresAt
	}
	if userID != "" {
		entry["user_id"] = userID
	}
	raw, err := json.Marshal(map[string]interface{}{"https://auth.x.ai::client": entry})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestGrokLiveUsageReadsBillingCredits(t *testing.T) {
	t.Setenv("GROK_CLIENT_VERSION", "")
	home := t.TempDir()
	writeGrokLiveSession(t, home, "grok-access", time.Now().Add(time.Hour).Format(time.RFC3339), "user-7")

	var authorization, userID, clientVersion string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		userID = r.Header.Get("x-userid")
		clientVersion = r.Header.Get("x-grok-client-version")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"config": map[string]interface{}{
				"creditUsagePercent": 18.5,
				"currentPeriod": map[string]interface{}{
					"type": "WEEKLY",
					"end":  "2026-09-20T00:00:00Z",
				},
			},
		})
	}))
	defer server.Close()
	original := grokUsageEndpoint
	grokUsageEndpoint = server.URL
	defer func() { grokUsageEndpoint = original }()

	usage, err := newGrok(home).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 1 {
		t.Fatalf("windows = %+v", usage)
	}
	if usage.Windows[0].Label != "Weekly" || usage.Windows[0].RemainingPercent != 82 {
		t.Fatalf("window = %+v, want Weekly at 82%% remaining", usage.Windows[0])
	}
	if usage.Windows[0].ResetsAtMs == nil {
		t.Fatal("period end must survive as a reset instant")
	}
	if authorization != "Bearer grok-access" {
		t.Fatalf("Authorization = %q", authorization)
	}
	if userID != "user-7" {
		t.Fatalf("x-userid = %q", userID)
	}
	if clientVersion != grokClientVersion {
		t.Fatalf("x-grok-client-version = %q", clientVersion)
	}
}

func TestGrokLiveUsageFallsBackToUsedOverLimit(t *testing.T) {
	usage, err := parseGrokUsage([]byte(`{"config":{
		"monthlyLimit":{"val":1000},"used":{"val":250},
		"currentPeriod":{"type":"MONTHLY"}
	}}`))
	if err != nil {
		t.Fatalf("parseGrokUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 1 {
		t.Fatalf("windows = %+v", usage)
	}
	if usage.Windows[0].Label != "Monthly" || usage.Windows[0].RemainingPercent != 75 {
		t.Fatalf("window = %+v", usage.Windows[0])
	}
}

func TestGrokLiveUsageIgnoresPayloadWithoutUsage(t *testing.T) {
	usage, err := parseGrokUsage([]byte(`{"config":{"currentPeriod":{"type":"WEEKLY"}}}`))
	if err != nil || usage != nil {
		t.Fatalf("usage = %+v err=%v", usage, err)
	}
}

func TestGrokLiveUsageSkipsExpiredSession(t *testing.T) {
	home := t.TempDir()
	writeGrokLiveSession(t, home, "grok-access", time.Now().Add(-time.Hour).Format(time.RFC3339), "")

	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer server.Close()
	original := grokUsageEndpoint
	grokUsageEndpoint = server.URL
	defer func() { grokUsageEndpoint = original }()

	usage, err := newGrok(home).LiveUsage(context.Background())
	if err != nil || usage != nil {
		t.Fatalf("usage = %+v err=%v, want nothing", usage, err)
	}
	if called {
		t.Fatal("an expired session must not be refreshed just to read quota")
	}
}

func TestGrokIdentityFollowsTheSelectedUsageSession(t *testing.T) {
	raw := []byte(`{
		"aaa-legacy":{"email":"legacy@example.test"},
		"https://auth.x.ai::z":{"email":"other@example.test","key":"other"},
		"https://auth.x.ai::a":{"email":"selected@example.test","key":"selected"}
	}`)
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	session, err := loadGrokSession(file)
	if err != nil || session.accessToken != "selected" || grokIdentity(entries) != "selected@example.test" {
		t.Fatalf("Grok resolved inconsistent sessions: %v", err)
	}
}
