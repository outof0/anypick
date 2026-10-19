package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
)

// composeForProfiles builds a real app graph (the composition root is what
// wires the cascade) over an isolated root and home.
func composeForProfiles(t *testing.T) (*App, func()) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "anypick")
	a, closeFn, err := Ready(context.Background(), Options{Root: root, Home: testHome(t)})
	if err != nil {
		t.Fatal(err)
	}
	return a, closeFn
}

// seedCodexProfile writes the native files an activation would have written
// for one named profile and stores its route.
func seedCodexProfile(t *testing.T, a *App, name string, source refs.Ref) {
	t.Helper()
	ctx := context.Background()
	if _, err := a.CodexProfileSvc.UpsertContext(ctx, "codex", name, bindings.Spec{
		Client: "codex", Source: source, Model: bindings.ExplicitModel("gpt-5.6"),
		TransportPolicy: "auto",
	}); err != nil {
		t.Fatal(err)
	}
	home := client.CodexProfileHomePath(a.Root, name)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(client.CodexProfileAuthPath(a.Root, name),
		[]byte(`{"OPENAI_API_KEY":"sk-`+name+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(client.CodexProfileConfigPathForRoot(a.Root, name),
		[]byte("# BEGIN anypick-managed\n# END anypick-managed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func codexProfileFiles(a *App, name string) []string {
	return []string{
		client.CodexProfileHomePath(a.Root, name),
		client.CodexProfileAuthPath(a.Root, name),
		client.CodexProfileConfigPathForRoot(a.Root, name),
		client.CodexProfileEnvPath(a.Root, name),
	}
}

// The behaviour this whole change exists for: deleting a Codex account also
// removes the named profiles bound to it, credential home included, and
// reports what it removed.
func TestDeletingAccountRemovesItsNamedProfiles(t *testing.T) {
	a, closeFn := composeForProfiles(t)
	defer closeFn()
	ctx := context.Background()

	a.writeCodexAuth(t, "gone@example.com", "token-gone")
	if _, err := a.Accounts.Save(ctx, "codex", "gone", true); err != nil {
		t.Fatal(err)
	}
	seedCodexProfile(t, a, "gone", refs.AccountRef("codex", "gone"))

	deleted, err := a.Accounts.Delete(ctx, "codex", "gone")
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted.Profiles) != 1 || deleted.Profiles[0] != "codex/gone" {
		t.Fatalf("Delete reported profiles %#v, want [codex/gone]", deleted.Profiles)
	}
	for _, path := range codexProfileFiles(a, "gone") {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("account deletion left %s behind (stat err = %v)", path, err)
		}
	}
	row, err := a.CodexProfileSvc.GetContext(ctx, "codex", "gone")
	if err != nil {
		t.Fatal(err)
	}
	if row != nil {
		t.Fatalf("named profile row survived the cascade: %#v", row)
	}
}

// Deleting one account must not touch a profile bound to another, or a
// gateway-backed profile.
func TestDeletingAccountLeavesOtherProfilesAlone(t *testing.T) {
	a, closeFn := composeForProfiles(t)
	defer closeFn()
	ctx := context.Background()

	for _, name := range []string{"gone", "kept"} {
		a.writeCodexAuth(t, name+"@example.com", "token-"+name)
		if _, err := a.Accounts.Save(ctx, "codex", name, true); err != nil {
			t.Fatal(err)
		}
	}
	seedCodexProfile(t, a, "gone", refs.AccountRef("codex", "gone"))
	seedCodexProfile(t, a, "kept", refs.AccountRef("codex", "kept"))
	seedCodexProfile(t, a, "gateway", refs.GatewayRef("openrouter"))

	if _, err := a.Accounts.Delete(ctx, "codex", "gone"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"kept", "gateway"} {
		row, err := a.CodexProfileSvc.GetContext(ctx, "codex", name)
		if err != nil || row == nil {
			t.Fatalf("profile %s did not survive: %#v, %v", name, row, err)
		}
		for _, path := range codexProfileFiles(a, name) {
			if path == client.CodexProfileEnvPath(a.Root, name) {
				continue // never seeded; the cascade is not what would create it
			}
			if _, err := os.Stat(path); err != nil {
				t.Errorf("deleting codex/gone removed profile %s file %s: %v", name, path, err)
			}
		}
	}
}

// A profile left over from a delete that predates the cascade (or from a
// database restored without its account rows) is swept at startup. The test
// drives the real startup entry point, so it fails if the sweep is unwired
// from maintenance rather than merely broken in isolation.
func TestStartupSweepsOrphanedProfilesAndKeepsLiveOnes(t *testing.T) {
	a, closeFn := composeForProfiles(t)
	defer closeFn()
	ctx := context.Background()

	a.writeCodexAuth(t, "alive@example.com", "token-alive")
	if _, err := a.Accounts.Save(ctx, "codex", "alive", true); err != nil {
		t.Fatal(err)
	}
	seedCodexProfile(t, a, "alive", refs.AccountRef("codex", "alive"))
	seedCodexProfile(t, a, "orphan", refs.AccountRef("codex", "deleted-account"))

	// Snapshot what actually exists before the run: the sweep must not delete
	// any of it. (env.sh is written lazily by activation, so asserting on the
	// static list here would fail on a file that never existed.)
	existed := map[string]bool{}
	for _, path := range codexProfileFiles(a, "orphan") {
		if _, err := os.Stat(path); err == nil {
			existed[path] = true
		}
	}

	// Startup maintenance now REPORTS orphans and removes nothing: the old
	// shape deleted whole credential homes unattended on every CLI run,
	// including --dry-run and current. Removal is a consented repair via
	// doctor --fix (see TestPlanAndRemoveOrphanedProfiles).
	runStartupMaintenance(ctx, a, a.Root)

	row, err := a.CodexProfileSvc.GetContext(ctx, "codex", "orphan")
	if err != nil {
		t.Fatal(err)
	}
	if row == nil {
		t.Fatal("startup maintenance removed the orphaned profile row; unattended removal was the defect")
	}
	for path := range existed {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			t.Errorf("orphan file %s was deleted unattended", path)
		}
	}
	for _, path := range codexProfileFiles(a, "alive") {
		if path == client.CodexProfileEnvPath(a.Root, "alive") {
			continue
		}
		if _, err := os.Stat(path); err != nil {
			t.Errorf("live profile file %s is missing: %v", path, err)
		}
	}
}

// The composition root is what makes the cascade real: a service built by hand
// has no BeforeDelete hook, so this pins the wiring rather than the helper.
func TestCompositionRootWiresTheDeletionCascade(t *testing.T) {
	a, closeFn := composeForProfiles(t)
	defer closeFn()
	if a.Accounts.BeforeDelete == nil {
		t.Fatal("composed accounts service has no deletion cascade; profiles would orphan on delete")
	}
	if a.Deps == nil || a.Deps.ClientProfiles == nil {
		t.Fatal("composed activation deps have no client profile store")
	}
}

func TestRefreshingAccountReappliesBoundCodexProfiles(t *testing.T) {
	a, closeFn := composeForProfiles(t)
	defer closeFn()
	ctx := context.Background()

	a.writeCodexAuth(t, "work@example.com", "token-before-refresh")
	if _, err := a.Accounts.Save(ctx, "codex", "work", true); err != nil {
		t.Fatal(err)
	}
	seedCodexProfile(t, a, "work-profile", refs.AccountRef("codex", "work"))
	profileAuth := client.CodexProfileAuthPath(a.Root, "work-profile")
	if err := os.WriteFile(profileAuth, []byte(`{"tokens":{"access_token":"old-profile-token"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	a.writeCodexAuth(t, "work@example.com", "token-after-refresh")
	if _, err := a.Accounts.RefreshSnapshot(ctx, "codex", "work"); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(profileAuth)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "token-after-refresh") {
		t.Fatalf("bound profile retained stale auth after snapshot refresh: %s", got)
	}
}

// writeCodexAuth fabricates a signed-in Codex login at the path the composed
// providers read. Home is a temp dir (testHome), so this never reaches the
// developer's real ~/.codex.
func (a *App) writeCodexAuth(t *testing.T, email, token string) {
	t.Helper()
	path := filepath.Join(a.Home, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"auth_mode":"chatgpt","tokens":{"access_token":"` + token +
		`","account_id":"acct-` + email + `"}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotCascadeWaitsForOutermostProviderLock(t *testing.T) {
	a, closeFn := composeForProfiles(t)
	defer closeFn()
	ctx := context.Background()
	a.writeCodexAuth(t, "work@example.com", "token-before")
	if _, err := a.Accounts.Save(ctx, "codex", "work", true); err != nil {
		t.Fatal(err)
	}
	seedCodexProfile(t, a, "work-profile", refs.AccountRef("codex", "work"))
	a.writeCodexAuth(t, "work@example.com", "token-after")
	original := a.Accounts.AfterSnapshotChange
	called := false
	a.Accounts.SetAfterSnapshotChange(func(c context.Context, provider, account string) error {
		called = true
		if lock.Holds(c, a.Root, refs.ProviderScope("codex")) {
			t.Error("cascade ran under caller's provider lock")
		}
		return original(c, provider, account)
	})
	err := lock.WithMutationLock(ctx, a.Root, refs.ProviderScope("codex"), func(c context.Context) error {
		if _, err := a.Accounts.RefreshSnapshot(c, "codex", "work"); err != nil {
			return err
		}
		if called {
			t.Error("cascade ran before enclosing mutation completed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("cascade was dropped")
	}
	data, err := os.ReadFile(client.CodexProfileAuthPath(a.Root, "work-profile"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "token-after") {
		t.Fatal("profile remained stale")
	}
}
