package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/transport"
)

func TestWorkBuddyProviderShape(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	if p.ID() != "workbuddy" {
		t.Fatalf("ID = %q, want workbuddy", p.ID())
	}
	if p.Name() != "WorkBuddy AI" {
		t.Fatalf("Name = %q", p.Name())
	}
	if !p.CanProxy() {
		t.Fatal("CanProxy = false, want true")
	}
	if p.ShortName() != "WorkBuddy" {
		t.Fatalf("ShortName = %q", p.ShortName())
	}
}

func TestWorkBuddyAccountAdapterTransport(t *testing.T) {
	a := transport.WorkBuddyAccountAdapter("workbuddy", "main")
	cases := map[string]transport.Capability{
		// The app's own client rides its provider's subscription through
		// the proxy; every other client keeps its existing classification.
		// Native switching is separate and supported via the desktop
		// session file.
		"workbuddy": transport.Direct,
		"claude":    transport.ManagedBuiltinProxy,
		"codex":     transport.ManagedBuiltinProxy,
		"opencode":  transport.ManagedBuiltinProxy,
		"dsh":       transport.ManagedBuiltinProxy,
		"gemini":    transport.Unsupported,
		"kiro":      transport.Unsupported,
	}
	for client, want := range cases {
		if got := a.TransportFor(client); got != want {
			t.Fatalf("WorkBuddyAccountAdapter.TransportFor(%q) = %v, want %v", client, got, want)
		}
	}
}

func TestWorkBuddyLoginMethods(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	methods := p.LoginMethods()
	if len(methods) != 2 {
		t.Fatalf("LoginMethods = %+v, want two sites", methods)
	}
	preferred := 0
	for _, m := range methods {
		// No launcher binary is involved, so every method is available.
		if !m.Available {
			t.Fatalf("method %q not available: %s", m.ID, m.UnavailableReason)
		}
		// These endpoints are undocumented, so claiming "official" would be
		// telling users Tencent supports this.
		if m.Provenance != "community" {
			t.Fatalf("method %q provenance = %q, want community", m.ID, m.Provenance)
		}
		if m.Preferred {
			preferred++
		}
	}
	if preferred != 1 {
		t.Fatalf("preferred methods = %d, want exactly 1", preferred)
	}
}

func TestWorkBuddyLoginRejectsUnknownMethodOrSource(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	err := p.Login(context.Background(), "wrong", "")
	var ae *anyerr.Error
	if !errors.As(err, &ae) || ae.Code != "PROVIDER_LOGIN_METHOD_UNKNOWN" {
		t.Fatalf("unknown method: %v", err)
	}
	err = p.Login(context.Background(), "workbuddy-international", "other")
	if !errors.As(err, &ae) || ae.Code != "PROVIDER_LOGIN_METHOD_UNKNOWN" {
		t.Fatalf("foreign source: %v", err)
	}
}

// writeLiveAuth drops a token document where the provider keeps its live file.
func writeLiveAuth(t *testing.T, p *workbuddy, doc workbuddyAuthDocument) string {
	t.Helper()
	path := p.authPath()
	if err := writeWorkBuddyAuthDocument(path, doc); err != nil {
		t.Fatalf("write live auth: %v", err)
	}
	return path
}

// TestWorkBuddyAuthPathIgnoresAppConfigDir pins the staging file to one place.
// The WorkBuddy app exports WORKBUDDY_CONFIG_DIR into every child process, so
// honouring it would move AnyPick's own login state to ~/.workbuddy-ai inside
// the app and ~/.workbuddy outside it — the same account would read as logged
// in or not depending on where the command was typed.
func TestWorkBuddyAuthPathIgnoresAppConfigDir(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	want := filepath.Join(home, ".workbuddy", workbuddyAuthFile)

	t.Setenv("WORKBUDDY_CONFIG_DIR", filepath.Join(home, "elsewhere"))
	t.Setenv("CODEBUDDY_CONFIG_DIR", filepath.Join(home, "elsewhere"))
	if got := p.authPath(); got != want {
		t.Fatalf("authPath = %q, want %q", got, want)
	}

	// The explicit escape hatch still wins, and it is the only thing that
	// moves the file.
	override := filepath.Join(home, "explicit", "auth.json")
	t.Setenv("WORKBUDDY_AUTH_PATH", override)
	if got := p.authPath(); got != override {
		t.Fatalf("authPath with override = %q, want %q", got, override)
	}
}

