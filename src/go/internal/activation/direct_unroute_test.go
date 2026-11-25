package activation

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/refs"
)

func TestExecuteClaudeUsesNativeJSONForTheActiveAccount(t *testing.T) {
	const login = `{"claudeAiOauth":{"email":"work@example.com","accessToken":"test-token"}}`
	for _, tc := range []struct {
		name       string
		live       string
		unreadable bool
	}{
		{name: "recoverable hex", live: hex.EncodeToString([]byte(login + "\n"))},
		{name: "unreadable live credential", live: `{"claudeAiOauth":`, unreadable: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			ctx := context.Background()
			if err := os.MkdirAll(filepath.Dir(env.ClaudeCreds), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(env.ClaudeCreds, []byte(login), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := env.Svc.Save(ctx, "claude", "work", false); err != nil {
				t.Fatal(err)
			}
			if err := env.Svc.Store.SetActiveContext(ctx, "claude", "work"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(env.ClaudeCreds, []byte(tc.live), 0o600); err != nil {
				t.Fatal(err)
			}
			plan, err := PlanActivation(ctx, Request{
				Mode: ModePersistent, Client: "claude", Source: refPtr(refs.AccountRef("claude", "work")),
			}, env.Deps, Options{})
			if err != nil {
				t.Fatal(err)
			}
			_, executeErr := Execute(ctx, plan, env.Deps, ExecuteOptions{})
			if (executeErr != nil) != tc.unreadable {
				t.Fatalf("execute error = %v, want error = %v", executeErr, tc.unreadable)
			}
			want := login + "\n"
			if tc.unreadable {
				want = tc.live
			}
			got, err := os.ReadFile(env.ClaudeCreds)
			if err != nil || string(got) != want {
				t.Fatalf("unexpected live credential after activation: read error = %v", err)
			}
		})
	}
}

// Switching back to a native account must unroute the proxy from the client
// config. Without RestoreNative on every direct-capable adapter, the client
// would keep hitting the previous proxy after a native switch.
func TestExecuteDirectSwitchUnroutesProxyEnv(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(upstream.Close)
	env.UpstreamURL = mustParseURL(t, upstream.URL)

	// Grok live login + saved proxy source for the borrowing client.
	t.Setenv("GROK_AUTH_PATH", filepath.Join(env.Home, ".grok", "auth.json"))
	if err := os.MkdirAll(filepath.Join(env.Home, ".grok"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.Home, ".grok", "auth.json"),
		[]byte(`{"main":{"email":"grok@example.com"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Svc.Save(ctx, "grok", "work", true); err != nil {
		t.Fatalf("save grok: %v", err)
	}

	// Claude live login + saved native target.
	if err := os.MkdirAll(filepath.Dir(env.ClaudeCreds), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.ClaudeCreds,
		[]byte(`{"claudeAiOauth":{"accessToken":"sk-ant-test-credential"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Svc.Save(ctx, "claude", "native", true); err != nil {
		t.Fatalf("save claude: %v", err)
	}

	settingsPath := filepath.Join(env.Home, ".claude", "settings.json")
	readBaseURL := func(t *testing.T) string {
		t.Helper()
		raw, err := os.ReadFile(settingsPath)
		if err != nil {
			t.Fatalf("read settings: %v", err)
		}
		var doc map[string]json.RawMessage
		if json.Unmarshal(raw, &doc) != nil {
			t.Fatalf("settings unreadable: %s", raw)
		}
		var envMap map[string]string
		_ = json.Unmarshal(doc["env"], &envMap)
		return envMap["ANTHROPIC_BASE_URL"]
	}

	// Bind Claude to the proxy source first.
	proxyPlan, err := PlanActivation(ctx, Request{
		Mode:   ModePersistent,
		Client: "claude",
		Source: refPtr(refs.AccountRef("grok", "work")),
	}, env.Deps, Options{})
	if err != nil {
		t.Fatalf("plan proxy: %v", err)
	}
	proxyResult, err := Execute(ctx, proxyPlan, env.Deps, ExecuteOptions{})
	if err != nil {
		t.Fatalf("execute proxy: %v", err)
	}
	if got := readBaseURL(t); got != proxyResult.ProxyEndpoint {
		t.Fatalf("proxy base URL = %q, want endpoint %q", got, proxyResult.ProxyEndpoint)
	}

	// Switch back to the native account: the proxy endpoint must go.
	directPlan, err := PlanActivation(ctx, Request{
		Mode:   ModePersistent,
		Client: "claude",
		Source: refPtr(refs.AccountRef("claude", "native")),
	}, env.Deps, Options{})
	if err != nil {
		t.Fatalf("plan direct: %v", err)
	}
	if _, err := Execute(ctx, directPlan, env.Deps, ExecuteOptions{}); err != nil {
		t.Fatalf("execute direct: %v", err)
	}
	if got := readBaseURL(t); got != "" {
		t.Fatalf("direct switch left proxy endpoint %q in settings", got)
	}
	raw, _ := os.ReadFile(settingsPath)
	if strings.Contains(string(raw), "127.0.0.1") {
		t.Fatalf("direct switch left loopback routing behind:\n%s", raw)
	}
	binding, err := env.Deps.Bindings.GetGlobalContext(ctx, "claude")
	if err != nil || binding == nil || refs.SerializeRef(binding.Spec.Source) != "account/claude/native" {
		t.Fatalf("binding = %+v, err = %v", binding, err)
	}
}
