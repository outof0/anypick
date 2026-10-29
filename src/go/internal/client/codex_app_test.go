package client

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

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

// model_reasoning_effort is copied with the route, so removing it from the
// profile must remove it from the app config too.
func TestWriteCodexProfileAppConfigClearsRemovedReasoningEffort(t *testing.T) {
	root := t.TempDir()
	writeProfileConfig(t, root, "work", "model = \"gpt-5\"\nmodel_reasoning_effort = \"high\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	if doc := readAppConfig(t, root, "work"); doc["model_reasoning_effort"] != "high" {
		t.Fatalf("reasoning effort not copied: %v", doc)
	}
	writeProfileConfig(t, root, "work", "model = \"gpt-5\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	if doc := readAppConfig(t, root, "work"); doc["model_reasoning_effort"] != nil {
		t.Fatalf("stale reasoning effort kept: %v", doc)
	}
}

// listenSingletonSocket stands in for a running instance: a Unix socket in a
// short temp dir (socket paths are limited to about 104 bytes) and the
// SingletonSocket link Electron puts in the user data directory.
func listenSingletonSocket(t *testing.T, root, name string) net.Listener {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the Codex app instance check is macOS-only")
	}
	sockDir, err := os.MkdirTemp("", "cx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "SingletonSocket")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	userData := CodexProfileAppUserDataPath(root, name)
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sock, filepath.Join(userData, "SingletonSocket")); err != nil {
		t.Fatal(err)
	}
	return ln
}

// A running instance would recreate the token-bearing config.toml in a
// directory nothing tracks, so removal waits for it to quit. Whatever a
// crash leaves behind (a socket link with no listener, an old launch
// marker) must not block removal.
func TestResetProfileRefusesWhileAppInstanceRuns(t *testing.T) {
	for _, tc := range []struct {
		name    string
		setup   func(t *testing.T, root string)
		refused bool
	}{
		{"listening instance", func(t *testing.T, root string) { listenSingletonSocket(t, root, "work") }, true},
		{"crashed instance", func(t *testing.T, root string) {
			// A crash leaves the socket file with nothing listening on it.
			ln := listenSingletonSocket(t, root, "work").(*net.UnixListener)
			ln.SetUnlinkOnClose(false)
			ln.Close()
		}, false},
		{"instance starting", func(t *testing.T, root string) { writeLaunchMarker(t, root, "work", 0) }, true},
		{"old launch marker", func(t *testing.T, root string) { writeLaunchMarker(t, root, "work", -time.Minute) }, false},
		{"launch marker from the future", func(t *testing.T, root string) { writeLaunchMarker(t, root, "work", time.Hour) }, false},
		{"never opened", func(*testing.T, string) {}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
			if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
				t.Fatal(err)
			}
			tc.setup(t, root)
			a := &codexAdapter{home: t.TempDir(), root: root}
			err := a.ResetProfile("work")
			_, statErr := os.Stat(CodexProfileAppConfigPath(root, "work"))
			if !tc.refused {
				if err != nil || !os.IsNotExist(statErr) {
					t.Fatalf("err = %v, app config = %v", err, statErr)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "open in the Codex app") {
				t.Fatalf("err = %v", err)
			}
			if statErr != nil {
				t.Fatal("refused reset still removed the app config")
			}
			if err := a.RemoveProfileFiles("work"); err == nil {
				t.Fatal("purge ran with the instance open")
			}
		})
	}
}

func writeLaunchMarker(t *testing.T, root, name string, age time.Duration) {
	t.Helper()
	userData := CodexProfileAppUserDataPath(root, name)
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(userData, codexAppLaunchMarker)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(age)
	if err := os.Chtimes(marker, when, when); err != nil {
		t.Fatal(err)
	}
}

// A failed launch starts nothing, so it must not leave the marker that makes
// a removal wait out the grace period.
func TestLaunchCodexProfileAppMarksOnlyASuccessfulLaunch(t *testing.T) {
	oldOpen, oldGOOS := codexAppOpen, codexAppGOOS
	t.Cleanup(func() { codexAppOpen, codexAppGOOS = oldOpen, oldGOOS })
	codexAppGOOS = "darwin"
	root := t.TempDir()

	codexAppOpen = func([]string) error { return errors.New("no app") }
	if err := LaunchCodexProfileApp(root, "work"); err == nil {
		t.Fatal("launch error swallowed")
	}
	if CodexProfileAppRunning(root, "work") {
		t.Fatal("failed launch left the profile looking open")
	}
	codexAppOpen = func([]string) error { return nil }
	if err := LaunchCodexProfileApp(root, "work"); err != nil {
		t.Fatal(err)
	}
	if !CodexProfileAppRunning(root, "work") {
		t.Fatal("a starting instance does not count as open")
	}
}

// The terminal gets a script that runs the launch command in the login shell
// (where `codex` is on PATH); the script is the user's own and executable.
func TestLaunchCodexProfileTerminalRunsLaunchCommand(t *testing.T) {
	root := t.TempDir()
	var got []string
	oldOpen, oldGOOS := codexAppOpen, codexAppGOOS
	codexAppOpen = func(args []string) error { got = args; return nil }
	codexAppGOOS = "darwin"
	t.Cleanup(func() { codexAppOpen, codexAppGOOS = oldOpen, oldGOOS })

	command := CodexProfileLaunchCommand(root, "work", true)
	if err := LaunchCodexProfileTerminal(root, "work", command); err != nil {
		t.Fatal(err)
	}
	path := CodexProfileTerminalScriptPath(root, "work")
	if !reflect.DeepEqual(got, []string{path}) {
		t.Fatalf("open args = %q", got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "("+command+")") {
		t.Fatalf("script does not run the launch command:\n%s", raw)
	}
	if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("script mode = %v", info.Mode().Perm())
	}

	a := &codexAdapter{home: t.TempDir(), root: root}
	if err := a.ResetProfile("work"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("reset left the terminal script: %v", err)
	}
}