func TestWorkBuddyDetectLiveAbsentOnGarbage(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	// A file AnyPick did not write is not a login, and must not be an error.
	if err := os.MkdirAll(filepath.Dir(p.authPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.authPath(), []byte(`{"email":"a@b.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := p.DetectLive()
	if err != nil {
		t.Fatalf("DetectLive on foreign file: %v", err)
	}
	if st.Present {
		t.Fatal("DetectLive = present for a document with no access token")
	}
}

func TestWorkBuddyBackupRestoreDetectLive(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)

	if st, err := p.DetectLive(); err != nil || st.Present {
		t.Fatalf("DetectLive before login: present=%v err=%v", st.Present, err)
	}
	if _, err := p.Backup(t.TempDir()); err == nil {
		t.Fatal("Backup should fail with no live auth")
	}

	writeLiveAuth(t, p, workbuddyAuthDocument{
		Version:      workbuddyAuthVersion,
		Kind:         workbuddyKindSub,
		MethodID:     "workbuddy-international",
		Base:         "https://www.codebuddy.ai",
		Domain:       "www.codebuddy.ai",
		AccessToken:  "at-123",
		RefreshToken: "rt-456",
		UserID:       "user-9",
	})

	st, err := p.DetectLive()
	if err != nil || !st.Present {
		t.Fatalf("DetectLive after login: present=%v err=%v", st.Present, err)
	}
	if st.Identity != "user-9" {
		t.Fatalf("DetectLive identity = %q, want user-9", st.Identity)
	}

	dest := t.TempDir()
	info, err := p.Backup(dest)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if info.Identity != "user-9" {
		t.Fatalf("Backup identity = %q, want user-9", info.Identity)
	}
	// native keeps core restoring the desktop app's session on switch;
	// external_oauth records how the token was obtained.
	if info.CredentialKind != "native" || info.CredentialClass != "external_oauth" {
		t.Fatalf("Backup kind/class = %q/%q, want native/external_oauth",
			info.CredentialKind, info.CredentialClass)
	}
	if _, err := os.Stat(filepath.Join(dest, workbuddyAuthFile)); err != nil {
		t.Fatalf("backup file not written: %v", err)
	}

	p2 := newWorkBuddy(t.TempDir())
	if err := p2.Restore(dest); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if st, err := p2.DetectLive(); err != nil || !st.Present || st.Identity != "user-9" {
		t.Fatalf("DetectLive after restore: %+v err=%v", st, err)
	}

	desc, err := p2.DescribeSnapshot(dest)
	if err != nil {
		t.Fatalf("DescribeSnapshot: %v", err)
	}
	if desc.Identity != "user-9" || desc.CredentialKind != "native" {
		t.Fatalf("DescribeSnapshot = %+v", desc)
	}
}

// The desktop app's session is the live login AnyPick switches: DetectLive,
// Backup and Restore all reach it when no device-flow staging is present.
func TestWorkBuddyDetectLiveReadsNativeSession(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)

	if st, err := p.DetectLive(); err != nil || st.Present {
		t.Fatalf("DetectLive before session: present=%v err=%v", st.Present, err)
	}
	if err := writeWorkBuddyNativeSession(nativePath, workbuddyAuthDocument{
		Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
		Domain: "www.workbuddy.ai", AccessToken: "at-native", RefreshToken: "rt-native",
		UserID: "native-user",
	}); err != nil {
		t.Fatalf("write native session: %v", err)
	}
	st, err := p.DetectLive()
	if err != nil || !st.Present {
		t.Fatalf("DetectLive native: present=%v err=%v", st.Present, err)
	}
	if st.Identity != "native-user" {
		t.Fatalf("DetectLive identity = %q, want native-user", st.Identity)
	}
}

// A just-completed device flow wins over the app session: after Login the
// staging file holds the login being saved, not the one being replaced.
func TestWorkBuddyBackupPrefersStagingOverNative(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)
	if err := writeWorkBuddyNativeSession(nativePath, workbuddyAuthDocument{
		AccessToken: "at-native", UserID: "native-user",
	}); err != nil {
		t.Fatal(err)
	}
	writeLiveAuth(t, p, workbuddyAuthDocument{
		Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
		AccessToken: "at-staging", UserID: "staging-user",
	})

	info, err := p.Backup(t.TempDir())
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if info.Identity != "staging-user" {
		t.Fatalf("Backup identity = %q, want staging-user", info.Identity)
	}
}

func TestWorkBuddyBackupFromNativeSession(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)
	if err := writeWorkBuddyNativeSession(nativePath, workbuddyAuthDocument{
		Domain: "www.workbuddy.ai", AccessToken: "at-native",
		RefreshToken: "rt-native", UserID: "native-user",
	}); err != nil {
		t.Fatal(err)
	}

	dest := t.TempDir()
	info, err := p.Backup(dest)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if info.Identity != "native-user" || info.CredentialKind != "native" {
		t.Fatalf("Backup = %+v, want native-user/native", info)
	}
	doc, err := readWorkBuddyAuthDocument(filepath.Join(dest, workbuddyAuthFile))
	if err != nil || doc == nil {
		t.Fatalf("snapshot doc = %+v err=%v", doc, err)
	}
	if doc.AccessToken != "at-native" || doc.RefreshToken != "rt-native" {
		t.Fatalf("snapshot tokens = %q/%q", doc.AccessToken, doc.RefreshToken)
	}
	if doc.Base != "https://www.workbuddy.ai" || doc.Domain != "www.workbuddy.ai" {
		t.Fatalf("snapshot origin = %q/%q", doc.Base, doc.Domain)
	}
	if doc.MethodID != "workbuddy-international" {
		t.Fatalf("snapshot method = %q", doc.MethodID)
	}
}

// Restore must move the running app: the session file gets the snapshot's
// tokens while fields AnyPick does not own survive the merge.
func TestWorkBuddyRestoreWritesNativeSession(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)
	if err := os.WriteFile(nativePath, []byte(`{"account":{"uid":"old-user","nickname":"old"},"auth":{"accessToken":"at-old","refreshToken":"rt-old","domain":"www.workbuddy.ai"},"customSection":{"keep":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	snap := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
		Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
		MethodID: "workbuddy-international", Base: "https://www.codebuddy.ai",
		Domain: "www.codebuddy.ai", AccessToken: "at-new", RefreshToken: "rt-new",
		UserID: "new-user",
	}); err != nil {
		t.Fatal(err)
	}
	if err := p.Restore(snap); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	st, err := p.DetectLive()
	if err != nil || !st.Present || st.Identity != "new-user" {
		t.Fatalf("DetectLive after restore: %+v err=%v", st, err)
	}
	raw, err := os.ReadFile(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil {
		t.Fatalf("native session unreadable: %s", raw)
	}
	var auth struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		Domain       string `json:"domain"`
	}
	if json.Unmarshal(top["auth"], &auth) != nil {
		t.Fatalf("native auth unreadable: %s", top["auth"])
	}
	if auth.AccessToken != "at-new" || auth.RefreshToken != "rt-new" || auth.Domain != "www.codebuddy.ai" {
		t.Fatalf("native auth = %+v", auth)
	}
	if _, ok := top["customSection"]; !ok {
		t.Fatalf("native merge dropped unowned fields: %s", raw)
	}
}

func TestWorkBuddyNativeBaseForDomain(t *testing.T) {
	cases := map[string]string{
		"www.workbuddy.ai":     "https://www.workbuddy.ai",
		"www.codebuddy.ai":     "https://www.codebuddy.ai",
		"copilot.tencent.com":  "https://copilot.tencent.com",
		"www.codebuddy.cn":     "https://copilot.tencent.com",
		"":                     "",
		"  www.workbuddy.ai  ": "https://www.workbuddy.ai",
	}
	for domain, want := range cases {
		if got := workbuddyNativeBaseForDomain(domain); got != want {
			t.Fatalf("base(%q) = %q, want %q", domain, got, want)
		}
	}
}

// TestWorkBuddyResolveUpstreamFollowsIssuingHost pins the fix for the wrong
// endpoint: a token from one Tencent site is rejected by the other, so the
// host has to come from the credential rather than a package default.
func TestWorkBuddyResolveUpstreamFollowsIssuingHost(t *testing.T) {
	cases := map[string]string{
		"https://www.codebuddy.ai":    "https://www.codebuddy.ai/v2",
		"https://copilot.tencent.com": "https://copilot.tencent.com/v2",
	}
	for base, want := range cases {
		p := newWorkBuddy(t.TempDir())
		snap := t.TempDir()
		if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
			Version:     workbuddyAuthVersion,
			Kind:        workbuddyKindSub,
			Base:        base,
			AccessToken: "at-123",
			UserID:      "user-9",
		}); err != nil {
			t.Fatal(err)
		}
		up, err := p.ResolveUpstream(snap)
		if err != nil {
			t.Fatalf("ResolveUpstream(%s): %v", base, err)
		}
		if up.BaseURL.String() != want {
			t.Fatalf("base = %v, want %s", up.BaseURL, want)
		}
		if up.Auth != "at-123" || up.AuthHeader != "Authorization" || up.AuthValuePrefix != "Bearer " {
			t.Fatalf("upstream auth = %q %q %q", up.Auth, up.AuthHeader, up.AuthValuePrefix)
		}
		if !up.TranslateAnthropic {
			t.Fatal("TranslateAnthropic = false, want true for Anthropic-speaking clients")
		}
	}
}

// The chat surface follows the endpoint the desktop app resolved for this
// installation, not the site that issued the token: WorkBuddy's app calls
// www.workbuddy.ai while the device flow issues tokens from www.codebuddy.ai.
// China tokens keep their own host (they are rejected elsewhere).
func TestWorkBuddyResolveUpstreamPrefersProductEndpoint(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".workbuddy-ai", "cache")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, workbuddyProductCatalogFile),
		[]byte(`{"endpoint":"https://www.workbuddy.ai","models":[{"id":"hy3"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p := newWorkBuddy(home)
	snap := t.TempDir()
	writeAuth := func(method, base string) {
		t.Helper()
		if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
			Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
			MethodID: method, Base: base, AccessToken: "at-123",
		}); err != nil {
			t.Fatal(err)
		}
	}

	writeAuth("workbuddy-international", "https://www.codebuddy.ai")
	up, err := p.ResolveUpstream(snap)
	if err != nil {
		t.Fatal(err)
	}
	if got := up.BaseURL.String(); got != "https://www.workbuddy.ai/v2" {
		t.Fatalf("base = %s, want the product endpoint", got)
	}

	writeAuth("codebuddy-china", "https://copilot.tencent.com")
	up, err = p.ResolveUpstream(snap)
	if err != nil {
		t.Fatal(err)
	}
	if got := up.BaseURL.String(); got != "https://copilot.tencent.com/v2" {
		t.Fatalf("china base = %s, want the issuing host", got)
	}
}

func TestWorkBuddyResolveUpstreamOverride(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	snap := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
		Version:     workbuddyAuthVersion,
		Kind:        workbuddyKindSub,
		Base:        "https://www.codebuddy.ai",
		AccessToken: "at-123",
	}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WORKBUDDY_BASE_URL", "https://example.com/v1")
	up, err := p.ResolveUpstream(snap)
	if err != nil {
		t.Fatalf("ResolveUpstream (override): %v", err)
	}
	if up.BaseURL.String() != "https://example.com/v1" {
		t.Fatalf("override base = %v, want https://example.com/v1", up.BaseURL)
	}
}

func TestWorkBuddyResolveUpstreamNoCredential(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	if _, err := p.ResolveUpstream(t.TempDir()); err == nil {
		t.Fatal("ResolveUpstream should fail without a credential")
	}
}

func TestWorkBuddyClearLive(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	// Clearing a login that is not there is not an error.
	if err := p.ClearLive(); err != nil {
		t.Fatalf("ClearLive on empty: %v", err)
	}
	writeLiveAuth(t, p, workbuddyAuthDocument{
		Version: workbuddyAuthVersion, Kind: workbuddyKindSub, AccessToken: "at-123",
	})
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)
	if err := writeWorkBuddyNativeSession(nativePath, workbuddyAuthDocument{
		Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
		AccessToken: "at-native", UserID: "user-native",
	}); err != nil {
		t.Fatalf("write native session: %v", err)
	}
	if err := p.ClearLive(); err != nil {
		t.Fatalf("ClearLive: %v", err)
	}
	if st, err := p.DetectLive(); err != nil || st.Present {
		t.Fatalf("DetectLive after ClearLive: present=%v err=%v", st.Present, err)
	}
	if _, err := os.Stat(nativePath); !os.IsNotExist(err) {
		t.Fatalf("native session survives ClearLive: %v", err)
	}
}

func TestWorkBuddyTokenIdentity(t *testing.T) {
	mk := func(claims map[string]any) string {
		t.Helper()
		payload, err := json.Marshal(claims)
		if err != nil {
			t.Fatal(err)
		}
		return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
	}
	cases := []struct {
		name   string
		claims map[string]any
		want   string
	}{
		{"email wins", map[string]any{"sub": "uid-1", "preferred_username": "nick", "email": "a@b.com"}, "a@b.com"},
		{"username fallback", map[string]any{"sub": "uid-1", "preferred_username": "nick"}, "nick"},
		{"sub fallback", map[string]any{"sub": "uid-1"}, "uid-1"},
		{"blank email skipped", map[string]any{"sub": "uid-1", "email": "  "}, "uid-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := workbuddyTokenIdentity(mk(tc.claims)); got != tc.want {
				t.Fatalf("identity = %q, want %q", got, tc.want)
			}
		})
	}
	for _, bad := range []string{"", "not-a-jwt", "a.b.c"} {
		if got := workbuddyTokenIdentity(bad); got != "" {
			t.Fatalf("identity(%q) = %q, want empty", bad, got)
		}
	}
}

// The session identity is the readable email, while the merge still keys the
// app's uid field off the token sub — an email must never land in uid.
func TestWorkBuddyNativeDocPrefersEmailIdentity(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"sub": "uid-9", "email": "reader@example.com"})
	token := "header." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
	path := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	raw, _ := json.Marshal(map[string]any{
		"account": map[string]any{"uid": "uid-9", "nickname": "nick9"},
		"auth":    map[string]any{"accessToken": token, "domain": "www.workbuddy.ai"},
	})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	doc, err := readWorkBuddyNativeDoc(path)
	if err != nil || doc == nil {
		t.Fatalf("doc = %+v err=%v", doc, err)
	}
	if doc.UserID != "reader@example.com" {
		t.Fatalf("identity = %q, want reader@example.com", doc.UserID)
	}
	if err := writeWorkBuddyNativeSession(path, *doc); err != nil {
		t.Fatalf("merge: %v", err)
	}
	merged, _ := os.ReadFile(path)
	var top struct {
		Account struct {
			UID string `json:"uid"`
		} `json:"account"`
		Accounts []struct {
			UID string `json:"uid"`
		} `json:"accounts"`
	}
	if json.Unmarshal(merged, &top) != nil {
		t.Fatalf("unreadable: %s", merged)
	}
	if top.Account.UID != "uid-9" {
		t.Fatalf("account.uid = %q, want uid-9 (email leaked into uid)", top.Account.UID)
	}
	if len(top.Accounts) != 1 || top.Accounts[0].UID != "uid-9" {
		t.Fatalf("accounts mirror = %+v, want [uid-9]", top.Accounts)
	}
}

func TestWorkBuddyTokenSubject(t *testing.T) {
	claims, err := json.Marshal(map[string]string{"sub": "user-42"})
	if err != nil {
		t.Fatal(err)
	}
	token := "header." + base64.RawURLEncoding.EncodeToString(claims) + ".signature"
	if got := workbuddyTokenSubject(token); got != "user-42" {
		t.Fatalf("workbuddyTokenSubject = %q, want user-42", got)
	}
	for _, bad := range []string{"", "not-a-jwt", "a.b", "a.b.c"} {
		if got := workbuddyTokenSubject(bad); got != "" {
			t.Fatalf("workbuddyTokenSubject(%q) = %q, want empty", bad, got)
		}
	}
}

// An expired subscription token must block activation with a re-login hint
// instead of starting a proxy that 401s. Tokens without exp fail open.
func TestWorkBuddyValidateSnapshotRejectsExpiredToken(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	past := time.Now().Add(-time.Hour).Unix()
	future := time.Now().Add(time.Hour).Unix()

	cases := []struct {
		name    string
		claims  map[string]any
		wantErr bool
	}{
		{"expired", map[string]any{"sub": "user-1", "exp": float64(past)}, true},
		{"valid", map[string]any{"sub": "user-1", "exp": float64(future)}, false},
		{"no expiry fails open", map[string]any{"sub": "user-1"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(tc.claims)
			if err != nil {
				t.Fatal(err)
			}
			token := "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
			snap := t.TempDir()
			if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
				Version: workbuddyAuthVersion, Kind: workbuddyKindSub, AccessToken: token,
			}); err != nil {
				t.Fatal(err)
			}
			err = p.ValidateSnapshot(snap)
			if tc.wantErr {
				var ae *anyerr.Error
				if !errors.As(err, &ae) || ae.Code != "AUTH_REQUIRED" {
					t.Fatalf("ValidateSnapshot = %v, want AUTH_REQUIRED", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidateSnapshot = %v, want nil", err)
			}
		})
	}
}

func TestOpenBrowserURLRejectsNonHTTPS(t *testing.T) {
	for _, raw := range []string{"http://example.com", "file:///etc/passwd", ""} {
		if err := openBrowserURL(raw); err == nil {
			t.Fatalf("openBrowserURL(%q) accepted", raw)
		}
	}
}

// TestWorkBuddyStateIssueSendsNoEnterpriseHeaders pins the live-service fix:
// with X-No-Authorization / X-User-Id / X-Enterprise-Id / X-Department-Info
// the gateway answers code 10000 "enterprise not found" and Sign In dies
// instantly; without them it issues a state (verified live 2026-09-04).
func TestWorkBuddyStateIssueSendsNoEnterpriseHeaders(t *testing.T) {
	var sawForbiddenHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, h := range []string{
			"X-No-Authorization", "X-User-Id", "X-Enterprise-Id", "X-Department-Info",
		} {
			if r.Header.Get(h) != "" {
				sawForbiddenHeader = h
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(
			`{"code":0,"msg":"OK","data":{"state":"st-1","authUrl":"https://example.com/login?state=st-1"}}`))
	}))
	t.Cleanup(srv.Close)
	site := workbuddySite{
		MethodID: "test", Label: "Test", Description: "Test",
		Base: srv.URL, Domain: "example.com",
	}
	state, authURL, err := workbuddyStartLogin(context.Background(), site)
	if err != nil {
		t.Fatalf("start login: %v", err)
	}
	if sawForbiddenHeader != "" {
		t.Fatalf("state request carried %s", sawForbiddenHeader)
	}
	if state != "st-1" || authURL != "https://example.com/login?state=st-1" {
		t.Fatalf("state = %q authURL = %q", state, authURL)
	}
}

func TestWorkBuddySanitizeOpenAIBodyShapesSubscriptionChannel(t *testing.T) {
	in := []byte(`{"model":"hy4","messages":[{"role":"user","content":"hi"}]}`)
	out := workbuddySanitizeOpenAIBody(in)
	var v map[string]any
	if json.Unmarshal(out, &v) != nil {
		t.Fatalf("unreadable: %s", out)
	}
	if v["model"] != "hy4" {
		t.Fatalf("model = %v, want the caller's slug untouched", v["model"])
	}
	if v["stream"] != true {
		t.Fatalf("stream = %v, want true (vendor 11101 without it)", v["stream"])
	}
	msgs, _ := v["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want system+user", len(msgs))
	}
	sys, _ := msgs[0].(map[string]any)
	if sys["role"] != "system" {
		t.Fatalf("leading role = %v, want system (vendor 11128 without it)", sys["role"])
	}
	already := []byte(`{"model":"hy3","messages":[{"role":"system","content":"Keep."},{"role":"user","content":"hi"}]}`)
	got := workbuddySanitizeOpenAIBody(already)
	var v2 map[string]any
	_ = json.Unmarshal(got, &v2)
	msgs2, _ := v2["messages"].([]any)
	if len(msgs2) != 2 {
		t.Fatalf("existing system was duplicated: %s", got)
	}
}

// The vendor rejects padded or uppercase slugs with 11102 and object
// tool_choice with 11101 (both in proxy.log); the sanitizer normalises them.
func TestWorkBuddySanitizeOpenAIBodyNormalisesModelAndToolChoice(t *testing.T) {
	in := []byte(`{"model":" custom-local:HY3 ","tool_choice":{"type":"function","function":{"name":"t"}},"messages":[{"role":"user","content":"hi"}]}`)
	out := workbuddySanitizeOpenAIBody(in)
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unreadable: %s", out)
	}
	if got["model"] != "hy3" {
		t.Fatalf("model = %v, want hy3", got["model"])
	}
	if got["tool_choice"] != "required" {
		t.Fatalf("tool_choice = %v, want required", got["tool_choice"])
	}

	strChoice := []byte(`{"model":"hy3","tool_choice":"auto","messages":[{"role":"system","content":"Keep."},{"role":"user","content":"hi"}]}`)
	out = workbuddySanitizeOpenAIBody(strChoice)
	var kept map[string]any
	if err := json.Unmarshal(out, &kept); err != nil {
		t.Fatalf("unreadable: %s", out)
	}
	if kept["tool_choice"] != "auto" || kept["model"] != "hy3" {
		t.Fatalf("string choice/model changed: %s", out)
	}
}

func TestWorkBuddySanitizeOpenAIBodyForcesStream(t *testing.T) {
	out := workbuddySanitizeOpenAIBody([]byte(
		`{"model":"hy3","stream":false,"messages":[{"role":"system","content":"Keep."},{"role":"user","content":"hi"}]}`))
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unreadable: %s", out)
	}
	if got["stream"] != true {
		t.Fatalf("stream = %v, want true", got["stream"])
	}
}

func TestWorkBuddySanitizeOpenAIBodyStripsLocalModelNamespace(t *testing.T) {
	in := []byte(`{"model":"custom-local:deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}`)
	out := workbuddySanitizeOpenAIBody(in)
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unreadable: %s", out)
	}
	if got["model"] != "deepseek-v4.1-flash" {
		t.Fatalf("model = %v, want provider model id", got["model"])
	}
}

