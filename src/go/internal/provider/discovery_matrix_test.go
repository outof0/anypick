package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/proxy"
)

// upstreamResolver is the provider-owned snapshot→egress capability the app
// resolver dispatches (internal/app). A CanProxy provider without it cannot
// serve traffic and cannot publish a catalog.
type upstreamResolver interface {
	ResolveUpstream(snapshotDir string) (*proxy.Upstream, error)
}

// TestProxyDiscoveryMatrix requires every proxy-capable builtin provider to
// publish a model catalog operation on its resolved upstream. The Grok picker
// outage was exactly this hole: grokUpstream carried no ModelDiscovery, so
// DiscoverModels returned ErrModelDiscoveryUnsupported forever, the desktop
// picker published zero options, and Claude bindings planned with no model.
//
// The assertion is structural (discovery present), never live: results stay
// offline and deterministic, while per-provider tests own live semantics.
// codex is the documented exception — its proxy serves only the codex client
// via a static credential and publishes its catalog into the client config,
// never through discovery. A provider with no matrix row fails here so the
// next one is classified on arrival, the same way adapter_test refuses an
// unclassified client.
func TestProxyDiscoveryMatrix(t *testing.T) {
	reg := NewRegistry()
	home := t.TempDir()
	if err := RegisterBuiltin(reg, home); err != nil {
		t.Fatal(err)
	}

	// seed builds a minimal snapshot dir that ResolveUpstream accepts.
	// wantDiscovery=false documents providers whose proxy needs no catalog.
	cases := map[string]struct {
		seed          func(t *testing.T) string
		wantDiscovery bool
		reason        string
	}{
		"grok": {seed: seedGrokMatrix, wantDiscovery: true},
		"gemini": {seed: func(t *testing.T) string {
			snap := t.TempDir()
			if _, err := newGemini(home).BackupInput("api-key", "matrix-key", "global", snap); err != nil {
				t.Fatalf("gemini seed: %v", err)
			}
			return snap
		}, wantDiscovery: true},
		"workbuddy": {seed: func(t *testing.T) string {
			wh := t.TempDir()
			p := newWorkBuddy(wh)
			writeLiveAuth(t, p, workbuddyAuthDocument{
				Version: workbuddyAuthVersion, Kind: workbuddyKindSub,
				MethodID: "workbuddy-international", Base: "https://www.codebuddy.ai",
				Domain: "www.codebuddy.ai", AccessToken: "at-matrix",
				RefreshToken: "rt-matrix", UserID: "user-matrix",
			})
			snap := t.TempDir()
			if _, err := p.Backup(snap); err != nil {
				t.Fatalf("workbuddy seed: %v", err)
			}
			return snap
		}, wantDiscovery: true},
		"cline": {seed: func(t *testing.T) string {
			snap := t.TempDir()
			if err := writeClineAuthDocument(filepath.Join(snap, clineAuthFile), clineAuthDocument{
				Version: clineAuthVersion, Kind: clineKindSub,
				AccessToken: "at-matrix", RefreshToken: "rt-matrix",
				ExpiresAtMs: time.Now().Add(time.Hour).UnixMilli(),
			}); err != nil {
				t.Fatalf("cline seed: %v", err)
			}
			return snap
		}, wantDiscovery: true},
		"opencode": {seed: func(t *testing.T) string {
			pinNoLiveOpenCodeStore(t)
			snap := t.TempDir()
			writeOpenCodeSnapshot(t, snap, `{"opencode":{"type":"api","key":"sk-matrix"}}`)
			return snap
		}, wantDiscovery: true},
		"cloudflare-aigateway": {seed: func(t *testing.T) string {
			snap := t.TempDir()
			if _, err := newCloudflareAIGateway().BackupInput("api-token", "cf-matrix", testCloudflareProfile, snap); err != nil {
				t.Fatalf("cloudflare seed: %v", err)
			}
			return snap
		}, wantDiscovery: true},
		// Keyless: the seed passes no secret, which is the case worth pinning.
		"ollama": {seed: func(t *testing.T) string {
			snap := t.TempDir()
			if _, err := newOllama().BackupInput("server", "", "global", snap); err != nil {
				t.Fatalf("ollama seed: %v", err)
			}
			return snap
		}, wantDiscovery: true},
		"lmstudio": {seed: func(t *testing.T) string {
			snap := t.TempDir()
			if _, err := newLMStudio().BackupInput("server", "", "default", snap); err != nil {
				t.Fatalf("lmstudio seed: %v", err)
			}
			return snap
		}, wantDiscovery: true},
		"codex": {seed: func(t *testing.T) string {
			snap := t.TempDir()
			writeCodexMatrixAuth(t, snap)
			return snap
		}, wantDiscovery: false,
			reason: "codex proxy serves only the codex client over a static credential; its catalog is published into the client config, not discovered"},
	}

	for _, id := range reg.IDs() {
		pv, err := reg.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if !pv.CanProxy() {
			continue // native-only (claude) and external-bridge (kiro) providers own no builtin catalog
		}
		row, ok := cases[id]
		if !ok {
			t.Errorf("provider %q CanProxy but has no discovery-matrix row: seed its snapshot and classify discovery", id)
			continue
		}
		t.Run(id, func(t *testing.T) {
			resolver, ok := pv.(upstreamResolver)
			if !ok {
				t.Fatalf("provider %q CanProxy but exposes no ResolveUpstream(snapshotDir)", id)
			}
			up, err := resolver.ResolveUpstream(row.seed(t))
			if err != nil {
				t.Fatalf("ResolveUpstream: %v", err)
			}
			got := up.ModelDiscovery != nil || up.Gemini != nil
			if got != row.wantDiscovery {
				t.Errorf("discovery-capable = %v, want %v (%s)", got, row.wantDiscovery, row.reason)
			}
		})
	}
}

