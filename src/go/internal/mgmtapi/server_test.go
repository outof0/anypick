package mgmtapi

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/usagelog"
)

type harness struct {
	app   *app.App
	base  string
	port  int
	token string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	t.Setenv("ANYPICK_HOME", root)
	t.Setenv("HOME", t.TempDir())
	a, closeFn, err := app.Ready(context.Background(), app.Options{
		Root: root, Home: t.TempDir(), SkipMigrate: true, SkipMaintenance: true, Bare: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeFn)
	token, err := EnsureToken(root)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(nil)
	port := ts.Listener.Addr().(*net.TCPAddr).Port
	srv := &Server{App: a, InstanceID: "test-instance", Port: port}
	ts.Config.Handler = srv.Handler()
	ts.Start()
	t.Cleanup(ts.Close)
	return &harness{app: a, base: ts.URL, port: port, token: token}
}

func (h *harness) do(t *testing.T, method, path, bearer string, mutate func(*http.Request)) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, h.base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	if mutate != nil {
		mutate(req)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestHealthIsOpenAndSecretFree(t *testing.T) {
	h := newHarness(t)
	status, body := h.do(t, http.MethodGet, "/health", "", nil)
	if status != http.StatusOK || !strings.Contains(body, `"apiVersion":1`) {
		t.Fatalf("health = %d %s", status, body)
	}
	if strings.Contains(body, h.token) {
		t.Fatal("/health carried the management token")
	}
}

// Every /v1 route fails closed: no bearer, a wrong one, and an empty token
// file are all refused.
func TestEveryV1RouteRequiresTheToken(t *testing.T) {
	h := newHarness(t)
	routes := []struct{ method, path string }{
		{"GET", "/v1/status"}, {"GET", "/v1/accounts"}, {"GET", "/v1/proxies"},
		{"GET", "/v1/hubs"}, {"GET", "/v1/agents"}, {"GET", "/v1/usage/history"},
		{"POST", "/v1/accounts/claude/work/activate"},
		{"POST", "/v1/proxies/claude/work/start"}, {"POST", "/v1/proxies/claude/work/stop"},
		{"POST", "/v1/hubs/default/start"}, {"POST", "/v1/hubs/default/stop"},
	}
	for _, rt := range routes {
		for _, bearer := range []string{"", "not-the-token"} {
			if status, _ := h.do(t, rt.method, rt.path, bearer, nil); status != http.StatusUnauthorized {
				t.Errorf("%s %s with bearer %q = %d, want 401", rt.method, rt.path, bearer, status)
			}
		}
	}
	if status, _ := h.do(t, "GET", "/v1/status", h.token, nil); status != http.StatusOK {
		t.Fatalf("the right token was refused: %d", status)
	}
	// An empty token file must not make an empty bearer valid.
	if err := os.WriteFile(TokenPath(h.app.Root), []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if status, _ := h.do(t, "GET", "/v1/status", "", func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer ")
	}); status != http.StatusUnauthorized {
		t.Fatalf("an empty token file authenticated an empty bearer: %d", status)
	}
}

func TestRotationTakesEffectWithoutARestart(t *testing.T) {
	h := newHarness(t)
	rotated, err := RotateToken(h.app.Root)
	if err != nil {
		t.Fatal(err)
	}
	if status, _ := h.do(t, "GET", "/v1/status", h.token, nil); status != http.StatusUnauthorized {
		t.Fatalf("the previous token still works: %d", status)
	}
	if status, _ := h.do(t, "GET", "/v1/status", rotated, nil); status != http.StatusOK {
		t.Fatalf("the rotated token is refused: %d", status)
	}
}

// DNS rebinding and web pages: a foreign Host, a different port, and any
// Origin are refused before the token is even looked at.
func TestForeignHostAndBrowsersAreRefused(t *testing.T) {
	h := newHarness(t)
	for _, host := range []string{
		"evil.example:" + strconv.Itoa(h.port),
		"127.0.0.1:" + strconv.Itoa(h.port+1),
		"127.0.0.1",
	} {
		status, _ := h.do(t, "GET", "/v1/status", h.token, func(r *http.Request) { r.Host = host })
		if status != http.StatusMisdirectedRequest {
			t.Errorf("Host %q = %d, want 421", host, status)
		}
	}
	for _, host := range []string{"localhost:" + strconv.Itoa(h.port), "127.0.0.1:" + strconv.Itoa(h.port)} {
		if status, _ := h.do(t, "GET", "/v1/status", h.token, func(r *http.Request) { r.Host = host }); status != http.StatusOK {
			t.Errorf("loopback Host %q = %d, want 200", host, status)
		}
	}
	status, _ := h.do(t, "GET", "/v1/status", h.token, func(r *http.Request) {
		r.Header.Set("Origin", "https://evil.example")
	})
	if status != http.StatusForbidden {
		t.Fatalf("a request with Origin = %d, want 403", status)
	}
	status, _ = h.do(t, "POST", "/v1/proxies/claude/work/stop", h.token, func(r *http.Request) {
		r.Header.Set("Content-Type", "text/plain")
	})
	if status != http.StatusUnsupportedMediaType {
		t.Fatalf("a non-JSON POST = %d, want 415", status)
	}
}

// Nothing secret crosses the API: not a saved account's key, not a hub's
// bearer, not the management token itself.
func TestNoSecretInAnyResponse(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	const canary = "sk-canary-must-never-cross-the-management-api-0123456789"
	if _, err := h.app.Accounts.SaveInput(ctx, "deepseek", "work",
		accounts.CredentialInput{Kind: "api-key", Secret: canary, Profile: "global"}, false); err != nil {
		t.Skipf("deepseek is not registered in this build: %v", err)
	}
	if _, err := h.app.ProxyHub.UpsertConfigContext(ctx, hub.Config{
		Name: "default", Enabled: true, Sources: []hub.Source{{ProviderID: "deepseek", Account: "work"}},
	}); err != nil {
		t.Fatal(err)
	}
	hubToken, err := h.app.ProxyHub.EnsureHubTokenContext(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/status", "/v1/accounts", "/v1/proxies", "/v1/hubs", "/v1/agents", "/health"} {
		status, body := h.do(t, "GET", path, h.token, nil)
		if status != http.StatusOK {
			t.Fatalf("%s = %d %s", path, status, body)
		}
		for name, secret := range map[string]string{"account key": canary, "hub token": hubToken, "management token": h.token} {
			if strings.Contains(body, secret) {
				t.Errorf("%s carried the %s", path, name)
			}
		}
	}
	_, body := h.do(t, "GET", "/v1/hubs", h.token, nil)
	var parsed struct {
		Hubs []map[string]interface{} `json:"hubs"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil || len(parsed.Hubs) != 1 {
		t.Fatalf("hubs = %s, %v", body, err)
	}
	if _, ok := parsed.Hubs[0]["token"]; ok {
		t.Fatal("a hub row has a token field")
	}
}

func TestActionsAnswerWithCodesAndRefuseUnknownOptions(t *testing.T) {
	h := newHarness(t)
	status, body := h.do(t, "POST", "/v1/accounts/claude/nobody/activate", h.token, nil)
	if status != http.StatusNotFound || !strings.Contains(body, `"ok":false`) || !strings.Contains(body, `"code":"ACCOUNT_NOT_FOUND"`) {
		t.Fatalf("activating a missing account = %d %s, want 404 ACCOUNT_NOT_FOUND", status, body)
	}
	req, _ := http.NewRequest("POST", h.base+"/v1/accounts/claude/nobody/activate",
		strings.NewReader(`{"allowForeignConfig":true,"surprise":1}`))
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("an unknown option = %d, want 400", resp.StatusCode)
	}
	if status, _ := h.do(t, "POST", "/v1/hubs/default/start", h.token, nil); status != http.StatusNotImplemented {
		t.Fatalf("hub control without the CLI's hooks = %d, want 501", status)
	}
}

func TestUsageHistoryAnswersTheSharedSummary(t *testing.T) {
	h := newHarness(t)
	if err := h.app.DB.MigrateSchema(); err != nil {
		t.Fatal(err)
	}
	if err := usagelog.Insert(context.Background(), h.app.DB, []usagelog.Event{{
		At: time.Now().UnixMilli(), Route: "hub", Provider: "claude", Account: "work",
		Model: "claude-opus-5-5", Status: 200, InputTokens: 100, OutputTokens: 10, Reported: true,
	}}); err != nil {
		t.Fatal(err)
	}
	status, body := h.do(t, http.MethodGet, "/v1/usage/history?since=24h&by=account", h.token, nil)
	if status != http.StatusOK {
		t.Fatalf("usage history = %d %s", status, body)
	}
	var resp struct {
		Usage usagelog.Summary `json:"usage"`
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Usage.By != "account" || !resp.Usage.Estimate || len(resp.Usage.Lines) != 1 ||
		resp.Usage.Lines[0].Key != "claude/work" || resp.Usage.Lines[0].InputTokens != 100 {
		t.Fatalf("usage = %+v", resp.Usage)
	}
	if status, _ := h.do(t, http.MethodGet, "/v1/usage/history?by=nope", h.token, nil); status != http.StatusBadRequest {
		t.Fatalf("an unknown grouping = %d, want 400", status)
	}
}