func TestWorkBuddySanitizeOpenAIBodyRedactsAgentBrandingOnlyInInternalBlocks(t *testing.T) {
	in := []byte(`{"model":"hy3","messages":[` +
		`{"role":"system","content":"You are Codex CLI from OpenAI. Use MCP."},` +
		`{"role":"user","content":"This is a long internal workspace preamble mentioning Codex and OpenAI."},` +
		`{"role":"user","content":"Please mention Codex exactly."}]}`)
	// Make the internal block long enough to exercise the metadata boundary.
	var doc map[string]interface{}
	if err := json.Unmarshal(in, &doc); err != nil {
		t.Fatal(err)
	}
	msgs, _ := doc["messages"].([]interface{})
	internal, _ := msgs[1].(map[string]interface{})
	internal["content"] = strings.Repeat("workspace Codex OpenAI ", 80)
	in, _ = json.Marshal(doc)

	out := workbuddySanitizeOpenAIBody(in)
	var got map[string]interface{}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	msgs, _ = got["messages"].([]interface{})
	system, _ := msgs[0].(map[string]interface{})
	if strings.Contains(strings.ToLower(system["content"].(string)), "codex") {
		t.Fatalf("system branding survived: %s", system["content"])
	}
	internal, _ = msgs[1].(map[string]interface{})
	if strings.Contains(strings.ToLower(internal["content"].(string)), "openai") {
		t.Fatal("long internal branding survived")
	}
	user, _ := msgs[2].(map[string]interface{})
	if user["content"] != "Please mention Codex exactly." {
		t.Fatalf("short user prompt changed: %v", user["content"])
	}
}

