package accounts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/store"
)

// fullService wires every builtin provider against an isolated HOME so tests
// can exercise claude's LiveMatcher surface without touching the real machine.
func fullService(t *testing.T) (*Service, *store.AccountStore, string) {
	t.Helper()
	root := t.TempDir()
	home := t.TempDir()
	database, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	st := store.New(root, database)
	reg := provider.NewRegistry()
	if err := provider.RegisterBuiltin(reg, home); err != nil {
		t.Fatal(err)
	}
	if err := provider.RegisterBuiltinCompatibles(reg, home); err != nil {
		t.Fatal(err)
	}
	// seedGrokLive writes through this override (fake HOME).
	t.Setenv("GROK_AUTH_PATH", filepath.Join(home, ".grok", "auth.json"))
	return New(st, reg), st, home
}

func seedClaudeLive(t *testing.T, email, access, refresh string) {
	t.Helper()
	path := os.Getenv("ANYPICK_CLAUDE_CREDENTIALS_PATH")
	if path == "" {
		t.Fatal("ANYPICK_CLAUDE_CREDENTIALS_PATH not set")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"claudeAiOauth":{"email":"` + email + `","accessToken":"` +
		access + `","refreshToken":"` + refresh + `"}}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestComputeLiveMatchMatcherAndPlain(t *testing.T) {
	svc, _, _ := fullService(t)

	// Providers without LiveMatcher report unknown match.
	deepseek, err := svc.Providers.Get("deepseek")
	if err != nil {
		t.Fatal(err)
	}
	match, known, err := computeLiveMatch(deepseek, "/unused", provider.LiveAuthStatus{})
	if match || known || err != nil {
		t.Fatalf("non-matcher = %v %v %v", match, known, err)
	}

	// Claude can identify the login across token refreshes.
	credPath := filepath.Join(t.TempDir(), "creds.json")
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	t.Setenv("ANYPICK_CLAUDE_CREDENTIALS_PATH", credPath)
	seedClaudeLive(t, "c@x.dev", "at-1", "rt-1")
	claude, err := svc.Providers.Get("claude")
	if err != nil {
		t.Fatal(err)
	}
	snap := t.TempDir()
	if _, err := claude.Backup(snap); err != nil {
		t.Fatal(err)
	}

	// Same material → match.
	live, err := claude.DetectLive()
	if err != nil || !live.Present {
		t.Fatalf("detect: %+v %v", live, err)
	}
	match, known, err = computeLiveMatch(claude, snap, live)
	if err != nil || !known || !match {
		t.Fatalf("same live: %v %v %v", match, known, err)
	}

	// Compare the refresh token when the access token has rotated.
	seedClaudeLive(t, "c@x.dev", "at-2", "rt-1")
	live, _ = claude.DetectLive()
	match, known, err = computeLiveMatch(claude, snap, live)
	if err != nil || !known || !match {
		t.Fatalf("refreshed live: %v %v %v", match, known, err)
	}

	// Unreadable credential file surfaces as a matcher error: replace the
	// file with a directory so ReadFile fails with something other than
	// NotExist.
	if err := os.Remove(credPath); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(credPath, 0o700); err != nil {
		t.Fatal(err)
	}
	_, known, err = computeLiveMatch(claude, snap, provider.LiveAuthStatus{Present: true})
	if err == nil || !known {
		t.Fatalf("unreadable live: known=%v err=%v", known, err)
	}
}

func TestCurrentIdentityFallbackAndMismatch(t *testing.T) {
	svc, st, _ := fullService(t)
	ctx := context.Background()

	credPath := filepath.Join(t.TempDir(), "creds.json")
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	t.Setenv("ANYPICK_CLAUDE_CREDENTIALS_PATH", credPath)
	seedClaudeLive(t, "cur@x.dev", "at-1", "rt-1")

	meta, err := svc.Save(ctx, "claude", "main", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetActiveContext(context.Background(), "claude", "main"); err != nil {
		t.Fatal(err)
	}

	// Refreshed token: material differs, identity matches → fallback says match.
	seedClaudeLive(t, "cur@x.dev", "at-2", "rt-1")
	cur, err := svc.Current(ctx, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if !cur.LiveMatchKnown {
		t.Fatal("claude must know the live match result")
	}
	if cur.IsLiveMatch != true {
		t.Fatalf("identity fallback failed: %+v", cur)
	}
	if cur.Account == nil || cur.Account.Meta.Identity != meta.Identity {
		t.Fatalf("account payload: %+v", cur.Account)
	}

	// Different identity entirely → honest mismatch.
	seedClaudeLive(t, "other@x.dev", "at-3", "rt-9")
	cur, err = svc.Current(ctx, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if cur.IsLiveMatch {
		t.Fatalf("mismatch reported as match: %+v", cur)
	}

	// No active pointer → early return without matching.
	if err := st.ClearActiveContext(context.Background(), "claude"); err != nil {
		t.Fatal(err)
	}
	cur, err = svc.Current(ctx, "claude")
	if err != nil || cur.Active != "" || cur.LiveMatchKnown {
		t.Fatalf("inactive current: %+v %v", cur, err)
	}

	// Active pointer to a vanished account degrades gracefully.
	if err := st.SetActiveContext(context.Background(), "claude", "ghost"); err != nil {
		t.Fatal(err)
	}
	cur, err = svc.Current(ctx, "claude")
	if err != nil || cur.Account != nil || cur.LiveMatchKnown {
		t.Fatalf("ghost active: %+v %v", cur, err)
	}
}

func TestCheckpointRestoreRoundTripWithActivePointer(t *testing.T) {
	svc, st, _ := fullService(t)
	ctx := context.Background()

	seedGrokLive(t, "cp@grok.xai")
	if err := st.SetActiveContext(context.Background(), "grok", "acc-a"); err != nil {
		t.Fatal(err)
	}

	cp, err := svc.CheckpointLiveAuth(ctx, "grok", true)
	if err != nil {
		t.Fatal(err)
	}
	if !cp.HadLiveAuth || cp.ActiveAccount == nil || *cp.ActiveAccount != "acc-a" {
		t.Fatalf("checkpoint: %+v", cp)
	}
	// Durable checkpoints live under the data root until discarded.
	if _, err := os.Stat(cp.Directory); err != nil {
		t.Fatalf("checkpoint directory missing: %v", err)
	}

	// Wipe live state and the pointer, then restore both from the checkpoint.
	if err := os.Remove(os.Getenv("GROK_AUTH_PATH")); err != nil {
		t.Fatal(err)
	}
	if err := st.ClearActiveContext(context.Background(), "grok"); err != nil {
		t.Fatal(err)
	}
	if err := svc.RestoreLiveAuthCheckpoint(ctx, cp); err != nil {
		t.Fatalf("restore: %v", err)
	}
	live, err := svc.Providers.Get("grok")
	if err != nil {
		t.Fatal(err)
	}
	status, err := live.DetectLive()
	if err != nil || !status.Present || status.Identity != "cp@grok.xai" {
		t.Fatalf("restored live: %+v %v", status, err)
	}
	active, err := st.GetActive(context.Background(), "grok")
	if err != nil || active != "acc-a" {
		t.Fatalf("restored active: %q %v", active, err)
	}
	if err := svc.DiscardLiveAuthCheckpoint(cp); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cp.Directory); !os.IsNotExist(err) {
		t.Fatal("checkpoint directory survived discard")
	}
}

func TestCheckpointDurableRootCreated(t *testing.T) {
	svc, _, _ := fullService(t)
	ctx := context.Background()
	seedGrokLive(t, "durable@grok.xai")

	cp, err := svc.CheckpointLiveAuth(ctx, "grok", true)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = svc.DiscardLiveAuthCheckpoint(cp) }()

	recoveryRoot := filepath.Join(svc.Store.Root, "recovery", "live-auth")
	info, err := os.Stat(recoveryRoot)
	if err != nil || !info.IsDir() {
		t.Fatalf("durable recovery root missing: %v", err)
	}
}

func TestRestoreEmptyCheckpointWithoutClearerFails(t *testing.T) {
	svc, _, _ := fullService(t)
	ctx := context.Background()

	// deepseek (compatible) never has live auth and exposes no LiveClearer,
	// so restoring an empty checkpoint cannot be done safely.
	cp, err := svc.CheckpointLiveAuth(ctx, "deepseek", false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = svc.DiscardLiveAuthCheckpoint(cp) }()
	if cp.HadLiveAuth {
		t.Fatalf("compatible vendors have no live auth: %+v", cp)
	}
	err = svc.RestoreLiveAuthCheckpoint(ctx, cp)
	var ae *anyerr.Error
	if !errors.As(err, &ae) || ae.Code != "SWITCH_ROLLBACK_UNAVAILABLE" {
		t.Fatalf("want SWITCH_ROLLBACK_UNAVAILABLE, got %v", err)
	}
}

func TestUnknownProviderErrors(t *testing.T) {
	svc, _, _ := fullService(t)
	ctx := context.Background()
	if _, err := svc.CheckpointLiveAuth(ctx, "nope", false); err == nil {
		t.Fatal("unknown provider must fail")
	}
	if _, err := svc.Current(ctx, "nope"); err == nil {
		t.Fatal("unknown provider must fail")
	}
	if err := svc.RestoreLiveAuthCheckpoint(ctx, &Checkpoint{ProviderID: "nope"}); err == nil {
		t.Fatal("unknown provider must fail")
	}
}

func TestSaveForceKeepsCreatedAt(t *testing.T) {
	svc, st, _ := fullService(t)
	ctx := context.Background()

	seedGrokLive(t, "keep@grok.xai")
	first, err := svc.Save(ctx, "grok", "keep", false)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)

	seedGrokLive(t, "updated@grok.xai")
	second, err := svc.Save(ctx, "grok", "keep", true)
	if err != nil {
		t.Fatal(err)
	}
	if second.CreatedAt != first.CreatedAt {
		t.Fatalf("CreatedAt drifted: %q -> %q", first.CreatedAt, second.CreatedAt)
	}
	if second.Identity != "updated@grok.xai" {
		t.Fatalf("snapshot not refreshed: %+v", second)
	}
	got, _ := st.Get(context.Background(), "grok", "keep")
	if got.Meta.CreatedAt != first.CreatedAt {
		t.Fatalf("stored meta drift: %+v", got.Meta)
	}

	// Save without --force refuses to overwrite.
	_, err = svc.Save(ctx, "grok", "keep", false)
	var ae *anyerr.Error
	if !errors.As(err, &ae) || ae.Code != "ACCOUNT_EXISTS" {
		t.Fatalf("want ACCOUNT_EXISTS, got %v", err)
	}
}
