package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/plugins"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transfer"
)

type lockedOutput struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (o *lockedOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.Write(p)
}

func (o *lockedOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.String()
}

func runCorrectnessMutation(t *testing.T, srv *Server, out *bytes.Buffer,
	payload map[string]interface{}) Result {
	t.Helper()
	out.Reset()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.handleMutate(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	return decodeMutateResult(t, out.String())
}

func mutationPayload(requestID, operation, name string) map[string]interface{} {
	payload := map[string]interface{}{
		"version": 1, "requestId": requestID, "operation": operation,
	}
	if name != "" {
		payload["name"] = name
	}
	return payload
}

func TestDesktopAccountMutationsDoNotSilentlySucceed(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)

	detect := mutationPayload("detect-missing", "account-detect", "detect")
	detect["providerId"] = "codex"
	if res := runCorrectnessMutation(t, srv, &out, detect); res.Status != "error" {
		t.Fatalf("detect without a live login = %+v", res)
	}

	env.writeCodexLive("desktop@example.com")
	detect["requestId"] = "detect-present"
	res := runCorrectnessMutation(t, srv, &out, detect)
	if res.Status != "success" || !strings.Contains(res.Message, "desktop@example.com") {
		t.Fatalf("detect live login = %+v", res)
	}

	save := mutationPayload("save-first", "account-save", "work")
	save["providerId"] = "codex"
	save["label"] = "Desktop Work"
	res = runCorrectnessMutation(t, srv, &out, save)
	if res.Status != "success" {
		t.Fatalf("first save = %+v", res)
	}
	account, err := env.Deps.Store.Get(context.Background(), "codex", "work")
	if err != nil || account == nil || account.Meta.Label != "Desktop Work" {
		t.Fatalf("saved account = %+v, %v", account, err)
	}

	env.writeCodexLive("replacement@example.com")
	save["requestId"] = "save-no-overwrite"
	res = runCorrectnessMutation(t, srv, &out, save)
	if res.Status != "error" {
		t.Fatalf("save over existing account without overwrite = %+v", res)
	}
	account, err = env.Deps.Store.Get(context.Background(), "codex", "work")
	if err != nil || account == nil || account.Meta.Identity != "desktop@example.com" {
		t.Fatalf("failed overwrite changed the snapshot: %+v, %v", account, err)
	}

	save["requestId"] = "save-overwrite"
	save["overwrite"] = true
	res = runCorrectnessMutation(t, srv, &out, save)
	if res.Status != "success" {
		t.Fatalf("confirmed overwrite = %+v", res)
	}
	account, err = env.Deps.Store.Get(context.Background(), "codex", "work")
	if err != nil || account == nil || account.Meta.Identity != "replacement@example.com" {
		t.Fatalf("confirmed overwrite did not update snapshot: %+v, %v", account, err)
	}

	edit := mutationPayload("edit", "account-edit", "work")
	edit["providerId"] = "codex"
	edit["label"] = "Renamed"
	res = runCorrectnessMutation(t, srv, &out, edit)
	if res.Status != "success" {
		t.Fatalf("account edit = %+v", res)
	}
	account, err = env.Deps.Store.Get(context.Background(), "codex", "work")
	if err != nil || account == nil || account.Meta.Label != "Renamed" {
		t.Fatalf("edited account = %+v, %v", account, err)
	}

	clear := mutationPayload("clear", "account-clear", "live")
	clear["providerId"] = "codex"
	res = runCorrectnessMutation(t, srv, &out, clear)
	if res.Status != "success" || !strings.Contains(res.Message, "cleared local auth") {
		t.Fatalf("account clear = %+v", res)
	}
	pv, err := env.Deps.Providers.Get("codex")
	if err != nil {
		t.Fatal(err)
	}
	live, err := pv.DetectLive()
	if err != nil || live.Present {
		t.Fatalf("clear left live auth behind: %+v, %v", live, err)
	}

	unsupported := mutationPayload("clear-unsupported", "account-clear", "live")
	unsupported["providerId"] = "openrouter"
	if res := runCorrectnessMutation(t, srv, &out, unsupported); res.Status != "error" {
		t.Fatalf("unsupported clear claimed success: %+v", res)
	}
}

