package activation

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/refs"
)

// The app config carries the route's bearer token and is the CLI's base
// config in that CODEX_HOME, so a platform that cannot launch the app must
// fail before writing it. The profile exists, so the write would happen if
// the check came later.
func TestOpenCodexProfileAppRefusesUnsupportedPlatformBeforeWriting(t *testing.T) {
	env := newTestEnv(t)
	env.makeCodexProfile(t, "work", refs.AccountRef("codex", "a"), "auto")
	t.Cleanup(client.SetCodexAppPlatformForTest("linux"))

	err := OpenCodexProfileApp(context.Background(), "work", env.Deps)
	var ae *anyerr.Error
	if !errorsAsAny(err, &ae) || ae.Code != "UNSUPPORTED_PLATFORM" {
		t.Fatalf("err = %v", err)
	}
	if _, statErr := os.Stat(client.CodexProfileAppConfigPath(env.Deps.Root, "work")); !os.IsNotExist(statErr) {
		t.Fatalf("app config written on an unsupported platform: %v", statErr)
	}
}

// One profile open in the Codex app refuses the whole batch before anything
// is removed or stopped, so an account deletion refused on its second profile
// has not already removed the first.
func TestRemoveNamedProfilesRefusesBatchBeforeRemovingAny(t *testing.T) {
	env := newTestEnv(t)
	first := env.makeCodexProfile(t, "first", refs.AccountRef("codex", "a"), "auto")
	env.makeCodexProfile(t, "open", refs.AccountRef("codex", "a"), "auto")
	userData := client.CodexProfileAppUserDataPath(env.Root, "open")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	// A fresh launch marker: the instance counts as open while it starts.
	if err := os.WriteFile(filepath.Join(userData, "anypick-launch"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	removals := []ProfileRemoval{
		{Client: "codex", Name: "first", PurgeCredentials: true},
		{Client: "codex", Name: "open", PurgeCredentials: true},
	}
	stop := func(context.Context) error { t.Fatal("stopped proxies for a refused batch"); return nil }
	err := RemoveNamedProfiles(context.Background(), removals, env.Deps, stop)
	var ae *anyerr.Error
	if !errorsAsAny(err, &ae) || ae.Code != "CODEX_APP_RUNNING" {
		t.Fatalf("err = %v", err)
	}
	for _, name := range []string{"first", "open"} {
		if row, err := env.ClientProfiles.GetContext(context.Background(), "codex", name); err != nil || row == nil {
			t.Fatalf("profile %s removed by a refused batch: %v", name, err)
		}
	}
	if _, err := os.Stat(first.configPath); err != nil {
		t.Fatalf("first profile's files removed by a refused batch: %v", err)
	}
}

// Opening a profile on a Mac writes the route, points the window at the main
// app's database and state, and only then launches it. The main home is the
// Codex adapter's (CODEX_HOME here), never the developer's real one.
func TestOpenCodexProfileAppSharesMainStateBeforeLaunch(t *testing.T) {
	env := newTestEnv(t)
	mainHome := t.TempDir()
	t.Setenv("CODEX_HOME", mainHome)
	t.Setenv("CODEX_SQLITE_HOME", "")
	if err := os.WriteFile(filepath.Join(mainHome, "state_5.sqlite"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	env.makeCodexProfile(t, "work", refs.AccountRef("codex", "a"), "auto")
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	statePath := filepath.Join(client.CodexProfileHomePath(env.Root, "work"), ".codex-global-state.json")
	launched := false
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		// Everything the window reads at start is in place before it starts.
		if _, err := os.Stat(statePath); err != nil {
			t.Errorf("launched before the state was seeded: %v", err)
		}
		launched = true
		return nil
	}))

	if err := OpenCodexProfileApp(context.Background(), "work", env.Deps); err != nil {
		t.Fatal(err)
	}
	if !launched {
		t.Fatal("app not launched")
	}
	raw, err := os.ReadFile(client.CodexProfileAppConfigPath(env.Root, "work"))
	if err != nil || !strings.Contains(string(raw), mainHome) {
		t.Fatalf("app config does not share the main database: %s (%v)", raw, err)
	}
	state := map[string]any{}
	stateRaw, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(stateRaw, &state); err != nil {
		t.Fatal(err)
	}
	atoms, _ := state["electron-persisted-atom-state"].(map[string]any)
	if atoms["electron:onboarding-projectless-completed"] != true {
		t.Fatalf("onboarding not skipped: %v", state)
	}
}
