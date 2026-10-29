package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/outof0/anypick/go/internal/atomicfile"
)

// codexAppGlobalStateFile is where the Codex desktop app keeps its UI state
// (sidebar projects, onboarding progress) inside CODEX_HOME.
const codexAppGlobalStateFile = ".codex-global-state.json"

// codexAppSharedStateKeys are the main app's global-state keys a profile
// window starts from: which projects are open, in what order, which one is
// selected and pinned, and which one-time local data migrations already ran
// against the shared database, so the profile window does not run them again.
var codexAppSharedStateKeys = []string{
	"project-order", "pinned-project-ids", "selected-project",
	"electron-saved-workspace-roots", "active-workspace-roots",
	"electron-completed-local-data-migration-ids", "electron-local-data-migration-id",
	"remote-project-connection-backfill-completed",
	"electron-remote-control-config-migration-completed",
}

// codexAppHostKeyedStateKeys are migration records the app keys by host,
// "local:<CODEX_HOME>". They are re-keyed to the profile's home, so the
// profile window sees the project migration as done instead of redoing it.
var codexAppHostKeyedStateKeys = []string{
	"app-server-projects-migration-by-host",
	"app-server-project-id-by-legacy-project-id-by-host",
	"app-server-migrated-pinned-thread-ids-by-host",
}

// codexAppOnboardingDone are the onboarding atoms that keep a profile window
// from opening on the welcome questions. The app skips onboarding once
// projectless onboarding is complete; welcome-pending is what shows the
// "which best describes your work" screen.
var codexAppOnboardingDone = map[string]any{
	"electron:onboarding-projectless-completed": true,
	"electron:onboarding-welcome-pending":       false,
}

// CodexMainHomeFor is the CODEX_HOME the user's own Codex app runs on, or ""
// when adapter is not the Codex adapter.
func CodexMainHomeFor(adapter Adapter) string {
	if a, ok := adapter.(*codexAdapter); ok {
		return codexHomePath(a.home)
	}
	return ""
}

// ShareCodexMainState makes a profile window open where the main Codex app
// is: the same projects and sessions, without onboarding.
//
// Projects and the session list live in state_5.sqlite, which the app looks
// for in sqlite_home (default CODEX_HOME). Pointing the profile's sqlite_home
// at the main home shares both; each session row carries the absolute path of
// its rollout file, so either window can list and open the other's sessions.
// The sidebar's order, selection and pins, and the onboarding progress, are
// in .codex-global-state.json, which is copied by key.
//
// The global state is copied only when the instance is not running: a running
// instance rewrites that file from memory and would undo the copy. The config
// is always written; the app reads it at its next start.
func ShareCodexMainState(root, name, mainHome string, running bool) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	if mainHome == "" {
		return nil
	}
	if dbHome := codexMainSQLiteHome(mainHome); dbHome != "" {
		if err := setCodexAppSQLiteHome(CodexProfileAppConfigPath(root, name), dbHome); err != nil {
			return err
		}
	}
	if running {
		return nil
	}
	return seedCodexAppGlobalState(mainHome, CodexProfileHomePath(root, name))
}

// codexMainSQLiteHome is where the main app keeps state_N.sqlite: the
// CODEX_SQLITE_HOME override, the main config's sqlite_home, or CODEX_HOME
// itself, as Codex resolves it. It is "" when no state database is there
// yet, so a profile window never creates one in the user's real home.
func codexMainSQLiteHome(mainHome string) string {
	dir := os.Getenv("CODEX_SQLITE_HOME")
	if dir == "" {
		dir = mainHome
		if raw, err := os.ReadFile(filepath.Join(mainHome, "config.toml")); err == nil {
			main := map[string]any{}
			if toml.Unmarshal(raw, &main) == nil {
				if v, _ := main["sqlite_home"].(string); v != "" {
					dir = v
				}
			}
		}
	}
	if rest, ok := strings.CutPrefix(dir, "~/"); ok {
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, rest)
		}
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "state_*.sqlite")); len(matches) == 0 {
		return ""
	}
	return dir
}