func TestWorkBuddyResolveUpstreamCarriesCLIHeaders(t *testing.T) {
	p := newWorkBuddy(t.TempDir())
	snap := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
		Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
		MethodID: "workbuddy-international", Base: "https://www.codebuddy.ai",
		Domain: "www.codebuddy.ai", AccessToken: "at-123",
	}); err != nil {
		t.Fatal(err)
	}
	up, err := p.ResolveUpstream(snap)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, h := range up.ExtraHeaders {
		got[h.Name] = h.Value
	}
	if got["User-Agent"] != workbuddyUserAgent {
		t.Fatalf("User-Agent = %q", got["User-Agent"])
	}
	if got["X-Domain"] != "www.codebuddy.ai" || got["X-Product"] != "SaaS" {
		t.Fatalf("channel headers = %+v", got)
	}
	if up.DynamicHeaders == nil {
		t.Fatal("DynamicHeaders = nil, want per-request CodeBuddy metadata")
	}
	dynamic, err := up.DynamicHeaders(context.Background())
	if err != nil {
		t.Fatalf("DynamicHeaders: %v", err)
	}
	dynamicMap := map[string]string{}
	dropped := map[string]bool{}
	for _, h := range dynamic {
		if h.Drop {
			dropped[h.Name] = true
			continue
		}
		dynamicMap[h.Name] = h.Value
		if strings.Contains(h.Value, "at-123") {
			t.Fatalf("dynamic header leaked upstream credential: %q", h.Name)
		}
	}
	if !dropped["X-Agent-Intent"] {
		t.Fatal("X-Agent-Intent must be dropped; craft puts the subscription in the write-agent loop")
	}
	if dynamicMap["X-Agent-Intent"] != "" {
		t.Fatalf("X-Agent-Intent must not be set, got %q", dynamicMap["X-Agent-Intent"])
	}
	for _, name := range []string{
		"X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID",
		"X-Request-ID", "X-IDE-Type", "X-IDE-Name",
		"X-IDE-Version", "X-Private-Data",
	} {
		if dynamicMap[name] == "" {
			t.Fatalf("dynamic header %s missing: %+v", name, dynamicMap)
		}
	}

	again, err := up.DynamicHeaders(context.Background())
	if err != nil {
		t.Fatalf("DynamicHeaders second call: %v", err)
	}
	againMap := map[string]string{}
	for _, h := range again {
		againMap[h.Name] = h.Value
	}
	if againMap["X-Conversation-ID"] == "" || againMap["X-Conversation-ID"] == dynamicMap["X-Conversation-ID"] {
		t.Fatalf("conversation id reused across requests: %q then %q",
			dynamicMap["X-Conversation-ID"], againMap["X-Conversation-ID"])
	}
}

