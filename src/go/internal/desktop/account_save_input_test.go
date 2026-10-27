package desktop

// account-save-input: the native Add Account sheet's typed-credential path
// for provider-declared credentials (API keys / plan keys). These tests pin the
// contract: snapshot advertises kinds+profiles, the handler saves through
// Accounts.SaveInput, and malformed payloads are rejected at the boundary.

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func findAccountProvider(t *testing.T, snap *Snapshot, id string) AccountProviderRow {
	t.Helper()
	for _, row := range snap.AccountProviders {
		if row.ID == id {
			return row
		}
	}
	t.Fatalf("no accountProviders row for %q", id)
	return AccountProviderRow{}
}

func TestAccountSaveInputSnapshotExposesCredentialKinds(t *testing.T) {
	env := newTrayEnv(t)
	srv := New(env.Deps, strings.NewReader(""), &bytes.Buffer{})
	snap, err := srv.buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	deepseek := findAccountProvider(t, snap, "deepseek")
	if len(deepseek.CredentialKinds) != 1 {
		t.Fatalf("deepseek kinds = %+v, want one api-key kind", deepseek.CredentialKinds)
	}
	kind := deepseek.CredentialKinds[0]
	if kind.Kind != "api-key" || len(kind.Profiles) == 0 || kind.Profiles[0].ID == "" {
		t.Fatalf("deepseek kind = %+v, want api-key with profiles", kind)
	}

	mimo := findAccountProvider(t, snap, "mimo")
	if len(mimo.CredentialKinds) != 2 {
		t.Fatalf("mimo kinds = %+v, want api-key + subscription-key", mimo.CredentialKinds)
	}

	gemini := findAccountProvider(t, snap, "gemini")
	if len(gemini.CredentialKinds) != 1 || gemini.CredentialKinds[0].Kind != "api-key" {
		t.Fatalf("gemini kinds = %+v, want native api-key input", gemini.CredentialKinds)
	}

	// Native-only providers publish no credential input: their accounts come
	// from a live login or a browser sign-in.
	claude := findAccountProvider(t, snap, "claude")
	if len(claude.CredentialKinds) != 0 {
		t.Fatalf("claude kinds = %+v, want none", claude.CredentialKinds)
	}
}

func TestAccountSaveInputHandler(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := New(env.Deps, strings.NewReader(""), &out)

	save := func(requestID string, payload map[string]interface{}) Result {
		t.Helper()
		payload["version"] = 1
		payload["requestId"] = requestID
		payload["operation"] = "account-save-input"
		return runCorrectnessMutation(t, srv, &out, payload)
	}

	res := save("save-input-1", map[string]interface{}{
		"providerId": "deepseek", "name": "work",
		"kind": "api-key", "profile": "global", "apiKey": "sk-test",
	})
	if res.Status != "success" {
		t.Fatalf("save-input = %+v", res)
	}
	acct, err := env.Deps.Store.Get(context.Background(), "deepseek", "work")
	if err != nil || acct == nil {
		t.Fatalf("saved account = %+v, %v", acct, err)
	}

	// An omitted profile selects the kind's first endpoint profile. A distinct
	// key keeps the snapshot distinct from `work`.
	res = save("save-input-2", map[string]interface{}{
		"providerId": "deepseek", "name": "second",
		"kind": "api-key", "apiKey": "sk-second",
	})
	if res.Status != "success" {
		t.Fatalf("save-input without profile = %+v", res)
	}

	// Native providers may expose a typed key in addition to their local
	// login. Gemini's provider-owned snapshot must keep the key in .env.
	res = save("save-input-gemini", map[string]interface{}{
		"providerId": "gemini", "name": "api", "kind": "api-key", "apiKey": "gemini-key",
	})
	if res.Status != "success" {
		t.Fatalf("Gemini save-input = %+v", res)
	}
	geminiAccount, err := env.Deps.Store.Get(context.Background(), "gemini", "api")
	if err != nil || geminiAccount == nil {
		t.Fatalf("Gemini account = %+v, %v", geminiAccount, err)
	}
	envFile, err := os.ReadFile(filepath.Join(geminiAccount.SnapshotDir, ".env"))
	if err != nil || string(envFile) != "GEMINI_API_KEY=gemini-key\n" {
		t.Fatalf("Gemini snapshot .env = %q, %v", envFile, err)
	}

	// Duplicates fail without overwrite, exactly like account-save.
	res = save("save-input-3", map[string]interface{}{
		"providerId": "deepseek", "name": "work",
		"kind": "api-key", "profile": "global", "apiKey": "sk-other",
	})
	if res.Status != "error" {
		t.Fatalf("duplicate save-input = %+v, want error", res)
	}

	// Unknown kinds fail with the provider's coded error, not a silent save.
	res = save("save-input-4", map[string]interface{}{
		"providerId": "deepseek", "name": "nope",
		"kind": "oauth", "profile": "global", "apiKey": "sk-test",
	})
	if res.Status != "error" || !strings.Contains(res.Message, "does not accept credential kind") {
		t.Fatalf("unknown kind = %+v, want UNSUPPORTED_CREDENTIAL_INPUT", res)
	}

	// A product that needs a key refuses a save without one in words the
	// user can act on, now that the frame no longer rejects it blind.
	res = save("save-input-6", map[string]interface{}{
		"providerId": "deepseek", "name": "nokey",
		"kind": "api-key", "profile": "global",
	})
	if res.Status != "error" || !strings.Contains(res.Message, "non-empty") {
		t.Fatalf("keyless save of a keyed product = %+v, want the provider's refusal", res)
	}

	// A key-optional product saves with no key.
	res = save("save-input-7", map[string]interface{}{
		"providerId": "ollama", "name": "local",
		"kind": "server", "profile": "default",
	})
	if res.Status != "success" {
		t.Fatalf("keyless Ollama save = %+v, want success", res)
	}

	// Native-only providers reject credential input.
	res = save("save-input-5", map[string]interface{}{
		"providerId": "claude", "name": "work",
		"kind": "api-key", "profile": "global", "apiKey": "sk-test",
	})
	if res.Status != "error" {
		t.Fatalf("native save-input = %+v, want error", res)
	}
}