func seedGrokMatrix(t *testing.T) string {
	t.Helper()
	snap := t.TempDir()
	writeGrokAuth(t, snap, "https://auth.x.ai::client",
		`{"key":"sk-matrix","oidc_issuer":"https://auth.x.ai","oidc_client_id":"client"}`)
	return snap
}

func writeCodexMatrixAuth(t *testing.T, snap string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(snap, "auth.json"), []byte(`{"tokens":{"access_token":"tok-matrix"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestCompatibleDiscoveryMatrix extends the matrix to declarative vendors:
// every builtin compatible definition funnels through one ResolveUpstream
// that wires compatibleModelDiscovery, so one generic seed (first credential
// kind, first endpoint profile) covers them all. A definition with no
// credential to seed is broken, not skipped.
func TestCompatibleDiscoveryMatrix(t *testing.T) {
	reg := NewRegistry()
	if err := RegisterBuiltinCompatibles(reg, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	for _, id := range reg.IDs() {
		pv, err := reg.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if !pv.CanProxy() {
			continue
		}
		t.Run(id, func(t *testing.T) {
			// zai is a native provider sharing the compatibles registry:
			// seed its typed-key credential the way its own tests do.
			if _, ok := pv.(*zai); ok {
				snap := t.TempDir()
				if _, err := mustNewZAI(t, t.TempDir()).BackupInput("subscription-key", "sk-matrix", "global", snap); err != nil {
					t.Fatalf("seed: %v", err)
				}
				resolver, ok := pv.(upstreamResolver)
				if !ok {
					t.Fatalf("provider %q CanProxy but exposes no ResolveUpstream(snapshotDir)", id)
				}
				up, err := resolver.ResolveUpstream(snap)
				if err != nil {
					t.Fatalf("ResolveUpstream: %v", err)
				}
				if up.ModelDiscovery == nil {
					t.Errorf("provider %q upstream carries no ModelDiscovery", id)
				}
				return
			}
			c, ok := pv.(*Compatible)
			if !ok {
				t.Fatalf("provider %q is neither *zai nor *Compatible: classify it here", id)
			}
			if len(c.Def.Credentials) == 0 || len(c.Def.Credentials[0].Profiles) == 0 {
				t.Fatalf("definition %q has no credential to seed", id)
			}
			snap := t.TempDir()
			kind := c.Def.Credentials[0].Kind
			profile := c.Def.Credentials[0].Profiles[0].ID
			if _, err := c.BackupInput(kind, "matrix-secret", profile, snap); err != nil {
				t.Fatalf("seed: %v", err)
			}
			up, err := c.ResolveUpstream(snap)
			if err != nil {
				t.Fatalf("ResolveUpstream: %v", err)
			}
			if up.ModelDiscovery == nil {
				t.Errorf("provider %q upstream carries no ModelDiscovery", id)
			}
		})
	}
}

// TestGrokDiscoveryNeverUnsupported is the end-to-end half of the matrix for
// the provider that burned us: proxy.DiscoverModels on a real grok upstream
// must return ids (live or static fallback), never
// ErrModelDiscoveryUnsupported. The models endpoint is pinned to loopback so
// the live attempt stays offline and fast; the fallback carries the assertion.
func TestGrokDiscoveryNeverUnsupported(t *testing.T) {
	upSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upSrv.Close()
	t.Setenv("GROK_MODELS_ENDPOINT", upSrv.URL)

	up, err := newGrok(t.TempDir()).ResolveUpstream(seedGrokMatrix(t))
	if err != nil {
		t.Fatalf("ResolveUpstream: %v", err)
	}
	models, err := proxy.DiscoverModels(context.Background(), up)
	if err != nil {
		t.Fatalf("DiscoverModels: %v (must never be ErrModelDiscoveryUnsupported)", err)
	}
	if len(models) == 0 {
		t.Fatal("DiscoverModels returned no ids")
	}
}