func TestWorkBuddyModelDiscoveryReadsProductCatalog(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".workbuddy-ai", "cache", workbuddyProductCatalogFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"models":[
    {"id":"default-model"},
    {"id":"fast-model"},
    {"id":"hy3"},
    {"id":"deepseek-v4.1-flash"},
    {"id":"custom-local:hy3"},
    {"id":"custom-local:deepseek-v4.1-flash"},
    {"id":"balanced-model"},
    {"id":"hy3"},
    {"id":"  "}
  ]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models, err := workbuddyModelDiscovery(home)(context.Background())
	if err != nil {
		t.Fatalf("model discovery: %v", err)
	}
	if got := strings.Join(models, ","); got != "hy3,deepseek-v4.1-flash" {
		t.Fatalf("models = %q, want hy3,deepseek-v4.1-flash", got)
	}
}

// The current product catalogue also lists image and video generation models.
// They carry no supportsToolCall, and no agent client can use them.
func TestWorkBuddyModelDiscoveryDropsModelsWithoutToolCalls(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".workbuddy-ai", "cache", workbuddyProductCatalogFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"models":[
    {"id":"default-model","supportsToolCall":true},
    {"id":"gpt-6-sol","supportsToolCall":true},
    {"id":"glm-5.3","supportsToolCall":true},
    {"id":"chat-no-tools","supportsToolCall":false},
    {"id":"hy-image-3.5","tags":["text-to-image","image-to-image"]},
    {"id":"kling-video-v3","tags":["text-to-video"],"videoGeneration":{"maxSeconds":15}}
  ]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models, err := workbuddyModelDiscovery(home)(context.Background())
	if err != nil {
		t.Fatalf("model discovery: %v", err)
	}
	if got := strings.Join(models, ","); got != "gpt-6-sol,glm-5.3" {
		t.Fatalf("models = %q, want gpt-6-sol,glm-5.3", got)
	}
}