func TestSnapshotPublishesSavedAccountIdentity(t *testing.T) {
	env := newTrayEnv(t)
	env.writeCodexLive("identity@example.com")
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)

	save := mutationPayload("save-identity", "account-save", "work")
	save["providerId"] = "codex"
	save["label"] = "Work"
	save["identity"] = "Current Codex login"
	if result := runCorrectnessMutation(t, srv, &out, save); result.Status != "success" {
		t.Fatalf("save account = %+v", result)
	}

	snapshot, err := srv.buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range snapshot.Accounts {
		if account.ProviderID == "codex" && account.Name == "work" {
			if account.Detail != "identity@example.com" {
				t.Fatalf("account detail = %q, want identity", account.Detail)
			}
			return
		}
	}
	t.Fatal("saved account was not published in the desktop snapshot")
}

func TestAccountSaveDisplayHintDoesNotMergeUnidentifiedLogins(t *testing.T) {
	env := newTrayEnv(t)
	env.writeCodexLive("placeholder@example.com")
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	ctx := context.Background()
	selection := []transfer.BackupEntry{{Provider: "codex", Name: "first"}, {Provider: "codex", Name: "second"}}
	for _, entry := range selection {
		// Distinct opaque credentials have no account-scoped identity. The UI's
		// shared display hint must not make their backup identities collide.
		auth := `{"auth_mode":"chatgpt","tokens":{"id_token":"` + entry.Name + `"}}`
		if err := os.WriteFile(env.CodexA, []byte(auth), 0o600); err != nil {
			t.Fatal(err)
		}
		save := mutationPayload("save-"+entry.Name, "account-save", entry.Name)
		save["providerId"] = "codex"
		save["identity"] = "Current OpenAI Codex login"
		if result := runCorrectnessMutation(t, srv, &out, save); result.Status != "success" {
			t.Fatalf("save account = %+v", result)
		}
	}
	path := filepath.Join(t.TempDir(), "unidentified.anypick-backup")
	if _, err := transfer.ExportSelectedBackup(env.Deps.Store, ctx, selection, path, false); err != nil {
		t.Fatal(err)
	}
	preview, err := transfer.InspectBackup(env.Deps.Store, env.Deps.Providers, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Entries) != len(selection) {
		t.Fatalf("backup entries = %d", len(preview.Entries))
	}
	for _, entry := range preview.Entries {
		if entry.Disposition != transfer.DispositionReplace {
			t.Fatalf("display hint caused a false identity conflict: %+v", entry)
		}
	}
	if _, err := transfer.RestoreSelectedContext(ctx, env.Deps.Store, env.Deps.Providers, path,
		selection, transfer.RestoreOptions{Replace: selection}); err != nil {
		t.Fatal(err)
	}
	for _, entry := range selection {
		account, err := env.Deps.Store.Get(ctx, entry.Provider, entry.Name)
		if err != nil || account == nil {
			t.Fatalf("restored account %s: %v", entry.Name, err)
		}
		if account.Meta.Identity != "" {
			t.Fatalf("display hint became identity: %q", account.Meta.Identity)
		}
		raw, err := os.ReadFile(filepath.Join(account.SnapshotDir, "auth.json"))
		if err != nil || !strings.Contains(string(raw), `"id_token":"`+entry.Name+`"`) {
			t.Fatalf("restore mixed up account %s: %v", entry.Name, err)
		}
	}
}

func TestDesktopAccountSaveUsesExplicitCredentialAndOverwrite(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload := mutationPayload("credential-save", "account-save", "router")
	payload["providerId"] = "openrouter"
	payload["apiKey"] = "sk-desktop-test"
	payload["region"] = "global"
	payload["label"] = "Router Key"

	res := runCorrectnessMutation(t, srv, &out, payload)
	if res.Status != "success" {
		t.Fatalf("credential save = %+v", res)
	}
	account, err := env.Deps.Store.Get(context.Background(), "openrouter", "router")
	if err != nil || account == nil {
		t.Fatalf("credential account = %+v, %v", account, err)
	}
	if account.Meta.CredentialKind != "proxy-only" || account.Meta.Label != "Router Key" {
		t.Fatalf("credential metadata = %+v", account.Meta)
	}

	payload["requestId"] = "credential-no-overwrite"
	payload["apiKey"] = "sk-replacement"
	if res := runCorrectnessMutation(t, srv, &out, payload); res.Status != "error" {
		t.Fatalf("credential overwrite without confirmation = %+v", res)
	}
	payload["requestId"] = "credential-overwrite"
	payload["overwrite"] = true
	if res := runCorrectnessMutation(t, srv, &out, payload); res.Status != "success" {
		t.Fatalf("credential overwrite = %+v", res)
	}
}

