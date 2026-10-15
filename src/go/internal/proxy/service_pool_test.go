// Pool lifecycle regressions (service_pool.go): a verified stop clears the
// primary's proxy_state so restarts rotate the token, and only a surviving
// record is reused; and the planned/persisted port is bound deterministically
// (pool.port, provider default, else 8080) instead of a random free port.
package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/store"
)

// newPoolTestService composes a Service with a multi pool over two members.
// The pool row starts on port 0 so each test picks its own port strategy.
func newPoolTestService(t *testing.T, database *db.DB, resolver UpstreamResolver) *Service {
	t.Helper()
	root := t.TempDir()
	svc := New(store.New(root, database), &LeaseStore{Root: root, DB: database.DB})
	svc.Resolver = resolver
	svc.Pools = &pools.Store{Root: root, DB: database.DB}
	for _, name := range []string{"a", "b"} {
		seedPoolAccount(t, svc, name)
	}
	if err := svc.Pools.Set(context.Background(), pools.Pool{
		Provider: "deepseek", Mode: "multi", Enabled: true,
		Strategy: "failover", Host: "127.0.0.1",
		Members: []pools.Member{{Account: "a", Enabled: true}, {Account: "b", Enabled: true}},
	}); err != nil {
		t.Fatal(err)
	}
	return svc
}

func openPoolTestDB(t *testing.T) (*db.DB, error) {
	t.Helper()
	database, err := db.Open(t.TempDir())
	if err == nil {
		t.Cleanup(func() { _ = database.Close() })
	}
	return database, err
}

// seedPoolAccount persists a minimal credential snapshot so the pool's primary
// proxy_config writes have an account row to update (SetProxyConfigContext
// refuses phantom accounts).
func seedPoolAccount(t *testing.T, svc *Service, name string) {
	t.Helper()
	staging, _, err := svc.Store.PrepareSnapshot("deepseek", name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staging+"/auth.json", []byte(`{"api_key":"sk-`+name+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	if err := svc.Store.WriteMetaContext(context.Background(), store.Meta{
		Name: name, Provider: "deepseek", CreatedAt: now, UpdatedAt: now,
	}, staging); err != nil {
		t.Fatal(err)
	}
	_ = svc.Store.DiscardPreparedSnapshot(staging)
}

func mustFreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func setPoolRow(t *testing.T, svc *Service, port int) {
	t.Helper()
	ctx := context.Background()
	pool, err := svc.Pools.GetContext(ctx, "deepseek")
	if err != nil || pool == nil {
		t.Fatalf("pool row missing: %+v err=%v", pool, err)
	}
	pool.Port = port
	if err := svc.Pools.Set(ctx, *pool); err != nil {
		t.Fatal(err)
	}
}

// TestStopLockedClosesInProcessPoolWithoutSignalingSelf is the regression
// for a pool restart that treated /health's pid as a detached child. That
// pid is this process. SIGTERM killed the desktop test and, in the app,
// cancels the service signal handler.
func TestStopLockedClosesInProcessPoolWithoutSignalingSelf(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{
		"a": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:1"), Auth: "s-a"},
		"b": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:2"), Auth: "s-b"},
	})
	defer svc.Close()
	port := mustFreePort(t)
	setPoolRow(t, svc, port)
	ctx := context.Background()
	started, err := svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	pid, err := svc.stopLocked(ctx, "deepseek", "a")
	if err != nil {
		t.Fatalf("stopLocked: %v", err)
	}
	if pid != 0 {
		t.Fatalf("in-process pool stop returned child pid %d", pid)
	}
	if got := healthInstance(started.Endpoint); got != "" {
		t.Fatalf("pool listener still echoing %q", got)
	}
	if _, ok := svc.poolServers.get("deepseek"); ok {
		t.Fatal("pool server remained registered")
	}
}

func TestStartPoolProxyRotatesTokenAcrossConsecutiveStarts(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{
		"a": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:1"), Auth: "s-a"},
		"b": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:2"), Auth: "s-b"},
	})
	defer svc.Close()
	// Deterministic port on a free value: every restart must rebind the SAME
	// port after the pre-stop releases it.
	port := mustFreePort(t)
	svc.DefaultPort = func(string) int { return port }
	ctx := context.Background()

	first, err := svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	second, err := svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	// Reading prior state before the stops used to make every restart REUSE
	// the token; the stop clears the record first, so restarts rotate it.
	if first.Token == "" || second.Token == "" || first.Token == second.Token {
		t.Fatalf("consecutive starts must rotate the pool token: %q then %q",
			first.Token, second.Token)
	}

	// A verified stop clears proxy_state, so the next start is fresh too.
	if err := svc.StopPoolProxy(ctx, "deepseek"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	third, err := svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatalf("third start: %v", err)
	}
	if third.Token == second.Token {
		t.Fatalf("start after verified stop reused stale token %q", third.Token)
	}
}

// pickPoolToken reuses a surviving record: reuse happens ONLY when a stop
// left the record behind (no-op/unverified stop).
func TestPickPoolTokenSurvivingRecordWins(t *testing.T) {
	fresh, err := pickPoolToken(nil)
	if err != nil || fresh == "" {
		t.Fatalf("nil prior must mint a fresh token, got %q err=%v", fresh, err)
	}
	reused, err := pickPoolToken(&store.ProxyRuntimeState{Token: "surviving-token"})
	if err != nil || reused != "surviving-token" {
		t.Fatalf("surviving record must win, got %q err=%v", reused, err)
	}
	emptyPrior, err := pickPoolToken(&store.ProxyRuntimeState{})
	if err != nil || emptyPrior == "" {
		t.Fatalf("empty prior token must mint fresh, got %q err=%v", emptyPrior, err)
	}
}

func TestStartPoolProxyBindsDeterministicPort(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{
		"a": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:1"), Auth: "s-a"},
	})
	defer svc.Close()
	ctx := context.Background()

	// Explicit persisted port binds exactly.
	want := mustFreePort(t)
	setPoolRow(t, svc, want)
	res, err := svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatalf("explicit-port start: %v", err)
	}
	if res.Port != want || res.Endpoint != fmt.Sprintf("http://127.0.0.1:%d", want) {
		t.Fatalf("endpoint = %q, want deterministic port %d", res.Endpoint, want)
	}
	if err := svc.StopPoolProxy(ctx, "deepseek"); err != nil {
		t.Fatal(err)
	}

	// Port 0 falls back to the provider default hook — never a random port.
	def := mustFreePort(t)
	svc.DefaultPort = func(string) int { return def }
	setPoolRow(t, svc, 0)
	res, err = svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatalf("default-port start: %v", err)
	}
	if res.Port != def {
		t.Fatalf("port = %d, want provider default %d", res.Port, def)
	}
	if err := svc.StopPoolProxy(ctx, "deepseek"); err != nil {
		t.Fatal(err)
	}

	// An occupied planned port fails loudly instead of relocating.
	busy := mustFreePort(t)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", busy))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	setPoolRow(t, svc, busy)
	if _, err := svc.StartPoolProxy(ctx, "deepseek"); err == nil {
		t.Fatal("bind collision must fail loudly")
	} else {
		var ae *anyerr.Error
		if !errors.As(err, &ae) || ae.Code != "PROXY_START_FAILED" {
			t.Fatalf("collision error = %v, want PROXY_START_FAILED", err)
		}
	}
}