func TestAccountSaveInputContract(t *testing.T) {
	valid := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-save-input",
		"providerId": "deepseek", "name": "work",
		"kind": "api-key", "profile": "global", "apiKey": "sk-test",
	}
	if _, err := DecodeLine("mutate\t" + b64(t, valid)); err != nil {
		t.Fatalf("valid save-input rejected: %v", err)
	}
	// A key-optional product (a local model server) is saved with no key, and
	// only the provider knows which products those are, so the frame accepts
	// it and the provider refuses a missing key with its own message.
	for _, keyless := range []func(m map[string]interface{}){
		func(m map[string]interface{}) { delete(m, "apiKey") },
		func(m map[string]interface{}) { m["apiKey"] = "" },
	} {
		m := map[string]interface{}{}
		for k, v := range valid {
			m[k] = v
		}
		keyless(m)
		if _, err := DecodeLine("mutate\t" + b64(t, m)); err != nil {
			t.Fatalf("keyless save-input rejected at the frame: %v", err)
		}
	}
	for _, tc := range []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"missing kind", func(m map[string]interface{}) { delete(m, "kind") }},
		{"empty kind", func(m map[string]interface{}) { m["kind"] = "" }},
		{"oversized apiKey", func(m map[string]interface{}) { m["apiKey"] = strings.Repeat("k", 8193) }},
		{"missing name", func(m map[string]interface{}) { delete(m, "name") }},
		{"missing providerId", func(m map[string]interface{}) { delete(m, "providerId") }},
		{"unknown field", func(m map[string]interface{}) { m["region"] = "us" }},
		{"label not allowed", func(m map[string]interface{}) { m["label"] = "Work" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			for k, v := range valid {
				m[k] = v
			}
			tc.mutate(m)
			if _, err := DecodeLine("mutate\t" + b64(t, m)); err == nil {
				t.Fatalf("%s: payload accepted", tc.name)
			}
		})
	}
}

func TestAccountSaveInputSnapshotExposesCloudflareGateway(t *testing.T) {
	env := newTrayEnv(t)
	srv := New(env.Deps, strings.NewReader(""), &bytes.Buffer{})
	snap, err := srv.buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	cf := findAccountProvider(t, snap, "cloudflare-aigateway")
	if cf.Label != "Cloudflare AI Gateway" {
		t.Fatalf("cloudflare label = %q", cf.Label)
	}
	if len(cf.CredentialKinds) != 1 || cf.CredentialKinds[0].Kind != "api-token" {
		t.Fatalf("cloudflare kinds = %+v, want one api-token kind", cf.CredentialKinds)
	}
}

