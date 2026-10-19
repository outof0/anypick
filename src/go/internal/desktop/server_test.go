package desktop

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/modelcache"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/store"
)

type trayEnv struct {
	t      *testing.T
	Root   string
	Home   string
	CodexA string // live auth path
	Deps   Deps
	Svc    *accounts.Service
}

func newTrayEnv(t *testing.T) *trayEnv {
	t.Helper()
	root := t.TempDir()
	home := t.TempDir()
	// Adapters also resolve fallback homes and OS credential stores. Passing
	// home into the registries alone does not isolate those paths (ADR 0004).
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("ANYPICK_HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	for _, key := range []string{"CODEX_HOME", "GROK_AUTH_PATH", "OPENCODE_AUTH_PATH", "OPENCODE_DATA_DIR", "KIRO_SSO_CACHE_DIR", "ANYPICK_KIRO_SECRET_DB", "WORKBUDDY_AUTH_PATH", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "GEMINI_CLI_HOME", "GEMINI_CONFIG_DIR", "DSH_HOME", "ANYPICK_ZAI_CREDENTIALS_PATH", "ANYPICK_ZAI_LIVE_PATH"} {
		t.Setenv(key, "")
	}
	codexAuth := filepath.Join(home, ".codex", "auth.json")
	t.Setenv("CODEX_AUTH_PATH", codexAuth)
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "1")
	t.Setenv("ANYPICK_KIRO_NO_KEYCHAIN", "1")
	t.Setenv("ANYPICK_CLAUDE_CREDENTIALS_PATH", filepath.Join(home, ".claude", ".credentials.json"))

	database, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	st := store.New(root, database)
	provReg := provider.NewRegistry()
	if err := provider.RegisterBuiltin(provReg, home); err != nil {
		t.Fatal(err)
	}
	if err := provider.RegisterBuiltinCompatibles(provReg, home); err != nil {
		t.Fatal(err)
	}
	clientReg := client.NewRegistry()
	// Production passes the data root too (app.compose), which is what gives
	// the Codex adapter its named-profile root. Without it the adapter falls
	// back to the ambient ANYPICK_HOME and a test would write outside its
	// temp root.
	if err := client.RegisterBuiltin(clientReg, home, root); err != nil {
		t.Fatal(err)
	}
	svc := accounts.New(st, provReg)
	px := proxy.New(st, &proxy.LeaseStore{Root: home, DB: database.DB})
	px.Resolver = &trayUpstreamResolver{}
	svc.Proxy = px

	env := &trayEnv{t: t, Root: root, Home: home, CodexA: codexAuth, Svc: svc}
	env.Deps = Deps{
		Root: root, Store: st, Accounts: svc, Proxy: px,
		Providers: provReg, Clients: clientReg,
		Profiles:    profile.NewService(&profile.Store{Root: root, DB: database.DB}),
		Bindings:    bindings.NewService(&bindings.Store{Root: root, DB: database.DB}),
		Inspections: NewInspectionManager(svc),
		ModelCache:  &modelcache.Store{DB: database},
	}
	cfgStore := config.NewStore(root, database)
	env.Deps.Config = config.NewService(cfgStore)
	return env
}

type trayUpstreamResolver struct{}

func (r *trayUpstreamResolver) ResolveUpstream(context.Context, string, string) (*proxy.Upstream, error) {
	base, _ := parseURLT("http://127.0.0.1:9") // never dialed in these tests
	return &proxy.Upstream{BaseURL: base, Auth: "x"}, nil
}

// delegatingUpstreamResolver mirrors internal/app's snapshot resolver: it
// dispatches ResolveUpstream to the real provider, so tests exercise
// provider-owned discovery instead of the tray stub's discovery-less
// upstream (which would hide a missing ModelDiscovery behind
// ErrModelDiscoveryUnsupported).
type delegatingUpstreamResolver struct{ env *trayEnv }