func TestLaunchCodexProfileTerminalRefusesOtherPlatforms(t *testing.T) {
	t.Cleanup(SetCodexAppPlatformForTest("linux"))
	root := t.TempDir()
	if err := LaunchCodexProfileTerminal(root, "work", "codex"); !errors.Is(err, ErrCodexTerminalUnsupported) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(CodexProfileTerminalScriptPath(root, "work")); !os.IsNotExist(err) {
		t.Fatalf("script written on an unsupported platform: %v", err)
	}
}

// The script borrows PATH from the user's own login shell, asking each shell
// family the way it accepts, then runs Codex with it. Stub shells stand in for
// each family: they log how they were asked, print startup and logout noise
// around the answer, and answer with a PATH that holds a stub codex. The
// launch command is the real one, sourcing an env file that exports a secret,
// which must reach codex and not the shell the window continues in.
func TestCodexTerminalScriptUsesTheUsersShellPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the terminal script is macOS-only")
	}
	for _, tc := range []struct {
		shell, wantArgs string
		fromEnv         bool // found through $SHELL, not the account record
		hasCodex        bool
	}{
		{shell: "zsh", wantArgs: "-i -l -c", hasCodex: true},
		{shell: "bash", wantArgs: "-i -l -c", fromEnv: true, hasCodex: true},
		{shell: "fish", wantArgs: "-l -c", hasCodex: true},
		{shell: "tcsh", wantArgs: "-c", hasCodex: true},
		{shell: "ksh", wantArgs: "-l -c", hasCodex: true},
		{shell: "zsh", wantArgs: "-i -l -c"},
	} {
		t.Run(tc.shell, func(t *testing.T) {
			dir, root := t.TempDir(), t.TempDir()
			bin := filepath.Join(dir, "bin")
			if err := os.MkdirAll(bin, 0o700); err != nil {
				t.Fatal(err)
			}
			if tc.hasCodex {
				stub := "#!/bin/sh\necho \"codex-ran secret=$ANYPICK_TEST_SECRET $*\"\n"
				if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(stub), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			envPath := CodexProfileEnvPath(root, "work")
			if err := os.MkdirAll(filepath.Dir(envPath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(envPath, []byte("export ANYPICK_TEST_SECRET=s3cret\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			shell := filepath.Join(dir, tc.shell)
			log := filepath.Join(dir, "args")
			stubShell := "#!/bin/sh\n" +
				"echo \"$*\" >> " + shellQuote(log) + "\n" +
				"echo 'startup noise'\n" +
				"for last; do :; done\n" +
				"PATH=" + shellQuote(bin+":/usr/bin:/bin") + " /bin/sh -c \"$last\"\n" +
				"echo 'bye from logout'\n"
			if err := os.WriteFile(shell, []byte(stubShell), 0o700); err != nil {
				t.Fatal(err)
			}

			script := codexTerminalScript("work", CodexProfileLaunchCommand(root, "work", true))
			lines := strings.Split(script, "\n")
			for i, line := range lines {
				if strings.HasPrefix(line, "user_shell=$(dscl") {
					lines[i] = "user_shell=" + shellQuote(shell)
					if tc.fromEnv {
						lines[i] = "user_shell=/nonexistent"
					}
				}
				if line == `exec "$user_shell" -l` {
					lines[i] = `echo "then $user_shell secret=${ANYPICK_TEST_SECRET:-none}"`
				}
			}
			cmd := exec.Command("/bin/sh", "-c", strings.Join(lines, "\n"))
			cmd.Env = []string{"PATH=/usr/bin:/bin", "SHELL=" + shell}
			out, _ := cmd.CombinedOutput()
			got := string(out)
			asked, _ := os.ReadFile(log)
			if !strings.HasPrefix(string(asked), tc.wantArgs+" printenv PATH") {
				t.Errorf("asked as %q, want %q", asked, tc.wantArgs)
			}
			ran := strings.Contains(got, "codex-ran secret=s3cret --profile work")
			if tc.hasCodex != ran {
				t.Errorf("codex installed: %v, ran: %v\n%s", tc.hasCodex, ran, got)
			}
			if !tc.hasCodex && !strings.Contains(got, "codex is not on the PATH") {
				t.Errorf("missing codex not explained:\n%s", got)
			}
			if !strings.Contains(got, "then "+shell+" secret=none") {
				t.Errorf("window does not continue in the user's shell, or the secret leaked into it:\n%s", got)
			}
		})
	}
}

// With no usable account record and no $SHELL, the script still has a shell.
func TestCodexTerminalScriptFallsBackToZsh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the terminal script is macOS-only")
	}
	var fallback string
	for _, line := range strings.Split(codexTerminalScript("work", "true"), "\n") {
		if strings.HasPrefix(line, `[ -x "$user_shell" ]`) {
			fallback = line
		}
	}
	if fallback == "" {
		t.Fatal("no fallback line in the script")
	}
	cmd := exec.Command("/bin/sh", "-c", "user_shell=/nonexistent\n"+fallback+"\necho \"$user_shell\"")
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != "/bin/zsh" {
		t.Fatalf("fallback = %q (%v)", out, err)
	}
}
