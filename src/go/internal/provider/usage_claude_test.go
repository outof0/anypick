package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Recorded shape of Claude Code /usage: the Fable window exists only in
// limits[], and percent is USED (the UI shows its complement).
const claudeQuotaFixture = `{"five_hour":{"utilization":46,"resets_at":"2026-10-16T17:40:00.221692+00:00"},"seven_day":{"utilization":66},"seven_day_opus":null,"limits":[{"kind":"session","group":"session","percent":46,"resets_at":"2026-10-16T17:40:00.221692+00:00"},{"kind":"weekly_all","group":"weekly","percent":66},{"kind":"weekly_scoped","group":"weekly","percent":42,"resets_at":"2026-10-16T20:00:00.221882+00:00","scope":{"model":{"display_name":"Fable"}}}]}`

func TestClaudeQuotaUsesEveryNativeWindowWithoutDuplicates(t *testing.T) {
	usage, err := parseClaudeUsage([]byte(claudeQuotaFixture))
	if err != nil || usage == nil || len(usage.Windows) != 3 {
		t.Fatalf("usage=%+v err=%v", usage, err)
	}
	for i, want := range []struct {
		label              string
		remaining, seconds int
	}{{"5h", 54, 18000}, {"Weekly", 34, 604800}, {"Fable · Weekly", 58, 604800}} {
		got := usage.Windows[i]
		if got.Label != want.label || got.RemainingPercent != want.remaining || got.LimitWindowSeconds == nil || *got.LimitWindowSeconds != want.seconds {
			t.Fatalf("window %d = %+v", i, got)
		}
	}
	if usage.Windows[0].ResetsAtMs == nil || usage.Windows[2].ResetsAtMs == nil {
		t.Fatal("reset instants were lost")
	}
}

func TestClaudeQuotaLegacyPartialAndMalformedWindows(t *testing.T) {
	u, err := parseClaudeUsage([]byte(`{"limits":[{"kind":"session","percent":0},{"kind":"weekly_scoped","percent":"invalid","scope":{"model":{"display_name":"Fable"}}}],"five_hour":{"utilization":20},"seven_day":{"utilization":100},"seven_day_fable":{"utilization":40},"seven_day_opus":{"utilization":null}}`))
	if err != nil || u == nil || len(u.Windows) != 3 {
		t.Fatalf("usage=%+v err=%v", u, err)
	}
	if u.Windows[0].RemainingPercent != 100 || u.Windows[1].RemainingPercent != 0 || u.Windows[2].RemainingPercent != 60 {
		t.Fatalf("wrong complements: %+v", u.Windows)
	}
	for _, raw := range []string{`{}`, `{"five_hour":null}`, `{"limits":[{"kind":"weekly_scoped","percent":5}]}`} {
		if u, err := parseClaudeUsage([]byte(raw)); err != nil || u != nil {
			t.Fatalf("%s -> %+v %v", raw, u, err)
		}
	}
}

func TestClaudeLiveUsageReadsCredentialWithoutWritingOrLeaking(t *testing.T) {
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	home := t.TempDir()
	path := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	before := `{"claudeAiOauth":{"accessToken":"test-secret","scopes":["user:profile"]}}`
	if err := os.WriteFile(path, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ANYPICK_CLAUDE_CREDENTIALS_PATH", path)
	status := 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" || r.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
			t.Error("missing native OAuth headers")
		}
		w.WriteHeader(status)
		if status == 200 {
			_, _ = w.Write([]byte(claudeQuotaFixture))
		} else {
			_, _ = w.Write([]byte("test-secret private vendor body"))
		}
	}))
	defer server.Close()
	t.Setenv("ANYPICK_CLAUDE_USAGE_ENDPOINT", server.URL)
	p := newClaude(home)
	if usage, err := p.LiveUsage(context.Background()); err != nil || usage == nil || len(usage.Windows) != 3 {
		t.Fatalf("usage=%+v err=%v", usage, err)
	}
	status = 429
	if _, err := p.LiveUsage(context.Background()); err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "vendor") {
		t.Fatalf("error leaked or absent: %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != before {
		t.Fatal("quota polling changed login")
	}
	t.Setenv("ANYPICK_CLAUDE_USAGE_ENDPOINT", "https://other.example/usage")
	if _, err := p.LiveUsage(context.Background()); err == nil {
		t.Fatal("non-loopback override accepted")
	}
}