func (r *delegatingUpstreamResolver) ResolveUpstream(ctx context.Context, providerID, accountName string) (*proxy.Upstream, error) {
	pv, err := r.env.Deps.Providers.Get(providerID)
	if err != nil {
		return nil, err
	}
	acct, err := r.env.Deps.Store.Get(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		return nil, &snapshotMissingError{label: providerID + "/" + accountName}
	}
	if compat, ok := pv.(interface {
		ResolveUpstream(snapshotDir string) (*proxy.Upstream, error)
	}); ok {
		return compat.ResolveUpstream(acct.SnapshotDir)
	}
	return nil, &snapshotMissingError{label: "upstream for " + providerID}
}

type snapshotMissingError struct{ label string }

func (e *snapshotMissingError) Error() string { return "no snapshot: " + e.label }

func (e *trayEnv) writeCodexLive(email string) {
	e.t.Helper()
	data, _ := json.Marshal(map[string]interface{}{
		"auth_mode": "chatgpt",
		"tokens": map[string]string{
			"id_token":     fakeJWT2(map[string]string{"email": email}),
			"access_token": "tok-" + email,
			"account_id":   "acct-" + email,
		},
	})
	if err := os.MkdirAll(filepath.Dir(e.CodexA), 0o700); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(e.CodexA, data, 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func fakeJWT2(claims map[string]string) string {
	payload, _ := json.Marshal(claims)
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) +
		"." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func TestDesktopServerRoundTrip(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()

	env.writeCodexLive("a@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "a", true); err != nil {
		t.Fatal(err)
	}
	env.writeCodexLive("b@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "b", true); err != nil {
		t.Fatal(err)
	}

	inR, inW, err := os.Pipe() // app writes → core reads
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe() // core writes → app reads
	if err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, inR, outW)
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx) }()

	// First snapshot must arrive immediately.
	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))
	if rev < 1 {
		t.Fatalf("revision = %v", snap["revision"])
	}
	rows := snap["accounts"].([]interface{})
	var switchA string
	for _, raw := range rows {
		row := raw.(map[string]interface{})
		if row["providerId"] == "codex" && row["name"] == "a" {
			id, _ := row["switchActionId"].(string)
			if id == "" {
				t.Fatal("missing switchActionId")
			}
			switchA = id
		}
	}
	if switchA == "" {
		t.Fatal("codex/a switch action missing")
	}
	if _, ok := snap["settings"].(map[string]interface{}); !ok {
		t.Error("settings section missing")
	}
	if _, ok := snap["proxies"].([]interface{}); !ok {
		t.Error("proxies section missing")
	}

	// Invoke the switch action for codex/a while b is live.
	sendCommand(t, inW, "invoke\t"+encodePayload(map[string]interface{}{
		"version": 1, "requestId": "r1", "revision": rev, "actionId": switchA,
	}))
	gotResult := false
	for !gotResult {
		frame := readFrame(t, outR, "")
		switch {
		case strings.HasPrefix(frame, "result\t"):
			res := decodeJSON(t, frame[len("result\t"):])
			if res["requestId"] != "r1" {
				continue
			}
			gotResult = true
			if res["status"] != "success" {
				t.Fatalf("switch failed: %v", res["message"])
			}
		case strings.HasPrefix(frame, "snapshot\t"):
			// post-invoke refresh; ignore here
		default:
			t.Fatalf("unexpected frame %q", truncate(frame, 80))
		}
	}

	live := readFile(t, env.CodexA)
	if !strings.Contains(live, "tok-a@example.com") {
		t.Errorf("live auth not switched to a: %s", live)
	}

	// The refreshed snapshot marks codex/a as active.
	next := decodeJSON(t, readFrame(t, outR, "snapshot"))
	for _, raw := range next["accounts"].([]interface{}) {
		row := raw.(map[string]interface{})
		if row["name"] == "a" && row["active"] != true {
			t.Errorf("codex/a active = %v after switch", row["active"])
		}
	}

	// quit terminates the loop cleanly.
	sendCommand(t, inW, "quit\n")
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("server did not exit on quit")
	}
}

