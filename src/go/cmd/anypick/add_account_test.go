package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/testexec"
)

// The onboarding docs are the canonical CLI contract (README, getting-started):
//
//	anypick add account codex --current --name personal
//	anypick add account codex --new --name personal
//
// These black-box tests run the documented forms against a sandbox HOME so a
// contract break fails the build instead of the user's first session.
func TestAddAccountCanonicalDocsForms(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	writeCodexLive := func() {
		p := filepath.Join(os.Getenv("HOME"), ".codex", "auth.json")
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(`{"OPENAI_API_KEY":"sk-docs-test"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeCodexLive()

	runAdd := func(args ...string) int {
		defer resetGlobals()()
		code := -1
		captureBoth(t, func() { code = run(args) })
		return code
	}

	if code := runAdd("add", "account", "codex", "--current", "--name", "personal"); code != int(anyerr.Success) {
		t.Fatalf("add account --current exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	// Documented account is now listed.
	if code := runAdd("list", "accounts", "codex"); code != int(anyerr.Success) {
		t.Fatalf("list accounts exited %d", code)
	}
	if !strings.Contains(lastStdout, "codex/personal") {
		t.Fatalf("list accounts lacks codex/personal (stdout=%q)", lastStdout)
	}
}

// Gemini is a native snapshot provider, not a typed API-key provider. Keep a
// black-box test for the documented --current path so a provider-specific
// credential-file regression cannot hide behind the generic CLI tests.
func TestAddAccountGeminiCurrent(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	geminiDir := filepath.Join(os.Getenv("HOME"), ".gemini")
	if err := os.MkdirAll(geminiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "oauth_creds.json"), []byte(`{
  "access_token": "gemini-access",
  "refresh_token": "gemini-refresh",
  "token_type": "Bearer"
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	code := -1
	captureBoth(t, func() {
		code = run([]string{"add", "account", "gemini", "--current", "--name", "personal"})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("add account gemini exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	if !strings.Contains(lastStdout, "gemini/personal") {
		t.Fatalf("add account gemini did not report the saved account (stdout=%q stderr=%q)", lastStdout, lastStderr)
	}

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	acct, err := a.Store.Get(context.Background(), "gemini", "personal")
	if err != nil || acct == nil {
		t.Fatalf("saved gemini/personal missing: %+v %v", acct, err)
	}
	saved, err := os.ReadFile(filepath.Join(acct.SnapshotDir, "oauth_creds.json"))
	if err != nil || !strings.Contains(string(saved), "gemini-refresh") {
		t.Fatalf("Gemini OAuth snapshot missing refresh token: %s %v", saved, err)
	}
}

// One login is one account: the CLI must refuse to save the same live login
// under a second name. Two names sharing one snapshot is how WorkBuddy ended
// up with an `outof0` + `work` pair that switched nothing.
func TestAddAccountRefusesDuplicateIdentity(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"dup@example.com"}`))
	token := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + payload + ".sig"
	authPath := filepath.Join(os.Getenv("HOME"), ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath,
		[]byte(`{"tokens":{"access_token":"`+token+`","id_token":"`+token+`","account_id":"acct-dup-1"}}`),
		0o600); err != nil {
		t.Fatal(err)
	}

	runCLI := func(args ...string) int {
		defer resetGlobals()()
		code := -1
		captureBoth(t, func() { code = run(args) })
		return code
	}
	if code := runCLI("add", "account", "codex", "--current", "--name", "personal"); code != int(anyerr.Success) {
		t.Fatalf("first save exited %d (stderr=%q)", code, lastStderr)
	}

	if code := runCLI("add", "account", "codex", "--current", "--name", "second"); code == int(anyerr.Success) {
		t.Fatalf("duplicate identity saved under a second name (stdout=%q stderr=%q)", lastStdout, lastStderr)
	}
	if !strings.Contains(lastStderr, "already saved as codex/personal") {
		t.Fatalf("duplicate refusal does not name the owner (stderr=%q)", lastStderr)
	}

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	if acct, err := a.Store.Get(context.Background(), "codex", "second"); err != nil || acct != nil {
		t.Fatalf("refused save left an account behind: %+v %v", acct, err)
	}
}

func TestAddAccountGeminiAPIKey(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	code := -1
	captureBoth(t, func() {
		code = run([]string{"add", "account", "gemini", "--name", "api", "--credential", "api-key", "--secret", "gemini-api-key"})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("add account gemini API key exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	acct, err := a.Store.Get(context.Background(), "gemini", "api")
	if err != nil || acct == nil {
		t.Fatalf("saved gemini/api missing: %+v %v", acct, err)
	}
	if acct.Meta.CredentialKind != "native" || acct.Meta.CredentialClass != "provider_api_key" {
		t.Fatalf("credential metadata = %q/%q", acct.Meta.CredentialKind, acct.Meta.CredentialClass)
	}
	env, err := os.ReadFile(filepath.Join(acct.SnapshotDir, ".env"))
	if err != nil || string(env) != "GEMINI_API_KEY=gemini-api-key\n" {
		t.Fatalf("Gemini API-key snapshot = %q (%v)", env, err)
	}
}

func TestAddAccountGeminiSourceSelectsRequestedLogin(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_OAUTH_SOURCE", "")

	geminiDir := filepath.Join(os.Getenv("HOME"), ".gemini")
	if err := os.MkdirAll(geminiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "oauth_creds.json"), []byte(`{"access_token":"cli","refresh_token":"cli-refresh","token_type":"Bearer"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "antigravity_oauth.json"), []byte(`{"token":{"access_token":"anti","refresh_token":"anti-refresh","token_type":"Bearer","expiry":"2026-09-13T00:00:00Z"},"email":"anti@example.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	runAdd := func(name, source string) int {
		defer resetGlobals()()
		code := -1
		captureBoth(t, func() {
			code = run([]string{"add", "account", "gemini", "--current", "--name", name, "--source", source})
		})
		return code
	}
	if code := runAdd("cli", "gemini-cli"); code != int(anyerr.Success) {
		t.Fatalf("scoped gemini-cli save exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	if code := runAdd("anti", "antigravity"); code != int(anyerr.Success) {
		t.Fatalf("scoped antigravity save exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	cli, err := a.Store.Get(context.Background(), "gemini", "cli")
	if err != nil || cli == nil {
		t.Fatalf("gemini/cli missing: %+v %v", cli, err)
	}
	anti, err := a.Store.Get(context.Background(), "gemini", "anti")
	if err != nil || anti == nil {
		t.Fatalf("gemini/anti missing: %+v %v", anti, err)
	}
	cliRaw, err := os.ReadFile(filepath.Join(cli.SnapshotDir, "oauth_creds.json"))
	if err != nil || !strings.Contains(string(cliRaw), "cli-refresh") {
		t.Fatalf("CLI snapshot = %q (%v)", cliRaw, err)
	}
	if _, err := os.Stat(filepath.Join(cli.SnapshotDir, "antigravity_oauth.json")); !os.IsNotExist(err) {
		t.Fatalf("CLI scoped snapshot contains Antigravity file: %v", err)
	}
	antiRaw, err := os.ReadFile(filepath.Join(anti.SnapshotDir, "antigravity_oauth.json"))
	if err != nil || !strings.Contains(string(antiRaw), "anti-refresh") {
		t.Fatalf("Antigravity snapshot = %q (%v)", antiRaw, err)
	}
	if _, err := os.Stat(filepath.Join(anti.SnapshotDir, "oauth_creds.json")); !os.IsNotExist(err) {
		t.Fatalf("Antigravity scoped snapshot contains CLI file: %v", err)
	}
}

// --new must run a real browser sign-in and save the NEW credential, not
// re-snapshot whatever happens to be live. The fake grok launcher writes a
// different identity than anything on disk; the saved account, the live file
// and the active pointer must all carry it afterwards.
func TestAddAccountNewPerformsFreshLogin(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	launcher := testexec.Build(t)
	// Scrub PATH so a host-installed launcher cannot escape the fake.
	t.Setenv("PATH", t.TempDir())

	authPath := filepath.Join(os.Getenv("HOME"), ".grok", "auth.json")
	t.Setenv("GROK_AUTH_PATH", authPath)
	testexec.SetWrite(t, authPath, `{"s1":{"email":"fresh@example.com","access_token":"tok-fresh"}}`)
	t.Setenv("GROK_BINARY", launcher)

	runAdd := func(args ...string) int {
		defer resetGlobals()()
		code := -1
		captureBoth(t, func() { code = run(args) })
		return code
	}

	if code := runAdd("add", "account", "grok", "--new", "--name", "work"); code != int(anyerr.Success) {
		t.Fatalf("add account --new exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	if !strings.Contains(lastStdout, "grok/work") {
		t.Fatalf("login did not report the saved account (stdout=%q stderr=%q)", lastStdout, lastStderr)
	}

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	acct, gerr := a.Store.Get(context.Background(), "grok", "work")
	if gerr != nil || acct == nil {
		t.Fatalf("saved grok/work missing: %+v %v", acct, gerr)
	}
	if acct.Meta.Identity != "fresh@example.com" {
		t.Fatalf("saved identity = %q, want the fresh login identity", acct.Meta.Identity)
	}
	active, _ := a.Store.GetActive(context.Background(), "grok")
	if active != "work" {
		t.Fatalf("active pointer = %q, want work", active)
	}
	live, rerr := os.ReadFile(authPath)
	if rerr != nil || !strings.Contains(string(live), "fresh@example.com") {
		t.Fatalf("live grok login was not replaced by the fresh one: %s %v", live, rerr)
	}

	// --auth-method selects the browser method; unknown ids fail closed.
	if code := runAdd("add", "account", "grok", "--new", "--name", "w2", "--auth-method", "nope"); code == int(anyerr.Success) {
		t.Fatalf("unknown --auth-method exited 0 (stdout=%q stderr=%q)", lastStdout, lastStderr)
	}
}

func TestAddAccountMutualExclusionAndAliases(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	p := filepath.Join(os.Getenv("HOME"), ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{"OPENAI_API_KEY":"sk-docs-test"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	runAdd := func(args ...string) int {
		defer resetGlobals()()
		code := -1
		captureBoth(t, func() { code = run(args) })
		return code
	}

	if code := runAdd("add", "account", "codex", "--current", "--new", "--name", "x"); code != int(anyerr.InvalidUsage) {
		t.Fatalf("--current+--new exited %d, want InvalidUsage", code)
	}
	// --new takes no credential flags: it signs in through the browser.
	if code := runAdd("add", "account", "codex", "--new", "--name", "x", "--credential", "api-key"); code != int(anyerr.InvalidUsage) {
		t.Fatalf("--new with credential flags exited %d, want InvalidUsage", code)
	}
	// Deprecated bare form stays a working alias for --current.
	if code := runAdd("add", "codex", "--name", "legacy"); code != int(anyerr.Success) {
		t.Fatalf("deprecated add alias exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	// Docs-era --api-key value form for compatible vendors.
	t.Setenv("ANYPICK_SECRET", "")
	if code := runAdd("add", "account", "deepseek", "--name", "ds", "--api-key", "sk-deepseek-test"); code != int(anyerr.Success) {
		t.Fatalf("add account --api-key exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	// Generic credential form with an endpoint-profile option.
	if code := runAdd("add", "account", "deepseek", "--name", "ds2",
		"--credential", "api-key", "--secret", "sk-x", "--option", "profile=global"); code != int(anyerr.Success) {
		t.Fatalf("add account --credential/--option exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	// Unknown option qualifiers fail closed instead of being dropped.
	if code := runAdd("add", "account", "deepseek", "--name", "ds3",
		"--credential", "api-key", "--secret", "sk-x", "--option", "bogus=1"); code != int(anyerr.InvalidUsage) {
		t.Fatalf("unknown --option exited %d, want InvalidUsage", code)
	}
	// Bare --secret prompts, which refuses without a TTY.
	if !isTTY(os.Stdin) {
		if code := runAdd("add", "account", "deepseek", "--name", "ds4",
			"--credential", "api-key", "--secret"); code != int(anyerr.InvalidUsage) {
			t.Fatalf("bare --secret without TTY exited %d, want InvalidUsage", code)
		}
	}
}

func TestAddAccountAuthFile(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"work@openai.com"}`))
	token := header + "." + payload + ".sig"
	const access = "cli-secret-access-token"
	body := `{"tokens":{"access_token":"` + access + `","id_token":"` + token + `"}}`
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	code := -1
	captureBoth(t, func() {
		code = run([]string{"--json", "add", "account", "codex", "--auth-file", path, "--name", "work"})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("auth-file exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	if strings.Contains(lastStdout, access) {
		t.Fatalf("json leaks the access token: %s", lastStdout)
	}
	var doc struct {
		OK       bool   `json:"ok"`
		Provider string `json:"provider"`
		Name     string `json:"name"`
		Identity string `json:"identity"`
	}
	if err := json.Unmarshal([]byte(lastStdout), &doc); err != nil {
		t.Fatal(err)
	}
	if !doc.OK || doc.Provider != "codex" || doc.Name != "work" || doc.Identity != "work@openai.com" {
		t.Fatalf("json = %+v", doc)
	}

	second := filepath.Join(t.TempDir(), "pair.json")
	pair := "[" + body + "," + strings.ReplaceAll(body, access, "other-access-token") + "]"
	if err := os.WriteFile(second, []byte(pair), 0o600); err != nil {
		t.Fatal(err)
	}
	code = -1
	captureBoth(t, func() {
		code = run([]string{"--json", "add", "account", "codex", "--auth-file", second, "--name", "nope"})
	})
	if code == int(anyerr.Success) {
		t.Fatalf("named list succeeded: %s", lastStdout)
	}
	if strings.TrimSpace(lastStdout) != "" {
		t.Fatalf("error path wrote stdout: %s", lastStdout)
	}

	code = -1
	captureBoth(t, func() {
		code = run([]string{"add", "account", "codex", "--auth-file", path, "--new", "--name", "fresh"})
	})
	if code != int(anyerr.InvalidUsage) {
		t.Fatalf("--auth-file --new exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	list, err := a.Store.ListAccounts(context.Background(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Meta.Name != "work" {
		t.Fatalf("accounts = %+v", list)
	}
}