// A catalogue from before supportsToolCall existed still carries the
// custom-local entries AnyPick wrote, and those set the field. They must not
// make the old catalogue look declared, or every product model is dropped.
func TestWorkBuddyModelDiscoveryIgnoresOwnEntriesForToolCallDeclaration(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".workbuddy-ai", "cache", workbuddyProductCatalogFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"models":[
    {"id":"default-model","supportsToolCall":true},
    {"id":"`+workbuddyCustomLocalModelPrefix+`gpt-6-sol","supportsToolCall":true},
    {"id":"hy3"},
    {"id":"glm-5.3"}
  ]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models, err := workbuddyModelDiscovery(home)(context.Background())
	if err != nil {
		t.Fatalf("model discovery: %v", err)
	}
	if got := strings.Join(models, ","); got != "hy3,glm-5.3" {
		t.Fatalf("models = %q, want hy3,glm-5.3", got)
	}
}

// TestWorkBuddyStalledServerFailsFast pins the per-request timeout: the poll
// loop's five-minute deadline only applies between iterations, so without a
// bound on one request a stalled connection holds Sign In — and the desktop
// sheet's spinner — forever with no terminal result.
func TestWorkBuddyStalledServerFailsFast(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second)
	}))
	t.Cleanup(srv.Close)
	site := workbuddySite{
		MethodID: "test", Label: "Test", Description: "Test",
		Base: srv.URL, Domain: "example.com",
	}

	old := workbuddyHTTPTimeout
	workbuddyHTTPTimeout = 100 * time.Millisecond
	t.Cleanup(func() { workbuddyHTTPTimeout = old })

	start := time.Now()
	_, _, err := workbuddyStartLogin(context.Background(), site)
	if err == nil {
		t.Fatal("stalled state request succeeded")
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("stalled request took %v, want a fast failure", elapsed)
	}
	var ae *anyerr.Error
	if !errors.As(err, &ae) || ae.Code != "PROVIDER_LOGIN_FAILED" {
		t.Fatalf("code = %v, want PROVIDER_LOGIN_FAILED", err)
	}
}

