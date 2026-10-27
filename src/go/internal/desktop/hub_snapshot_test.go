package desktop

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/modelcache"
	"github.com/outof0/anypick/go/internal/pools"
)

func hubTestEnv(t *testing.T) *trayEnv {
	t.Helper()
	env := newTrayEnv(t)
	env.Deps.Hub = hub.NewService(&hub.Store{DB: env.Deps.Store.DB.DB, Root: env.Root})
	return env
}

func toggleHub(t *testing.T, srv *Server, reqID, hubName, provider, account string, enabled bool) Result {
	t.Helper()
	return toggleHubOperation(t, srv, reqID, "hub-source-toggle", hubName, account, enabled, provider)
}

// toggleHubOperation drives one hub mutation; provider may be empty.
func toggleHubOperation(
	t *testing.T, srv *Server, reqID, operation, hubName, account string, enabled bool, provider ...string,
) Result {
	t.Helper()
	req := Mutate{
		Version: 1, RequestID: reqID, Operation: operation,
		Name: hubName, SourceID: account, Enabled: enabled,
	}
	if len(provider) > 0 {
		req.ProviderID = provider[0]
	}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	srv.Out = &out
	if err := srv.handleMutate(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	return decodeMutateResult(t, out.String())
}

// The toggle honors the explicit Enabled flag and creates the hub on first
// enable (H2): no presence guessing, no HUB_NOT_FOUND for new hubs.
func TestHubSourceToggleHonorsEnabled(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	if res := toggleHub(t, srv, "h-off-1", "default", "codex", "a", false); res.Status != "success" {
		t.Fatalf("disable on missing hub = %+v, want success no-op", res)
	}
	// Attaching a source for an account that does not exist fails closed
	// with the account named (the foreign key would refuse it anyway with
	// a raw constraint error). Ghosts are never writable.
	if res := toggleHub(t, srv, "h-on-1", "default", "codex", "a", true); res.Status == "success" {
		t.Fatalf("enable missing account = %+v, want ACCOUNT_NOT_FOUND", res)
	}
	env.writeCodexLive("hub-toggle@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "a", true); err != nil {
		t.Fatal(err)
	}
	if res := toggleHub(t, srv, "h-on-live", "default", "codex", "a", true); res.Status != "success" {
		t.Fatalf("enable = %+v", res)
	}
	cfg, err := env.Deps.Hub.GetConfigContext(ctx, "default")
	if err != nil || cfg == nil || len(cfg.Sources) != 1 || !cfg.Sources[0].IsEnabled() {
		t.Fatalf("config after enable = %+v, %v", cfg, err)
	}
	// Idempotent re-enable, then detach.
	if res := toggleHub(t, srv, "h-on-2", "default", "codex", "a", true); res.Status != "success" {
		t.Fatalf("re-enable = %+v", res)
	}
	cfg, _ = env.Deps.Hub.GetConfigContext(ctx, "default")
	if len(cfg.Sources) != 1 {
		t.Fatalf("re-enable duplicated sources: %+v", cfg.Sources)
	}
	if res := toggleHub(t, srv, "h-off-2", "default", "codex", "a", false); res.Status != "success" {
		t.Fatalf("disable = %+v", res)
	}
	cfg, _ = env.Deps.Hub.GetConfigContext(ctx, "default")
	if len(cfg.Sources) != 0 {
		t.Fatalf("sources after disable = %+v", cfg.Sources)
	}
}

// Snapshot carries hub sources for every saved account, one lifecycle row
// for the default hub, and a hub log source (H1/H3).
func TestSnapshotEmitsHubSections(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	env.writeCodexLive("hub@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "work", true); err != nil {
		t.Fatal(err)
	}

	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	foundSource := false
	for _, row := range snap.HubSources {
		id, _ := row["id"].(string)
		if id == "hub/default/codex/work" {
			foundSource = true
			if row["enabled"] != false || row["hub"] != "default" || row["name"] != "work" {
				t.Fatalf("source row = %+v", row)
			}
		}
	}
	if !foundSource {
		t.Fatalf("hub source missing: %+v", snap.HubSources)
	}
	foundProxy, foundLogs := false, false
	for _, p := range snap.Proxies {
		if p.ID == "proxy-hub/default" {
			foundProxy = true
			if p.ToggleActionID == "" || p.RestartActionID == "" {
				t.Fatalf("hub proxy has no actions: %+v", p)
			}
			if p.Running || p.Enabled {
				t.Fatalf("fresh hub should be stopped/disabled: %+v", p)
			}
		}
	}
	for _, l := range snap.LogSources {
		if l.ID == "proxy-hub/default" {
			foundLogs = true
		}
	}
	if !foundProxy || !foundLogs {
		t.Fatalf("hub proxy=%v logs=%v", foundProxy, foundLogs)
	}
	if len(snap.HubConflicts) != 0 {
		t.Fatalf("conflicts must stay empty without catalogs: %+v", snap.HubConflicts)
	}
}

func TestHubRoutingRegistersConflictActionsAndPersistsOwner(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	env.writeCodexLive("hub-a@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "hub-a", true); err != nil {
		t.Fatal(err)
	}
	env.writeCodexLive("hub-b@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "hub-b", true); err != nil {
		t.Fatal(err)
	}
	enabled := true
	if _, err := env.Deps.Hub.UpsertConfigContext(ctx, hub.Config{
		Name: "default", Enabled: true,
		Sources: []hub.Source{
			{ProviderID: "codex", Account: "hub-a", Enabled: &enabled},
			{ProviderID: "codex", Account: "hub-b", Enabled: &enabled},
		},
	}); err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	snap, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatalf("buildSnapshot: %v", err)
	}
	if len(snap.HubConflicts) != 1 {
		t.Fatalf("hub conflicts = %+v, want one same-catalog choice", snap.HubConflicts)
	}
	candidates, _ := snap.HubConflicts[0]["candidates"].([]map[string]any)
	if len(candidates) != 2 {
		t.Fatalf("conflict candidates = %+v", candidates)
	}
	actionID, _ := candidates[0]["actionId"].(string)
	ownerID, _ := candidates[0]["id"].(string)
	if actionID == "" || ownerID == "" {
		t.Fatalf("incomplete candidate = %+v", candidates[0])
	}
	handler, ok := srv.actionHandler(actionID)
	if !ok {
		t.Fatalf("no engine action registered for %q", actionID)
	}
	if err := handler(ctx, actionOptions{}); err != nil {
		t.Fatalf("choose hub owner: %v", err)
	}

	updated, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatalf("buildSnapshot after owner choice: %v", err)
	}
	if len(updated.HubConflicts) != 0 {
		t.Fatalf("conflict remained after owner choice: %+v", updated.HubConflicts)
	}
	found := false
	for _, row := range updated.HubPublishedModels {
		if row["ownerAccountId"] == ownerID && row["needsChoice"] == false {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("owner pin missing from published models: %+v", updated.HubPublishedModels)
	}
}

