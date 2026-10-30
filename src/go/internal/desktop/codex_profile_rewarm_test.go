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

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/refs"
)

// Startup reads the model cache only. When an upgrade invalidates an
// account's cached list (new discovery rules), the restored profile offered
// just its stored model, as 1.2.1's RC did for every Gemini profile; startup
// must fetch the list before it restores the profile.
func TestRehydrateRewarmsACodexProfileWithNoCachedModels(t *testing.T) {
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
	defer upSrv.Close()
	t.Setenv("GROK_MODELS_ENDPOINT", upSrv.URL)

	if _, err := env.Deps.Activation.ClientProfiles.UpsertContext(ctx, "codex", "g", bindings.Spec{
		Client: "codex", Source: refs.AccountRef("grok", "a"),
		Model: bindings.ExplicitModel("grok-4.3"), TransportPolicy: "auto",
	}); err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if err := srv.rehydrateManagedBindings(ctx); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}

	home := client.CodexProfileHomePath(env.Root, "g")
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
	if !got["grok-4.5"] || !got["grok-4.3"] {
		t.Fatalf("profile catalog = %s, want the discovered grok-4.5 and grok-4.3", raw)
	}
}