func TestShutdownUsesCompositionOwnedServiceSweep(t *testing.T) {
	called := false
	srv := New(Deps{
		ShutdownOwned: func(context.Context) error {
			called = true
			return fmt.Errorf("verified stop failed")
		},
	}, strings.NewReader(""), io.Discard)
	if err := srv.shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown remains best effort: %v", err)
	}
	if !called {
		t.Fatal("composition-owned service sweep was not called")
	}
}

func sendCommand(t *testing.T, w *os.File, line string) {
	t.Helper()
	if _, err := fmt.Fprintln(w, line); err != nil {
		t.Fatal(err)
	}
}

type frameReadResult struct {
	line string
	err  error
}

type frameReader struct{ lines chan frameReadResult }

var frameReaders sync.Map // map[*os.File]*frameReader; one buffered reader per pipe

func readerFor(t *testing.T, r *os.File) *frameReader {
	t.Helper()
	if cached, ok := frameReaders.Load(r); ok {
		return cached.(*frameReader)
	}
	created := &frameReader{lines: make(chan frameReadResult, 128)}
	cached, loaded := frameReaders.LoadOrStore(r, created)
	if loaded {
		return cached.(*frameReader)
	}
	t.Cleanup(func() {
		frameReaders.CompareAndDelete(r, created)
		_ = r.Close()
	})
	go func() {
		reader := bufio.NewReader(r)
		for {
			line, err := reader.ReadString('\n')
			if line != "" || err != nil {
				created.lines <- frameReadResult{line: line, err: err}
			}
			if err != nil {
				return
			}
		}
	}()
	return created
}

func readFrame(t *testing.T, r *os.File, wantPrefix string) string {
	t.Helper()
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	reader := readerFor(t, r)
	for {
		select {
		case result := <-reader.lines:
			line, err := completeFrame(result)
			if err != nil {
				t.Fatalf("read protocol frame: %v", err)
			}
			if wantPrefix != "" && !strings.HasPrefix(line, wantPrefix+"\t") {
				continue // skip unrelated frames
			}
			return line
		case <-timer.C:
			t.Fatal("timeout waiting for frame")
			return ""
		}
	}
}

func completeFrame(result frameReadResult) (string, error) {
	if result.err != nil {
		if result.line != "" {
			return "", fmt.Errorf("unterminated frame: %w", result.err)
		}
		return "", result.err
	}
	return strings.TrimRight(result.line, "\r\n"), nil
}

func TestCompleteFrameRejectsUnterminatedEOF(t *testing.T) {
	if _, err := completeFrame(frameReadResult{line: "snapshot\t{}", err: io.EOF}); err == nil {
		t.Fatal("unterminated frame was accepted")
	}
	if got, err := completeFrame(frameReadResult{line: "snapshot\t{}\n"}); err != nil || got != "snapshot\t{}" {
		t.Fatalf("complete frame = %q, %v; want valid frame", got, err)
	}
}

func encodePayload(v interface{}) string {
	raw, _ := json.Marshal(v)
	return base64.StdEncoding.EncodeToString(raw)
}

func decodeJSON(t *testing.T, frame string) map[string]interface{} {
	t.Helper()
	parts := strings.SplitN(frame, "\t", 2)
	raw, err := base64.StdEncoding.DecodeString(parts[len(parts)-1])
	if err != nil {
		t.Fatalf("frame base64: %v", err)
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil {
		t.Fatalf("frame json: %s", raw)
	}
	return m
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func parseURLT(raw string) (*urlT, error) { return urlParse(raw) }

type urlT = url.URL

func urlParse(raw string) (*url.URL, error) { return parseURL(raw) }

func parseURL(raw string) (*url.URL, error) { return url.Parse(raw) }

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