func setCodexAppSQLiteHome(path, mainHome string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	app := map[string]any{}
	if err := toml.Unmarshal(raw, &app); err != nil {
		return fmt.Errorf("read codex app config %s: %w", path, err)
	}
	app["sqlite_home"] = mainHome
	out, err := toml.Marshal(app)
	if err != nil {
		return fmt.Errorf("encode codex app config: %w", err)
	}
	return atomicfile.Write(path, out, 0o600)
}

// seedCodexAppGlobalState is best-effort: the app rewrites its state file
// while it runs, so a main file caught half-written (or a profile file the
// app left unreadable) skips the copy rather than refusing to open the window.
func seedCodexAppGlobalState(mainHome, profileHome string) error {
	main := map[string]any{}
	if readJSONIfExists(filepath.Join(mainHome, codexAppGlobalStateFile), &main) != nil {
		return nil
	}
	path := filepath.Join(profileHome, codexAppGlobalStateFile)
	state := map[string]any{}
	if readJSONIfExists(path, &state) != nil {
		return nil
	}
	for _, key := range codexAppSharedStateKeys {
		if v, ok := main[key]; ok {
			state[key] = v
		}
	}
	profileHost := "local:" + profileHome
	for _, key := range codexAppHostKeyedStateKeys {
		byHost, _ := main[key].(map[string]any)
		if v, ok := codexHostEntry(byHost, mainHome); ok {
			state[key] = map[string]any{profileHost: v}
		}
	}
	atoms, _ := state["electron-persisted-atom-state"].(map[string]any)
	if atoms == nil {
		atoms = map[string]any{}
	}
	for k, v := range codexAppOnboardingDone {
		atoms[k] = v
	}
	state["electron-persisted-atom-state"] = atoms

	out, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := atomicfile.Write(path, out, 0o600); err != nil {
		return err
	}
	// The app keeps a .bak beside the file; a stale one must not be what it
	// falls back to.
	if err := os.Remove(path + ".bak"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// codexHostEntry finds the main home's entry in a map the app keys by
// "local:<CODEX_HOME>". The app writes the path as it resolved it, which can
// differ from ours by a symlink or by case on a case-insensitive disk; a miss
// would make the profile window redo the projects migration on the shared
// database.
func codexHostEntry(byHost map[string]any, mainHome string) (any, bool) {
	if v, ok := byHost["local:"+mainHome]; ok {
		return v, true
	}
	want := canonicalPath(mainHome)
	for key, v := range byHost {
		if path, ok := strings.CutPrefix(key, "local:"); ok && strings.EqualFold(canonicalPath(path), want) {
			return v, true
		}
	}
	return nil, false
}

func canonicalPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return filepath.Clean(path)
}

func readJSONIfExists(path string, into *map[string]any) error {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	// UseNumber keeps large integers in the app's state exact when it is
	// written back.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(into); err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	return nil
}

// codexSessionDirs hold a CODEX_HOME's conversation files (rollouts). They
// carry no credentials.
var codexSessionDirs = map[string]bool{"sessions": true, "archived_sessions": true}

// codexProfileSharesMainSessions reports whether the profile's sessions are
// listed in the main app's database: its app config, which the CLI in that
// CODEX_HOME reads too, points sqlite_home elsewhere.
func codexProfileSharesMainSessions(root, name string) bool {
	raw, err := os.ReadFile(CodexProfileAppConfigPath(root, name))
	if err != nil {
		return false
	}
	app := map[string]any{}
	if toml.Unmarshal(raw, &app) != nil {
		return false
	}
	home, _ := app["sqlite_home"].(string)
	return home != ""
}

// removeCodexHomeKeepingSessions purges a profile home but leaves its session
// files. The main app's database lists those sessions by absolute path, so
// deleting them would leave the user's own Codex app showing conversations
// that no longer open. Everything that can hold a credential goes.
func removeCodexHomeKeepingSessions(home string) error {
	entries, err := os.ReadDir(home)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && codexSessionDirs[entry.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(home, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}