func makeWorkBuddyTestJWT(sub, email, username, sid string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	claims := map[string]string{
		"sub":                sub,
		"email":              email,
		"preferred_username": username,
		"sid":                sid,
	}
	raw, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return header + "." + payload + ".sig"
}

func TestWorkBuddyRestoreSyncsNicknameAndSessionState(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)

	oldToken := makeWorkBuddyTestJWT("old-sub", "old@example.com", "olduser", "old-sid")
	newToken := makeWorkBuddyTestJWT("new-sub", "new@example.com", "newuser", "new-sid")

	initial := []byte(`{
		"account": {"uid": "old-sub", "nickname": "old@example.com", "lastLogin": true},
		"auth": {"accessToken": "` + oldToken + `", "sessionState": "old-sid", "domain": "www.codebuddy.ai"}
	}`)
	if err := os.WriteFile(nativePath, initial, 0o600); err != nil {
		t.Fatal(err)
	}

	snap := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
		Version:      workbuddyAuthVersion,
		Kind:         workbuddyKindSub,
		MethodID:     "workbuddy-international",
		Base:         "https://www.codebuddy.ai",
		Domain:       "www.codebuddy.ai",
		AccessToken:  newToken,
		RefreshToken: "rt-new",
		UserID:       "new@example.com",
	}); err != nil {
		t.Fatal(err)
	}

	if err := p.Restore(snap); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	raw, err := os.ReadFile(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Account struct {
			UID       string `json:"uid"`
			Nickname  string `json:"nickname"`
			LastLogin bool   `json:"lastLogin"`
		} `json:"account"`
		Auth struct {
			AccessToken  string `json:"accessToken"`
			SessionState string `json:"sessionState"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal native session: %v", err)
	}

	if doc.Account.UID != "new-sub" {
		t.Errorf("account.uid = %q, want new-sub", doc.Account.UID)
	}
	if doc.Account.Nickname != "new@example.com" {
		t.Errorf("account.nickname = %q, want new@example.com", doc.Account.Nickname)
	}
	if !doc.Account.LastLogin {
		t.Error("account.lastLogin = false, want true")
	}
	if doc.Auth.SessionState != "new-sid" {
		t.Errorf("auth.sessionState = %q, want new-sid", doc.Auth.SessionState)
	}
}

func TestWorkBuddyRestoreUpdatesAccountLists(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)

	oldToken := makeWorkBuddyTestJWT("old-sub", "old@example.com", "olduser", "old-sid")
	newToken := makeWorkBuddyTestJWT("new-sub", "new@example.com", "newuser", "new-sid")

	initial := []byte(`{
		"account": {"uid": "old-sub", "nickname": "old@example.com", "lastLogin": true},
		"auth": {"accessToken": "` + oldToken + `", "domain": "www.codebuddy.ai"},
		"accounts": [
			{"uid": "old-sub", "nickname": "old@example.com", "lastLogin": true}
		],
		"allAccounts": [
			{"uid": "old-sub", "nickname": "old@example.com", "lastLogin": true}
		]
	}`)
	if err := os.WriteFile(nativePath, initial, 0o600); err != nil {
		t.Fatal(err)
	}

	snap := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snap, workbuddyAuthFile), workbuddyAuthDocument{
		Version:      workbuddyAuthVersion,
		Kind:         workbuddyKindSub,
		MethodID:     "workbuddy-international",
		Base:         "https://www.codebuddy.ai",
		Domain:       "www.codebuddy.ai",
		AccessToken:  newToken,
		RefreshToken: "rt-new",
		UserID:       "new@example.com",
	}); err != nil {
		t.Fatal(err)
	}

	if err := p.Restore(snap); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	raw, err := os.ReadFile(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		AllAccounts []struct {
			UID       string `json:"uid"`
			Nickname  string `json:"nickname"`
			LastLogin bool   `json:"lastLogin"`
		} `json:"allAccounts"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal native session: %v", err)
	}

	if len(doc.AllAccounts) != 2 {
		t.Fatalf("allAccounts count = %d, want 2", len(doc.AllAccounts))
	}

	var foundOld, foundNew bool
	for _, entry := range doc.AllAccounts {
		if entry.UID == "old-sub" {
			foundOld = true
			if entry.LastLogin {
				t.Error("old account in allAccounts has lastLogin=true, want false")
			}
		}
		if entry.UID == "new-sub" {
			foundNew = true
			if !entry.LastLogin {
				t.Error("new account in allAccounts has lastLogin=false, want true")
			}
			if entry.Nickname != "new@example.com" {
				t.Errorf("new account in allAccounts nickname = %q, want new@example.com", entry.Nickname)
			}
		}
	}
	if !foundOld || !foundNew {
		t.Fatalf("foundOld=%v foundNew=%v in allAccounts: %+v", foundOld, foundNew, doc.AllAccounts)
	}
}

