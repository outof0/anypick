package desktop

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/store"
)

type namedOnly struct{}

func (namedOnly) Name() string { return "BareName" }

func TestShortNameOfBothBranches(t *testing.T) {
	env := newTrayEnv(t)
	srv := newWaitedServerOut(t, env.Deps, &bytes.Buffer{})

	pv, err := env.Deps.Providers.Get("codex")
	if err != nil {
		t.Fatal(err)
	}
	if got := shortNameOf(srv, pv); got != "Codex" {
		t.Fatalf("provider branch = %q want Codex", got)
	}
	if got := shortNameOf(srv, namedOnly{}); got != "BareName" {
		t.Fatalf("fallback branch = %q want BareName", got)
	}
}

// fakeHealthyProxy persists runtime state whose endpoint answers /health with
// the recorded instance id — enough for Status to report Running.
func fakeHealthyProxy(t *testing.T, env *trayEnv, providerID, name, instanceID string) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"instanceId":"` + instanceID + `"}`))
	}))
	t.Cleanup(ts.Close)

	ctx := context.Background()
	err := env.Deps.Store.WriteProxyStateContext(ctx, providerID, name, store.ProxyRuntimeState{
		AccountName: name, Endpoint: ts.URL,
		PID: 0, InstanceID: instanceID, StartedAt: "now", Token: "tok-" + name,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ts
}

func TestHandleLogsRunningTailAndEmpty(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)

	fakeHealthyProxy(t, env, "codex", "logged", "inst-log")
	// Running but never written to → exercises the empty branch.
	fakeHealthyProxy(t, env, "codex", "nolog", "inst-nolog")
	logPath := paths.ProxyLogPath(env.Deps.Root, "codex", "logged")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("l1\nl2\nl3\nl4\nl5\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	request := func(name string, lines int) ProxyLogsResult {
		t.Helper()
		out.Reset()
		raw, _ := json.Marshal(logsPayload{Version: 1, RequestID: "r-" + name,
			ProviderID: "codex", Name: name, Lines: lines})
		if err := srv.handleLogs(context.Background(), raw); err != nil {
			t.Fatal(err)
		}
		decoded := decodeFramePayload(t, firstFrameLine(out.String()))
		var res ProxyLogsResult
		if err := json.Unmarshal(decoded, &res); err != nil {
			t.Fatalf("decode %s: %v", decoded, err)
		}
		return res
	}

	res := request("logged", 2)
	if res.State != "ready" || res.Text != "l4\nl5" {
		t.Fatalf("tail: state=%q text=%q", res.State, res.Text)
	}
	if res.ProxyID != "codex/logged" {
		t.Fatalf("proxy id %q", res.ProxyID)
	}

	// Lines <= 0 keeps the whole file.
	res = request("logged", 0)
	if res.State != "ready" || !strings.Contains(res.Text, "l1") {
		t.Fatalf("full read: state=%q text=%q", res.State, res.Text)
	}

	// Running but no log file yet → empty.
	res = request("nolog", 5)
	if res.State != "empty" || res.Text != "" {
		t.Fatalf("no log: state=%q text=%q", res.State, res.Text)
	}

	// Corrupt payload surfaces as a decode error.
	if err := srv.handleLogs(context.Background(), json.RawMessage(`{oops`)); err == nil {
		t.Fatal("corrupt logs payload must error")
	}
}

func TestHandleMutateRemainingOperations(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	ctx := context.Background()

	run := func(m Mutate) Result {
		t.Helper()
		out.Reset()
		raw, _ := json.Marshal(m)
		if err := srv.handleMutate(ctx, raw); err != nil {
			t.Fatal(err)
		}
		decoded := decodeFramePayload(t, firstFrameLine(out.String()))
		var res Result
		if err := json.Unmarshal(decoded, &res); err != nil {
			t.Fatalf("decode %s: %v", decoded, err)
		}
		return res
	}

	// account-refresh on a missing account errors cleanly.
	res := run(Mutate{Version: 1, RequestID: "ar0", Operation: "account-refresh",
		ProviderID: "codex", Name: "ghost"})
	if res.Status != "error" || !strings.Contains(res.Message, "account not found") {
		t.Fatalf("refresh missing: %+v", res)
	}

	// Seeded live auth makes refresh succeed.
	env.writeCodexLive("rf@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "rf-acc", true); err != nil {
		t.Fatal(err)
	}
	res = run(Mutate{Version: 1, RequestID: "ar1", Operation: "account-refresh",
		ProviderID: "codex", Name: "rf-acc"})
	if res.Status != "success" {
		t.Fatalf("refresh ok: %+v", res)
	}

	// Stop/restart-all succeed trivially with nothing enabled.
	for _, op := range []string{"proxy-stop-all", "proxy-restart-all"} {
		res = run(Mutate{Version: 1, RequestID: "op-" + op, Operation: op})
		if res.Status != "success" {
			t.Fatalf("%s: %+v", op, res)
		}
	}

	// Unknown operations are reported, never fatal.
	res = run(Mutate{Version: 1, RequestID: "unk", Operation: "warp-drive"})
	if res.Status != "error" || !strings.Contains(res.Message, "unknown mutation operation") {
		t.Fatalf("unknown op: %+v", res)
	}
}

func TestHandleMutateErrorBranches(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	ctx := context.Background()

	run := func(m Mutate) Result {
		t.Helper()
		out.Reset()
		raw, _ := json.Marshal(m)
		if err := srv.handleMutate(ctx, raw); err != nil {
			t.Fatal(err)
		}
		return decodeMutateResult(t, out.String())
	}

	// Corrupt payload surfaces as a decode error.
	if err := srv.handleMutate(ctx, json.RawMessage(`{oops`)); err == nil {
		t.Fatal("corrupt mutate payload must error")
	}

	// save-current without any live login fails honestly.
	res := run(Mutate{Version: 1, RequestID: "e1", Operation: "account-save-current",
		ProviderID: "codex"})
	if res.Status != "error" {
		t.Fatalf("save-current expected failure: %+v", res)
	}

	// account-save follows the wire contract and never invents a name; the
	// save-current operation may derive one from the detected identity.
	env.writeCodexLive("br@example.com")
	res = run(Mutate{Version: 1, RequestID: "e2", Operation: "account-save", ProviderID: "codex"})
	if res.Status != "error" {
		t.Fatalf("unnamed account-save must fail: %+v", res)
	}
	res = run(Mutate{Version: 1, RequestID: "e3", Operation: "account-save-current", ProviderID: "codex"})
	if res.Status != "success" {
		t.Fatalf("save-current: %+v", res)
	}

	// Refresh against an unknown provider reports the registry error.
	res = run(Mutate{Version: 1, RequestID: "e4", Operation: "account-refresh",
		ProviderID: "nope", Name: "x"})
	if res.Status != "error" || strings.Contains(res.Message, "account not found") {
		t.Fatalf("unknown provider refresh: %+v", res)
	}

	// Validation guards.
	res = run(Mutate{Version: 1, RequestID: "e5", Operation: "account-remove", Name: "x"})
	if res.Status != "error" || !strings.Contains(res.Message, "providerId") {
		t.Fatalf("remove guard: %+v", res)
	}
	res = run(Mutate{Version: 1, RequestID: "e6", Operation: "gateway-remove"})
	if res.Status != "error" || !strings.Contains(res.Message, "name") {
		t.Fatalf("gateway-remove guard: %+v", res)
	}
	res = run(Mutate{Version: 1, RequestID: "e7", Operation: "gateway-edit", Name: "ghost-gw"})
	if res.Status != "error" || !strings.Contains(res.Message, "gateway not found") {
		t.Fatalf("gateway-edit guard: %+v", res)
	}
	res = run(Mutate{Version: 1, RequestID: "e8", Operation: "client-reset", ProviderID: "nope"})
	if res.Status != "error" {
		t.Fatalf("client-reset guard: %+v", res)
	}

	// restart-all with an enabled config walks the real stop/start loop.
	// A distinct live identity: a login may only be saved once, so reusing
	// br@example.com here would (correctly) be refused as a duplicate.
	env.writeCodexLive("rf@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "rf-acc", true); err != nil {
		t.Fatal(err)
	}
	if err := env.Deps.Store.SetProxyConfigContext(ctx, "codex", "rf-acc",
		store.ProxyConfig{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	res = run(Mutate{Version: 1, RequestID: "e9", Operation: "proxy-restart-all"})
	if res.Status != "success" {
		t.Fatalf("restart-all: %+v", res)
	}
}

func TestProxyStartAllStartsStoppedProxiesAndLeavesRunningOnes(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	ctx := context.Background()

	env.writeCodexLive("start-all-idle@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "idle", true); err != nil {
		t.Fatal(err)
	}
	env.writeCodexLive("start-all-live@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "live", true); err != nil {
		t.Fatal(err)
	}
	live := fakeHealthyProxy(t, env, "codex", "live", "inst-live")
	t.Cleanup(func() {
		_ = env.Deps.Proxy.Stop(context.Background(), "codex", "idle")
	})

	// The proxies pane sends this exact object. A full Mutate marshal would
	// add an empty path, which the default mutate contract rejects.
	raw, err := json.Marshal(map[string]any{
		"version": 1, "requestId": "start-all", "operation": "proxy-start-all", "name": "all",
	})
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := DecodeLine("mutate\t" + base64.StdEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatalf("proxy-start-all must be a real operation: %v", err)
	}
	out.Reset()
	if err := srv.handle(ctx, cmd); err != nil {
		t.Fatal(err)
	}
	res := decodeMutateResult(t, out.String())
	if res.Status != "success" {
		t.Fatalf("start-all: %+v", res)
	}
	resultJSON, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(resultJSON), "apiKey") {
		t.Fatalf("start-all result carries a bearer: %s", firstFrameLine(out.String()))
	}
	idleStatus, err := env.Deps.Proxy.StatusContext(ctx, "codex", "idle")
	if err != nil || idleStatus == nil || !idleStatus.Running {
		t.Fatalf("stopped proxy was not started: %+v %v", idleStatus, err)
	}
	liveStatus, err := env.Deps.Proxy.StatusContext(ctx, "codex", "live")
	if err != nil || liveStatus == nil || !liveStatus.Running || liveStatus.Endpoint != live.URL {
		t.Fatalf("running proxy was disturbed: %+v %v", liveStatus, err)
	}
}

func decodeMutateResult(t *testing.T, out string) Result {
	t.Helper()
	decoded := decodeFramePayload(t, firstFrameLine(out))
	var res Result
	if err := json.Unmarshal(decoded, &res); err != nil {
		t.Fatalf("decode %s: %v", decoded, err)
	}
	return res
}

func TestRunProcessesMalformedAndShutdownLines(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	env.writeCodexLive("run@example.com")

	in := strings.NewReader(strings.Join([]string{
		"this is not a frame",
		"refresh\t" + base64.StdEncoding.EncodeToString([]byte(`{}`)),
		"",
	}, "\n") + "\n")

	var out bytes.Buffer
	srv := New(env.Deps, in, &out)
	// EOF on stdin ends the loop cleanly.
	if err := srv.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(out.String(), "snapshot") {
		t.Fatalf("expected snapshot frames, got %q", out.String())
	}
}

func TestRunStopsOnQuitCommand(t *testing.T) {
	env := newTrayEnv(t)
	in := strings.NewReader("quit\t\n")
	var out bytes.Buffer
	srv := New(env.Deps, in, &out)
	if err := srv.Run(context.Background()); err != nil {
		t.Fatalf("Run with quit: %v", err)
	}
}
