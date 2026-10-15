package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/compensation"
	"github.com/outof0/anypick/go/internal/transport"
)

func TestCreateEphemeralClaude(t *testing.T) {
	s := testService(t)
	// Seed a live settings file so copyIfPresent has something to carry.
	liveSettings := filepath.Join(s.Home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(liveSettings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(liveSettings, []byte(`{"env":{"KEEP":"1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	rt, err := s.CreateEphemeralRuntime(EphemeralSpec{
		ClientID: "claude",
		Endpoint: "https://proxy.example/v1",
		APIKey:   "sk-proxy",
	})
	if err != nil {
		t.Fatalf("CreateEphemeralRuntime claude: %v", err)
	}
	defer func() { _ = rt.Cleanup() }()
	if rt.Home == "" || rt.Directory == "" {
		t.Fatalf("EphemeralRuntime empty: %#v", rt)
	}
	if rt.Environment["HOME"] != rt.Home {
		t.Fatalf("claude HOME env = %q want %q", rt.Environment["HOME"], rt.Home)
	}
	// Isolated settings should exist and contain proxy env.
	isoSettings := filepath.Join(rt.Home, ".claude", "settings.json")
	raw, err := os.ReadFile(isoSettings)
	if err != nil {
		t.Fatalf("iso settings missing: %v", err)
	}
	if !strings.Contains(string(raw), "proxy.example") {
		t.Fatalf("iso settings missing proxy: %s", raw)
	}
	// Cleanup is idempotent.
	if err := rt.Cleanup(); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if _, err := os.Stat(rt.Directory); !os.IsNotExist(err) {
		t.Fatalf("directory should be removed after Cleanup")
	}
	_ = rt.Cleanup() // second call must not error
}

func TestCreateEphemeralCodex(t *testing.T) {
	s := testService(t)
	t.Setenv("CODEX_HOME", "")
	// Seed a codex config so copyIfPresent copies it.
	cfg := filepath.Join(s.Home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, []byte("# user\napproval_policy=\"never\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rt, err := s.CreateEphemeralRuntime(EphemeralSpec{
		ClientID:     "codex",
		Endpoint:     "https://proxy.example/v1",
		APIKey:       "sk-proxy",
		DefaultModel: "gpt-5",
	})
	if err != nil {
		t.Fatalf("CreateEphemeralRuntime codex: %v", err)
	}
	defer func() { _ = rt.Cleanup() }()
	if rt.Environment["CODEX_HOME"] == "" {
		t.Fatalf("codex CODEX_HOME env missing: %#v", rt.Environment)
	}
	if rt.Environment["ANYPICK_PROXY_API_KEY"] != "sk-proxy" {
		t.Fatalf("APIKey env = %q", rt.Environment["ANYPICK_PROXY_API_KEY"])
	}
	isoCfg := filepath.Join(rt.Home, ".codex", "config.toml")
	raw, err := os.ReadFile(isoCfg)
	if err != nil {
		t.Fatal(err)
	}
	// Should preserve user content and add proxy block.
	if !strings.Contains(string(raw), "approval_policy=\"never\"") {
		t.Fatalf("user content lost: %s", raw)
	}
	if !strings.Contains(string(raw), "proxy.example") {
		t.Fatalf("proxy block missing: %s", raw)
	}
}

func TestCreateEphemeralCodexNativeProfileCopiesAuth(t *testing.T) {
	s := testService(t)
	t.Setenv("CODEX_HOME", filepath.Join(s.Home, ".codex"))
	snapshot := t.TempDir()
	const authB = `{"OPENAI_API_KEY":"sk-profile-b"}`
	if err := os.WriteFile(filepath.Join(snapshot, "auth.json"), []byte(authB), 0o600); err != nil {
		t.Fatal(err)
	}

	rt, err := s.CreateEphemeralRuntime(EphemeralSpec{
		ClientID: "codex", DefaultModel: "gpt-5.6", SourceKind: "account",
		SourceProvider: "codex", SourceName: "b", TransportCapability: transport.Direct,
		ProfileName: "b", NativeAuthSnapshotDir: snapshot,
	})
	if err != nil {
		t.Fatalf("CreateEphemeralRuntime native Codex profile: %v", err)
	}
	defer func() { _ = rt.Cleanup() }()
	if rt.Environment["CODEX_HOME"] != filepath.Join(rt.Home, ".codex") {
		t.Fatalf("profile CODEX_HOME = %q", rt.Environment["CODEX_HOME"])
	}
	auth, err := os.ReadFile(filepath.Join(rt.Home, ".codex", "auth.json"))
	if err != nil || string(auth) != authB {
		t.Fatalf("isolated profile auth = %q, %v", auth, err)
	}
	config, err := os.ReadFile(filepath.Join(rt.Home, ".codex", "b.config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "model_provider = \"openai\"") ||
		strings.Contains(string(config), "base_url") {
		t.Fatalf("isolated native profile config is not native:\n%s", config)
	}
	if _, err := os.Stat(filepath.Join(s.Home, ".codex", "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("ephemeral native profile touched live auth: %v", err)
	}
}

// TestCreateEphemeralZCode covers the isolated home the `run` path builds.
// ZCode resolves its config and its whole storage tree from $HOME (see the
// provenance comment on zcodeAdapter.Capabilities), so an isolated run must
// produce a working config inside the temp home *and* leave the user's real
// ~/.zcode alone.
func TestCreateEphemeralZCode(t *testing.T) {
	s := testService(t)
	liveCfg := filepath.Join(s.Home, ".zcode", "cli", "config.json")
	if err := os.MkdirAll(filepath.Dir(liveCfg), 0o700); err != nil {
		t.Fatal(err)
	}
	const liveBody = `{"provider":{"deepseek":{"id":"deepseek","name":"DeepSeek"}}}`
	if err := os.WriteFile(liveCfg, []byte(liveBody), 0o600); err != nil {
		t.Fatal(err)
	}

	rt, err := s.CreateEphemeralRuntime(EphemeralSpec{
		ClientID:     "zcode",
		Endpoint:     "http://127.0.0.1:8080",
		APIKey:       "sk-proxy",
		DefaultModel: "glm-4.6",
	})
	if err != nil {
		t.Fatalf("CreateEphemeralRuntime zcode: %v", err)
	}
	defer func() { _ = rt.Cleanup() }()
	if rt.Environment["HOME"] != rt.Home {
		t.Fatalf("zcode HOME env = %q want %q", rt.Environment["HOME"], rt.Home)
	}

	isoCfg := filepath.Join(rt.Home, ".zcode", "cli", "config.json")
	raw, err := os.ReadFile(isoCfg)
	if err != nil {
		t.Fatalf("isolated config missing: %v", err)
	}
	var doc struct {
		Provider map[string]struct {
			Options struct {
				BaseURL string `json:"baseURL"`
			} `json:"options"`
		} `json:"provider"`
		Model map[string]string `json:"model"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("isolated config: %v", err)
	}
	if _, ok := doc.Provider["anypick"]; !ok {
		t.Fatalf("isolated config missing managed provider:\n%s", raw)
	}
	if doc.Provider["anypick"].Options.BaseURL != "http://127.0.0.1:8080" {
		t.Fatalf("isolated baseURL = %q", doc.Provider["anypick"].Options.BaseURL)
	}
	if doc.Model["main"] != "anypick/glm-4.6" {
		t.Fatalf("isolated model.main = %q", doc.Model["main"])
	}
	// The user's own provider must survive the carry-over.
	if _, ok := doc.Provider["deepseek"]; !ok {
		t.Fatalf("user provider dropped from isolated config:\n%s", raw)
	}

	// The whole point: the live config was never written to.
	if got, err := os.ReadFile(liveCfg); err != nil || string(got) != liveBody {
		t.Fatalf("live config changed (got %s, err %v)", got, err)
	}

	if err := rt.Cleanup(); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if _, err := os.Stat(rt.Directory); !os.IsNotExist(err) {
		t.Fatal("directory should be removed after Cleanup")
	}
}

// TestCreateEphemeralZCodeWithoutALiveConfig covers the machine this adapter
// was written on: ~/.zcode/cli exists as a runtime directory but holds no
// config.json, so the isolated run has to create one from nothing.
func TestCreateEphemeralZCodeWithoutALiveConfig(t *testing.T) {
	s := testService(t)
	if err := os.MkdirAll(filepath.Join(s.Home, ".zcode", "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	rt, err := s.CreateEphemeralRuntime(EphemeralSpec{
		ClientID:     "zcode",
		Endpoint:     "http://127.0.0.1:8080",
		APIKey:       "sk-proxy",
		DefaultModel: "glm-4.6",
	})
	if err != nil {
		t.Fatalf("CreateEphemeralRuntime zcode: %v", err)
	}
	defer func() { _ = rt.Cleanup() }()

	raw, err := os.ReadFile(filepath.Join(rt.Home, ".zcode", "cli", "config.json"))
	if err != nil {
		t.Fatalf("isolated config not created: %v", err)
	}
	if !strings.Contains(string(raw), "anypick") {
		t.Fatalf("isolated config missing managed provider:\n%s", raw)
	}
	if _, err := os.Stat(filepath.Join(s.Home, ".zcode", "cli", "config.json")); !os.IsNotExist(err) {
		t.Fatal("a config was created in the live ~/.zcode/cli, which must stay untouched")
	}
}

func TestCreateEphemeralUnknownClient(t *testing.T) {
	s := testService(t)
	if _, err := s.CreateEphemeralRuntime(EphemeralSpec{ClientID: "nope", Endpoint: "https://x", APIKey: "sk"}); err == nil {
		t.Fatal("want error for unknown client")
	}
	// Known provider id that doesn't support isolated homes would also error if registered,
	// but "gemini" is not a client adapter — unknown is enough to cover the branch.
}

func TestCreateEphemeralCodexWithoutSourceFile(t *testing.T) {
	s := testService(t)
	t.Setenv("CODEX_HOME", "")
	// Ensure no source config exists — copyIfPresent should be no-op.
	_ = os.Remove(filepath.Join(s.Home, ".codex", "config.toml"))
	rt, err := s.CreateEphemeralRuntime(EphemeralSpec{ClientID: "codex", Endpoint: "https://proxy.example/v1", APIKey: "sk"})
	if err != nil {
		t.Fatalf("codex without source: %v", err)
	}
	defer func() { _ = rt.Cleanup() }()
	isoCfg := filepath.Join(rt.Home, ".codex", "config.toml")
	if _, err := os.Stat(isoCfg); err != nil {
		t.Fatalf("iso config should exist after Apply even without source: %v", err)
	}
}

func TestHelpersSanitizeAndSplit(t *testing.T) {
	if got := sanitize("hello-world_123"); got != "hello-world_123" {
		t.Fatalf("sanitize alnum = %q", got)
	}
	if got := sanitize("a b/c@d"); got != "a_b_c_d" {
		t.Fatalf("sanitize special = %q", got)
	}
	long := strings.Repeat("a", 30)
	if len(sanitize(long)) != 24 {
		t.Fatalf("sanitize trunc len = %d", len(sanitize(long)))
	}
	// The record parse now lives in internal/compensation, shared with the
	// crash-recovery path, so there is one reader of the wire format.
	if rec, ok := compensation.Parse("a=>b"); !ok || rec.Src != "a" || rec.Dest != "b" {
		t.Fatalf("Parse a=>b = %+v ok=%v", rec, ok)
	}
	if rec, ok := compensation.Parse(" delete => /tmp/x "); !ok || rec.Src != "delete" || rec.Dest != "/tmp/x" {
		t.Fatalf("Parse spaced = %+v ok=%v", rec, ok)
	}
	if _, ok := compensation.Parse("nope"); ok {
		t.Fatal("Parse should fail for missing =>")
	}
	// copyIfPresent: missing src is no error and dest not created
	tmp := t.TempDir()
	if err := copyIfPresent(filepath.Join(tmp, "missing"), filepath.Join(tmp, "dest")); err != nil {
		t.Fatalf("copyIfPresent missing source: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "dest")); !os.IsNotExist(err) {
		t.Fatalf("copyIfPresent should not create dest for missing src")
	}
	// present src copies
	srcFile := filepath.Join(tmp, "src.txt")
	destFile := filepath.Join(tmp, "dest.txt")
	_ = os.WriteFile(srcFile, []byte("hello"), 0o600)
	if err := copyIfPresent(srcFile, destFile); err != nil {
		t.Fatalf("copyIfPresent: %v", err)
	}
	raw, _ := os.ReadFile(destFile)
	if string(raw) != "hello" {
		t.Fatalf("copyIfPresent failed: %q", raw)
	}
	// clientHome fallback and codexConfigPath env override
	s := testService(t)
	customCodex := filepath.Join(os.TempDir(), "custom-codex")
	t.Setenv("CODEX_HOME", customCodex)
	if got := codexConfigPath(s); got != filepath.Join(customCodex, "config.toml") {
		t.Fatalf("codexConfigPath env = %q", got)
	}
	t.Setenv("CODEX_HOME", "")
	_ = clientHome(s) // just cover the branch
	// ApplyProxyEndpoint unknown client
	if _, err := s.ApplyProxyEndpoint(context.Background(), "nope", ProxyEndpointOptions{Endpoint: "https://x", APIKey: "sk"}); err == nil {
		t.Fatal("want error for unknown client in ApplyProxyEndpoint")
	}
	// PrepareClientConfigRecovery unknown client -> error
	if _, err := s.PrepareClientConfigRecovery("nope", "jid"); err == nil {
		t.Fatalf("want error for unknown client in PrepareClientConfigRecovery")
	}
	// Restore with malformed record is ignored
	if err := RestoreClientConfigRecovery([]string{"bad-record"}); err != nil {
		t.Fatalf("malformed record should be ignored: %v", err)
	}
}

func TestCreateEphemeralRuntimeRejectsUnreadableSourceConfig(t *testing.T) {
	s := testService(t)
	settings := filepath.Join(s.Home, ".claude", "settings.json")
	if err := os.MkdirAll(settings, 0o700); err != nil {
		t.Fatal(err)
	}

	if _, err := s.CreateEphemeralRuntime(EphemeralSpec{
		ClientID: "claude",
		Endpoint: "https://proxy.example/v1",
		APIKey:   "sk-proxy",
	}); err == nil {
		t.Fatal("want an error when the source config cannot be read")
	}
}