// Pinned route models surface as published models with owners.
func TestSnapshotPublishesPinnedRouteModels(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	env.writeCodexLive("pub@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "work", true); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Deps.Hub.UpsertConfigContext(ctx, hub.Config{
		Name: "default", Sources: []hub.Source{{ProviderID: "codex", Account: "work"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := env.Deps.Hub.AttachRouteContext(ctx, hub.Route{
		RouteID: hub.DefaultRouteID("default"), HubName: "default",
		ClientID: "codex", Token: "tok-123",
		Models: []hub.ModelRoute{{Model: "gpt-x", SourceIndex: 0}},
	}); err != nil {
		t.Fatal(err)
	}

	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.HubPublishedModels) != 1 {
		t.Fatalf("published = %+v", snap.HubPublishedModels)
	}
	row := snap.HubPublishedModels[0]
	if row["id"] != "gpt-x" || row["ownerProviderId"] != "codex" || row["needsChoice"] != false {
		t.Fatalf("published row = %+v", row)
	}
}

// HubCatalogs carry static policy models without egress: a codex account
// resolves through the openai catalog policy (CatalogProviderFor), cold
// cache, no network.
func TestSnapshotEmitsHubCatalogsFromStaticPolicy(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	env.writeCodexLive("hub@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "work", true); err != nil {
		t.Fatal(err)
	}
	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range snap.HubCatalogs {
		id, _ := row["accountID"].(string)
		if id != "hub/default/codex/work" {
			continue
		}
		found = true
		if row["catalog"] != "openai" {
			t.Fatalf("catalog = %+v, want openai", row)
		}
		models, _ := row["models"].([]string)
		if len(models) == 0 {
			t.Fatalf("codex catalog is empty: %+v", row)
		}
		seen := map[string]bool{}
		for _, m := range models {
			seen[m] = true
		}
		if !seen["gpt-5.6-sol"] {
			t.Fatalf("codex catalog missing static fallback: %v", models)
		}
	}
	if !found {
		t.Fatalf("hub catalog missing: %+v", snap.HubCatalogs)
	}
}

// Warm-on-start writes opencode live models to the cache (fake fetch, no
// network); the next snapshot tick reads them cache-only alongside the
// static mirror union.
func TestWarmOpenCodeCatalogsCachesLiveModels(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	authPath := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"opencode-go":{"type":"api","key":"sk-test"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENCODE_AUTH_PATH", authPath)
	if _, err := env.Svc.Save(ctx, "opencode", "work", true); err != nil {
		t.Fatal(err)
	}
	env.Deps.Discovery = &discovery.Service{Root: env.Root, Cache: &modelcache.Store{DB: env.Deps.Store.DB}}
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	calls := 0
	srv.warmOpenCodeCatalogs(ctx, func(context.Context, string, string) ([]string, error) {
		calls++
		return []string{"m-warm-1"}, nil
	})
	if calls == 0 {
		t.Fatal("warm did not fetch for the opencode mirror")
	}
	snap, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range snap.HubCatalogs {
		id, _ := row["accountID"].(string)
		if id != "hub/default/opencode/work" {
			continue
		}
		found = true
		models, _ := row["models"].([]string)
		seen := map[string]bool{}
		for _, m := range models {
			seen[m] = true
		}
		if !seen["m-warm-1"] || !seen["glm-5.2"] {
			t.Fatalf("opencode catalog = %v, want warmed + static union", models)
		}
	}
	if !found {
		t.Fatalf("opencode hub catalog missing: %+v", snap.HubCatalogs)
	}
}

// Warm is a no-op without opencode accounts: no fetch, no cache write, no error.
func TestWarmOpenCodeCatalogsSkipsWithoutAccounts(t *testing.T) {
	env := hubTestEnv(t)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	srv.warmOpenCodeCatalogs(context.Background(), func(context.Context, string, string) ([]string, error) {
		t.Fatal("fetch must not run without opencode accounts")
		return nil, nil
	})
}

// Pinned route models merge into catalog rows, so Swift compiles published
// models and conflicts from a single input.
func TestSnapshotMergesPinnedModelsIntoCatalogs(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	env.writeCodexLive("pub@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "work", true); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Deps.Hub.UpsertConfigContext(ctx, hub.Config{
		Name: "default", Sources: []hub.Source{{ProviderID: "codex", Account: "work"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := env.Deps.Hub.AttachRouteContext(ctx, hub.Route{
		RouteID: hub.DefaultRouteID("default"), HubName: "default",
		ClientID: "codex", Token: "tok-123",
		Models: []hub.ModelRoute{{Model: "gpt-pinned-x", SourceIndex: 0}},
	}); err != nil {
		t.Fatal(err)
	}
	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range snap.HubCatalogs {
		id, _ := row["accountID"].(string)
		if id != "hub/default/codex/work" {
			continue
		}
		found = true
		models, _ := row["models"].([]string)
		seen := map[string]bool{}
		for _, m := range models {
			seen[m] = true
		}
		if !seen["gpt-pinned-x"] || !seen["gpt-5.6-sol"] {
			t.Fatalf("catalog = %v, want pinned + static union", models)
		}
	}
	if !found {
		t.Fatalf("hub catalog missing: %+v", snap.HubCatalogs)
	}
}

// seedCodexAccounts saves n accounts so the hub has something to rotate.
func seedCodexAccounts(t *testing.T, env *trayEnv, names ...string) {
	t.Helper()
	ctx := context.Background()
	for _, name := range names {
		env.writeCodexLive(name + "@example.com")
		if _, err := env.Svc.Save(ctx, "codex", name, true); err != nil {
			t.Fatal(err)
		}
	}
}

// The mode is one row for the whole hub — never one row per provider — and it
// reports how many accounts actually rotate.
func TestHubRotationRowIsHubWide(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	seedCodexAccounts(t, env, "work", "home")
	if _, err := env.Deps.Hub.UpsertConfigContext(ctx, hub.Config{
		Name: "default",
		Sources: []hub.Source{
			{ProviderID: "codex", Account: "work"},
			{ProviderID: "codex", Account: "home"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rotations := 0
	var row map[string]any
	for _, candidate := range snap.HubSources {
		if candidate["rotates"] == true {
			rotations++
			row = candidate
		}
	}
	if rotations != 1 {
		t.Fatalf("rotation rows = %d, want exactly one hub-wide row: %+v", rotations, snap.HubSources)
	}
	if row["id"] != "hub/default/rotation" || row["enabled"] != false || row["accountCount"] != 2 {
		t.Fatalf("rotation row = %+v", row)
	}
}

// Turning it on writes the hub's strategy — no pool rows, no per-provider
// source surgery — and turning it off restores the sticky default.
func TestHubRotationToggleWritesStrategy(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	seedCodexAccounts(t, env, "work", "home")
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	res := toggleHubOperation(t, srv, "rot-on", "hub-rotation", "default", "", true)
	if res.Status != "success" {
		t.Fatalf("enable rotation = %+v", res)
	}
	cfg, err := env.Deps.Hub.GetConfigContext(ctx, "default")
	if err != nil || cfg == nil {
		t.Fatal(err)
	}
	if !cfg.SpreadsRequests() {
		t.Fatalf("strategy after enable = %q", cfg.Strategy)
	}
	snap, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range snap.HubSources {
		if row["rotates"] == true && row["enabled"] != true {
			t.Fatalf("rotation row after enable = %+v", row)
		}
	}

	if res := toggleHubOperation(t, srv, "rot-off", "hub-rotation", "default", "", false); res.Status != "success" {
		t.Fatalf("disable rotation = %+v", res)
	}
	cfg, err = env.Deps.Hub.GetConfigContext(ctx, "default")
	if err != nil || cfg == nil {
		t.Fatal(err)
	}
	if cfg.Strategy != hub.StrategyFailover {
		t.Fatalf("strategy after disable = %q, want failover", cfg.Strategy)
	}
}

// A host that names the strategy sets it directly, and the snapshot reports
// it, so a third mode is not squeezed through the round-robin flag.
func TestHubRotationAcceptsANamedStrategy(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	seedCodexAccounts(t, env, "work", "home")
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	raw, err := json.Marshal(Mutate{
		Version: 1, RequestID: "rot-soonest", Operation: "hub-rotation",
		Name: "default", Strategy: hub.StrategySoonestReset,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The frame a host sends carries only the keys it sets.
	wire, _ := json.Marshal(map[string]any{
		"version": 1, "requestId": "rot-soonest", "operation": "hub-rotation",
		"name": "default", "strategy": hub.StrategySoonestReset,
	})
	if _, err := DecodeLine("mutate\t" + base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("a strategy-only hub-rotation was rejected: %v", err)
	}
	var out strings.Builder
	srv.Out = &out
	if err := srv.handleMutate(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if res := decodeMutateResult(t, out.String()); res.Status != "success" {
		t.Fatalf("set soonest-reset = %+v", res)
	}
	cfg, err := env.Deps.Hub.GetConfigContext(ctx, "default")
	if err != nil || cfg == nil || cfg.Strategy != hub.StrategySoonestReset {
		t.Fatalf("stored strategy = %+v, %v", cfg, err)
	}
	snap, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range snap.HubSources {
		if row["rotates"] == true {
			found = true
			if row["strategy"] != hub.StrategySoonestReset || row["enabled"] != false {
				t.Fatalf("rotation row = %+v, want strategy soonest-reset and the round-robin flag off", row)
			}
		}
	}
	if !found {
		t.Fatal("no rotation row in the snapshot")
	}

	bad, _ := json.Marshal(map[string]any{
		"version": 1, "requestId": "bad", "operation": "hub-rotation", "name": "default", "strategy": "random",
	})
	if _, err := DecodeLine("mutate\t" + base64.StdEncoding.EncodeToString(bad)); err == nil {
		t.Fatal("an unknown strategy was accepted")
	}
}

// A hub source toggle restarts a hub that is already serving: the manifest and
// the config are read when it starts, so a switch that appeared to work would
// otherwise route nothing new.
func TestHubSourceToggleLeavesAStoppedHubAlone(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	seedCodexAccounts(t, env, "work")
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	if res := toggleHub(t, srv, "h-on", "default", "codex", "work", true); res.Status != "success" {
		t.Fatalf("enable = %+v", res)
	}
	cfg, err := env.Deps.Hub.GetConfigContext(ctx, "default")
	if err != nil || cfg == nil || len(cfg.Sources) != 1 {
		t.Fatalf("config = %+v, %v", cfg, err)
	}
}

// hubRotateEnv adds the pools table the pool-source rows and toggles write.
func hubRotateEnv(t *testing.T) *trayEnv {
	t.Helper()
	env := hubTestEnv(t)
	env.Deps.Pools = pools.NewService(&pools.Store{Root: env.Root, DB: env.Deps.Store.DB.DB})
	return env
}

// seedPoolSource points one provider's hub source at its account pool, the way
// the CLI (and an older build of the app) does.
func seedPoolSource(t *testing.T, env *trayEnv, providerID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := env.Deps.Hub.UpsertConfigContext(ctx, hub.Config{
		Name: "default",
		Sources: []hub.Source{
			{ProviderID: providerID, Account: hub.PoolSourceAccount(providerID)},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := env.Deps.Pools.Set(ctx, pools.Pool{
		Provider: providerID, Mode: "multi", Enabled: true, Strategy: hub.StrategyRoundRobin,
		Members: []pools.Member{{Account: "work", Enabled: true}, {Account: "home", Enabled: true}},
	}); err != nil {
		t.Fatal(err)
	}
}

// A pool source must be visible in the Hub pane: it is the only source for that
// provider, so an app that cannot see it offers account switches that are all
// refused ("this hub serves codex through its account pool").
func TestHubPoolSourceIsVisibleAndToggleable(t *testing.T) {
	env := hubRotateEnv(t)
	ctx := context.Background()
	seedCodexAccounts(t, env, "work", "home")
	seedPoolSource(t, env, "codex")
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	snap, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]any
	for _, candidate := range snap.HubSources {
		if candidate["id"] == "hub/default/codex/pool:codex" {
			row = candidate
		}
	}
	if row == nil {
		t.Fatalf("the pool source has no row: %+v", snap.HubSources)
	}
	if row["poolSource"] != true || row["enabled"] != true {
		t.Fatalf("pool row = %+v", row)
	}
	if label, _ := row["label"].(string); !strings.Contains(label, "All codex accounts") {
		t.Fatalf("pool row label = %q, want it to name the pool", label)
	}
	if detail, _ := row["detail"].(string); !strings.Contains(detail, "Legacy") {
		t.Fatalf("pool row detail = %q, want it to say the row must go", detail)
	}

	// Enabling one account while the pool owns the provider is refused, with a
	// next step the user can actually perform in the app.
	res := toggleHub(t, srv, "acct-on", "default", "codex", "work", true)
	if res.Status != "error" || res.Code != "POOL_SOURCE_ACTIVE" {
		t.Fatalf("account toggle during a pool source = %+v", res)
	}
	joined := strings.Join(res.Suggestions, " ")
	if !strings.Contains(joined, "All codex accounts (pool)") {
		t.Fatalf("refusal suggestions = %v, want the row to turn off", res.Suggestions)
	}

	// Turning the legacy row back on is refused: rotation is the hub-wide
	// switch, and one ring per provider is what the user rejected.
	res = toggleHub(t, srv, "pool-on-legacy", "default", "codex", "pool:codex", true)
	if res.Status != "error" || res.Code != "POOL_SOURCE_RETIRED" {
		t.Fatalf("re-enabling a retired pool source = %+v", res)
	}

	// Turning the pool row off clears both halves: the source and the pool row.
	if res := toggleHub(t, srv, "pool-off", "default", "codex", "pool:codex", false); res.Status != "success" {
		t.Fatalf("pool toggle off = %+v", res)
	}
	cfg, err := env.Deps.Hub.GetConfigContext(ctx, "default")
	if err != nil || cfg == nil {
		t.Fatal(err)
	}
	for _, src := range cfg.Sources {
		if src.ProviderID == "codex" {
			t.Fatalf("codex source survived the pool toggle: %+v", src)
		}
	}
	// The pool row itself is a separate feature (CLI-managed pool proxies), so
	// retiring a legacy hub source must not disable it behind the user's back.
	pool, err := env.Deps.Pools.GetContext(ctx, "codex")
	if err != nil || pool == nil || !pool.Enabled {
		t.Fatalf("pool row after toggle off = %+v, %v", pool, err)
	}

	// With the pool gone, an individual account is switchable again.
	if res := toggleHub(t, srv, "acct-on2", "default", "codex", "work", true); res.Status != "success" {
		t.Fatalf("account toggle after the pool was cleared = %+v", res)
	}
}

// A hub source whose account no longer exists must surface as a ghost row.
// Relational rows make this unreachable through the API (the foreign key
// refuses the upsert), so the test stages a foreign-written document
// directly: the row covers pre-migration and foreign states, where the
// GetConfig fallback reads the document because no rows exist.
func TestSnapshotEmitsGhostRowForDeletedHubSource(t *testing.T) {
	env := hubTestEnv(t)
	ctx := context.Background()
	config := `{"name":"default","enabled":true,"host":"127.0.0.1","sources":[
		{"ref":{"kind":"account","provider":"workbuddy","name":"ghost"}}],
		"modelOwners":[],"revision":1,"createdAt":"t","updatedAt":"t"}`
	if _, err := env.Deps.Store.DB.DB.ExecContext(ctx,
		`INSERT INTO proxy_hubs (name, config_json, created_at, updated_at)
		 VALUES ('default', ?, 't', 't')`, config); err != nil {
		t.Fatal(err)
	}
	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatalf("buildSnapshot: %v", err)
	}
	for _, row := range snap.HubSources {
		if id, _ := row["id"].(string); id == "hub/default/workbuddy/ghost" {
			if row["ghost"] != true {
				t.Fatalf("ghost flag missing: %+v", row)
			}
			if reason, _ := row["unavailableReason"].(string); reason == "" {
				t.Fatalf("ghost row needs unavailableReason: %+v", row)
			}
			return
		}
	}
	t.Fatalf("no ghost row for deleted hub source: %+v", snap.HubSources)
}
