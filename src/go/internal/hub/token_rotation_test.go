package hub

import (
	"context"
	"testing"

	"github.com/outof0/anypick/go/internal/proxy"
)

// The hub looks a key up on every request, so a rotation must take effect on
// a running hub without a restart: the old key refused at once, the new one
// accepted. `anypick proxy hub token --rotate` reports success only after
// checking exactly this.
func TestRunningHubHonoursARotatedKeyAtOnce(t *testing.T) {
	st := newHubStore(t)
	seedHubAccounts(t, st, "glm/cn")
	ctx := context.Background()
	cfg, err := st.UpsertConfigContext(ctx, Config{
		Name: "default", Enabled: true,
		Sources: []Source{{ProviderID: "glm", Account: "cn"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(st)
	previous, err := svc.EnsureHubTokenContext(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{Config: cfg, Store: svc, Resolver: &fakeResolver{}}
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = srv.Stop() }()

	if err := proxy.VerifyTokenRotation(ctx, srv.Endpoint(), previous, ""); err != nil {
		t.Fatalf("the hub refused its own key before rotation: %v", err)
	}
	rotated, err := svc.RotateHubTokenContext(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	if err := proxy.VerifyTokenRotation(ctx, srv.Endpoint(), rotated, previous); err != nil {
		t.Fatalf("a running hub did not honour the rotation: %v", err)
	}
}
