package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func readGlobalState(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	state := map[string]any{}
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

// newMainHome is a main CODEX_HOME whose app has created its state database.
func newMainHome(t *testing.T) string {
	t.Helper()
	t.Setenv("CODEX_SQLITE_HOME", "")
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "state_5.sqlite"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A profile window opens on the main app's projects and sessions, without
// onboarding, and keeps the state it already had of its own.
func TestShareCodexMainStateSharesProjectsAndSkipsOnboarding(t *testing.T) {
	root, mainHome := t.TempDir(), newMainHome(t)
	writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	profileHome := CodexProfileHomePath(root, "work")
	writeJSON(t, filepath.Join(mainHome, codexAppGlobalStateFile), map[string]any{
		"project-order":                  []any{"p1", "p2"},
		"selected-project":               map[string]any{"type": "local", "projectId": "p2"},
		"prompt-history":                 []any{"private prompt"},
		"electron-saved-workspace-roots": []any{"/src/a"},
		"app-server-projects-migration-by-host": map[string]any{
			"local:" + mainHome: map[string]any{"projectsMigrated": true},
			"local:/elsewhere":  map[string]any{"projectsMigrated": false},
		},
		"electron-persisted-atom-state": map[string]any{
			"electron:onboarding-welcome-pending": true,
			"composer-prompt-drafts-v1":           "draft",
		},
	})
	statePath := filepath.Join(profileHome, codexAppGlobalStateFile)
	writeJSON(t, statePath, map[string]any{
		"electron-main-window-bounds":   map[string]any{"width": 900.0},
		"electron-persisted-atom-state": map[string]any{"diff-filter": "all"},
	})
	if err := os.WriteFile(statePath+".bak", []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ShareCodexMainState(root, "work", mainHome, false); err != nil {
		t.Fatal(err)
	}
	if doc := readAppConfig(t, root, "work"); doc["sqlite_home"] != mainHome {
		t.Fatalf("sqlite_home = %v", doc["sqlite_home"])
	}
	state := readGlobalState(t, statePath)
	if !reflect.DeepEqual(state["project-order"], []any{"p1", "p2"}) ||
		!reflect.DeepEqual(state["electron-saved-workspace-roots"], []any{"/src/a"}) ||
		state["selected-project"].(map[string]any)["projectId"] != "p2" {
		t.Fatalf("projects not shared: %v", state)
	}
	if _, ok := state["prompt-history"]; ok {
		t.Fatal("copied state beyond projects")
	}
	migration := state["app-server-projects-migration-by-host"].(map[string]any)
	if len(migration) != 1 || migration["local:"+profileHome] == nil {
		t.Fatalf("migration not re-keyed to the profile home: %v", migration)
	}
	atoms := state["electron-persisted-atom-state"].(map[string]any)
	if atoms["electron:onboarding-welcome-pending"] != false ||
		atoms["electron:onboarding-projectless-completed"] != true {
		t.Fatalf("onboarding not skipped: %v", atoms)
	}
	if atoms["diff-filter"] != "all" || atoms["composer-prompt-drafts-v1"] != nil {
		t.Fatalf("profile atoms lost, or main atoms copied: %v", atoms)
	}
	if state["electron-main-window-bounds"] == nil {
		t.Fatal("profile's own state lost")
	}
	if _, err := os.Stat(statePath + ".bak"); !os.IsNotExist(err) {
		t.Fatalf("stale .bak kept: %v", err)
	}
}

// A running instance rewrites its global state from memory, so only the
// config, which it reads at its next start, is written.
func TestShareCodexMainStateLeavesARunningWindowsStateAlone(t *testing.T) {
	root, mainHome := t.TempDir(), newMainHome(t)
	writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(mainHome, codexAppGlobalStateFile), map[string]any{"project-order": []any{"p1"}})
	if err := ShareCodexMainState(root, "work", mainHome, true); err != nil {
		t.Fatal(err)
	}
	if doc := readAppConfig(t, root, "work"); doc["sqlite_home"] != mainHome {
		t.Fatalf("sqlite_home = %v", doc["sqlite_home"])
	}
	if _, err := os.Stat(filepath.Join(CodexProfileHomePath(root, "work"), codexAppGlobalStateFile)); !os.IsNotExist(err) {
		t.Fatalf("wrote a running window's state: %v", err)
	}
}

// Rewriting the route clears sqlite_home with it, so a profile never keeps
// pointing at a home it was not given this time.
func TestWriteCodexProfileAppConfigClearsSQLiteHome(t *testing.T) {
	root, mainHome := t.TempDir(), newMainHome(t)
	writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	if err := ShareCodexMainState(root, "work", mainHome, true); err != nil {
		t.Fatal(err)
	}
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	if doc := readAppConfig(t, root, "work"); doc["sqlite_home"] != nil {
		t.Fatalf("sqlite_home kept: %v", doc["sqlite_home"])
	}
}

// The profile window uses the database the main app uses, and never creates
// one in a home whose app has not.
func TestShareCodexMainStateFollowsTheMainDatabase(t *testing.T) {
	setup := func(t *testing.T) (string, string) {
		root := t.TempDir()
		writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
		if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
			t.Fatal(err)
		}
		return root, t.TempDir()
	}
	t.Run("no database yet", func(t *testing.T) {
		t.Setenv("CODEX_SQLITE_HOME", "")
		root, mainHome := setup(t)
		if err := ShareCodexMainState(root, "work", mainHome, true); err != nil {
			t.Fatal(err)
		}
		if doc := readAppConfig(t, root, "work"); doc["sqlite_home"] != nil {
			t.Fatalf("pointed at a home with no database: %v", doc["sqlite_home"])
		}
	})
	t.Run("main config sqlite_home", func(t *testing.T) {
		t.Setenv("CODEX_SQLITE_HOME", "")
		root, mainHome := setup(t)
		db := t.TempDir()
		if err := os.WriteFile(filepath.Join(db, "state_5.sqlite"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(mainHome, "config.toml"), []byte("sqlite_home = '"+db+"'\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := ShareCodexMainState(root, "work", mainHome, true); err != nil {
			t.Fatal(err)
		}
		if doc := readAppConfig(t, root, "work"); doc["sqlite_home"] != db {
			t.Fatalf("sqlite_home = %v, want %s", doc["sqlite_home"], db)
		}
	})
	t.Run("CODEX_SQLITE_HOME", func(t *testing.T) {
		root, mainHome := setup(t)
		db := t.TempDir()
		if err := os.WriteFile(filepath.Join(db, "state_6.sqlite"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CODEX_SQLITE_HOME", db)
		if err := ShareCodexMainState(root, "work", mainHome, true); err != nil {
			t.Fatal(err)
		}
		if doc := readAppConfig(t, root, "work"); doc["sqlite_home"] != db {
			t.Fatalf("sqlite_home = %v, want %s", doc["sqlite_home"], db)
		}
	})
}

// The app's state file is rewritten while it runs; one caught half-written
// skips the copy instead of refusing to open the window.
func TestShareCodexMainStateSkipsAnUnreadableMainState(t *testing.T) {
	root, mainHome := t.TempDir(), newMainHome(t)
	writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mainHome, codexAppGlobalStateFile), []byte(`{"project-or`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ShareCodexMainState(root, "work", mainHome, false); err != nil {
		t.Fatalf("half-written main state failed the open: %v", err)
	}
}

// The app keys migration records by the home path as it resolved it; a
// symlinked home must still match, or the profile window redoes the projects
// migration on the shared database.
func TestShareCodexMainStateMatchesTheHostThroughASymlink(t *testing.T) {
	root, realHome := t.TempDir(), newMainHome(t)
	linkHome := filepath.Join(t.TempDir(), "codex")
	if err := os.Symlink(realHome, linkHome); err != nil {
		t.Skip(err)
	}
	writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
	if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(realHome, codexAppGlobalStateFile), map[string]any{
		"app-server-projects-migration-by-host": map[string]any{
			"local:" + realHome: map[string]any{"projectsMigrated": true},
		},
	})
	if err := ShareCodexMainState(root, "work", linkHome, false); err != nil {
		t.Fatal(err)
	}
	state := readGlobalState(t, filepath.Join(CodexProfileHomePath(root, "work"), codexAppGlobalStateFile))
	if state["app-server-projects-migration-by-host"] == nil {
		t.Fatalf("migration record missed through the symlink: %v", state)
	}
}

// The main app lists a shared profile's sessions by absolute path, so purging
// the profile (its account was deleted) removes the credentials but keeps the
// conversations. A profile that never shared keeps the old full purge.
func TestRemoveProfileFilesKeepsSharedSessions(t *testing.T) {
	for _, shared := range []bool{true, false} {
		root, mainHome := t.TempDir(), newMainHome(t)
		writeProfileConfig(t, root, "work", "model_provider = \"anypick\"\n")
		if err := WriteCodexProfileAppConfig(root, "work"); err != nil {
			t.Fatal(err)
		}
		if shared {
			if err := ShareCodexMainState(root, "work", mainHome, true); err != nil {
				t.Fatal(err)
			}
		}
		home := CodexProfileHomePath(root, "work")
		rollout := filepath.Join(home, "sessions", "2026", "rollout.jsonl")
		if err := os.MkdirAll(filepath.Dir(rollout), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(rollout, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"tokens":{}}`), 0o600); err != nil {
			t.Fatal(err)
		}

		a := &codexAdapter{home: t.TempDir(), root: root}
		if err := a.RemoveProfileFiles("work"); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
			t.Fatalf("shared=%v: credential kept: %v", shared, err)
		}
		_, err := os.Stat(rollout)
		if shared && err != nil {
			t.Fatalf("shared session deleted: %v", err)
		}
		if !shared && !os.IsNotExist(err) {
			t.Fatalf("unshared profile home kept: %v", err)
		}
	}
}
