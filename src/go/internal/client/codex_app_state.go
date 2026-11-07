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

// codexAppSeededFile records, per merged key, the ids the last seed copied
// from the main app. It is AnyPick's own file, so the app never rewrites it.
const codexAppSeededFile = "anypick-seeded-state.json"

// codexAppSharedStateKeys are the main app's global-state keys a profile
// window starts from: which projects are open, in what order, which one is
// selected and pinned, and which one-time local data migrations already ran
// against the shared database, so the profile window does not run them again.
var codexAppSharedStateKeys = []string{
	"selected-project",
	"electron-saved-workspace-roots", "active-workspace-roots",
	"electron-completed-local-data-migration-ids", "electron-local-data-migration-id",
	"remote-project-connection-backfill-completed",
	"electron-remote-control-config-migration-completed",
}

// codexAppMergedStateKeys are collections the app keys by project or thread
// id: the project list itself (local-projects) and which thread belongs to
// which project. The main app's entries are merged in, and entries only the
// profile window has (a project opened there) are kept, so neither side's
// projects drop out of the sidebar. An entry an earlier seed copied from the
// main app is dropped once the main app no longer has it.
var codexAppMergedStateKeys = []string{
	"local-projects", "project-order", "project-appearances", "pinned-project-ids",
	"thread-project-assignments", "thread-project-membership-host-ids",
	"thread-workspace-root-hints", "thread-projectless-output-directories",
	"projectless-thread-ids", "sidebar-project-thread-orders",
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
	seededPath := filepath.Join(profileHome, codexAppSeededFile)
	seeded := map[string]any{}
	_ = readJSONIfExists(seededPath, &seeded) // unreadable reads as never seeded
	next, pending := mergeCodexAppProjects(main, state, seeded)
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

	// The record is written first with this round's ids and the earlier ones
	// together, so a failed state write cannot leave copied ids unrecorded
	// (they would then read as the profile's own and never leave). Over-
	// recording only drops ids the main app no longer has. The exact record
	// replaces it once the state is written.
	if err := writeCodexSeeded(seededPath, pending); err != nil {
		return err
	}
	out, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := atomicfile.Write(path, out, 0o600); err != nil {
		return err
	}
	if err := writeCodexSeeded(seededPath, next); err != nil {
		return err
	}
	// The app keeps a .bak beside the file; a stale one must not be what it
	// falls back to.
	if err := os.Remove(path + ".bak"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// mergeCodexStateValue merges a main-app collection with the profile's: for
// a map the main app's entry wins on a shared key, for a list the main app's
// order comes first and the profile's extra items follow. A profile entry
// whose id is in copied (put there by an earlier seed) is dropped: the main
// app has since removed it. Any other shape, or two different shapes, takes
// the main app's value; the lists the app keeps here hold string ids only.
func mergeCodexStateValue(main, profile any, copied map[string]bool) any {
	switch m := main.(type) {
	case map[string]any:
		p, ok := profile.(map[string]any)
		if !ok {
			return m
		}
		out := make(map[string]any, len(m)+len(p))
		for k, v := range p {
			if !copied[k] {
				out[k] = v
			}
		}
		for k, v := range m {
			out[k] = v
		}
		return out
	case []any:
		p, ok := profile.([]any)
		if !ok {
			return m
		}
		out := append([]any(nil), m...)
		seen := stringSet(m)
		for _, v := range p {
			if s, ok := v.(string); ok && !seen[s] && !copied[s] {
				seen[s] = true
				out = append(out, v)
			}
		}
		return out
	}
	return main
}

// mergeCodexAppProjects merges the main app's project collections into the
// profile state and returns two records of the ids copied from main: next is
// this round's exact set, pending adds the earlier copied ids to it.
func mergeCodexAppProjects(main, state, seeded map[string]any) (next, pending map[string]any) {
	own := codexProfileOwnProjects(main, state)
	next = make(map[string]any, len(codexAppMergedStateKeys))
	pending = make(map[string]any, len(codexAppMergedStateKeys))
	for _, key := range codexAppMergedStateKeys {
		v, ok := main[key]
		if !ok {
			// Nothing to merge this round; the earlier record still says
			// which profile ids came from the main app.
			if prev, recorded := seeded[key]; recorded {
				next[key], pending[key] = prev, prev
			}
			continue
		}
		copied := stringSet(seeded[key])
		if _, recorded := seeded[key]; !recorded && codexAppFormerlyCopiedKeys[key] {
			copied = codexIDsExcept(state[key], own)
		}
		state[key] = mergeCodexStateValue(v, state[key], copied)
		next[key] = codexStateIDs(v)
		pending[key] = codexStateIDs(v)
		for id := range copied {
			pending[key] = append(pending[key].([]any), id)
		}
	}
	return next, pending
}

// codexAppFormerlyCopiedKeys were copied wholesale before the seeded record
// existed (1.2.0). With no record yet, their ids in the profile came from the
// main app, except projects only the profile has.
var codexAppFormerlyCopiedKeys = map[string]bool{"project-order": true, "pinned-project-ids": true}

// codexProfileOwnProjects are the project ids in the profile's local-projects
// that the main app does not have: projects opened in the profile window.
func codexProfileOwnProjects(main, profile map[string]any) map[string]bool {
	mainProjects, _ := main["local-projects"].(map[string]any)
	profileProjects, _ := profile["local-projects"].(map[string]any)
	own := map[string]bool{}
	for id := range profileProjects {
		if _, shared := mainProjects[id]; !shared {
			own[id] = true
		}
	}
	return own
}

func codexIDsExcept(v any, keep map[string]bool) map[string]bool {
	out := map[string]bool{}
	for _, id := range codexStateIDs(v) {
		if s := id.(string); !keep[s] {
			out[s] = true
		}
	}
	return out
}

func writeCodexSeeded(path string, seeded map[string]any) error {
	out, err := json.Marshal(seeded)
	if err != nil {
		return err
	}
	return atomicfile.Write(path, out, 0o600)
}

// codexStateIDs lists the ids a collection holds: a map's keys or a list's
// strings.
func codexStateIDs(v any) []any {
	var ids []any
	switch c := v.(type) {
	case map[string]any:
		for k := range c {
			ids = append(ids, k)
		}
	case []any:
		for _, item := range c {
			if s, ok := item.(string); ok {
				ids = append(ids, s)
			}
		}
	}
	return ids
}

func stringSet(v any) map[string]bool {
	list, _ := v.([]any)
	set := make(map[string]bool, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			set[s] = true
		}
	}
	return set
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
