package provider

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/transport"
)

func TestCompatibleIdentityGetters(t *testing.T) {
	def := BuiltinDefinitions()[0]
	pv, err := NewCompatible(def)
	if err != nil {
		t.Fatal(err)
	}
	if pv.ID() != def.ID || pv.Name() != def.Name || pv.Description() != def.Description {
		t.Fatalf("identity getters diverge from definition: %q/%q/%q", pv.ID(), pv.Name(), pv.Description())
	}
	if !pv.CanProxy() {
		t.Fatal("compatible vendors must ride the builtin proxy")
	}
	if pv.Definition().ID != def.ID {
		t.Fatal("Definition() must echo the inert definition")
	}

	// AccountAdapter: claude, codex, pi and omp may accept this source.
	adapter := pv.AccountAdapter("main", false)
	for _, clientID := range []string{"claude", "codex", "pi", "omp"} {
		if got := adapter.TransportFor(clientID); got != transport.ManagedBuiltinProxy {
			t.Fatalf("TransportFor(%s) = %v", clientID, got)
		}
	}
	if got := adapter.TransportFor("gemini"); got != transport.Unsupported {
		t.Fatalf("gemini must be unsupported, got %v", got)
	}
	if adapter.Capabilities.Provider != def.ID || adapter.SourceRef.Name != "main" {
		t.Fatalf("adapter identity wrong: %+v", adapter)
	}
}

func TestKiroPoolAdapterUsesExternalBridge(t *testing.T) {
	p := newKiro(t.TempDir())
	pool, ok := interface{}(p).(poolAdapterProvider)
	if !ok {
		t.Fatal("kiro must expose PoolAdapter")
	}
	adapter := pool.PoolAdapter()
	if adapter.SourceRef.Kind != "account-pool" || adapter.SourceRef.Provider != "kiro" {
		t.Fatalf("unexpected pool adapter ref: %+v", adapter.SourceRef)
	}
	if p.CanProxy() {
		t.Fatal("kiro must not use the builtin proxy")
	}
	if p.ID() != "kiro" || p.ShortName() != "Kiro" {
		t.Fatalf("identity: %q/%q", p.ID(), p.ShortName())
	}
}

func TestIdentityFromTokenFileVariants(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"snake arn", `{"profile_arn":"arn:aws:prof/TeamLead"}`, "TeamLead"},
		{"camel arn", `{"profileArn":"arn:aws:prof/Member"}`, "Member"},
		{"with provider", `{"profile_arn":"arn:x/p","provider":"BuilderId"}`, "BuilderId:p"},
		{"no arn", `{"provider":"X"}`, ""},
		{"bad json", `{oops`, ""},
	}
	for _, tc := range cases {
		path := write(strings.ReplaceAll(tc.name, " ", "_")+".json", tc.content)
		if got := identityFromTokenFile(path); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
	if got := identityFromTokenFile(filepath.Join(dir, "missing.json")); got != "" {
		t.Errorf("missing file: got %q", got)
	}
}

func TestSameStringMap(t *testing.T) {
	if !sameStringMap(nil, nil) || !sameStringMap(map[string]string{}, map[string]string{}) {
		t.Fatal("empty maps are equal")
	}
	a := map[string]string{"k": "v"}
	if sameStringMap(a, nil) || sameStringMap(nil, a) {
		t.Fatal("nil vs non-nil differ")
	}
	if !sameStringMap(map[string]string{"k": "v", "x": "y"}, map[string]string{"x": "y", "k": "v"}) {
		t.Fatal("order independent equality")
	}
	if sameStringMap(map[string]string{"k": "v"}, map[string]string{"k": "w"}) {
		t.Fatal("value mismatch")
	}
	if sameStringMap(map[string]string{"k": ""}, map[string]string{}) {
		t.Fatal("empty value is still a key")
	}
}

