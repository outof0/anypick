package client

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/outof0/anypick/go/internal/transport"
)

func commandCodeApplyContext(t *testing.T, home, root string) *ApplyContext {
	t.Helper()
	t.Setenv("ANYPICK_HOME", root)
	return &ApplyContext{
		Endpoint:     "http://127.0.0.1:8787/v1/",
		APIKey:       "proxy-secret",
		DefaultModel: "deepseek-4.1-flash",
		ModelRoles:   map[string]string{"default": "deepseek-4.1-flash"},
		AnyPickRoot:  root,
		Home:         home,
	}
}

func readCommandCodeTestObject(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	doc := map[string]json.RawMessage{}
	if err := json.Unmarshal(mustRead(t, path), &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return doc
}

func assertCommandCodeJSONEqual(t *testing.T, want string, got []byte, label string) {
	t.Helper()
	var wantValue, gotValue interface{}
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("parse expected %s: %v", label, err)
	}
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("parse actual %s: %v", label, err)
	}
	if !jsonEqualValue(wantValue, gotValue) {
		t.Fatalf("%s changed:\nwant %s\n got %s", label, want, got)
	}
}

func jsonEqualValue(left, right interface{}) bool {
	leftRaw, leftErr := json.Marshal(left)
	rightRaw, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftRaw) == string(rightRaw)
}

func TestCommandCodeClientCapabilities(t *testing.T) {
	a := newCommandCode(t.TempDir())
	if a.ID() != "commandcode" || a.Name() != "Command Code" {
		t.Fatalf("id/name = %q/%q", a.ID(), a.Name())
	}
	if a.Executable() != "cmd" {
		t.Fatalf("executable = %q, want cmd", a.Executable())
	}
	caps := a.Capabilities()
	if caps.ID != "commandcode" || caps.ProtocolPreference != transport.OpenAI ||
		!caps.SupportsPersistentConfig || !caps.SupportsIsolatedHome || !caps.RequiresDefaultModel {
		t.Fatalf("capabilities = %#v", caps)
	}
	if got := CommandCodeConfigPaths("/tmp/home"); len(got) != 3 ||
		got[0] != filepath.Join("/tmp/home", ".commandcode", "providers.json") ||
		got[1] != filepath.Join("/tmp/home", ".commandcode", "auth.json") ||
		got[2] != filepath.Join("/tmp/home", ".commandcode", "config.json") {
		t.Fatalf("config paths = %v", got)
	}
}

