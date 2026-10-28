package activation

import (
	"context"
	"os"
	"path/filepath"
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