func TestCodexLiveUsageErrorBranches(t *testing.T) {
	dir := t.TempDir()
	authPath := filepath.Join(dir, "auth.json")
	t.Setenv("CODEX_AUTH_PATH", authPath)
	p := newCodex(dir)

	// Missing auth file.
	if _, err := p.LiveUsage(context.Background()); err == nil {
		t.Fatal("want error without auth.json")
	}
	// Auth file without an access token.
	if err := os.WriteFile(authPath, []byte(`{"tokens":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.LiveUsage(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "no access token") {
		t.Fatalf("want no-access-token error, got %v", err)
	}
	// Corrupt JSON.
	if err := os.WriteFile(authPath, []byte(`{oops`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.LiveUsage(context.Background()); err == nil {
		t.Fatal("corrupt auth.json must error")
	}
}

func TestExpandHomeVariants(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	if got := expandHome("~"); got != home {
		t.Fatalf("~ => %q want %q", got, home)
	}
	if got := expandHome("~/x/y"); got != filepath.Join(home, "x", "y") {
		t.Fatalf("~/x/y => %q", got)
	}
	for _, unchanged := range []string{"", "/abs/path", "rel/path", "~user/x"} {
		if got := expandHome(unchanged); got != unchanged {
			t.Fatalf("%q changed to %q", unchanged, got)
		}
	}
}

func TestNumberValueAndResetAtMs(t *testing.T) {
	if numberValue(float64(2.5)) != 2.5 || numberValue(7) != 7 {
		t.Fatal("numeric conversions")
	}
	if !math.IsNaN(numberValue("5")) || !math.IsNaN(numberValue(nil)) {
		t.Fatal("non-numbers must be NaN")
	}

	ms := 1717171717000.0
	if got := resetAtMs(map[string]interface{}{"resets_at_ms": ms}, 0); got == nil || *got != ms {
		t.Fatal("resets_at_ms not read")
	}
	if got := resetAtMs(map[string]interface{}{"reset_at_ms": ms}, 0); got == nil || *got != ms {
		t.Fatal("reset_at_ms fallback not read")
	}
	if got := resetAtMs(map[string]interface{}{"resets_at_ms": "soon"}, 0); got != nil {
		t.Fatal("non-numeric reset must be nil")
	}
	if got := resetAtMs(map[string]interface{}{}, 0); got != nil {
		t.Fatal("absent reset must be nil")
	}
	if got := resetAtMs(map[string]interface{}{"reset_at": 1717171717.0}, 0); got == nil ||
		*got != 1717171717000.0 {
		t.Fatal("reset_at seconds not converted")
	}
	if got := resetAtMs(map[string]interface{}{"reset_after_seconds": 60.0}, 1000); got == nil ||
		*got != 61000.0 {
		t.Fatal("reset_after_seconds not anchored")
	}
}

func grokSessions(t *testing.T, raw string) map[string]json.RawMessage {
	t.Helper()
	out := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestGrokIdentityVariants(t *testing.T) {
	email := grokSessions(t, `{"s":{"email":"a@b.dev"}}`)
	if got := grokIdentity(email); got != "a@b.dev" {
		t.Fatalf("email key: %q", got)
	}
	userEmail := grokSessions(t, `{"s":{"user_email":"u@d.io"}}`)
	if got := grokIdentity(userEmail); got != "u@d.io" {
		t.Fatalf("user_email key: %q", got)
	}
	nested := grokSessions(t, `{"s":{"user":{"email":"n@e.org"}}}`)
	if got := grokIdentity(nested); got != "n@e.org" {
		t.Fatalf("nested user: %q", got)
	}
	none := grokSessions(t, `{"s":{"name":"x"},"t":42}`)
	if got := grokIdentity(none); got != "" {
		t.Fatalf("no email anywhere: %q", got)
	}
	bad := map[string]json.RawMessage{"s": json.RawMessage(`{oops`)}
	if got := grokIdentity(bad); got != "" {
		t.Fatalf("garbage session: %q", got)
	}
}

func TestGrokDescribeSnapshotVariants(t *testing.T) {
	dir := t.TempDir()
	p := newGrok(dir)

	// Missing snapshot → zero info, no error.
	info, err := p.DescribeSnapshot(dir)
	if err != nil || info.Identity != "" {
		t.Fatalf("missing snapshot: %+v %v", info, err)
	}
	// With a session email.
	snap := t.TempDir()
	if err := os.WriteFile(filepath.Join(snap, "auth.json"),
		[]byte(`{"s":{"email":"g@x.ai"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err = p.DescribeSnapshot(snap)
	if err != nil || info.Identity != "g@x.ai" {
		t.Fatalf("snapshot identity: %+v %v", info, err)
	}
	// Corrupt snapshot parses as no identity.
	if err := os.WriteFile(filepath.Join(snap, "auth.json"), []byte(`{nope`), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err = p.DescribeSnapshot(snap)
	if err != nil || info.Identity != "" {
		t.Fatalf("corrupt snapshot: %+v %v", info, err)
	}
}

func TestOpenCodeIdentityVariants(t *testing.T) {
	parse := func(raw string) map[string]json.RawMessage {
		t.Helper()
		out := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(raw), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	jwt := parse(`{"openai":{"type":"oauth","access":"` + fakeJWT(map[string]string{"email": "oc@x.dev"}) + `"}}`)
	if got := openCodeIdentity(jwt); got != "oc@x.dev" {
		t.Fatalf("jwt email: %q", got)
	}
	meta := parse(`{"p":{"type":"oauth","metadata":{"email":"m@k.io"}}}`)
	if got := openCodeIdentity(meta); got != "m@k.io" {
		t.Fatalf("metadata email: %q", got)
	}
	long := parse(`{"p":{"type":"oauth","accountId":"abcdefghijk-wider"}}`)
	if got := openCodeIdentity(long); got != "p:abcdefghijk-" {
		t.Fatalf("account prefix: %q", got)
	}
	short := parse(`{"p":{"type":"oauth","accountId":"abc"}}`)
	if got := openCodeIdentity(short); got != "p:abc" {
		t.Fatalf("short account: %q", got)
	}
	apiKey := parse(`{"p":{"type":"api_key","access":"` + fakeJWT(map[string]string{"email": "z@z.z"}) + `"}}`)
	if got := openCodeIdentity(apiKey); got != "" {
		t.Fatalf("non-oauth entry: %q", got)
	}
	if got := openCodeIdentity(map[string]json.RawMessage{}); got != "" {
		t.Fatalf("empty store: %q", got)
	}
}

func TestOpenCodeDetectAndDescribe(t *testing.T) {
	dir := t.TempDir()
	authPath := filepath.Join(dir, "auth.json")
	t.Setenv("OPENCODE_AUTH_PATH", authPath)
	// liveOpenCodeAuthStatus probes the REAL user home's opencode.db; pin
	// HOME so the test never sees the developer's actual Zen/Go login.
	t.Setenv("HOME", dir)
	p := newOpenCode(dir)

	// No file → absent.
	live, err := p.DetectLive()
	if err != nil || live.Present {
		t.Fatalf("absent live: %+v %v", live, err)
	}

	// OAuth entry → present with JWT identity.
	raw := `{"openai":{"type":"oauth","access":"` + fakeJWT(map[string]string{"email": "live@oc.dev"}) + `"}}`
	if err := os.WriteFile(authPath, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	live, err = p.DetectLive()
	if err != nil || !live.Present || live.Identity != "live@oc.dev" {
		t.Fatalf("oauth detect: %+v %v", live, err)
	}

	// Snapshot describe mirrors it.
	snap := t.TempDir()
	info, err := p.DescribeSnapshot(snap)
	if err != nil || info.Identity != "" {
		t.Fatalf("describe missing: %+v %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(snap, "auth.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err = p.DescribeSnapshot(snap)
	if err != nil || info.Identity != "live@oc.dev" {
		t.Fatalf("describe: %+v %v", info, err)
	}
}

func TestGeminiOauthEmailFallbacks(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GEMINI_CONFIG_DIR", dir)
	g := newGemini(dir)

	cfgDir := dir // GEMINI_CONFIG_DIR override wins over home

	// Neither file → "".
	if got := g.oauthEmail(); got != "" {
		t.Fatalf("empty config: %q", got)
	}
	// id_token claim wins.
	idToken := fakeJWT(map[string]string{"email": "gm@gmail"})
	if err := os.WriteFile(filepath.Join(cfgDir, "oauth_creds.json"),
		[]byte(`{"id_token":"`+idToken+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := g.oauthEmail(); got != "gm@gmail" {
		t.Fatalf("id_token email: %q", got)
	}
	// google_accounts.json fallback when the token carries no email.
	if err := os.WriteFile(filepath.Join(cfgDir, "oauth_creds.json"),
		[]byte(`{"id_token":"not-a-jwt"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "google_accounts.json"),
		[]byte(`[{"email":"acct@gmail"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := g.oauthEmail(); got != "acct@gmail" {
		t.Fatalf("accounts fallback: %q", got)
	}
}
