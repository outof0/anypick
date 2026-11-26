package desktop

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/journal"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/presets"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/runtime"
	"github.com/outof0/anypick/go/internal/store"
)

// Route actions (Switch-menu chips, app-route chips) must activate through the
// persistent planner/executor. invokeTrayAction routes EVERY non-proxy
// target through app.bindingService.use(target.clientId, { with: target.source }).
// A handler that mutates the source provider's account directly (wrong scope)
// or returns success without mutating anything (false success) violates that
// contract.

// wireActivation mirrors internal/app compose so desktop handlers exercise the
// same planner/executor graph the CLI uses.
func wireActivation(t *testing.T, env *trayEnv) {
	t.Helper()
	database := env.Deps.Store.DB.DB
	profileStore := env.Deps.Profiles.Store
	if profileStore.Root == "" {
		profileStore.Root = env.Root
	}
	rt := &runtime.Service{
		Root:     env.Root,
		Home:     env.Home,
		Clients:  env.Deps.Clients,
		Profiles: profileStore,
		Catalog:  catalog.NewIndex(catalog.Builtin()),
	}
	catalogEntries := map[string]activation.CatalogEntry{}
	for id, p := range catalog.Builtin() {
		catalogEntries[id] = activation.CatalogEntry{Name: p.Name, APIStyle: string(p.APIStyle), Protocols: p.Protocols}
	}
	presetsStore := &presets.Store{Root: env.Root, DB: database}
	poolsStore := &pools.Store{Root: env.Root, DB: database}
	hubStore := &hub.Store{DB: database, Root: env.Root}
	env.Deps.Hub = hub.NewService(hubStore)
	clientProfiles := &client.ProfileStore{Root: env.Root, DB: database}
	env.Deps.Activation = &activation.Deps{
		Root:           env.Root,
		Accounts:       activation.NewAccountsView(env.Svc),
		Providers:      env.Deps.Providers,
		Clients:        env.Deps.Clients,
		ClientProfiles: clientProfiles,
		Bindings:       env.Deps.Bindings,
		Presets:        activation.NewPresetsView(presets.NewService(presetsStore)),
		Profiles:       env.Deps.Profiles,
		Pools:          activation.NewPoolsView(pools.NewService(poolsStore)),
		Journal:        &journal.OperationJournal{DB: database},
		Runtime:        rt,
		Proxy:          env.Deps.Proxy,
		Catalog:        activation.NewCatalogIndex(catalogEntries),
		Hub:            env.Deps.Hub,
	}
}

// invokeAndWait invokes one action and returns its terminal result frame. It
// drains the handler's trailing snapshot refresh before returning: the action
// runs in its own goroutine, and without this the next command is served while
// that goroutine still owns the snapshot.
func invokeAndWait(
	t *testing.T, srv *Server, inW *os.File, outR *os.File, rev int, actionID, reqID string,
) map[string]interface{} {
	t.Helper()
	return invokeWithConsent(t, srv, inW, outR, rev, actionID, reqID, false)
}

// invokeWithConsent is invokeAndWait with the user's answer to a
// CLIENT_CONFIG_FOREIGN refusal attached.
func invokeWithConsent(
	t *testing.T, srv *Server, inW *os.File, outR *os.File, rev int, actionID, reqID string, consent bool,
) map[string]interface{} {
	t.Helper()
	payload := map[string]interface{}{
		"version": 1, "requestId": reqID, "revision": rev, "actionId": actionID,
	}
	if consent {
		payload["allowForeignConfig"] = true
	}
	sendCommand(t, inW, "invoke\t"+encodePayload(payload))
	for {
		frame := readFrame(t, outR, "")
		if !strings.HasPrefix(frame, "result\t") {
			continue
		}
		res := decodeJSON(t, frame[len("result\t"):])
		if res["requestId"] == reqID {
			srv.Wait()
			return res
		}
	}
}

// gatewayProfile is a saved gateway the action tests route a client to.
func gatewayProfile(name string) profile.Runtime {
	return profile.Runtime{
		Meta: profile.Meta{
			Name: name, Provider: "deepseek", Endpoint: "https://api.deepseek.com",
		},
		Secrets: profile.Secrets{APIKey: "sk-test"},
	}
}

