package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestParseComboStep(t *testing.T) {
	for arg, want := range map[string][3]string{
		"claude/work=claude-opus-4":                   {"claude", "work", "claude-opus-4"},
		"codex/pool:codex=gpt-5":                      {"codex", "pool:codex", "gpt-5"},
		"openrouter/team=anthropic/claude-sonnet-4.5": {"openrouter", "team", "anthropic/claude-sonnet-4.5"},
	} {
		step, err := parseComboStep(arg)
		if err != nil || step.Provider != want[0] || step.Account != want[1] || step.Model != want[2] {
			t.Errorf("%q = %+v, %v; want %v", arg, step, err, want)
		}
	}
	for _, bad := range []string{"claude/work", "claude=opus", "/work=x", "claude/=x", "claude/work= "} {
		if _, err := parseComboStep(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

// The whole lifecycle through the CLI: a step must name a source in the hub,
// the combo persists, and remove takes it away.
func TestHubComboLifecycle(t *testing.T) {
	isolateEnv(t)
	t.Setenv("ANYPICK_SECRET", "sk-combo-test")
	runOK := func(args ...string) string {
		t.Helper()
		var code int
		restore := resetGlobals()
		out, errOut := captureBoth(t, func() { code = run(args) })
		restore()
		if code != 0 {
			t.Fatalf("%v exited %d: %s %s", args, code, out, errOut)
		}
		return out
	}
	runOK("add", "account", "deepseek", "--name", "work", "--kind", "api-key")
	runOK("proxy", "hub", "enable", "default")
	runOK("proxy", "hub", "source", "default", "deepseek", "work")

	var code int
	restore := resetGlobals()
	_, errOut := captureBoth(t, func() {
		code = run([]string{"proxy", "hub", "combo", "add", "default", "smart", "deepseek/other=deepseek-chat"})
	})
	restore()
	if code == 0 || !strings.Contains(errOut, "not a source in hub") {
		t.Fatalf("a step naming no hub source = %d %q, want a refusal", code, errOut)
	}

	runOK("proxy", "hub", "combo", "add", "default", "smart", "deepseek/work=deepseek-chat", "deepseek/work=deepseek-reasoner")
	listed := runOK("--json", "proxy", "hub", "combo", "list", "default")
	var got struct {
		Combos []struct {
			Name  string `json:"name"`
			Steps []struct {
				Model string `json:"model"`
			} `json:"steps"`
		} `json:"combos"`
	}
	if err := json.Unmarshal([]byte(listed), &got); err != nil {
		t.Fatalf("list --json = %q: %v", listed, err)
	}
	if len(got.Combos) != 1 || got.Combos[0].Name != "smart" || len(got.Combos[0].Steps) != 2 ||
		got.Combos[0].Steps[1].Model != "deepseek-reasoner" {
		t.Fatalf("combos = %+v", got.Combos)
	}
	runOK("proxy", "hub", "combo", "remove", "default", "smart")
	if out := runOK("proxy", "hub", "combo", "list", "default"); !strings.Contains(out, "no combos") {
		t.Fatalf("after remove: %q", out)
	}
}

// A failed check after a committed rotation is reported beside the new key,
// never instead of it: the key is already the one the hub serves, and a user
// told only "failed" has no way to reach their own hub.
func TestHubRotateKeepsTheKeyWhenVerificationFails(t *testing.T) {
	isolateEnv(t)
	// Answers /health as the hub but accepts every key, so the previous key
	// is "still accepted" and verification must fail.
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"ok":true,"hub":"default"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer fake.Close()
	port := fake.Listener.Addr().(*net.TCPAddr).Port

	restore := resetGlobals()
	_, _ = captureBoth(t, func() { run([]string{"proxy", "hub", "enable", "default", "--port", strconv.Itoa(port)}) })
	restore()

	var code int
	restore = resetGlobals()
	out, errOut := captureBoth(t, func() { code = run([]string{"proxy", "hub", "token", "default", "--rotate", "--json"}) })
	restore()
	if code == 0 {
		t.Fatalf("a failed verification exited 0: %s %s", out, errOut)
	}
	var got struct {
		APIKey   string `json:"apiKey"`
		Verified bool   `json:"verified"`
		Error    string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output is not one JSON document: %v\n%s", err, out)
	}
	if got.APIKey == "" || got.Verified || got.Error == "" {
		t.Fatalf("rotate result = %+v, want the new key, verified=false and the reason", got)
	}
}