func TestDesktopGatewayRefreshUsesStoredSecretWithoutEchoingIt(t *testing.T) {
	models := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("authorization"); got != "Bearer sk-never-echo" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-a"},{"id":"model-b"}]}`))
	}))
	t.Cleanup(models.Close)

	env := newTrayEnv(t)
	if _, err := env.Deps.Profiles.UpsertContext(context.Background(), profile.Runtime{
		Meta:    profile.Meta{Name: "live-gateway", Provider: "openai", Endpoint: models.URL + "/v1"},
		Secrets: profile.Secrets{APIKey: "sk-never-echo"},
	}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload := mutationPayload("gateway-refresh", "gateway-refresh", "live-gateway")
	res := runCorrectnessMutation(t, srv, &out, payload)
	if res.Status != "success" || !strings.Contains(res.Message, "2 models") {
		t.Fatalf("gateway refresh = %+v", res)
	}
	if strings.Contains(out.String(), "sk-never-echo") {
		t.Fatal("gateway secret crossed the desktop output boundary")
	}
}

func TestSnapshotPublishesProviderLoginMethods(t *testing.T) {
	env := newTrayEnv(t)
	env.writeCodexLive("login-method@example.com")
	srv := newWaitedServerOut(t, env.Deps, &bytes.Buffer{})
	snapshot, err := srv.buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range snapshot.AccountProviders {
		if row.ProviderID != "codex" {
			continue
		}
		if len(row.LoginMethods) == 0 {
			t.Fatal("codex login methods were omitted")
		}
		method := row.LoginMethods[0]
		if method.ID == "" || method.Label == "" || method.Provenance == "" {
			t.Fatalf("incomplete login method: %+v", method)
		}
		if !row.Installed || !row.LivePresent || row.LiveIdentity != "login-method@example.com" {
			t.Fatalf("provider availability = %+v", row)
		}
		return
	}
	t.Fatal("codex provider row missing")
}

