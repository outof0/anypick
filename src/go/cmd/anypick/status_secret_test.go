package main

import (
	"context"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/store"
)

// Status is the read a script and a CI log capture. The per-instance bearer
// stays on the dedicated token commands (ADR 0006 §6).
func TestStatusOmitsProxyAndHubSecrets(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()

	const proxySecret = "apk-proxy-status-secret"
	if code := run([]string{"add", "deepseek", "--name", "ds", "--kind", "api-key", "--secret", "sk-ds"}); code != 0 {
		t.Fatalf("add exited %d", code)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Store.WriteProxyStateContext(context.Background(), "deepseek", "ds", store.ProxyRuntimeState{
		AccountName: "ds",
		Endpoint:    "http://127.0.0.1:4680",
		Token:       proxySecret,
	}); err != nil {
		closeFn()
		t.Fatal(err)
	}
	closeFn()

	clearJSON()
	human := captureStdout(t, func() {
		if code := run([]string{"proxy", "status", "deepseek", "ds"}); code != 0 {
			t.Fatalf("proxy status exited %d", code)
		}
	})
	assertOmitsSecret(t, human, proxySecret, "Enabled:")

	clearJSON()
	js := captureStdout(t, func() {
		if code := run([]string{"--json", "proxy", "status", "deepseek", "ds"}); code != 0 {
			t.Fatalf("proxy status --json exited %d", code)
		}
	})
	assertOmitsSecret(t, js, proxySecret, `"enabled"`)

	clearJSON()
	tokenOut := captureStdout(t, func() {
		if code := run([]string{"proxy", "token", "deepseek", "ds"}); code != 0 {
			t.Fatalf("proxy token exited %d", code)
		}
	})
	if !strings.Contains(tokenOut, proxySecret) {
		t.Fatalf("proxy token should still print the bearer, got %q", tokenOut)
	}

	clearJSON()
	if code := run([]string{"proxy", "hub", "enable", "statushub"}); code != 0 {
		t.Fatalf("hub enable exited %d", code)
	}
	clearJSON()
	hubTokenOut := captureStdout(t, func() {
		if code := run([]string{"proxy", "hub", "token", "statushub"}); code != 0 {
			t.Fatalf("hub token exited %d", code)
		}
	})
	fields := strings.Fields(hubTokenOut)
	if len(fields) == 0 {
		t.Fatal("hub token printed nothing")
	}
	hubSecret := fields[len(fields)-1]
	if hubSecret == "" || strings.Contains(hubSecret, "api_key") {
		t.Fatalf("hub token did not print a key: %q", hubTokenOut)
	}

	clearJSON()
	hubStatus := captureStdout(t, func() {
		if code := run([]string{"proxy", "hub", "status", "statushub"}); code != 0 {
			t.Fatalf("hub status exited %d", code)
		}
	})
	assertOmitsSecret(t, hubStatus, hubSecret, "enabled=")

	clearJSON()
	hubJSON := captureStdout(t, func() {
		if code := run([]string{"--json", "proxy", "hub", "status", "statushub"}); code != 0 {
			t.Fatalf("hub status --json exited %d", code)
		}
	})
	assertOmitsSecret(t, hubJSON, hubSecret, `"enabled"`)

	// The management API token (ADR 0034) is the third sanctioned printer:
	// `serve token` prints it, and nothing else that `serve` says may.
	clearJSON()
	serveTokenOut := captureStdout(t, func() {
		if code := run([]string{"serve", "token"}); code != 0 {
			t.Fatalf("serve token exited %d", code)
		}
	})
	serveSecret := strings.TrimSpace(serveTokenOut)
	if serveSecret == "" || strings.ContainsAny(serveSecret, " \n") {
		t.Fatalf("serve token did not print the token alone: %q", serveTokenOut)
	}
	clearJSON()
	serveStop := captureStdout(t, func() { _ = run([]string{"--json", "serve", "--stop"}) })
	if strings.Contains(serveStop, serveSecret) {
		t.Fatalf("serve --stop output contains the management token: %s", serveStop)
	}
}

func clearJSON() {
	globals.JSON = false
	globalJSON = false
}

func assertOmitsSecret(t *testing.T, out, secret, keep string) {
	t.Helper()
	if strings.Contains(out, secret) {
		t.Fatalf("output contains the bearer %q: %s", secret, out)
	}
	if !strings.Contains(out, keep) {
		t.Fatalf("output dropped %q: %s", keep, out)
	}
}