func TestAccountSaveInputHandlerCloudflareGateway(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := New(env.Deps, strings.NewReader(""), &out)

	payload := map[string]interface{}{
		"version": 1, "requestId": "save-input-cf", "operation": "account-save-input",
		"providerId": "cloudflare-aigateway", "name": "work",
		"kind":    "api-token",
		"profile": "f4b3c2a1e5d647a8b9c0d1e2f3a4b5c6/default",
		"apiKey":  "cf-test-token",
	}
	res := runCorrectnessMutation(t, srv, &out, payload)
	if res.Status != "success" {
		t.Fatalf("cloudflare save-input = %+v", res)
	}
	acct, err := env.Deps.Store.Get(context.Background(), "cloudflare-aigateway", "work")
	if err != nil || acct == nil {
		t.Fatalf("cloudflare account = %+v, %v", acct, err)
	}

	// The routing pair is required: without it the provider's coded error
	// reaches the sheet instead of a silent save.
	bad := map[string]interface{}{
		"version": 1, "requestId": "save-input-cf-bad", "operation": "account-save-input",
		"providerId": "cloudflare-aigateway", "name": "bad",
		"kind": "api-token", "profile": "global", "apiKey": "cf-test-token",
	}
	res = runCorrectnessMutation(t, srv, &out, bad)
	if res.Status != "error" || !strings.Contains(res.Message, "<account_id>/<gateway_id>") {
		t.Fatalf("cloudflare bad profile = %+v, want routing hint", res)
	}
}

func TestAccountSaveCurrentGeminiUsesRequestedSource(t *testing.T) {
	env := newTrayEnv(t)
	t.Setenv("GEMINI_CONFIG_DIR", filepath.Join(env.Home, ".gemini"))
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_OAUTH_SOURCE", "")
	geminiDir := filepath.Join(env.Home, ".gemini")
	if err := os.MkdirAll(geminiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "oauth_creds.json"),
		[]byte(`{"access_token":"cli","refresh_token":"cli-refresh","token_type":"Bearer"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "antigravity_oauth.json"),
		[]byte(`{"token":{"access_token":"anti","refresh_token":"anti-refresh","token_type":"Bearer","expiry":"2026-09-13T00:00:00Z"},"email":"anti@example.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	srv := New(env.Deps, strings.NewReader(""), &out)
	result := runCorrectnessMutation(t, srv, &out, map[string]interface{}{
		"version": 1, "requestId": "gemini-scoped", "operation": "account-save-current",
		"providerId": "gemini", "sourceId": "antigravity", "name": "anti",
	})
	if result.Status != "success" {
		t.Fatalf("scoped Gemini save = %+v", result)
	}
	account, err := env.Deps.Store.Get(context.Background(), "gemini", "anti")
	if err != nil || account == nil {
		t.Fatalf("scoped Gemini account = %+v, %v", account, err)
	}
	marker, err := os.ReadFile(filepath.Join(account.SnapshotDir, ".env"))
	if err != nil || string(marker) != "GEMINI_OAUTH_SOURCE=antigravity\n" {
		t.Fatalf("scoped Gemini marker = %q, %v", marker, err)
	}
	anti, err := os.ReadFile(filepath.Join(account.SnapshotDir, "antigravity_oauth.json"))
	if err != nil || !strings.Contains(string(anti), "anti-refresh") {
		t.Fatalf("scoped Gemini credential = %q, %v", anti, err)
	}
	if _, err := os.Stat(filepath.Join(account.SnapshotDir, "oauth_creds.json")); !os.IsNotExist(err) {
		t.Fatalf("scoped Gemini snapshot contains CLI credential: %v", err)
	}
}

func TestAccountSaveGeminiUsesRequestedSource(t *testing.T) {
	env := newTrayEnv(t)
	t.Setenv("GEMINI_CONFIG_DIR", filepath.Join(env.Home, ".gemini"))
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_OAUTH_SOURCE", "")
	geminiDir := filepath.Join(env.Home, ".gemini")
	if err := os.MkdirAll(geminiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "oauth_creds.json"),
		[]byte(`{"access_token":"cli","refresh_token":"cli-refresh","token_type":"Bearer"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "antigravity_oauth.json"),
		[]byte(`{"token":{"access_token":"anti","refresh_token":"anti-refresh","token_type":"Bearer","expiry":"2026-09-13T00:00:00Z"},"email":"anti@example.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	srv := New(env.Deps, strings.NewReader(""), &out)
	result := runCorrectnessMutation(t, srv, &out, map[string]interface{}{
		"version": 1, "requestId": "gemini-scoped-save", "operation": "account-save",
		"providerId": "gemini", "sourceId": "antigravity", "name": "anti",
	})
	if result.Status != "success" {
		t.Fatalf("scoped account-save = %+v", result)
	}
	account, err := env.Deps.Store.Get(context.Background(), "gemini", "anti")
	if err != nil || account == nil {
		t.Fatalf("scoped account-save account = %+v, %v", account, err)
	}
	anti, err := os.ReadFile(filepath.Join(account.SnapshotDir, "antigravity_oauth.json"))
	if err != nil || !strings.Contains(string(anti), "anti-refresh") {
		t.Fatalf("scoped account-save credential = %q, %v", anti, err)
	}
	if _, err := os.Stat(filepath.Join(account.SnapshotDir, "oauth_creds.json")); !os.IsNotExist(err) {
		t.Fatalf("scoped account-save snapshot contains CLI credential: %v", err)
	}
}
