package client

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
)

// codexAppBundleID names the Codex desktop app. It ships inside ChatGPT.app,
// so a bundle path would be wrong on one install or the other.
const codexAppBundleID = "com.openai.codex"

// codexAppRouteKeys are the root keys a profile's route owns in the app's
// config.toml. Everything else in that file belongs to the app. A key copied
// from the profile must be listed here, or removing it from the profile would
// leave the old value in the app config for good.
var codexAppRouteKeys = []string{"model", "model_provider", "model_catalog_json", "model_reasoning_effort", "sqlite_home"}

// CodexProfileAppConfigPath is config.toml in the profile's CODEX_HOME. The
// CLI reads <name>.config.toml through --profile; the desktop app has no
// profile option and reads only config.toml, so a profile opened in the app
// needs both.
func CodexProfileAppConfigPath(root, name string) string {
	return filepath.Join(CodexProfileHomePath(root, name), "config.toml")
}

// CodexProfileAppUserDataPath is the app instance's own Electron user data.
// Electron allows one running instance per user data directory, so a shared
// one would hand the profile's window to the instance already open.
func CodexProfileAppUserDataPath(root, name string) string {
	if root == "" {
		root = anyPickRootFallback()
	}
	return filepath.Join(root, "clients", "codex", "profiles", name, "app-user-data")
}

