package client

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/transport"
)

func TestClaudeAdapterIdentityAndReset(t *testing.T) {
	home := t.TempDir()
	a := newClaude(home)

	if a.ID() != "claude" || a.Name() != "Claude Code" || a.ShortName() != "Claude" {
		t.Fatalf("identity: %q/%q/%q", a.ID(), a.Name(), a.ShortName())
	}
	caps := a.Capabilities()
	if caps.ProtocolPreference != transport.Anthropic || !caps.SupportsIsolatedHome {
		t.Fatalf("capabilities: %+v", caps)
	}

	// Reset without a managed marker touches nothing: values without the
	// marker are not provably AnyPick's, so an explicit unroute must not
	// delete user-set settings. The stale endpoint here was never written by
	// AnyPick, so it stays.
	t.Setenv("ANYPICK_HOME", t.TempDir())
	settings := settingsPath(home)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	const userContent = `{"env":{"USER_KEY":"keep","ANTHROPIC_BASE_URL":"http://127.0.0.1:9999"}}`
	if err := os.WriteFile(settings, []byte(userContent), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	raw, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != userContent {
		t.Fatalf("Reset modified unmanaged settings: %s", raw)
	}
}

func TestClaudeResetRestoresPreAnyPickBackup(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_HOME", root)
	a := newClaude(home)

	settings := settingsPath(home)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	managed := `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9999"},"` + anypickManagedKey + `":{"keys":["ANTHROPIC_BASE_URL"]}}`
	if err := os.WriteFile(settings, []byte(managed), 0o600); err != nil {
		t.Fatal(err)
	}
	backupDir := filepath.Join(root, "clients", "claude", "backup")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		t.Fatal(err)
	}
	const preAnyPick = `{"env":{"USER_KEY":"orig"}}`
	if err := os.WriteFile(filepath.Join(backupDir, "settings.json"), []byte(preAnyPick), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	raw, err := os.ReadFile(settings)
	if err != nil || string(raw) != preAnyPick {
		t.Fatalf("Reset did not restore backup: %q %v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(backupDir, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("backup was not consumed: %v", err)
	}
}

// TestClaudeResetKeepsUserEditsOnceTheMarkerIsGone: the one-time backup must
// not overwrite a settings.json the user has since edited (the marker is how
// we know AnyPick still owns the file). Reset strips the managed keys and
// leaves the backup for the next call.
func TestClaudeResetKeepsUserEditsOnceTheMarkerIsGone(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_HOME", root)
	a := newClaude(home)

	settings := settingsPath(home)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"env":{"USER_ADDED_LATER":"keep"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	backupDir := filepath.Join(root, "clients", "claude", "backup")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backupDir, "settings.json"), []byte(`{"env":{"USER_KEY":"orig"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := a.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	raw, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"USER_ADDED_LATER":"keep"`) {
		t.Fatalf("Reset destroyed user edits: %s", raw)
	}
	if _, err := os.Stat(filepath.Join(backupDir, "settings.json")); err != nil {
		t.Fatalf("backup must survive a gated Reset: %v", err)
	}
}

func TestClaudeRestoreNativeKeepsBackupForReset(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_HOME", root)
	a := newClaude(home)

	settings := settingsPath(home)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	managed := `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9999"},"` + anypickManagedKey + `":{"keys":["ANTHROPIC_BASE_URL"]}}`
	if err := os.WriteFile(settings, []byte(managed), 0o600); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(root, "clients", "claude", "backup", "settings.json")
	if err := os.MkdirAll(filepath.Dir(backupPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.RestoreNative(); err != nil {
		t.Fatalf("RestoreNative: %v", err)
	}
	raw, _ := os.ReadFile(settings)
	if strings.Contains(string(raw), "127.0.0.1:9999") {
		t.Fatalf("RestoreNative left proxy endpoint: %s", raw)
	}
	if _, err := os.Stat(backupPath); err != nil {
		t.Fatalf("RestoreNative must not consume the Reset backup: %v", err)
	}
}

func TestClaudeInspectVariants(t *testing.T) {
	home := t.TempDir()
	a := newClaude(home)

	// Missing settings file.
	res, err := a.Inspect()
	if err != nil || res.Present || len(res.Issues) != 1 ||
		!strings.Contains(res.Issues[0], "not found") {
		t.Fatalf("missing: %+v %v", res, err)
	}

	settings := settingsPath(home)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}

	// Unreadable JSON.
	if err := os.WriteFile(settings, []byte(`{oops`), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = a.Inspect()
	if err != nil || res.Present || !strings.Contains(res.Issues[0], "unreadable") {
		t.Fatalf("corrupt: %+v %v", res, err)
	}

	// Valid JSON without the managed marker.
	if err := os.WriteFile(settings, []byte(`{"env":{"X":"1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = a.Inspect()
	if err != nil || res.Present || !strings.Contains(res.Issues[0], "anypick-managed") {
		t.Fatalf("unmanaged: %+v %v", res, err)
	}

	// Managed block present.
	managed := `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1234"},"` + anypickManagedKey + `":true}`
	if err := os.WriteFile(settings, []byte(managed), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = a.Inspect()
	if err != nil || !res.Present || len(res.Issues) != 0 {
		t.Fatalf("managed: %+v %v", res, err)
	}
}

func TestBareModelID(t *testing.T) {
	cases := map[string]string{
		"":            "",
		"  ":          "",
		"glm-4.7":     "glm-4.7",
		"vendor/name": "name",
		"a/b/c":       "c",
		" x/y ":       "y",
	}
	for in, want := range cases {
		if got := bareModelID(in); got != want {
			t.Errorf("bareModelID(%q)=%q want %q", in, got, want)
		}
	}
}

func TestSmallJSONHelpers(t *testing.T) {
	doc := map[string]json.RawMessage{
		"s": json.RawMessage(`"str"`),
		"n": json.RawMessage(`42`),
	}
	if stringField(doc, "s") != "str" || stringField(doc, "n") != "" ||
		stringField(doc, "absent") != "" {
		t.Fatal("stringField semantics")
	}

	if got := firstNonEmpty("", " ", " real "); got != "real" {
		t.Fatalf("firstNonEmpty: %q", got)
	}
	if got := firstNonEmpty(); got != "" {
		t.Fatalf("firstNonEmpty empty: %q", got)
	}

	files := writeClientEnvFiles(t.TempDir(), "claude",
		map[string]string{"B_KEY": "v2", "A_KEY": "v1"})
	if len(files) != 2 {
		t.Fatalf("env files: %v", files)
	}
	raw, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	aIdx := strings.Index(text, `export A_KEY="v1"`)
	bIdx := strings.Index(text, `export B_KEY="v2"`)
	if aIdx < 0 || bIdx < 0 || aIdx > bIdx {
		t.Fatalf("keys not sorted or missing:\n%s", text)
	}

	// Unwritable client dir yields no files.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := writeClientEnvFiles(blocker, "claude", nil); got != nil {
		t.Fatalf("expected nil for unwritable dir: %v", got)
	}
}

func TestCodexIdentityAndConfigPathOverride(t *testing.T) {
	home := t.TempDir()
	a := newCodex(home)
	if a.ID() != "codex" || a.Name() != "OpenAI Codex" || a.ShortName() != "Codex" {
		t.Fatalf("identity: %q/%q/%q", a.ID(), a.Name(), a.ShortName())
	}

	// Default lives under the adapter home.
	if got := codexConfigPath(home); got != filepath.Join(home, ".codex", "config.toml") {
		t.Fatalf("default path: %q", got)
	}
	// CODEX_HOME overrides.
	override := t.TempDir()
	t.Setenv("CODEX_HOME", override)
	if got := codexConfigPath(home); got != filepath.Join(override, "config.toml") {
		t.Fatalf("override ignored: %q", got)
	}
}

func TestBuiltinNativeInspectionIsExplicit(t *testing.T) {
	for _, key := range []string{"CODEX_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "XDG_CONFIG_HOME", "GEMINI_CLI_HOME", "GEMINI_CONFIG_DIR"} {
		t.Setenv(key, "")
	}
	reg := NewRegistry()
	if err := RegisterBuiltin(reg, t.TempDir(), t.TempDir()); err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{"claude": true, "codex": true, "gemini": true, "kiro": true, "opencode": true, "workbuddy": true, "zcode": true, "pi": false, "omp": false, "dsh": false, "commandcode": false}
	for _, id := range reg.IDs() {
		want, ok := expected[id]
		if !ok {
			t.Fatalf("classify native routing for new client %s", id)
		}
		adapter, _ := reg.Get(id)
		state, err := adapter.Inspect()
		if err != nil || state.Native != want {
			t.Fatalf("%s native=%+v err=%v, want %v", id, state, err, want)
		}
	}
}

func TestGeneratedShellEnvironmentDoesNotExpandValues(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires POSIX shell")
	}
	value := "key$(echo unwanted)'with$variables`and&metacharacters"
	paths := writeClientEnvFiles(t.TempDir(), "fixture", map[string]string{"ANYPICK_TEST_VALUE": value})
	if len(paths) != 2 {
		t.Fatalf("missing environment mirrors: %v", paths)
	}
	output, err := exec.Command("/bin/sh", "-c", `. "$1"; printf '%s' "$ANYPICK_TEST_VALUE"`, "test", paths[0]).Output()
	if err != nil || string(output) != value {
		t.Fatalf("shell round-trip=%q, %v", output, err)
	}
}

func TestCodexInspectNativeSelection(t *testing.T) {
	t.Setenv("CODEX_HOME", "")
	for _, tc := range []struct {
		name, config string
		native       bool
	}{
		{"default", `model = "gpt-test"`, true},
		{"explicit native", `model_provider = "openai"`, true},
		{"custom", `model_provider = "custom"`, false},
		{"managed", `model_provider = "anypick"`, false},
		{"official provider overridden", `[model_providers.openai]
base_url = "https://custom.invalid"`, false},
		{"selected external profile", `profile = "external"
[profiles.external]
model_provider = "custom"`, false},
		{"corrupt", `broken = [`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			path := codexConfigPath(home)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(tc.config), 0o600); err != nil {
				t.Fatal(err)
			}
			result, err := newCodex(home).Inspect()
			if err != nil || result.Native != tc.native {
				t.Fatalf("Inspect=%+v, %v, want native %v", result, err, tc.native)
			}
		})
	}
}

func TestOpenCodeInspectUsesSelectedModel(t *testing.T) {
	for _, tc := range []struct {
		config string
		native bool
	}{
		{`{"model":"opencode/native","provider":{"anypick-managed":{}}}`, true},
		{`{"model":"anypick-managed/test","provider":{"anypick-managed":{}}}`, false},
		{`{"provider":{"anypick-managed":{}}}`, false},
		{`{"model":"custom/test","provider":{"custom":{"options":{"baseURL":"https://custom.invalid"}}}}`, false},
		{`null`, false},
	} {
		home := t.TempDir()
		path := openCodeEffectiveConfigPath(home)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(tc.config), 0o600); err != nil {
			t.Fatal(err)
		}
		result, err := newOpenCode(home).Inspect()
		if err != nil || result.Native != tc.native {
			t.Fatalf("Inspect=%+v, %v, want %v", result, err, tc.native)
		}
	}
}

func TestGeneratedPowerShellEnvironmentRoundTrips(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("requires native Windows PowerShell")
	}
	root := t.TempDir()
	value := "key'with$variables`and&metacharacters"
	paths := writeClientEnvFiles(root, "fixture", map[string]string{"ANYPICK_TEST_VALUE": value})
	if len(paths) != 2 {
		t.Fatalf("missing environment mirrors: %v", paths)
	}
	script := ". '" + strings.ReplaceAll(paths[1], "'", "''") + "'; [Console]::Write($env:ANYPICK_TEST_VALUE)"
	output, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil || string(output) != value {
		t.Fatalf("PowerShell round-trip=%q, %v", output, err)
	}
}

func TestEveryClientClassifiesChangedLiveSelection(t *testing.T) {
	type fixture struct {
		paths   func(string) []string
		content string
		changed bool
	}
	cases := map[string]fixture{
		"claude":      {func(h string) []string { return []string{settingsPath(h)} }, `{"model":"native"}`, true},
		"codex":       {func(h string) []string { return []string{codexConfigPath(h)} }, `model_provider = "openai"`, true},
		"gemini":      {func(h string) []string { return []string{geminiSettingsPath(h)} }, `{}`, true},
		"kiro":        {func(h string) []string { return nil }, ``, false},
		"opencode":    {func(h string) []string { return []string{openCodeEffectiveConfigPath(h)} }, `{"model":"opencode/native","provider":{"anypick-managed":{}}}`, true},
		"workbuddy":   {workbuddyModelsPaths, `{"models":[]}`, true},
		"zcode":       {func(h string) []string { return []string{filepath.Join(h, ".zcode", "cli", "config.json")} }, `{"provider":{"anypick":{}},"model":{"main":"zai/native"}}`, true},
		"dsh":         {func(h string) []string { return []string{dshSettingsPath(h)} }, `model = "native"`, true},
		"commandcode": {func(h string) []string { return []string{commandCodeConfigPath(h)} }, `{"modelProvider":"other","model":"other/test"}`, true},
		"pi":          {func(h string) []string { return []string{piSettingsPath(h)} }, `{"defaultProvider":"anthropic","defaultModel":"anthropic/native"}`, true},
		"omp":         {func(h string) []string { return []string{ompConfigPath(h)} }, "defaultProvider: 'anthropic'\ndefaultModel: 'anthropic/native'\n", true},
	}
	for _, key := range []string{"CODEX_HOME", "DSH_HOME", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "GEMINI_CLI_HOME", "GEMINI_CONFIG_DIR", "XDG_CONFIG_HOME"} {
		t.Setenv(key, "")
	}
	reg := NewRegistry()
	home := t.TempDir()
	if err := RegisterBuiltin(reg, home, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	for _, id := range reg.IDs() {
		t.Run(id, func(t *testing.T) {
			tc, ok := cases[id]
			if !ok {
				t.Fatalf("classify changed routing for %s", id)
			}
			for _, path := range tc.paths(home) {
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			cad, _ := reg.Get(id)
			state, err := cad.Inspect()
			if err != nil || state.RoutingChanged != tc.changed {
				t.Fatalf("%s Inspect=%+v, %v, want changed=%v", id, state, err, tc.changed)
			}
		})
	}
}
