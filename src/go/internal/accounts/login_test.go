package accounts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/store"
	"github.com/outof0/anypick/go/internal/testexec"
	"github.com/outof0/anypick/go/internal/transport"
)

func wantCode(t *testing.T, err error) string {
	t.Helper()
	var ae *anyerr.Error
	if !errors.As(err, &ae) {
		t.Fatalf("want AnyPickError, got %v", err)
	}
	return ae.Code
}

func newLoginService(t *testing.T) (*Service, *store.AccountStore, string) {
	t.Helper()
	root := t.TempDir()
	database, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	st := store.New(root, database)
	reg := provider.NewRegistry()
	home := t.TempDir()
	authPath := filepath.Join(home, ".grok", "auth.json")
	t.Setenv("GROK_AUTH_PATH", authPath)
	if err := provider.RegisterBuiltin(reg, home); err != nil {
		t.Fatal(err)
	}
	return New(st, reg), st, authPath
}

func grokAuthBody(email string) string {
	return `{"sessions":{"s1":{"email":"` + email + `","access_token":"tok"}}}`
}

func TestLoginMethodsForGeminiSubscriptionSources(t *testing.T) {
	svc, _, _ := newLoginService(t)
	methods, err := svc.LoginMethods(context.Background(), "gemini", "")
	if err != nil {
		t.Fatalf("LoginMethods: %v", err)
	}
	if len(methods) != 2 {
		t.Fatalf("gemini methods = %+v, want Gemini and Antigravity subscription paths", methods)
	}
	if methods[0].ID != "gemini-subscription" || methods[0].Source != "gemini-cli" || !methods[0].Preferred {
		t.Fatalf("default Gemini method = %+v", methods[0])
	}
	filtered, err := svc.LoginMethods(context.Background(), "gemini", "antigravity")
	if err != nil {
		t.Fatalf("filtered LoginMethods: %v", err)
	}
	if len(filtered) != 1 || filtered[0].ID != "antigravity-subscription" {
		t.Fatalf("filtered methods = %+v", filtered)
	}
}

func TestLoginMethodsAvailabilityFollowsLauncher(t *testing.T) {
	// Scrub PATH so host-installed launchers cannot flip availability.
	emptyPath := t.TempDir()
	launcher := testexec.Build(t)
	svc, _, _ := newLoginService(t)

	// No launcher on PATH and no extra path present → unavailable with reason.
	t.Setenv("PATH", emptyPath)
	methods, err := svc.LoginMethods(context.Background(), "grok", "")
	if err != nil {
		t.Fatalf("LoginMethods: %v", err)
	}
	if len(methods) != 1 || methods[0].Available {
		t.Fatalf("expected single unavailable method, got %+v", methods)
	}
	if methods[0].UnavailableReason == "" {
		t.Fatal("missing unavailableReason")
	}

	// With the launcher present the same method becomes available.
	svc2, _, _ := newLoginService(t)
	t.Setenv("GROK_BINARY", launcher)
	methods, err = svc2.LoginMethods(context.Background(), "grok", "")
	if err != nil {
		t.Fatalf("LoginMethods: %v", err)
	}
	if len(methods) != 1 || !methods[0].Available || methods[0].ID != "grok-subscription" {
		t.Fatalf("available method mismatch: %+v", methods)
	}
	if methods[0].Provenance != "official" || !methods[0].Preferred {
		t.Fatalf("provenance/preferred lost: %+v", methods[0])
	}
}

