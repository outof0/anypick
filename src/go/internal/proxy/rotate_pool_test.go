package proxy

import (
	"context"
	"net/http"
	"testing"

	"github.com/outof0/anypick/go/internal/refs"
)

// A running pool keeps its listener on the primary member's runtime row, so
// "is the primary's proxy running?" answers yes for the pool. Rotating the
// primary's key used to stop that listener and start a single-account proxy
// in its place: the pool silently stopped rotating, and every other member
// went unused until someone restarted it by hand.
func TestRotatePoolPrimaryKeepsThePool(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{
		"a": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:1"), Auth: "s-a"},
		"b": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:2"), Auth: "s-b"},
	})
	defer svc.Close()
	setPoolRow(t, svc, mustFreePort(t))
	ctx := context.Background()
	started, err := svc.StartPoolProxy(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}

	rotated, err := svc.RotateToken(ctx, "deepseek", "a")
	if err != nil {
		t.Fatalf("rotate the pool primary: %v", err)
	}

	if _, ok := svc.poolServers.get("deepseek"); !ok {
		t.Fatal("rotating the primary's key stopped the pool")
	}
	if _, ok := svc.servers.get("deepseek", "a"); ok {
		t.Fatal("rotating the primary's key started a single-account proxy in the pool's place")
	}
	st, err := svc.StatusContext(ctx, "deepseek", "a")
	if err != nil || st == nil || !st.Running {
		t.Fatalf("pool status after rotate = %+v, %v", st, err)
	}
	if err := VerifyTokenRotation(ctx, st.Endpoint, rotated, started.Token); err != nil {
		t.Fatalf("the pool does not serve the rotated key: %v", err)
	}
	if got := probeBearerStatus(st.Endpoint, started.Token); got != http.StatusUnauthorized {
		t.Fatalf("the pool still accepts the previous key: %d", got)
	}
}

// The pool's key lives on its primary's row, so the pool's clients hold it
// too. A rotation that moved only the account's clients left every client
// bound to pool:<provider> presenting a refused key, while the command
// reported success.
func TestKeyHoldersOfAPoolPrimaryIncludeThePool(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{
		"a": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:1"), Auth: "s-a"},
		"b": {BaseURL: mustParseURLHelper(t, "http://127.0.0.1:2"), Auth: "s-b"},
	})
	defer svc.Close()
	setPoolRow(t, svc, mustFreePort(t))
	ctx := context.Background()
	if got := svc.KeyHolders(ctx, "deepseek", "a"); len(got) != 1 {
		t.Fatalf("before the pool runs, key holders = %v, want the account only", got)
	}
	if _, err := svc.StartPoolProxy(ctx, "deepseek"); err != nil {
		t.Fatal(err)
	}
	got := svc.KeyHolders(ctx, "deepseek", "a")
	if len(got) != 2 || refs.SerializeRef(got[1]) != refs.SerializeRef(refs.AccountPoolRef("deepseek")) {
		t.Fatalf("key holders of the running pool's primary = %v, want the account and pool:deepseek", got)
	}
	if other := svc.KeyHolders(ctx, "deepseek", "b"); len(other) != 1 {
		t.Fatalf("a non-primary member holds no pool key, got %v", other)
	}
}
