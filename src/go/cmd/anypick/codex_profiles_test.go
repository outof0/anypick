package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/testexec"
)

func TestCodexProfileLoginIsolatesNativeAuth(t *testing.T) {
	base := isolateEnv(t)
	t.Setenv("CODEX_HOME", filepath.Join(base, "home", ".codex"))
	t.Setenv("CODEX_AUTH_PATH", filepath.Join(base, "home", ".codex", "auth.json"))
	defer resetGlobals()()

	mainAuth := filepath.Join(base, "home", ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(mainAuth), 0o700); err != nil {
		t.Fatal(err)
	}
	const accountA = `{"OPENAI_API_KEY":"sk-account-a"}`
	if err := os.WriteFile(mainAuth, []byte(accountA), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := testexec.Build(t)
	testexec.SetWriteInEnvDir(t, "CODEX_HOME", "auth.json", `{"OPENAI_API_KEY":"sk-account-b"}`)
	t.Setenv("CODEX_BINARY", launcher)

	var code int
	out, errOut := captureBoth(t, func() {
		code = run([]string{"codex", "profile", "login", "b"})
	})
	if code != 0 {
		t.Fatalf("profile login exited %d (stdout=%q stderr=%q)", code, out, errOut)
	}
	if strings.Contains(out, "sk-account-") {
		t.Fatalf("profile login leaked credential material: %q", out)
	}

	mainAfter, err := os.ReadFile(mainAuth)
	if err != nil || string(mainAfter) != accountA {
		t.Fatalf("desktop auth changed: %q %v", mainAfter, err)
	}
	profileAuth, err := os.ReadFile(filepath.Join(base, "data", "clients", "codex", "profiles", "b", "codex-home", "auth.json"))
	if err != nil || !strings.Contains(string(profileAuth), "sk-account-b") {
		t.Fatalf("profile auth missing B: %q %v", profileAuth, err)
	}

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	profile, err := a.CodexProfileSvc.GetContext(context.Background(), "codex", "b")
	if err != nil || profile == nil {
		t.Fatalf("profile row missing: %#v %v", profile, err)
	}
	active, err := a.Accounts.Active(context.Background(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	if active != "" {
		t.Fatalf("profile login changed desktop active pointer to %q", active)
	}
}

func TestCodexProfileLoginRefusesExistingAccountName(t *testing.T) {
	base := isolateEnv(t)
	t.Setenv("CODEX_HOME", filepath.Join(base, "home", ".codex"))
	mainAuth := filepath.Join(base, "home", ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(mainAuth), 0o700); err != nil {
		t.Fatal(err)
	}
	const accountA = `{"OPENAI_API_KEY":"sk-account-a"}`
	if err := os.WriteFile(mainAuth, []byte(accountA), 0o600); err != nil {
		t.Fatal(err)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Accounts.Save(context.Background(), "codex", "b", true); err != nil {
		closeFn()
		t.Fatal(err)
	}
	saved, err := a.Accounts.Get(context.Background(), "codex", "b")
	closeFn()
	if err != nil || saved == nil {
		t.Fatalf("seed account: %#v %v", saved, err)
	}
	before, err := os.ReadFile(filepath.Join(saved.SnapshotDir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}

	launcher := testexec.Build(t)
	testexec.SetWriteInEnvDir(t, "CODEX_HOME", "auth.json", `{"OPENAI_API_KEY":"sk-account-b"}`)
	t.Setenv("CODEX_BINARY", launcher)
	defer resetGlobals()()

	var code int
	_, errOut := captureBoth(t, func() {
		code = run([]string{"codex", "profile", "login", "b"})
	})
	if code == 0 {
		t.Fatalf("profile login over an existing account succeeded: %s", errOut)
	}
	after, err := os.ReadFile(filepath.Join(saved.SnapshotDir, "auth.json"))
	if err != nil || string(after) != string(before) {
		t.Fatalf("existing account snapshot changed: %q -> %q (%v)", before, after, err)
	}
}

func TestCodexProfileCommandsListShowAndRemove(t *testing.T) {
	isolateEnv(t)
	t.Setenv("CODEX_HOME", "")
	defer resetGlobals()()

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.CodexProfileSvc.UpsertContext(context.Background(), "codex", "personal", bindings.Spec{
		Client: "codex", Source: refs.GatewayRef("openrouter-work"),
		Model: bindings.ExplicitModel("openai/gpt-5.6"), TransportPolicy: "direct",
	})
	closeFn()
	if err != nil {
		t.Fatal(err)
	}

	var code int
	out, errOut := captureBoth(t, func() { code = run([]string{"codex", "profile", "list"}) })
	if code != 0 {
		t.Fatalf("list exited %d (stdout=%q stderr=%q)", code, out, errOut)
	}
	if !strings.Contains(out, "personal") || !strings.Contains(out, "openrouter-work") {
		t.Fatalf("list output = %q", out)
	}

	out, errOut = captureBoth(t, func() { code = run([]string{"codex", "profile", "show", "personal"}) })
	if code != 0 {
		t.Fatalf("show exited %d (stdout=%q stderr=%q)", code, out, errOut)
	}
	if !strings.Contains(out, "openai/gpt-5.6") || !strings.Contains(out, "config:") {
		t.Fatalf("show output = %q", out)
	}

	if code := run([]string{"codex", "profile", "remove", "personal", "--yes"}); code != 0 {
		t.Fatalf("remove exited %d", code)
	}
	a, closeFn, err = appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	removed, err := a.CodexProfileSvc.GetContext(context.Background(), "codex", "personal")
	closeFn()
	if err != nil {
		t.Fatal(err)
	}
	if removed != nil {
		t.Fatalf("profile survived remove: %#v", removed)
	}
}