// WriteCodexProfileAppConfig copies the profile's route from its CLI file into
// the config.toml the desktop app reads. env_key is dropped: the app is
// started by LaunchServices, which never sees the profile's env file, and
// Codex fails a turn on a missing env_key even when the provider also carries
// experimental_bearer_token. The app rewrites this file itself (adding
// plugins and dropping comments), so the route is merged by key rather than
// kept inside AnyPick's marker block.
func WriteCodexProfileAppConfig(root, name string) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	profilePath := CodexProfileConfigPathForRoot(root, name)
	raw, err := os.ReadFile(profilePath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("codex profile %s has no config at %s", name, profilePath)
		}
		return err
	}
	profile := map[string]any{}
	if err := toml.Unmarshal(raw, &profile); err != nil {
		return fmt.Errorf("read codex profile config %s: %w", profilePath, err)
	}

	appPath := CodexProfileAppConfigPath(root, name)
	app := map[string]any{}
	if existing, err := os.ReadFile(appPath); err == nil {
		if err := toml.Unmarshal(existing, &app); err != nil {
			return fmt.Errorf("read codex app config %s: %w", appPath, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	removeCodexAppRoute(app)
	for _, key := range codexAppRouteKeys {
		if v, ok := profile[key]; ok {
			app[key] = v
		}
	}
	if providers, ok := profile["model_providers"].(map[string]any); ok {
		if anypick, ok := providers["anypick"].(map[string]any); ok {
			provider := make(map[string]any, len(anypick))
			for k, v := range anypick {
				if k != "env_key" {
					provider[k] = v
				}
			}
			appProviders, _ := app["model_providers"].(map[string]any)
			if appProviders == nil {
				appProviders = map[string]any{}
			}
			appProviders["anypick"] = provider
			app["model_providers"] = appProviders
		}
	}

	out, err := toml.Marshal(app)
	if err != nil {
		return fmt.Errorf("encode codex app config: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(appPath), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(appPath, out, 0o600)
}

// removeCodexAppRoute drops the keys a previous route wrote, so a profile
// re-pointed from a proxy to a native account does not keep the old provider.
func removeCodexAppRoute(app map[string]any) {
	for _, key := range codexAppRouteKeys {
		delete(app, key)
	}
	if providers, ok := app["model_providers"].(map[string]any); ok {
		delete(providers, "anypick")
		if len(providers) == 0 {
			delete(app, "model_providers")
		}
	}
}

// codexAppOpen runs /usr/bin/open; tests replace it.
var codexAppOpen = func(args []string) error {
	out, err := exec.Command("/usr/bin/open", args...).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

// codexAppGOOS is runtime.GOOS; tests replace it.
var codexAppGOOS = runtime.GOOS

// SetCodexAppOpenForTest replaces the open(1) call with fn and returns a
// restore function, so other packages' tests can open a profile without
// launching the app.
func SetCodexAppOpenForTest(fn func(args []string) error) func() {
	old := codexAppOpen
	codexAppOpen = fn
	return func() { codexAppOpen = old }
}

// SetCodexAppPlatformForTest makes CodexProfileAppSupported answer for goos
// and returns a restore function. Other packages' tests use it to reach the
// unsupported-platform path on a Mac.
func SetCodexAppPlatformForTest(goos string) func() {
	old := codexAppGOOS
	codexAppGOOS = goos
	return func() { codexAppGOOS = old }
}

// ErrCodexAppUnsupported reports a platform without the Codex desktop app
// launch path. Only macOS's open(1) can pass a per-instance environment.
var ErrCodexAppUnsupported = fmt.Errorf("opening a Codex profile in the Codex app is supported only on macOS")

// CodexProfileAppSupported reports whether this machine can open a profile
// in the Codex desktop app.
func CodexProfileAppSupported() bool { return codexAppGOOS == "darwin" }

// LaunchCodexProfileApp starts a separate Codex app instance on the profile's
// CODEX_HOME. CODEX_ELECTRON_USER_DATA_PATH is what makes the app keep the
// CODEX_HOME it was given: without it the app replaces its environment with
// the login shell's, and the instance reads ~/.codex instead. The app's own
// demo-build launcher starts its second instance the same way.
func LaunchCodexProfileApp(root, name string) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	if !CodexProfileAppSupported() {
		return ErrCodexAppUnsupported
	}
	home := CodexProfileHomePath(root, name)
	userData := CodexProfileAppUserDataPath(root, name)
	if err := os.MkdirAll(userData, 0o700); err != nil {
		return err
	}
	if err := MarkCodexProfileAppStarting(root, name); err != nil {
		return err
	}
	marker := filepath.Join(userData, codexAppLaunchMarker)
	err := codexAppOpen([]string{
		"-n", "-b", codexAppBundleID,
		"--env", "CODEX_HOME=" + home,
		"--env", "CODEX_ELECTRON_USER_DATA_PATH=" + userData,
		"--args", "--user-data-dir=" + userData,
	})
	if err != nil {
		// Nothing is starting, so the grace period must not block a removal.
		_ = os.Remove(marker)
	}
	return err
}

// codexAppLaunchGrace covers the gap between open(1) returning and the new
// instance creating its singleton socket, during which a removal would
// otherwise see no instance at all.
const codexAppLaunchGrace = 30 * time.Second

// codexAppLaunchMarker is written into the instance's user data directory
// just before the launch; its age is what the grace period is measured from.
const codexAppLaunchMarker = "anypick-launch"

// MarkCodexProfileAppStarting makes the profile count as open for the launch
// grace period. OpenCodexProfileApp calls it inside the profile's mutation
// lock, so a removal that takes the lock after the app config is written
// already sees the instance as starting.
func MarkCodexProfileAppStarting(root, name string) error {
	userData := CodexProfileAppUserDataPath(root, name)
	if err := os.MkdirAll(userData, 0o700); err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(userData, codexAppLaunchMarker), nil, 0o600)
}

// CodexProfileAppRunning reports whether a Codex app instance runs, or is
// starting, on the profile. Electron's single-instance check is a
// SingletonSocket symlink in the user data directory pointing at a Unix
// socket the running instance listens on; connecting is the same liveness
// test Chromium itself uses. It is preferred over the SingletonLock
// "<hostname>-<pid>" target, which a crash leaves behind for a pid that may
// be reused and which stops matching when the Mac's hostname changes.
func CodexProfileAppRunning(root, name string) bool {
	userData := CodexProfileAppUserDataPath(root, name)
	// A marker from the future (the clock stepped back) is stale, not open.
	if info, err := os.Stat(filepath.Join(userData, codexAppLaunchMarker)); err == nil {
		if age := time.Since(info.ModTime()); age >= 0 && age < codexAppLaunchGrace {
			return true
		}
	}
	// The link's target, not the link, is dialled: a socket path is limited
	// to about 104 bytes, and the target sits in the short system temp dir.
	target, err := os.Readlink(filepath.Join(userData, "SingletonSocket"))
	if err != nil {
		return false
	}
	conn, err := net.DialTimeout("unix", target, time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// errCodexProfileAppRunning refuses to remove a profile whose app instance is
// open: the instance rewrites config.toml (with the route's bearer token) and
// refreshes auth.json in CODEX_HOME, so it would recreate them in a directory
// nothing tracks any more.
func errCodexProfileAppRunning(name string) error {
	return anyerr.Newf(
		"Codex profile "+name+" is open in the Codex app.",
		"CODEX_APP_RUNNING", anyerr.WithExitCode(anyerr.CapabilityConflict),
		anyerr.WithSuggestions("Quit that Codex app window, then try again. A window opened in the last 30 seconds counts as open while it starts."))
}