func TestLoginEndToEndCreatesAccountAndActivates(t *testing.T) {
	svc, st, authPath := newLoginService(t)
	launcher := testexec.Build(t)
	testexec.SetWrite(t, authPath, grokAuthBody("user@example.com"))
	t.Setenv("GROK_BINARY", launcher)

	res, err := svc.Login(context.Background(), "grok", LoginOptions{Name: "work"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if res.Provider != "grok" || res.Account.Name == "" {
		t.Fatalf("result = %#v", res)
	}
	if res.Method.ID != "grok-subscription" {
		t.Fatalf("method = %+v", res.Method)
	}
	if res.BackedUpTo != nil {
		t.Fatalf("no stash expected without prior live login: %v", *res.BackedUpTo)
	}
	acct, gerr := st.Get(context.Background(), "grok", res.Account.Name)
	if gerr != nil || acct == nil {
		t.Fatalf("account not persisted: %v", gerr)
	}
	active, aerr := st.GetActive(context.Background(), "grok")
	if aerr != nil || active != res.Account.Name {
		t.Fatalf("active = %q, want %q", active, res.Account.Name)
	}
}

func TestLoginReusesIdentitySnapshotName(t *testing.T) {
	svc, st, authPath := newLoginService(t)
	writeAuth := testexec.Build(t)
	testexec.SetWrite(t, authPath, grokAuthBody("same@example.com"))

	// First login creates an identity-named account.
	t.Setenv("GROK_BINARY", writeAuth)
	first, err := svc.Login(context.Background(), "grok", LoginOptions{Name: "first-run"})
	if err != nil {
		t.Fatalf("first Login: %v", err)
	}

	// A second login for the same identity must refresh that account, not alias.
	second, err := svc.Login(context.Background(), "grok", LoginOptions{})
	if err != nil {
		t.Fatalf("second Login: %v", err)
	}
	if second.Account.Name != first.Account.Name {
		t.Fatalf("identity reuse failed: %q vs %q", first.Account.Name, second.Account.Name)
	}
	list, _ := st.ListAccounts(context.Background(), "grok")
	if len(list) != 1 {
		t.Fatalf("expected one account, got %d", len(list))
	}
}

func TestLoginStashesPriorLiveLoginAndSetsBackedUpTo(t *testing.T) {
	svc, _, authPath := newLoginService(t)
	// Pre-existing live login (different identity).
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	old := grokAuthBody("old@example.com")
	if err := os.WriteFile(authPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	newAuth := grokAuthBody("new@example.com")
	launcher := testexec.Build(t)
	testexec.SetWrite(t, authPath, newAuth)
	t.Setenv("GROK_BINARY", launcher)

	res, err := svc.Login(context.Background(), "grok", LoginOptions{Name: "brand-new"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if res.BackedUpTo == nil || *res.BackedUpTo == "" {
		t.Fatal("prior live login was not stashed")
	}
	// The new login is now live and active.
	live, derr := svc.Providers.Get("grok")
	if derr != nil {
		t.Fatal(derr)
	}
	status, derr := live.DetectLive()
	if derr != nil || !status.Present {
		t.Fatalf("live after login = %+v (%v)", status, derr)
	}
}

func TestLoginFailureRollsBackLiveAuth(t *testing.T) {
	svc, _, authPath := newLoginService(t)
	old := grokAuthBody("keep@example.com")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	// The provider launcher refuses to proceed if the old auth is still in
	// place. This pins the checkpoint → clear → login ordering: a fresh login
	// must not silently reuse the current subscription account.
	failing := testexec.Build(t)
	t.Setenv("ANYPICK_TESTEXEC_FAIL_IF_PRESENT", authPath)
	marker := filepath.Join(t.TempDir(), "auth-presence")
	t.Setenv("ANYPICK_TESTEXEC_PRESENCE_MARKER", marker)
	t.Setenv("GROK_BINARY", failing)

	_, err := svc.Login(context.Background(), "grok", LoginOptions{})
	if err == nil || wantCode(t, err) != "PROVIDER_LOGIN_FAILED" {
		t.Fatalf("want PROVIDER_LOGIN_FAILED, got %v", err)
	}
	if state, err := os.ReadFile(marker); err != nil || string(state) != "absent" {
		t.Fatalf("login launcher observed auth state %q before failing; want absent (%v)", state, err)
	}
	data, rerr := os.ReadFile(authPath)
	if rerr != nil || string(data) != old {
		t.Fatalf("live auth not restored: %v %q", rerr, data)
	}
	after, err := svc.Store.ListAccounts(context.Background(), "grok")
	if err != nil {
		t.Fatalf("list stashed accounts: %v", err)
	}
	if len(after) == 0 {
		t.Fatal("rollback deleted the stashed account")
	}
	foundOldSnapshot := false
	for _, row := range after {
		account, err := svc.Store.Get(context.Background(), "grok", row.Meta.Name)
		if err != nil {
			t.Fatalf("read stashed account %q: %v", row.Meta.Name, err)
		}
		if account == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(account.SnapshotDir, "auth.json"))
		if err == nil && string(data) == old {
			foundOldSnapshot = true
			break
		}
	}
	if !foundOldSnapshot {
		t.Fatal("rollback lost or changed the prior credential snapshot")
	}
}

func TestLoginUnknownMethodRejected(t *testing.T) {
	svc, _, _ := newLoginService(t)
	t.Setenv("GROK_BINARY", testexec.Build(t))
	_, err := svc.Login(context.Background(), "grok", LoginOptions{MethodID: "nope"})
	if err == nil || wantCode(t, err) != "PROVIDER_LOGIN_METHOD_UNKNOWN" {
		t.Fatalf("unknown method: %v", err)
	}
}

func TestSelectLoginMethodPreferenceOrdering(t *testing.T) {
	officialPreferred := provider.LoginMethod{ID: "a", Label: "B", Provenance: "community", Available: true}
	m := []provider.LoginMethod{
		officialPreferred,
		{ID: "b", Label: "A", Provenance: "official", Preferred: true, Available: true},
	}
	got, err := selectLoginMethod(m, "")
	if err != nil || got.ID != "b" {
		t.Fatalf("official preferred must win: %v %v", got, err)
	}

	ambiguous := []provider.LoginMethod{
		{ID: "x", Provenance: "official", Available: true},
		{ID: "y", Provenance: "official", Available: true},
	}
	if _, err := selectLoginMethod(ambiguous, ""); err == nil ||
		wantCode(t, err) != "PROVIDER_LOGIN_METHOD_REQUIRED" {
		t.Fatalf("ambiguity must be explicit: %v", err)
	}

	requested := []provider.LoginMethod{{ID: "only"}}
	if got, err := selectLoginMethod(requested, "only"); err != nil || got.ID != "only" {
		t.Fatalf("requested method: %v %v", got, err)
	}
	_, err = selectLoginMethod(requested, "other")
	if err == nil || wantCode(t, err) != "PROVIDER_LOGIN_METHOD_UNKNOWN" {
		t.Fatalf("unknown id must fail: %v", err)
	}
}

func TestLoginCancelAfterSnapshotCommitRestoresPrevious(t *testing.T) {
	svc, st, authPath := newLoginService(t)
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(grokAuthBody("old@example.com")), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Save(context.Background(), "grok", "keep", false); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if body := snapshotBlob(t, st, "grok", "keep"); !strings.Contains(body, "old@example.com") {
		t.Fatalf("seed snapshot = %s", body)
	}
	// Save does not clear the live file and does not mark the account active.
	// Login would then stash those same bytes under "stash", and the alias
	// guard would refuse before the launcher ever replaced the snapshot.
	if err := os.Remove(authPath); err != nil {
		t.Fatal(err)
	}

	launcher := testexec.Build(t)
	testexec.SetWrite(t, authPath, grokAuthBody("new@example.com"))
	t.Setenv("GROK_BINARY", launcher)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	loginCommitHook = func() { cancel() }
	t.Cleanup(func() { loginCommitHook = nil })

	_, err := svc.Login(ctx, "grok", LoginOptions{Name: "keep"})
	if err == nil || wantCode(t, err) != "PROVIDER_LOGIN_CANCELLED" {
		t.Fatalf("want PROVIDER_LOGIN_CANCELLED, got %v", err)
	}
	got, gerr := st.Get(context.Background(), "grok", "keep")
	if gerr != nil || got == nil {
		t.Fatalf("account after cancel: %+v %v", got, gerr)
	}
	body := snapshotBlob(t, st, "grok", "keep")
	if !strings.Contains(body, "old@example.com") || strings.Contains(body, "new@example.com") {
		t.Fatalf("snapshot bytes after cancel: %s identity %s", body, got.Meta.Identity)
	}
}

func snapshotBlob(t *testing.T, st *store.AccountStore, providerID, name string) string {
	t.Helper()
	rows, err := st.DB.QueryContext(context.Background(),
		`SELECT path, content FROM account_snapshot_files WHERE provider = ? AND account = ?`,
		providerID, name)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var path string
		var content []byte
		if err := rows.Scan(&path, &content); err != nil {
			t.Fatal(err)
		}
		b.WriteString(path)
		b.WriteByte('\n')
		b.Write(content)
		b.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestLoginCancelAfterCreatingAccountDeletesIt(t *testing.T) {
	svc, st, authPath := newLoginService(t)
	launcher := testexec.Build(t)
	testexec.SetWrite(t, authPath, grokAuthBody("new@example.com"))
	t.Setenv("GROK_BINARY", launcher)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	loginCommitHook = func() { cancel() }
	t.Cleanup(func() { loginCommitHook = nil })

	_, err := svc.Login(ctx, "grok", LoginOptions{Name: "fresh"})
	if err == nil || wantCode(t, err) != "PROVIDER_LOGIN_CANCELLED" {
		t.Fatalf("want PROVIDER_LOGIN_CANCELLED, got %v", err)
	}
	got, gerr := st.Get(context.Background(), "grok", "fresh")
	if gerr != nil {
		t.Fatal(gerr)
	}
	if got != nil {
		t.Fatalf("cancelled login left account %+v", got.Meta)
	}
	if body := snapshotBlob(t, st, "grok", "fresh"); body != "" {
		t.Fatalf("cancelled login left snapshot rows: %s", body)
	}
}

func TestLoginCancelInCommitWindowRollsBack(t *testing.T) {
	svc, st, authPath := newLoginService(t)

	// Wrap the real grok provider so that when its launcher finishes, the
	// request context is already cancelled: the launcher writes auth.json and
	// THEN we cancel — exactly the late-cancel race.
	launcher := testexec.Build(t)
	testexec.SetWrite(t, authPath, grokAuthBody("race@example.com"))
	t.Setenv("ANYPICK_TESTEXEC_WAIT_MS", "200")
	t.Setenv("GROK_BINARY", launcher)

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel after the launcher child exits but before DetectLive commits:
	// poll for the credential file from a goroutine.
	go func() {
		for {
			if _, err := os.Stat(authPath); err == nil {
				cancel()
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	_, err := svc.Login(ctx, "grok", LoginOptions{Name: "racy"})
	if err == nil {
		t.Fatal("cancelled login must not succeed")
	}
	var ae *anyerr.Error
	if !errors.As(err, &ae) || ae.Code != "PROVIDER_LOGIN_CANCELLED" {
		t.Fatalf("want PROVIDER_LOGIN_CANCELLED, got %v", err)
	}
	// No account may be committed by the abandoned request.
	list, lerr := st.ListAccounts(context.Background(), "grok")
	if lerr != nil {
		t.Fatal(lerr)
	}
	for _, acct := range list {
		if acct.Meta.Identity != "" && strings.Contains(acct.Meta.Identity, "race@example.com") {
			t.Fatalf("cancelled login committed state: %+v", acct.Meta)
		}
	}
	if active, _ := st.GetActive(context.Background(), "grok"); active != "" {
		t.Fatalf("active pointer set despite cancellation: %q", active)
	}
}

// memLogin is a two-store provider: an API-key file plus a CLI oauth file.
// It exists so login tests can prove a source-scoped sign-in does not destroy
// the other store or a dotenv the new snapshot does not replace.
type memLogin struct {
	root string
	fail bool
}

func (p *memLogin) ID() string          { return "memlogin" }
func (p *memLogin) Name() string        { return "Mem" }
func (p *memLogin) Description() string { return "test login provider" }
func (p *memLogin) CanProxy() bool      { return false }
func (p *memLogin) AccountAdapter(name string, _ bool) transport.Adapter {
	return transport.GeminiAccountAdapter("memlogin", name)
}
func (p *memLogin) live(name string) string { return filepath.Join(p.root, name) }

func (p *memLogin) DetectLive() (provider.LiveAuthStatus, error) {
	if _, err := os.Stat(p.live("api-key")); err == nil {
		return provider.LiveAuthStatus{Present: true, Details: "api"}, nil
	}
	return p.DetectLiveSource("cli")
}

func (p *memLogin) DetectLiveSource(source string) (provider.LiveAuthStatus, error) {
	if source != "cli" {
		return provider.LiveAuthStatus{}, nil
	}
	raw, err := os.ReadFile(p.live("oauth"))
	if err != nil {
		return provider.LiveAuthStatus{}, nil
	}
	return provider.LiveAuthStatus{Present: true, Identity: strings.TrimSpace(string(raw)), Source: "cli"}, nil
}

func (p *memLogin) Backup(dest string) (provider.SnapshotInfo, error) {
	found := false
	for _, name := range []string{"api-key", "oauth", "anti", "env"} {
		raw, err := os.ReadFile(p.live(name))
		if err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(dest, name), raw, 0o600); err != nil {
			return provider.SnapshotInfo{}, err
		}
		found = true
	}
	if !found {
		return provider.SnapshotInfo{}, anyerr.Newf("no live auth", "NO_LIVE_AUTH")
	}
	info := provider.SnapshotInfo{}
	if raw, err := os.ReadFile(p.live("oauth")); err == nil {
		info.Identity = strings.TrimSpace(string(raw))
	}
	return info, nil
}

func (p *memLogin) BackupSource(source, dest string) (provider.SnapshotInfo, error) {
	if source != "cli" {
		return provider.SnapshotInfo{}, anyerr.Newf("unknown source", "INVALID_USAGE")
	}
	raw, err := os.ReadFile(p.live("oauth"))
	if err != nil {
		return provider.SnapshotInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(dest, "oauth"), raw, 0o600); err != nil {
		return provider.SnapshotInfo{}, err
	}
	return provider.SnapshotInfo{Identity: strings.TrimSpace(string(raw))}, nil
}

func (p *memLogin) Restore(src string) error {
	for _, name := range []string{"api-key", "oauth", "anti", "env"} {
		raw, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			_ = os.Remove(p.live(name))
			continue
		}
		if err := os.WriteFile(p.live(name), raw, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (p *memLogin) DescribeSnapshot(string) (provider.SnapshotInfo, error) {
	return provider.SnapshotInfo{}, nil
}

func (p *memLogin) LoginMethods() []provider.LoginMethod {
	return []provider.LoginMethod{{
		ID: "mem-login", Label: "Mem", Source: "cli",
		Provenance: "official", Preferred: true, Available: true,
	}}
}

func (p *memLogin) Login(_ context.Context, methodID, source string) error {
	if methodID != "mem-login" || (source != "" && source != "cli") {
		return anyerr.Newf("unknown method", "PROVIDER_LOGIN_METHOD_UNKNOWN")
	}
	if p.fail {
		return anyerr.Newf("sign-in failed", "PROVIDER_LOGIN_FAILED")
	}
	return os.WriteFile(p.live("oauth"), []byte("new@example.com"), 0o600)
}

func (p *memLogin) CanClearLive(source string) bool { return source != "external" }

func (p *memLogin) ClearLive() error {
	for _, name := range []string{"api-key", "oauth", "anti", "env"} {
		_ = os.Remove(p.live(name))
	}
	return nil
}

func (p *memLogin) ClearLiveSource(source string) error {
	if !p.CanClearLive(source) {
		return nil
	}
	if source == "cli" {
		_ = os.Remove(p.live("oauth"))
	}
	return nil
}

func (p *memLogin) SourceSaveDropsSnapshot(dir, _ string) bool {
	if _, err := os.Stat(filepath.Join(dir, "api-key")); err == nil {
		return true
	}
	_, err := os.Stat(filepath.Join(dir, "anti"))
	return err == nil
}

func (p *memLogin) PreserveAuthEnv() (string, error) {
	raw, err := os.ReadFile(p.live("env"))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(raw), nil
}

func (p *memLogin) RestoreAuthEnv(body string) error {
	if strings.TrimSpace(body) == "" {
		return nil
	}
	return os.WriteFile(p.live("env"), []byte(body), 0o600)
}

func TestLoginKeepsAPIKeyStashAndUnrelatedFiles(t *testing.T) {
	svc, st, _ := newLoginService(t)
	p := &memLogin{root: t.TempDir()}
	if err := os.MkdirAll(p.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.live("api-key"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.live("anti"), []byte("other-source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.live("env"), []byte("VERTEX=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.Providers.Register(p); err != nil {
		t.Fatal(err)
	}

	res, err := svc.Login(context.Background(), "memlogin", LoginOptions{Name: "stash"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if res.Account.Name == "stash" {
		t.Fatal("new oauth login replaced the API-key stash")
	}
	if res.BackedUpTo == nil || *res.BackedUpTo != "stash" {
		t.Fatalf("backedUpTo = %v, want stash", res.BackedUpTo)
	}
	stash, err := st.Get(context.Background(), "memlogin", "stash")
	if err != nil || stash == nil {
		t.Fatalf("stash missing: %v", err)
	}
	key, err := os.ReadFile(filepath.Join(stash.SnapshotDir, "api-key"))
	if err != nil || string(key) != "secret" {
		t.Fatalf("stash api key = %q (%v)", key, err)
	}
	if _, err := os.Stat(p.live("anti")); err != nil {
		t.Fatalf("other source removed: %v", err)
	}
	env, err := os.ReadFile(p.live("env"))
	if err != nil || string(env) != "VERTEX=1\n" {
		t.Fatalf("env = %q (%v)", env, err)
	}
	if _, err := os.Stat(p.live("api-key")); err != nil {
		t.Fatalf("live api key removed: %v", err)
	}
}

func TestLoginFailureRestoresPreservedEnv(t *testing.T) {
	svc, _, _ := newLoginService(t)
	p := &memLogin{root: t.TempDir(), fail: true}
	if err := os.MkdirAll(p.root, 0o700); err != nil {
		t.Fatal(err)
	}
	const body = "GOOGLE_CLOUD_PROJECT=vertex\n"
	if err := os.WriteFile(p.live("env"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.Providers.Register(p); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Login(context.Background(), "memlogin", LoginOptions{Name: "work"})
	if err == nil {
		t.Fatal("expected login failure")
	}
	got, rerr := os.ReadFile(p.live("env"))
	if rerr != nil || string(got) != body {
		t.Fatalf("env after failed login = %q (%v), want preserved", got, rerr)
	}
}
