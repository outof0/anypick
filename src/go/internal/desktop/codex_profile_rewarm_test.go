package desktop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/refs"
)

// Startup reads the model cache only. When an upgrade invalidates an
// account's cached list (new discovery rules), the restored profile offered
// just its stored model, as 1.2.1's RC did for every Gemini profile; startup
// must fetch the list before it restores the profile.
func TestRehydrateRewarmsACodexProfileWithNoCachedModels(t *testing.T) {
	env, ctx := codexGrokProfileEnv(t)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if err := srv.rehydrateManagedBindings(ctx); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	assertProfileModels(t, env.Root, "grok-4.5", "grok-4.3")
}

// A cached list is not trusted at startup either: the account may have
// gained or lost models since it was stored.
func TestRehydrateReplacesACachedCodexProfileModelList(t *testing.T) {
	env, ctx := codexGrokProfileEnv(t)
	if err := env.Deps.Discovery.StoreLive(ctx, catalog.CatalogIdentityFor("grok"),
		accountCatalogCacheKey(refs.AccountRef("grok", "a")), []string{"grok-old"}); err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if err := srv.rehydrateManagedBindings(ctx); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	slugs := assertProfileModels(t, env.Root, "grok-4.5", "grok-4.3")
	if slugs["grok-old"] {
		t.Fatal("startup restored the profile with the cached list instead of the live one")
	}
}

// Opening a profile fetches the account's list again before the window
// starts, so it offers what the account can call now.
func TestOpenRefreshesACodexProfileModelList(t *testing.T) {
	env, ctx := codexGrokProfileEnv(t)
	if err := env.Deps.Discovery.StoreLive(ctx, catalog.CatalogIdentityFor("grok"),
		accountCatalogCacheKey(refs.AccountRef("grok", "a")), []string{"grok-old"}); err != nil {
		t.Fatal(err)
	}
	opened := false
	saved := openCodexProfileApp
	openCodexProfileApp = func(context.Context, string, *activation.Deps) error { opened = true; return nil }
	t.Cleanup(func() { openCodexProfileApp = saved })

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if res := srv.mutateCodexProfileOpen(ctx, Mutate{Operation: "codex-profile-open", Name: "g"}, Result{}); !opened {
		t.Fatalf("open did not reach the app launch: %+v", res)
	}
	slugs := assertProfileModels(t, env.Root, "grok-4.5", "grok-4.3")
	if slugs["grok-old"] {
		t.Fatal("open kept the cached list instead of the live one")
	}
}

// codexGrokProfileEnv saves a Grok account whose discovery answers grok-4.5
// and grok-4.3, and a Codex profile "g" routed to it.
func codexGrokProfileEnv(t *testing.T) (*trayEnv, context.Context) {
	t.Helper()
	env := newTrayEnv(t)
	wireActivation(t, env)
	env.Deps.Proxy.Resolver = &delegatingUpstreamResolver{env: env}
	env.Deps.Discovery = &discovery.Service{Root: env.Root, Cache: env.Deps.ModelCache}
	writeGrokOIDCLive(t)
	ctx := context.Background()

	if _, err := env.Svc.Save(ctx, "grok", "a", true); err != nil {
		t.Fatalf("save grok: %v", err)
	}
	upSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"grok-4.5"},{"id":"grok-4.3"}]}`))
	}))
	t.Cleanup(upSrv.Close)
	t.Setenv("GROK_MODELS_ENDPOINT", upSrv.URL)

	if _, err := env.Deps.Activation.ClientProfiles.UpsertContext(ctx, "codex", "g", bindings.Spec{
		Client: "codex", Source: refs.AccountRef("grok", "a"),
		Model: bindings.ExplicitModel("grok-4.3"), TransportPolicy: "auto",
	}); err != nil {
		t.Fatal(err)
	}
	return env, ctx
}

// assertProfileModels reads profile g's Codex catalog and requires each id.
func assertProfileModels(t *testing.T, root string, want ...string) map[string]bool {
	t.Helper()
	home := client.CodexProfileHomePath(root, "g")
	paths, _ := filepath.Glob(filepath.Join(home, "anypick-model-catalog-*.json"))
	if len(paths) != 1 {
		t.Fatalf("profile catalogs under %s = %v, want one", home, paths)
	}
	raw, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Models []struct {
			Slug string `json:"slug"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, m := range doc.Models {
		got[m.Slug] = true
	}
	for _, id := range want {
		if !got[id] {
			t.Fatalf("profile catalog = %s, want %v", raw, want)
		}
	}
	return got
}
