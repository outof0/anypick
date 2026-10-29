package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/modelcache"
)

func newTestService(t *testing.T) (*Service, *modelcache.Store) {
	t.Helper()
	root := t.TempDir()
	database, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store := &modelcache.Store{DB: database}
	return &Service{Root: root, Cache: store}, store
}

func TestListFallsBackToCatalogWithoutLiveDiscovery(t *testing.T) {
	svc, _ := newTestService(t)
	res := svc.List(context.Background(), Request{ProviderID: "custom"})
	if res.Source != SourceCatalog || len(res.Models) == 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestListLiveFetchThenCache(t *testing.T) {
	models := []string{"m-newest", "m-older"}
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]string{{"id": models[0]}, {"id": models[1]}},
		})
	}))
	defer srv.Close()

	svc, store := newTestService(t)
	res := svc.List(context.Background(), Request{ProviderID: "openai", Endpoint: srv.URL, APIKey: "k"})
	if hits != 1 || res.Source != SourceLive || len(res.Models) != 2 || res.Models[0] != "m-newest" {
		t.Fatalf("live fetch wrong: hits=%d res=%+v", hits, res)
	}

	// Fresh cache answers without a network call.
	cached, _ := store.Get(context.Background(), "openai", srv.URL)
	if cached == nil {
		t.Fatal("live fetch was not cached")
	}
	res = svc.List(context.Background(), Request{ProviderID: "openai", Endpoint: srv.URL})
	if res.Source != SourceCache || hits != 1 {
		t.Fatalf("cache step wrong: hits=%d res=%+v", hits, res)
	}

	// Refresh forces the vendor.
	res = svc.List(context.Background(), Request{ProviderID: "openai", Endpoint: srv.URL, Refresh: true})
	if hits != 2 || res.Source != SourceLive {
		t.Fatalf("refresh ignored: hits=%d res=%+v", hits, res)
	}
}

func TestListLiveStyleDiscoversProviderModelsWithoutStaticPolicy(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]string{{"id": "model-added-after-release"}},
		})
	}))
	defer srv.Close()

	svc, _ := newTestService(t)
	res := svc.List(context.Background(), Request{
		ProviderID: "future-provider", Endpoint: srv.URL, APIKey: "key",
		LiveStyle: "openai",
	})
	if res.Source != SourceLive || len(res.Models) != 1 || res.Models[0] != "model-added-after-release" {
		t.Fatalf("live provider catalog = %+v", res)
	}
	if gotAuth != "Bearer key" {
		t.Fatalf("authorization = %q", gotAuth)
	}
}

func TestListVendorFailureFallsBackToStaleThenCatalog(t *testing.T) {
	up := true
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !up {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": []string{"v1"}})
	}))
	defer srv.Close()
	srvURL = srv.URL

	svc, _ := newTestService(t)
	if res := svc.List(context.Background(), Request{ProviderID: "grok-api", Endpoint: srvURL}); res.Source != SourceLive {
		t.Fatalf("expected live first: %+v", res)
	}
	up = false
	res := svc.List(context.Background(), Request{ProviderID: "grok-api", Endpoint: srvURL, Refresh: true})
	if res.Source != SourceStale || res.Note == "" {
		t.Fatalf("stale fallback wrong: %+v", res)
	}
	// Unknown provider with no cache → catalog.
	res = svc.List(context.Background(), Request{ProviderID: "gemini-api"})
	if res.Source != SourceCatalog {
		t.Fatalf("catalog fallback wrong: %+v", res)
	}
}

func TestFreshnessWindowHonoursTTL(t *testing.T) {
	old := time.Now().Add(-2 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z07:00")
	if isFresh(old, time.Now()) {
		t.Fatal("stale timestamp treated as fresh")
	}
	recent := time.Now().UTC().Format(time.RFC3339Nano)
	if !isFresh(recent, time.Now()) {
		t.Fatal("fresh timestamp treated as stale")
	}
}

var _ = filepath.Join

func TestListNoLiveNeverFetches(t *testing.T) {
	models := []string{"m-live"}
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]string{{"id": models[0]}},
		})
	}))
	defer srv.Close()

	svc, _ := newTestService(t)
	ctx := context.Background()

	// Cold cache: static fallback, zero egress.
	res := svc.List(ctx, Request{ProviderID: "openai", Endpoint: srv.URL, NoLive: true})
	if hits != 0 || res.Source != SourceCatalog || len(res.Models) == 0 {
		t.Fatalf("NoLive cold cache wrong: hits=%d res=%+v", hits, res)
	}

	// Warm the cache through the live path, then prove NoLive reads it
	// without touching the network — fresh or stale.
	live := svc.List(ctx, Request{ProviderID: "openai", Endpoint: srv.URL, APIKey: "k"})
	if live.Source != SourceLive || hits != 1 {
		t.Fatalf("warmup wrong: hits=%d res=%+v", hits, live)
	}
	res = svc.List(ctx, Request{ProviderID: "openai", Endpoint: srv.URL, NoLive: true})
	if hits != 1 || res.Source != SourceCache || len(res.Models) != 1 || res.Models[0] != "m-live" {
		t.Fatalf("NoLive fresh cache wrong: hits=%d res=%+v", hits, res)
	}

	// Expire the row: NoLive serves it stale, still without egress.
	svc.Now = func() time.Time { return time.Now().Add(2 * TTL) }
	res = svc.List(ctx, Request{ProviderID: "openai", Endpoint: srv.URL, NoLive: true})
	if hits != 1 || res.Source != SourceStale {
		t.Fatalf("NoLive stale cache wrong: hits=%d res=%+v", hits, res)
	}
}

func TestListUsesAccountScopedCacheWithoutAnEndpoint(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	key := "account/gemini/work"
	models := []string{"gemini-new-model"}
	if err := svc.StoreLive(ctx, "gemini-api", key, models); err != nil {
		t.Fatal(err)
	}

	res := svc.List(ctx, Request{
		ProviderID: "gemini-api", CacheKey: key, NoLive: true,
	})
	if res.Source != SourceCache || len(res.Models) != 1 || res.Models[0] != models[0] {
		t.Fatalf("account cache was not used: %+v", res)
	}
}

// A row filtered under older discovery rules is not served, not even as a
// stale fallback: it can hold ids the provider no longer publishes. A fresh
// write records the current rules and is served again.
func TestListIgnoresCatalogCachedUnderOlderRules(t *testing.T) {
	svc, store := newTestService(t)
	ctx := context.Background()
	key := "account/gemini/work"
	if err := store.Write(ctx, &modelcache.Entry{
		Provider: "gemini-api", Endpoint: key,
		Models: []string{"gemini-3.8-flash-tiered", "tab_flash_lite_preview"}, FetchedAt: "2026-09-18T06:44:20.574Z",
	}); err != nil {
		t.Fatal(err)
	}
	res := svc.List(ctx, Request{ProviderID: "gemini-api", CacheKey: key, NoLive: true})
	if res.Source != SourceCatalog {
		t.Fatalf("old-rules row was served: %+v", res)
	}

	if err := svc.StoreLive(ctx, "gemini-api", key, []string{"gemini-3-flash"}); err != nil {
		t.Fatal(err)
	}
	res = svc.List(ctx, Request{ProviderID: "gemini-api", CacheKey: key, NoLive: true})
	if res.Source != SourceCache || len(res.Models) != 1 || res.Models[0] != "gemini-3-flash" {
		t.Fatalf("current-rules row not served: %+v", res)
	}
}