func TestWorkBuddySnapshotMatchesLive(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)

	tokenA := makeWorkBuddyTestJWT("sub-a", "a@example.com", "userA", "sid-a")
	tokenB := makeWorkBuddyTestJWT("sub-b", "b@example.com", "userB", "sid-b")

	snapDirA := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snapDirA, workbuddyAuthFile), workbuddyAuthDocument{
		AccessToken: tokenA,
		UserID:      "a@example.com",
	}); err != nil {
		t.Fatal(err)
	}

	snapDirB := t.TempDir()
	if err := writeWorkBuddyAuthDocument(filepath.Join(snapDirB, workbuddyAuthFile), workbuddyAuthDocument{
		AccessToken: tokenB,
		UserID:      "b@example.com",
	}); err != nil {
		t.Fatal(err)
	}

	// No live file yet: match=false, known=true
	match, known, err := p.SnapshotMatchesLive(snapDirA)
	if err != nil || match || !known {
		t.Fatalf("no live session: match=%v known=%v err=%v, want false/true", match, known, err)
	}

	// Live file matches snapDirA
	if err := writeWorkBuddyNativeSession(nativePath, workbuddyAuthDocument{
		AccessToken: tokenA,
		UserID:      "a@example.com",
	}); err != nil {
		t.Fatal(err)
	}

	match, known, err = p.SnapshotMatchesLive(snapDirA)
	if err != nil || !match || !known {
		t.Fatalf("matching session: match=%v known=%v err=%v, want true/true", match, known, err)
	}

	// Live file differs from snapDirB
	match, known, err = p.SnapshotMatchesLive(snapDirB)
	if err != nil || match || !known {
		t.Fatalf("differing session: match=%v known=%v err=%v, want false/true", match, known, err)
	}
}

func TestWorkBuddyDetectLivePrefersNewerNativeSession(t *testing.T) {
	home := t.TempDir()
	p := newWorkBuddy(home)
	nativePath := filepath.Join(t.TempDir(), "workbuddy-desktop-ai.info")
	t.Setenv("WORKBUDDY_NATIVE_AUTH_PATH", nativePath)

	// 1. Staging file is created first
	writeLiveAuth(t, p, workbuddyAuthDocument{
		AccessToken: "at-staging",
		UserID:      "staging-user@example.com",
	})
	stagingPath := p.authPath()
	oldTime := time.Now().Add(-1 * time.Hour)
	if err := os.Chtimes(stagingPath, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	// 2. User logged in via desktop app later (native file newer)
	if err := writeWorkBuddyNativeSession(nativePath, workbuddyAuthDocument{
		AccessToken: "at-native",
		UserID:      "native-user@example.com",
	}); err != nil {
		t.Fatal(err)
	}
	newerTime := time.Now()
	if err := os.Chtimes(nativePath, newerTime, newerTime); err != nil {
		t.Fatal(err)
	}

	st, err := p.DetectLive()
	if err != nil || !st.Present {
		t.Fatalf("DetectLive: present=%v err=%v", st.Present, err)
	}
	if st.Identity != "native-user@example.com" {
		t.Fatalf("DetectLive identity = %q, want native-user@example.com", st.Identity)
	}
}