func TestCommandCodeApplyPreservesAndResetRestoresUserState(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "anypick")
	dir := filepath.Join(home, ".commandcode")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	providersPath, authPath, configPath := commandCodePaths(home)[0], commandCodePaths(home)[1], commandCodePaths(home)[2]
	providersBefore := `{
  "provider": {
    "mine": {"baseURL":"https://example.test/v1","models":{"mine-model":{}}},
    "anypick-managed": {"baseURL":"https://old.test/v1","models":{"old":{}}}
  },
  "keep": true
}`
	authBefore := `{
  "userId": "subscription-user",
  "anypick-managed": {"type":"api","key":"old-secret"}
}`
	configBefore := `{"theme":"dark","model":"mine/mine-model","modelProvider":"mine"}`
	for path, contents := range map[string]string{
		providersPath: providersBefore,
		authPath:      authBefore,
		configPath:    configBefore,
	} {
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	a := newCommandCode(home)
	if _, err := a.Apply(commandCodeApplyContext(t, home, root)); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	providers := readCommandCodeTestObject(t, providersPath)
	var providerMap map[string]json.RawMessage
	if err := json.Unmarshal(providers["provider"], &providerMap); err != nil {
		t.Fatal(err)
	}
	var managed map[string]json.RawMessage
	if err := json.Unmarshal(providerMap[commandCodeManagedProviderID], &managed); err != nil {
		t.Fatal(err)
	}
	if got := stringField(managed, "baseURL"); got != "http://127.0.0.1:8787/v1" {
		t.Fatalf("managed baseURL = %q", got)
	}
	if got := stringField(managed, "api"); got != "openai-completions" {
		t.Fatalf("managed api = %q", got)
	}
	if string(managed["apiKey"]) != "false" {
		t.Fatalf("providers.json contains an unexpected apiKey value: %s", managed["apiKey"])
	}
	var models map[string]json.RawMessage
	if err := json.Unmarshal(managed["models"], &models); err != nil {
		t.Fatal(err)
	}
	if _, ok := models["deepseek-4.1-flash"]; !ok {
		t.Fatalf("managed models = %v", models)
	}
	if string(providers["keep"]) != "true" || providerMap["mine"] == nil {
		t.Fatalf("user provider data was not preserved: %s", mustRead(t, providersPath))
	}

	auth := readCommandCodeTestObject(t, authPath)
	var credential map[string]json.RawMessage
	if err := json.Unmarshal(auth[commandCodeManagedProviderID], &credential); err != nil {
		t.Fatal(err)
	}
	if stringField(credential, "type") != "api" || stringField(credential, "key") != "proxy-secret" {
		t.Fatalf("managed credential = %v", credential)
	}
	if stringField(auth, "userId") != "subscription-user" {
		t.Fatalf("native auth was not preserved: %s", mustRead(t, authPath))
	}

	config := readCommandCodeTestObject(t, configPath)
	if stringField(config, "model") != "anypick-managed/deepseek-4.1-flash" {
		t.Fatalf("config model = %q", stringField(config, "model"))
	}
	if _, err := os.Stat(filepath.Join(root, "clients", "commandcode", commandCodeRestoreFile)); err != nil {
		t.Fatalf("restore checkpoint missing: %v", err)
	}

	if err := a.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	assertCommandCodeJSONEqual(t, providersBefore, mustRead(t, providersPath), "providers.json after reset")
	assertCommandCodeJSONEqual(t, authBefore, mustRead(t, authPath), "auth.json after reset")
	assertCommandCodeJSONEqual(t, configBefore, mustRead(t, configPath), "config.json after reset")
}

func TestCommandCodeApplyRejectsMalformedConfigBeforeWriting(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".commandcode")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	providersPath := commandCodeProvidersPath(home)
	if err := os.WriteFile(providersPath, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newCommandCode(home).Apply(commandCodeApplyContext(t, home, filepath.Join(home, "anypick"))); err == nil {
		t.Fatal("Apply accepted malformed providers.json")
	}
	if _, err := os.Stat(commandCodeAuthPath(home)); !os.IsNotExist(err) {
		t.Fatalf("Apply wrote auth.json after parse failure: %v", err)
	}
}

func TestCommandCodeEphemeralRuntimeUsesIsolatedHome(t *testing.T) {
	live := t.TempDir()
	root := filepath.Join(live, "anypick")
	if err := os.MkdirAll(filepath.Join(live, ".commandcode"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(commandCodeConfigPath(live), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	runtime, err := newCommandCode(live).CreateEphemeralRuntime(context.Background(), &EphemeralContext{
		Endpoint:     "http://127.0.0.1:8787",
		APIKey:       "proxy-secret",
		DefaultModel: "gpt-test",
		AnyPickRoot:  root,
		Home:         live,
	})
	if err != nil {
		t.Fatalf("CreateEphemeralRuntime: %v", err)
	}
	t.Cleanup(func() { _ = runtime.Cleanup() })
	if runtime.Environment["HOME"] != runtime.Home {
		t.Fatalf("isolated HOME = %q, home = %q", runtime.Environment["HOME"], runtime.Home)
	}
	for _, path := range commandCodePaths(runtime.Home) {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("isolated config missing %s: %v", path, err)
		}
	}
	if _, err := os.Stat(commandCodeProvidersPath(live)); !os.IsNotExist(err) {
		t.Fatalf("ephemeral apply touched live providers.json: %v", err)
	}
	config := readCommandCodeTestObject(t, commandCodeConfigPath(runtime.Home))
	if stringField(config, "theme") != "dark" || stringField(config, "model") != "anypick-managed/gpt-test" {
		t.Fatalf("isolated config = %v", config)
	}
}