// actionAfterInvoke reads the snapshot the previous invoke published on its
// way out. Handlers stay registered for the current revision and the one
// before it. The 2.5s ticker keeps publishing, so an id taken before a slow
// invoke is retired before a follow-up; under the race detector that wait is
// long enough for the follow-up to be rejected as stale.
func actionAfterInvoke(
	t *testing.T, outR *os.File, pred func(map[string]interface{}) bool,
) (int, string) {
	t.Helper()
	snap := decodeJSON(t, readFrame(t, outR, "snapshot"))
	rev := int(snap["revision"].(float64))
	actionID := findAction(snap, pred)
	if actionID == "" {
		t.Fatal("action missing from the snapshot after invoke")
	}
	return rev, actionID
}

func findAction(snap map[string]interface{}, pred func(map[string]interface{}) bool) string {
	rows, _ := snap["actions"].([]interface{})
	for _, raw := range rows {
		row := raw.(map[string]interface{})
		if pred(row) {
			id, _ := row["id"].(string)
			return id
		}
	}
	return ""
}

func stopServer(inW *os.File) {
	_ = inW.Close() // scanner EOF → Run shuts down gracefully
}

// writeGrokLive points GROK_AUTH_PATH at a temp auth file with one session.
func writeGrokLive(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".grok", "auth.json")
	t.Setenv("GROK_AUTH_PATH", path)
	data := `{"session":{"email":"grok-a@example.com","token":"tok-grok-a"}}`
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A gateway app-route chip must write a global binding for the client via the
// planner/executor — not report success while doing nothing.
func TestInvokeGatewayRouteActionWritesBinding(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	ctx := context.Background()

	if _, err := env.Deps.Profiles.UpsertContext(ctx, gatewayProfile("gw1")); err != nil {
		t.Fatal(err)
	}

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })

	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))

	actionID := findAction(snap, func(row map[string]interface{}) bool {
		kind, _ := row["kind"].(string)
		src, _ := row["sourceId"].(string)
		client, _ := row["clientId"].(string)
		return kind == "gateway" && src == "gateway/gw1" && client == "codex"
	})
	if actionID == "" {
		t.Fatal("gateway route action missing from snapshot")
	}

	res := invokeAndWait(t, srv, inW, outR, rev, actionID, "gw-1")
	if res["status"] != "success" {
		t.Fatalf("gateway route invoke failed: %v", res["message"])
	}

	binding, err := env.Deps.Bindings.GetGlobalContext(context.Background(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil {
		t.Fatal("gateway chip reported success but wrote no global binding for codex")
	}
	if got := refs.SerializeRef(binding.Spec.Source); got != "gateway/gw1" {
		t.Fatalf("binding source = %q, want gateway/gw1", got)
	}
}

// A hub app-route chip must be published for every configured hub: the
// macOS sheet and tray offer the hub from these rows, and without one the
// hub exists but can never be selected. Invoking it must reach the hub
// planner (not die as an unknown action): this composition wires no live hub
// child — the activation package stubs the same boundary in its own tests —
// so the honest terminal code is HUB_UNAVAILABLE and nothing is bound.
func TestHubRouteActionPublishedAndRoutedToPlanner(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	ctx := context.Background()

	env.writeCodexLive("a@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "a", true); err != nil {
		t.Fatal(err)
	}
	enabled := true
	if _, err := env.Deps.Hub.UpsertConfigContext(ctx, hub.Config{
		Name: "hub", Enabled: true,
		Sources: []hub.Source{
			{ProviderID: "codex", Account: "a", Enabled: &enabled},
		},
	}); err != nil {
		t.Fatal(err)
	}

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })

	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))

	actionID := findAction(snap, func(row map[string]interface{}) bool {
		kind, _ := row["kind"].(string)
		src, _ := row["sourceId"].(string)
		client, _ := row["clientId"].(string)
		routeKind, _ := row["routeKind"].(string)
		return kind == "hub" && routeKind == "hub" && src == "hub/hub" && client == "codex"
	})
	if actionID == "" {
		t.Fatal("hub route action missing from snapshot")
	}

	res := invokeAndWait(t, srv, inW, outR, rev, actionID, "hub-1")
	if res["status"] != "error" {
		t.Fatalf("hub route invoke status = %q, want error (no live hub child here)", res["status"])
	}
	if code, _ := res["code"].(string); code != "HUB_UNAVAILABLE" {
		t.Fatalf("hub route invoke code = %q, want HUB_UNAVAILABLE (dead chip?)", res["code"])
	}

	binding, err := env.Deps.Bindings.GetGlobalContext(context.Background(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	if binding != nil {
		if got := refs.SerializeRef(binding.Spec.Source); got == "hub/hub" {
			t.Fatal("refused hub route must not bind codex")
		}
	}
}

// A cross-provider app-route chip must bind the CLIENT to the source account.
// Mutating the source provider's active account instead is a wrong-scope
// mutation: clicking "Claude Code ← grok/a" must not touch grok's live auth.
func TestInvokeCrossProviderAppRouteBindsClientNotSourceProvider(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	grokAuth := writeGrokLive(t)
	ctx := context.Background()

	if _, err := env.Svc.Save(ctx, "grok", "a", true); err != nil {
		t.Fatal(err)
	}

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })

	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))

	actionID := findAction(snap, func(row map[string]interface{}) bool {
		client, _ := row["clientId"].(string)
		src, _ := row["sourceId"].(string)
		return client == "claude" && src == "account/grok/a"
	})
	if actionID == "" {
		t.Fatal("cross-provider app-route action for claude × grok/a missing")
	}

	res := invokeAndWait(t, srv, inW, outR, rev, actionID, "xprov-1")
	if res["status"] != "success" {
		t.Fatalf("cross-provider route invoke failed: %v", res["message"])
	}

	binding, err := env.Deps.Bindings.GetGlobalContext(context.Background(), "claude")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil {
		t.Fatal("app-route chip reported success but wrote no global binding for claude")
	}
	if got := refs.SerializeRef(binding.Spec.Source); got != "account/grok/a" {
		t.Fatalf("binding source = %q, want account/grok/a", got)
	}

	// The source provider's live login must be untouched. Grok's adapter
	// declares requiresNativeAuthWrite: false, so the WriteNativeAuth step
	// never runs for grok sources and switching claude onto grok/a must not
	// rewrite grok's live auth or active pointer.
	live, rerr := os.ReadFile(grokAuth)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if !strings.Contains(string(live), "grok-a@example.com") {
		t.Fatalf("grok live auth was mutated by a claude route switch: %s", live)
	}
	if active, _ := env.Deps.Store.GetActive(context.Background(), "grok"); active != "" {
		t.Fatalf("grok active pointer = %q, want \"\" (route switch must not switch the source provider)", active)
	}
}

