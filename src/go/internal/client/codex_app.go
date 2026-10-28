package client

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/outof0/anypick/go/internal/atomicfile"
)

// codexAppBundleID names the Codex desktop app. It ships inside ChatGPT.app,
// so a bundle path would be wrong on one install or the other.
const codexAppBundleID = "com.openai.codex"

// codexAppRouteKeys are the root keys a profile's route owns in the app's
// config.toml. Everything else in that file belongs to the app.
var codexAppRouteKeys = []string{"model", "model_provider", "model_catalog_json"}

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
	if v, ok := profile["model_reasoning_effort"]; ok {
		app["model_reasoning_effort"] = v
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
	return codexAppOpen([]string{
		"-n", "-b", codexAppBundleID,
		"--env", "CODEX_HOME=" + home,
		"--env", "CODEX_ELECTRON_USER_DATA_PATH=" + userData,
		"--args", "--user-data-dir=" + userData,
	})
}
