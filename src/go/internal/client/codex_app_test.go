package client

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func writeProfileConfig(t *testing.T, root, name, body string) {
	t.Helper()
	path := CodexProfileConfigPathForRoot(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readAppConfig(t *testing.T, root, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(CodexProfileAppConfigPath(root, name))
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{}
	if err := toml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// The app is started by LaunchServices and never sees the profile's env file,
// and Codex fails a turn on a missing env_key even with a bearer token set.
// The app's own settings in the same file must survive a rewrite.
func TestWriteCodexProfileAppConfigCopiesRouteWithoutEnvKey(t *testing.T) {
	root := t.TempDir()
	writeProfileConfig(t, root, "work", `# BEGIN anypick-managed
model = "gemini-3.8-flash-tiered"
model_catalog_json = "/catalog.json"
model_provider = "anypick"

[model_providers.anypick]
name = "AnyPick"
base_url = "http://127.0.0.1:50563/v1"
env_key = "ANYPICK_CODEX_PROFILE_WORK_API_KEY"
experimental_bearer_token = "secret"
wire_api = "responses"
requires_openai_auth = false
# END anypick-managed

[tui]
screen_reader_detection_done = true
`)
	appPath := CodexProfileAppConfigPath(root, "work")
	if err := os.WriteFile(appPath, []byte(`model = "stale"
[desktop]
followUpQueueMode = "steer"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	doc := readAppConfig(t, root, "work")
	if doc["model"] != "gemini-3.8-flash-tiered" || doc["model_provider"] != "anypick" ||
		doc["model_catalog_json"] != "/catalog.json" {
		t.Fatalf("route keys = %v", doc)
	}
	provider := doc["model_providers"].(map[string]any)["anypick"].(map[string]any)
	if _, ok := provider["env_key"]; ok {
		t.Fatalf("env_key copied into the app config: %v", provider)
	}
	if provider["experimental_bearer_token"] != "secret" || provider["base_url"] != "http://127.0.0.1:50563/v1" {
		t.Fatalf("provider = %v", provider)
	}
	if !reflect.DeepEqual(doc["desktop"], map[string]any{"followUpQueueMode": "steer"}) {
		t.Fatalf("app settings lost: %v", doc)
	}
	if _, ok := doc["tui"]; ok {
		t.Fatalf("CLI state copied into the app config: %v", doc)
	}
	info, err := os.Stat(appPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("app config mode = %v, %v", info, err)
	}
}

// A profile re-pointed from a proxy to its native account must not keep the
// old provider and its token in the app config.
func TestWriteCodexProfileAppConfigDropsPreviousProvider(t *testing.T) {
	root := t.TempDir()
	writeProfileConfig(t, root, "work", `model = "gpt-5"
model_provider = "anypick"
[model_providers.anypick]
base_url = "http://127.0.0.1:1/v1"
experimental_bearer_token = "old"
`)
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	writeProfileConfig(t, root, "work", `# BEGIN anypick-native-profile
model = "gpt-5"
model_provider = "openai"
# END anypick-native-profile
`)
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	doc := readAppConfig(t, root, "work")
	if doc["model_provider"] != "openai" {
		t.Fatalf("model_provider = %v", doc["model_provider"])
	}
	if _, ok := doc["model_providers"]; ok {
		t.Fatalf("old provider kept: %v", doc)
	}
}

func TestWriteCodexProfileAppConfigNeedsProfileConfig(t *testing.T) {
	if err := WriteCodexProfileAppConfig(t.TempDir(), "missing"); err == nil {
		t.Fatal("wrote an app config for a profile with no config")
	}
}

// The instance needs its own CODEX_HOME and, for the app to keep it, its own
// Electron user data directory.
func TestLaunchCodexProfileAppPassesProfileHome(t *testing.T) {
	root := t.TempDir()
	var got []string
	oldOpen, oldGOOS := codexAppOpen, codexAppGOOS
	codexAppOpen = func(args []string) error { got = args; return nil }
	codexAppGOOS = "darwin"
	t.Cleanup(func() { codexAppOpen, codexAppGOOS = oldOpen, oldGOOS })

	if err := LaunchCodexProfileApp(root, "work"); err != nil {
		t.Fatal(err)
	}
	userData := CodexProfileAppUserDataPath(root, "work")
	want := []string{
		"-n", "-b", codexAppBundleID,
		"--env", "CODEX_HOME=" + CodexProfileHomePath(root, "work"),
		"--env", "CODEX_ELECTRON_USER_DATA_PATH=" + userData,
		"--args", "--user-data-dir=" + userData,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("open args = %q", got)
	}
	if info, err := os.Stat(userData); err != nil || !info.IsDir() {
		t.Fatalf("user data dir not created: %v", err)
	}
}

func TestLaunchCodexProfileAppRefusesOtherPlatforms(t *testing.T) {
	oldOpen, oldGOOS := codexAppOpen, codexAppGOOS
	codexAppOpen = func([]string) error { t.Fatal("open ran"); return nil }
	codexAppGOOS = "linux"
	t.Cleanup(func() { codexAppOpen, codexAppGOOS = oldOpen, oldGOOS })
	if err := LaunchCodexProfileApp(t.TempDir(), "work"); !errors.Is(err, ErrCodexAppUnsupported) {
		t.Fatalf("err = %v", err)
	}
}

// The app config carries the profile's bearer token, so removing the route
// must remove it too.
func TestResetProfileRemovesAppConfig(t *testing.T) {
	root := t.TempDir()
	writeProfileConfig(t, root, "work", `model_provider = "anypick"
[model_providers.anypick]
experimental_bearer_token = "secret"
`)
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	a := &codexAdapter{home: t.TempDir(), root: root}
	if err := a.ResetProfile("work"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(CodexProfileAppConfigPath(root, "work")); !os.IsNotExist(err) {
		t.Fatalf("app config left behind: %v", err)
	}
	if !strings.Contains(strings.Join(CodexProfilePaths("", root, "work"), "\n"), CodexProfileAppConfigPath(root, "work")) {
		t.Fatal("recovery does not snapshot the app config")
	}
}