// WorkBuddy uses its own login in the native app and can serve other clients
// through the proxy.
func TestWorkBuddyProviderHasClientActions(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	authPath := filepath.Join(t.TempDir(), "auth.json")
	doc, _ := json.Marshal(map[string]any{
		"version": 1, "kind": "subscription", "methodId": "workbuddy-international",
		"base": "https://www.codebuddy.ai", "domain": "www.codebuddy.ai",
		"accessToken": "tok", "userId": "user-1",
	})
	if err := os.WriteFile(authPath, doc, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WORKBUDDY_AUTH_PATH", authPath)
	if _, err := env.Svc.Save(ctx, "workbuddy", "outof0", false); err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	snap, err := srv.buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	foundChip, foundCurrent := false, false
	for _, a := range snap.Actions {
		if a.ClientID != "workbuddy" {
			continue
		}
		if a.SourceID != "account/workbuddy/outof0" || a.RouteKind != "direct-account" || !a.Enabled {
			t.Fatalf("workbuddy route = %+v, want the direct native account", a)
		}
		switch a.Presentation {
		case "native-account":
			foundChip = true
		case "app-route":
			foundCurrent = a.Selected
		}
	}
	if !foundChip || !foundCurrent {
		t.Fatal("workbuddy is missing the saved account action or selected route")
	}
	if ids := srv.managedAppClientIDs(); !containsString(ids, "workbuddy") {
		t.Fatalf("workbuddy must be an app row: %v", ids)
	}
	if !containsString(srv.managedAppClientIDs(), "dsh") {
		t.Fatalf("dsh must stay an app row: %v", srv.managedAppClientIDs())
	}
	accountRow := false
	proxyRow := false
	for _, row := range snap.Accounts {
		if row.ProviderID == "workbuddy" && row.Name == "outof0" {
			accountRow = true
		}
	}
	for _, row := range snap.Proxies {
		if row.ProviderID == "workbuddy" && row.ID == "workbuddy/outof0" {
			proxyRow = true
		}
	}
	if !accountRow || !proxyRow {
		t.Fatalf("workbuddy account/proxy rows missing: account=%v proxy=%v", accountRow, proxyRow)
	}
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// Two saved logins behind one provider must not render as identical proxy
// rows: the label carries the account, and stays slash-free so the native
// app keeps it verbatim instead of collapsing it to the provider name.
func TestProxyRowsDisambiguateAccountsOfOneProvider(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	for _, seed := range []struct{ name, label, user string }{
		{"aa", "Alpha", "alpha-user"},
		{"bb", "Beta", "beta-user"},
	} {
		authPath := filepath.Join(t.TempDir(), seed.name+"-auth.json")
		doc, _ := json.Marshal(map[string]any{
			"version": 1, "kind": "subscription", "methodId": "workbuddy-international",
			"base": "https://www.codebuddy.ai", "domain": "www.codebuddy.ai",
			"accessToken": "tok-" + seed.name, "userId": seed.user,
		})
		if err := os.WriteFile(authPath, doc, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("WORKBUDDY_AUTH_PATH", authPath)
		if _, err := env.Svc.Save(ctx, "workbuddy", seed.name, true); err != nil {
			t.Fatalf("save %s: %v", seed.name, err)
		}
		if _, err := env.Svc.PatchMeta(ctx, "workbuddy", seed.name,
			store.MetaPatch{LabelSet: true, Label: seed.label}); err != nil {
			t.Fatalf("label %s: %v", seed.name, err)
		}
	}

	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]bool{}
	for _, row := range snap.Proxies {
		if row.ProviderID != "workbuddy" {
			continue
		}
		labels[row.Label] = true
		if strings.Contains(row.Label, "/") {
			t.Fatalf("proxy label %q carries a slash; the app would collapse it", row.Label)
		}
	}
	if !labels["WorkBuddy proxy · Alpha"] || !labels["WorkBuddy proxy · Beta"] {
		t.Fatalf("proxy labels = %v, want one row per account", labels)
	}
}

// A client's current source must appear once in the switcher: the selected
// app-route row. The cross-provider chip for that same source was emitted too,
// with a different routeKind ("account" vs "managed-account"), whose friendly
// copy differs — so the native picker could not dedupe them and showed the
// same account twice.
func TestBoundSourceAppearsOnceInTheSwitcher(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	authPath := filepath.Join(t.TempDir(), "grok-auth.json")
	t.Setenv("GROK_AUTH_PATH", authPath)
	writeLive := func(email string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(authPath, []byte(`{"sess":{"email":"`+email+`"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeLive("one@grok.xai")
	if _, err := env.Svc.Save(ctx, "grok", "one", true); err != nil {
		t.Fatal(err)
	}
	writeLive("two@grok.xai")
	if _, err := env.Svc.Save(ctx, "grok", "two", true); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{
		Client: "claude",
		Spec:   bindings.Spec{Client: "claude", Source: refs.AccountRef("grok", "one")},
	}); err != nil {
		t.Fatal(err)
	}

	snap, err := New(env.Deps, strings.NewReader(""), &strings.Builder{}).buildSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	bound, unbound := 0, 0
	for _, a := range snap.Actions {
		if a.ClientID != "claude" {
			continue
		}
		switch a.SourceID {
		case "account/grok/one":
			bound++
			if a.Presentation != "app-route" || !a.Selected || a.RouteKind != "managed-account" {
				t.Fatalf("bound source row = %+v, want the selected app-route row", a)
			}
		case "account/grok/two":
			unbound++
			if a.Presentation != "app-route" || a.Selected {
				t.Fatalf("unbound source row = %+v, want an unselected chip", a)
			}
		}
	}
	if bound != 1 {
		t.Fatalf("bound source appears %d times, want exactly the selected row", bound)
	}
	if unbound != 1 {
		t.Fatalf("unbound account chip appears %d times, want 1", unbound)
	}
}

// ZCode cannot start with an empty model selection. The model must come from
// the catalog belonging to this Z.ai account, not the first model in the
// provider definition.
func TestInvokeZCodeRouteForZAIAccountUsesAccountCatalog(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()

	if _, err := env.Svc.SaveInput(ctx, "zai", "work", accounts.CredentialInput{
		Kind: "subscription-key", Profile: "global", Secret: "test-plan-key",
	}, false); err != nil {
		t.Fatal(err)
	}
	env.Deps.Discovery = &discovery.Service{Root: env.Root, Cache: env.Deps.ModelCache}
	if err := env.Deps.Discovery.StoreLive(ctx, "zai", accountCatalogCacheKey(refs.AccountRef("zai", "work")),
		[]string{"glm-live-entitlement"}); err != nil {
		t.Fatal(err)
	}
	wireActivation(t, env)

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })

	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))
	actionID := findAction(snap, func(row map[string]interface{}) bool {
		client, _ := row["clientId"].(string)
		source, _ := row["sourceId"].(string)
		return client == "zcode" && source == "account/zai/work"
	})
	if actionID == "" {
		t.Fatal("ZCode route action for account/zai/work missing")
	}

	res := invokeAndWait(t, srv, inW, outR, rev, actionID, "zai-zcode-1")
	if res["status"] != "success" {
		t.Fatalf("ZCode route invoke failed: %v", res["message"])
	}

	binding, err := env.Deps.Bindings.GetGlobalContext(ctx, "zcode")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil || refs.SerializeRef(binding.Spec.Source) != "account/zai/work" {
		t.Fatalf("ZCode binding = %+v, want account/zai/work", binding)
	}
	if binding.Spec.Model.Mode != "explicit" || binding.Spec.Model.ID != "glm-live-entitlement" {
		t.Fatalf("ZCode model = %+v, want account catalog model", binding.Spec.Model)
	}
}

func TestZCodeRouteUsesAccountCatalogForDefaultModel(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	env.Deps.Discovery = &discovery.Service{Root: env.Root, Cache: env.Deps.ModelCache}
	source := refs.AccountRef("zai", "work")
	if err := env.Deps.Discovery.StoreLive(ctx, "zai", accountCatalogCacheKey(source),
		[]string{"glm-live-entitlement"}); err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if got := srv.routeDefaultModel(ctx, "zcode", source); got != "glm-live-entitlement" {
		t.Fatalf("route default model = %q, want dynamic account catalog", got)
	}
}

// DeepSeek Harness is a borrowing client: a WorkBuddy subscription account
// must start the managed proxy, select a source model, then write dsh's native
// files and commit the client binding. Keep this route covered separately from
// ZCode because dsh has a different config adapter.
func TestInvokeDeepSeekHarnessRouteForWorkBuddyAccount(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	authPath := filepath.Join(t.TempDir(), "workbuddy-auth.json")
	t.Setenv("WORKBUDDY_AUTH_PATH", authPath)
	if err := os.WriteFile(authPath, []byte(`{
  "version": 1,
  "kind": "subscription",
  "methodId": "workbuddy-international",
  "base": "http://127.0.0.1:9",
  "domain": "workbuddy.ai",
  "accessToken": "test-workbuddy-token",
  "userId": "workbuddy-test"
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Svc.Save(ctx, "workbuddy", "work", true); err != nil {
		t.Fatal(err)
	}
	env.Deps.Discovery = &discovery.Service{Root: env.Root, Cache: env.Deps.ModelCache}
	if err := env.Deps.Discovery.StoreLive(
		ctx,
		"workbuddy",
		accountCatalogCacheKey(refs.AccountRef("workbuddy", "work")),
		[]string{"deepseek-v4.1-flash"},
	); err != nil {
		t.Fatal(err)
	}
	wireActivation(t, env)

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })

	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))
	actionID := findAction(snap, func(row map[string]interface{}) bool {
		client, _ := row["clientId"].(string)
		source, _ := row["sourceId"].(string)
		return client == "dsh" && source == "account/workbuddy/work"
	})
	if actionID == "" {
		t.Fatal("DeepSeek Harness route action for account/workbuddy/work missing")
	}

	res := invokeAndWait(t, srv, inW, outR, rev, actionID, "dsh-workbuddy-1")
	if res["status"] != "success" {
		t.Fatalf("DeepSeek Harness route invoke failed: %v", res["message"])
	}

	binding, err := env.Deps.Bindings.GetGlobalContext(ctx, "dsh")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil || refs.SerializeRef(binding.Spec.Source) != "account/workbuddy/work" {
		t.Fatalf("DeepSeek Harness binding = %+v, want account/workbuddy/work", binding)
	}
	if binding.Spec.Model.Mode != "explicit" || binding.Spec.Model.ID != "deepseek-v4.1-flash" {
		t.Fatalf("DeepSeek Harness model = %+v, want dynamic account model", binding.Spec.Model)
	}
}

// A persisted binding must read as configured on the very first snapshot after
// an app launch, not only after a later mutation rebuilds it. The known-apps
// fallback used a hand-kept list that omitted dsh, so a reopen showed
// "Not Configured" even though the binding was committed.
func TestFirstSnapshotAfterRestartMarksDSHConfigured(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	authPath := filepath.Join(t.TempDir(), "workbuddy-auth.json")
	t.Setenv("WORKBUDDY_AUTH_PATH", authPath)
	if err := os.WriteFile(authPath, []byte(`{
  "version": 1,
  "kind": "subscription",
  "methodId": "workbuddy-international",
  "base": "http://127.0.0.1:9",
  "domain": "workbuddy.ai",
  "accessToken": "test-workbuddy-token",
  "userId": "workbuddy-test"
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Svc.Save(ctx, "workbuddy", "work", true); err != nil {
		t.Fatal(err)
	}
	env.Deps.Discovery = &discovery.Service{Root: env.Root, Cache: env.Deps.ModelCache}
	if err := env.Deps.Discovery.StoreLive(
		ctx,
		"workbuddy",
		accountCatalogCacheKey(refs.AccountRef("workbuddy", "work")),
		[]string{"deepseek-v4.1-flash"},
	); err != nil {
		t.Fatal(err)
	}
	wireActivation(t, env)

	// First launch: bind dsh through the real route action.
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })
	first := decodeJSON(t, readFrame(t, outR, "snapshot"))
	rev := int(first["revision"].(float64))
	actionID := findAction(first, func(row map[string]interface{}) bool {
		client, _ := row["clientId"].(string)
		source, _ := row["sourceId"].(string)
		return client == "dsh" && source == "account/workbuddy/work"
	})
	if actionID == "" {
		t.Fatal("DeepSeek Harness route action for account/workbuddy/work missing")
	}
	if res := invokeAndWait(t, srv, inW, outR, rev, actionID, "dsh-bind-once"); res["status"] != "success" {
		t.Fatalf("DeepSeek Harness route invoke failed: %v", res["message"])
	}

	// Second launch (fresh server, empty action cache): the committed binding
	// alone must mark dsh configured in the first snapshot.
	inR2, inW2, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR2, outW2, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv2 := New(env.Deps, inR2, outW2)
	go func() { _ = srv2.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW2) })
	second := decodeJSON(t, readFrame(t, outR2, "snapshot"))

	selected := false
	for _, raw := range second["actions"].([]interface{}) {
		row := raw.(map[string]interface{})
		if row["clientId"] != "dsh" {
			continue
		}
		if sel, _ := row["selected"].(bool); sel {
			selected = true
		}
	}
	if !selected {
		t.Fatal("first snapshot after restart has no selected dsh route action")
	}
	ready := false
	for _, raw := range second["routes"].([]interface{}) {
		row := raw.(map[string]interface{})
		if row["clientId"] == "dsh" && row["status"] == "ready" && row["source"] != nil {
			ready = true
		}
	}
	if !ready {
		t.Fatal("first snapshot after restart has no ready dsh route row")
	}
}

// Clicking the already-selected current-route row re-applies the bound source
// through the same planned path; it must never be a silent no-op.
func TestInvokeCurrentRouteReappliesBinding(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	ctx := context.Background()

	env.writeCodexLive("a@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "a", true); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{
		Client: "codex",
		Spec: bindings.Spec{
			Client: "codex",
			Source: refs.AccountRef("codex", "a"),
			Model:  bindings.OmittedModel(),
		},
	}); err != nil {
		t.Fatal(err)
	}

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, inR, outW)
	go func() { _ = srv.Run(ctx) }()
	t.Cleanup(func() { stopServer(inW) })

	first := readFrame(t, outR, "snapshot")
	snap := decodeJSON(t, first)
	rev := int(snap["revision"].(float64))

	actionID := findAction(snap, func(row map[string]interface{}) bool {
		selected, _ := row["selected"].(bool)
		client, _ := row["clientId"].(string)
		pres, _ := row["presentation"].(string)
		route, _ := row["routeKind"].(string)
		return selected && client == "codex" && pres == "app-route" && route == "direct-account"
	})
	if actionID == "" {
		t.Fatal("selected current-route action missing for codex")
	}

	res := invokeAndWait(t, srv, inW, outR, rev, actionID, "cur-1")
	if res["status"] != "success" {
		t.Fatalf("current-route invoke failed: %v", res["message"])
	}
	binding, err := env.Deps.Bindings.GetGlobalContext(context.Background(), "codex")
	if err != nil {
		t.Fatal(err)
	}
	if binding == nil || refs.SerializeRef(binding.Spec.Source) != "account/codex/a" {
		t.Fatal("current-route re-invoke lost or rewrote the codex binding")
	}
}