func TestSnapshotPublishesGeminiLiveSource(t *testing.T) {
	env := newTrayEnv(t)
	t.Setenv("GEMINI_CONFIG_DIR", filepath.Join(env.Home, ".gemini"))
	geminiDir := filepath.Join(env.Home, ".gemini")
	if err := os.MkdirAll(geminiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "antigravity_oauth.json"), []byte(
		`{"token":{"access_token":"access","refresh_token":"refresh","expiry":"2099-01-01T00:00:00Z"},"email":"anti@example.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := New(env.Deps, strings.NewReader(""), &bytes.Buffer{}).
		buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	gemini := findAccountProvider(t, snapshot, "gemini")
	if !gemini.LivePresent || gemini.LiveIdentity != "anti@example.com" ||
		gemini.SourceID != "antigravity" || gemini.CanClear {
		t.Fatalf("Gemini live source = %+v", gemini)
	}
}

func TestSnapshotMapsZAIToZCodeAndPublishesZCodeRoute(t *testing.T) {
	env := newTrayEnv(t)
	livePath := filepath.Join(env.Home, "zai-live.json")
	t.Setenv("ANYPICK_ZAI_CREDENTIALS_PATH", filepath.Join(env.Home, "zai-credentials.json"))
	t.Setenv("ANYPICK_ZAI_LIVE_PATH", livePath)
	if err := os.WriteFile(livePath, []byte(
		`{"version":1,"source":"zcode","oauthAccessToken":"oauth","identity":"zai@example.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := newWaitedServerOut(t, env.Deps, &bytes.Buffer{})
	snapshot, err := srv.buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	zai := findAccountProvider(t, snapshot, "zai")
	if zai.ClientID != "zcode" || zai.Label != "ZCode" || !zai.LivePresent || zai.LiveIdentity != "zai@example.com" {
		t.Fatalf("Z.ai provider presentation = %+v", zai)
	}

	if _, err := env.Deps.Accounts.SaveInput(context.Background(), "zai", "work", accounts.CredentialInput{
		Kind: "subscription-key", Profile: "global", Secret: "test-plan-key",
	}, false); err != nil {
		t.Fatal(err)
	}
	snapshot, err = srv.buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var zcodeRoutes, legacyZaiRoutes int
	var zcodeRouteClient string
	for _, action := range snapshot.Actions {
		if action.SourceID != "account/zai/work" {
			continue
		}
		switch action.ClientID {
		case "zcode":
			zcodeRoutes++
			zcodeRouteClient = action.Client
		case "zai":
			legacyZaiRoutes++
		}
	}
	if zcodeRoutes != 1 || legacyZaiRoutes != 0 || zcodeRouteClient != "ZCode" {
		t.Fatalf("Z.ai route presentation = zcode:%d legacy-zai:%d client:%q", zcodeRoutes, legacyZaiRoutes, zcodeRouteClient)
	}
}

func TestSnapshotPublishesPluginDegradedConditions(t *testing.T) {
	env := newTrayEnv(t)
	env.Deps.PluginDiagnostics = func(context.Context) plugins.Diagnostics {
		return plugins.Diagnostics{
			Host: plugins.HostDiagnostic{
				State: "degraded", LoadedPlugins: 1, Error: "pluginhost: host crashed",
			},
			Failures: []plugins.LoadFailure{{
				Name: "changed-plugin", Reason: "package digest changed", Untrusted: true,
			}},
		}
	}
	snapshot, err := New(env.Deps, strings.NewReader(""), &bytes.Buffer{}).
		buildSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.DegradedConditions) != 2 {
		t.Fatalf("degraded conditions = %+v", snapshot.DegradedConditions)
	}
	if snapshot.DegradedConditions[0].ID != "plugin-host" ||
		snapshot.DegradedConditions[1].ID != "plugin:changed-plugin" ||
		snapshot.DegradedConditions[1].Title != "Plugin changed after trust" {
		t.Fatalf("degraded conditions = %+v", snapshot.DegradedConditions)
	}
}

func TestProxySnapshotStateHandlesNilAndStatusErrors(t *testing.T) {
	if running, address := proxySnapshotState(nil, nil); running || address != "" {
		t.Fatalf("nil status = %v, %q", running, address)
	}
	status := &proxy.Status{Running: true, Endpoint: "http://127.0.0.1:43123"}
	if running, address := proxySnapshotState(status, errors.New("status failed")); running || address != "" {
		t.Fatalf("errored status = %v, %q", running, address)
	}
	if running, address := proxySnapshotState(status, nil); !running || address != status.Endpoint {
		t.Fatalf("healthy status = %v, %q", running, address)
	}
}

func TestInvokePublishesExactlyOneTerminalResult(t *testing.T) {
	env := newTrayEnv(t)
	var out lockedOutput
	srv := newWaitedServerOut(t, env.Deps, &out)
	srv.revision = 1
	var calls atomic.Int32
	srv.actions = map[string]actionHandler{
		"once": func(context.Context, actionOptions) error {
			calls.Add(1)
			return nil
		},
	}
	raw, err := json.Marshal(invokePayload{
		Version: 1, RequestID: "invoke-once", Revision: 1, ActionID: "once",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.handle(context.Background(), &Command{Kind: "invoke", Payload: raw}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for calls.Load() == 0 || !strings.Contains(out.String(), "result\t") {
		if time.Now().After(deadline) {
			t.Fatalf("invoke did not finish: calls=%d output=%q", calls.Load(), out.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Give the goroutine time to complete its following snapshot write. A
	// second terminal result, if present, is emitted before that refresh.
	time.Sleep(25 * time.Millisecond)
	resultCount := 0
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if !strings.HasPrefix(line, "result\t") {
			continue
		}
		var result Result
		if err := json.Unmarshal(decodeFramePayload(t, line), &result); err != nil {
			t.Fatal(err)
		}
		if result.RequestID == "invoke-once" {
			resultCount++
		}
	}
	if calls.Load() != 1 || resultCount != 1 {
		t.Fatalf("invoke calls=%d terminal results=%d output=%q",
			calls.Load(), resultCount, out.String())
	}
}
