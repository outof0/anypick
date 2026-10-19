package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeApplyDryRun(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	reg := NewRegistry()
	if err := RegisterBuiltin(reg, home); err != nil {
		t.Fatal(err)
	}
	a, _ := reg.Get("claude")
	res, err := a.Apply(&ApplyContext{
		Endpoint:    "https://proxy.example/v1",
		APIKey:      "sk-proxy",
		Home:        home,
		AnyPickRoot: root,
		DryRun:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.ManagedPaths) == 0 || len(res.ManagedEnvKeys) == 0 {
		t.Fatalf("ManagedPaths/EnvKeys empty: %#v", res)
	}
	// DryRun must not touch disk.
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("DryRun created settings.json")
	}
}

func TestClaudeApplyRealAndInspect(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	reg := NewRegistry()
	_ = RegisterBuiltin(reg, home)
	a, _ := reg.Get("claude")

	if _, err := a.Apply(&ApplyContext{
		Endpoint:    "https://proxy.example/v1",
		APIKey:      "sk-proxy",
		Home:        home,
		AnyPickRoot: root,
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		t.Fatalf("settings.json unreadable: %s", raw)
	}
	if _, ok := doc["env"]; !ok {
		t.Fatalf("settings.json missing env: %s", raw)
	}
	if _, ok := doc[anypickManagedKey]; !ok {
		t.Fatalf("settings.json missing %s: %s", anypickManagedKey, raw)
	}
	ins, err := a.Inspect()
	if err != nil {
		t.Fatal(err)
	}
	if !ins.Present {
		t.Fatalf("Inspect Present=false want true, issues=%v", ins.Issues)
	}
	// Managed env block must contain base url.
	var env map[string]string
	_ = json.Unmarshal(doc["env"], &env)
	if env["ANTHROPIC_BASE_URL"] != "https://proxy.example/v1" {
		t.Fatalf("ANTHROPIC_BASE_URL=%q", env["ANTHROPIC_BASE_URL"])
	}
}

func TestClaudeApplyPreservesUserKeys(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	// Seed existing settings with user env key that should survive.
	claudeDir := filepath.Join(home, ".claude")
	_ = os.MkdirAll(claudeDir, 0o700)
	seed := `{"env":{"MY_KEEP":"1","ANTHROPIC_MODEL":"old"}}`
	_ = os.WriteFile(filepath.Join(claudeDir, "settings.json"), []byte(seed), 0o600)

	reg := NewRegistry()
	_ = RegisterBuiltin(reg, home)
	a, _ := reg.Get("claude")
	if _, err := a.Apply(&ApplyContext{
		Endpoint:    "https://proxy.example/v1",
		APIKey:      "sk",
		Home:        home,
		AnyPickRoot: root,
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(claudeDir, "settings.json"))
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(raw, &doc)
	var env map[string]string
	_ = json.Unmarshal(doc["env"], &env)
	if env["MY_KEEP"] != "1" {
		t.Fatalf("user key MY_KEEP lost: %v", env)
	}
}

func TestCodexApplyAndInspect(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	// Isolate CODEX_HOME to home.
	t.Setenv("ANYPICK_HOME", root)
	t.Setenv("CODEX_HOME", "")
	reg := NewRegistry()
	_ = RegisterBuiltin(reg, home)
	a, _ := reg.Get("codex")

	// No config yet -> Inspect reports absent.
	ins, _ := a.Inspect()
	if ins.Present {
		t.Fatalf("Inspect want absent before Apply")
	}

	// DryRun.
	if res, err := a.Apply(&ApplyContext{
		Endpoint:    "https://proxy.example/v1",
		APIKey:      "sk",
		Home:        home,
		AnyPickRoot: root,
		DryRun:      true,
	}); err != nil || len(res.ManagedPaths) == 0 {
		t.Fatalf("DryRun codex: %v %#v", err, res)
	}

	// Real apply.
	if _, err := a.Apply(&ApplyContext{
		Endpoint:    "https://proxy.example/v1",
		APIKey:      "sk",
		Home:        home,
		AnyPickRoot: root,
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), codexBeginMarker) || !strings.Contains(string(raw), "AnyPick") {
		t.Fatalf("codex config missing managed block:\n%s", raw)
	}
	if !strings.Contains(string(raw), `base_url = "https://proxy.example/v1"`) {
		t.Fatalf("codex endpoint was not normalized:\n%s", raw)
	}
	if !strings.Contains(string(raw), "requires_openai_auth = false") ||
		!strings.Contains(string(raw), "supports_websockets = false") {
		t.Fatalf("codex proxy provider must disable native auth/websockets:\n%s", raw)
	}
	ins2, _ := a.Inspect()
	if !ins2.Present {
		t.Fatalf("Inspect after Apply want present")
	}

	// Reset removes block.
	if err := a.Reset(); err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if strings.Contains(string(raw2), codexBeginMarker) {
		t.Fatalf("Reset did not remove block:\n%s", raw2)
	}
}

func TestCodexNamedProfilesAreIndependent(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	t.Setenv("ANYPICK_HOME", root)

	reg := NewRegistry()
	if err := RegisterBuiltin(reg, home); err != nil {
		t.Fatal(err)
	}
	a, _ := reg.Get("codex")
	apply := func(name, endpoint, model string) {
		t.Helper()
		if _, err := a.Apply(&ApplyContext{
			Endpoint: endpoint, APIKey: "token-" + name, DefaultModel: model,
			ModelCatalog: []string{model + "-catalog"}, ProfileName: name,
			Home: home, AnyPickRoot: root,
		}); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	apply("a", "http://127.0.0.1:4101", "model-a")
	apply("b", "http://127.0.0.1:4102", "model-b")

	aConfig, err := os.ReadFile(CodexProfileConfigPathForRoot(root, "a"))
	if err != nil {
		t.Fatal(err)
	}
	bConfig, err := os.ReadFile(CodexProfileConfigPathForRoot(root, "b"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(aConfig), "4101") || strings.Contains(string(aConfig), "4102") {
		t.Fatalf("profile a was overwritten by b:\n%s", aConfig)
	}
	if !strings.Contains(string(bConfig), "4102") || strings.Contains(string(bConfig), "4101") {
		t.Fatalf("profile b was overwritten by a:\n%s", bConfig)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("named apply touched global config.toml: %v", err)
	}
	for _, name := range []string{"a", "b"} {
		if _, err := os.Stat(CodexProfileEnvPath(root, name)); err != nil {
			t.Fatalf("profile %s env file missing: %v", name, err)
		}
		if _, err := os.Stat(CodexProfileModelCatalogPathForRoot(root, name)); err != nil {
			t.Fatalf("profile %s catalog missing: %v", name, err)
		}
		inspected, err := a.(ProfileInspector).InspectProfile(name)
		if err != nil || !inspected.Present {
			t.Fatalf("inspect profile %s = %#v, %v", name, inspected, err)
		}
	}

	if err := a.(ProfileResetter).ResetProfile("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(CodexProfileConfigPathForRoot(root, "a")); !os.IsNotExist(err) {
		t.Fatalf("reset left profile a config: %v", err)
	}
	bAfter, err := os.ReadFile(CodexProfileConfigPathForRoot(root, "b"))
	if err != nil || !strings.Contains(string(bAfter), "4102") {
		t.Fatalf("reset a changed profile b: %q %v", bAfter, err)
	}
}

func TestCodexIsolatedApplyIgnoresParentCodexHome(t *testing.T) {
	liveHome := t.TempDir()
	isolatedHome := t.TempDir()
	parentCodexHome := t.TempDir()
	root := t.TempDir()
	t.Setenv("CODEX_HOME", parentCodexHome)

	reg := NewRegistry()
	_ = RegisterBuiltin(reg, liveHome)
	a, _ := reg.Get("codex")
	if _, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:4311",
		APIKey:       "proxy-token",
		Home:         liveHome,
		IsolatedHome: isolatedHome,
		AnyPickRoot:  root,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(parentCodexHome, "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("isolated apply wrote to parent CODEX_HOME: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(isolatedHome, ".codex", "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "127.0.0.1:4311") {
		t.Fatalf("isolated config missing proxy endpoint:\n%s", raw)
	}
}

func TestCodexPreservesUserContent(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	cfgPath := filepath.Join(home, ".codex", "config.toml")
	_ = os.MkdirAll(filepath.Dir(cfgPath), 0o700)
	_ = os.WriteFile(cfgPath, []byte("# user header\napproval_policy = \"never\"\n"), 0o600)

	reg := NewRegistry()
	_ = RegisterBuiltin(reg, home)
	a, _ := reg.Get("codex")
	if _, err := a.Apply(&ApplyContext{Endpoint: "https://proxy.example/v1", APIKey: "sk", Home: home, AnyPickRoot: root}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(raw), "approval_policy = \"never\"") {
		t.Fatalf("user content lost:\n%s", raw)
	}
	if !strings.Contains(string(raw), codexBeginMarker) {
		t.Fatalf("managed block missing:\n%s", raw)
	}
}

func TestCodexManagedBlockStaysAtTomlRoot(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	cfgPath := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o700); err != nil {
		t.Fatal(err)
	}
	seed := `model_reasoning_effort = "max"
model = "native-model"

[model_providers.custom]
name = "custom"
base_url = "https://example.test/v1"
`
	if err := os.WriteFile(cfgPath, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	reg := NewRegistry()
	_ = RegisterBuiltin(reg, home)
	a, _ := reg.Get("codex")
	if _, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:4312",
		APIKey:       "proxy-token",
		DefaultModel: "deepseek-4.1-flash",
		Home:         home,
		AnyPickRoot:  root,
		// The seed config pins a foreign root `model`; this test exercises
		// block placement, not the consent gate, so grant takeover.
		AllowForeignConfig: true,
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	managedAt := strings.Index(text, "model_provider = \"anypick\"")
	tableAt := strings.Index(text, "[model_providers.custom]")
	if managedAt < 0 || tableAt < 0 || managedAt > tableAt {
		t.Fatalf("managed provider escaped TOML root:\n%s", text)
	}
	if !strings.Contains(text, "model = \"deepseek-4.1-flash\"") {
		t.Fatalf("model override missing:\n%s", text)
	}
	if strings.Count(text, "model = ") != 1 {
		t.Fatalf("managed model was duplicated:\n%s", text)
	}
}

func TestClaudeInspectNativeRouting(t *testing.T) {
	for _, tc := range []struct {
		name, settings string
		native         bool
	}{
		{"missing", "", true},
		{"subscription", `{"model":"opus"}`, true},
		{"empty env", `{"env":{}}`, true},
		{"stale marker", `{"env":{},"_anypickManaged":{"keys":["ANTHROPIC_BASE_URL"]}}`, true},
		{"managed proxy", `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1234","ANTHROPIC_AUTH_TOKEN":"test"},"_anypickManaged":{}}`, false},
		{"external proxy", `{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example"}}`, false},
		{"api key", `{"env":{"ANTHROPIC_API_KEY":"test"}}`, false},
		{"key helper", `{"apiKeyHelper":"my-helper"}`, false},
		{"bedrock", `{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}`, false},
		{"vertex", `{"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}`, false},
		{"foundry", `{"env":{"CLAUDE_CODE_USE_FOUNDRY":"1"}}`, false},
		{"oauth override", `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"test"}}`, false},
		{"invalid", `{`, false},
		{"null", `null`, false},
		{"invalid env", `{"env":[]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if tc.settings != "" {
				path := settingsPath(home)
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(tc.settings), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			result, err := newClaude(home).Inspect()
			if err != nil {
				t.Fatal(err)
			}
			if result.Native != tc.native {
				t.Fatalf("Native = %v, want %v: %+v", result.Native, tc.native, result)
			}
		})
	}
}
