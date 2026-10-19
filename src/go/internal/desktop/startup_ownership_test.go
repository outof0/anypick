package desktop

// Startup must check a client's live config before it writes anything, and a
// config the user pointed at their own login must survive an AnyPick start.
// These are the regressions for "AnyPick overwrote my Claude Code settings".

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/refs"
)

// claudeSettingsPath is where the claude adapter reads and writes.
func claudeSettingsPath(home string) string {
	return filepath.Join(home, ".claude", "settings.json")
}

// writeClaudeSettings writes the file the user would have before AnyPick ran.
func writeClaudeSettings(t *testing.T, home string, env map[string]string) string {
	t.Helper()
	path := claudeSettingsPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{"env": env})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// bindWorkbuddyToClaude saves the managed route these tests restore from.
func bindWorkbuddyToClaude(t *testing.T, env *trayEnv) refs.Ref {
	t.Helper()
	ctx := context.Background()
	authPath := filepath.Join(t.TempDir(), "auth.json")
	doc, _ := json.Marshal(map[string]any{
		"version": 1, "kind": "subscription", "methodId": "workbuddy-international",
		"base": "https://www.codebuddy.ai", "domain": "www.codebuddy.ai",
		"accessToken": "tok-ownership", "userId": "ownership@example.com",
	})
	if err := os.WriteFile(authPath, doc, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WORKBUDDY_AUTH_PATH", authPath)
	if _, err := env.Svc.Save(ctx, "workbuddy", "main", true); err != nil {
		t.Fatal(err)
	}
	source := refs.AccountRef("workbuddy", "main")
	if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{
		Client: "claude",
		Spec: bindings.Spec{
			Client: "claude", Source: source, Model: bindings.OmittedModel(),
			TransportPolicy: "auto",
		},
		Provenance: bindings.Provenance{Kind: "direct"},
	}); err != nil {
		t.Fatal(err)
	}
	return source
}

// TestStartupLeavesAnUnboundClientConfigAlone is the core promise: a client the
// user configured for their own login is not an AnyPick client, so an AnyPick
// start must not touch it — not even to "helpfully" point it at a proxy.
func TestStartupLeavesAnUnboundClientConfigAlone(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)

	userOwned := map[string]string{
		"ANTHROPIC_BASE_URL":   "https://api.anthropic.com",
		"ANTHROPIC_API_KEY":    "sk-ant-user-own-key",
		"ANTHROPIC_AUTH_TOKEN": "user-own-token",
	}
	path := writeClaudeSettings(t, env.Home, userOwned)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if err := srv.rehydrateManagedBindings(context.Background()); err != nil {
		t.Fatalf("no binding to restore, so nothing may fail: %v", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("AnyPick rewrote a client it has no binding for:\n before %s\n after  %s", before, after)
	}
	if conditions := srv.clientConfigConditions(); len(conditions) != 0 {
		t.Fatalf("an untouched client must not raise a condition: %+v", conditions)
	}
}

// TestStartupRefusesToOverwriteAUserOwnedConfig covers the bound case: the
// client has a saved AnyPick route, but its live config points at the user's
// own endpoint. AnyPick must fail closed, keep the file byte-identical, and say
// so in the snapshot instead of rewriting the user's login.
func TestStartupRefusesToOverwriteAUserOwnedConfig(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	bindWorkbuddyToClaude(t, env)

	userOwned := map[string]string{
		"ANTHROPIC_BASE_URL":   "https://api.anthropic.com",
		"ANTHROPIC_API_KEY":    "sk-ant-user-own-key",
		"ANTHROPIC_AUTH_TOKEN": "user-own-token",
	}
	path := writeClaudeSettings(t, env.Home, userOwned)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	err = srv.rehydrateManagedBindings(context.Background())
	if err == nil {
		t.Fatal("restore into a user-owned config must report the refusal")
	}
	if !strings.Contains(err.Error(), "CLIENT_CONFIG_FOREIGN") &&
		!strings.Contains(err.Error(), "not managed by AnyPick") {
		t.Fatalf("refusal should name the conflict, got %v", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("refused restore still rewrote the file:\n before %s\n after  %s", before, after)
	}

	conditions := srv.clientConfigConditions()
	if len(conditions) != 1 {
		t.Fatalf("conditions = %+v, want one for claude", conditions)
	}
	if conditions[0].ID != "client-config:claude" {
		t.Fatalf("condition id = %q", conditions[0].ID)
	}
	if !strings.Contains(conditions[0].Title, "claude") {
		t.Fatalf("condition title must name the client: %q", conditions[0].Title)
	}
	if !strings.Contains(conditions[0].Detail, "AnyPick did not change it") {
		t.Fatalf("condition detail must say the file is untouched: %q", conditions[0].Detail)
	}
}

// TestStartupRestoresItsOwnStaleConfigWithoutAsking is the other half: a
// loopback endpoint is AnyPick's own value by shape, so the restart repair
// (stale proxy token after a proxy restart) still works with no prompt.
func TestStartupRestoresItsOwnStaleConfigWithoutAsking(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	bindWorkbuddyToClaude(t, env)

	path := writeClaudeSettings(t, env.Home, map[string]string{
		"ANTHROPIC_BASE_URL":   "http://127.0.0.1:1",
		"ANTHROPIC_AUTH_TOKEN": "stale-token-from-previous-start",
	})

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	ctx := context.Background()
	if _, err := env.Deps.Proxy.StartProxy(ctx, "workbuddy", "main"); err != nil {
		t.Fatal(err)
	}
	if err := srv.rehydrateManagedBindings(ctx); err != nil {
		t.Fatalf("restore of AnyPick's own config: %v", err)
	}
	if conditions := srv.clientConfigConditions(); len(conditions) != 0 {
		t.Fatalf("a successful restore must not raise a condition: %+v", conditions)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Env["ANTHROPIC_AUTH_TOKEN"] == "stale-token-from-previous-start" {
		t.Fatal("the stale token survived: the restart repair did not run")
	}
	state, err := env.Deps.Store.ReadProxyState(ctx, "workbuddy", "main")
	if err != nil || state == nil {
		t.Fatalf("proxy state: %v", err)
	}
	if doc.Env["ANTHROPIC_AUTH_TOKEN"] != state.Token {
		t.Fatal("settings.json does not carry the live proxy token")
	}
}

// TestInvokeTakeoverNeedsExplicitConsent proves the app-side path: the route
// action fails closed, names CLIENT_CONFIG_FOREIGN, offers the takeover, and
// only the consent flag lets the same action through — after which the engine
// manages the client.
func TestInvokeTakeoverNeedsExplicitConsent(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)

	if _, err := env.Deps.Profiles.UpsertContext(context.Background(), gatewayProfile("gw1")); err != nil {
		t.Fatal(err)
	}
	path := writeClaudeSettings(t, env.Home, map[string]string{
		"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
		"ANTHROPIC_API_KEY":  "sk-ant-user-own-key",
	})
	before, err := os.ReadFile(path)
	if err != nil {
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
	go func() { _ = srv.Run(context.Background()) }()
	t.Cleanup(func() { stopServer(inW) })

	snap := decodeJSON(t, readFrame(t, outR, "snapshot"))
	rev := int(snap["revision"].(float64))
	wantGateway := func(row map[string]interface{}) bool {
		kind, _ := row["kind"].(string)
		src, _ := row["sourceId"].(string)
		client, _ := row["clientId"].(string)
		return kind == "gateway" && src == "gateway/gw1" && client == "claude"
	}
	actionID := findAction(snap, wantGateway)
	if actionID == "" {
		t.Fatal("claude gateway route action missing from snapshot")
	}

	refused := invokeWithConsent(t, srv, inW, outR, rev, actionID, "take-1", false)
	if refused["status"] != "error" {
		t.Fatalf("an unconfirmed takeover must fail: %+v", refused)
	}
	if refused["code"] != "CLIENT_CONFIG_FOREIGN" {
		t.Fatalf("code = %v, want CLIENT_CONFIG_FOREIGN", refused["code"])
	}
	suggestions, _ := refused["suggestions"].([]interface{})
	if len(suggestions) == 0 {
		t.Fatalf("a refusal must carry the escape hatch, got %+v", refused)
	}
	joined := ""
	for _, s := range suggestions {
		joined += s.(string) + " "
	}
	if !strings.Contains(joined, "allow-foreign-config") {
		t.Fatalf("suggestions must name a flag that exists: %q", joined)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatalf("refused takeover rewrote the file: %s", after)
	}

	rev, actionID = actionAfterInvoke(t, outR, wantGateway)
	confirmed := invokeWithConsent(t, srv, inW, outR, rev, actionID, "take-2", true)
	if confirmed["status"] != "success" {
		t.Fatalf("confirmed takeover failed: %v", confirmed["message"])
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) == string(before) {
		t.Fatal("confirmed takeover did not rewrite the client config")
	}
	var doc struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(after, &doc); err != nil {
		t.Fatal(err)
	}
	// A gateway route points the client at the gateway's own endpoint with the
	// gateway's key; the user's key must be gone, not left beside it.
	if doc.Env["ANTHROPIC_BASE_URL"] != "https://api.deepseek.com" {
		t.Fatalf("client was not pointed at the gateway: %q", doc.Env["ANTHROPIC_BASE_URL"])
	}
	if doc.Env["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("the user's own API key survived next to the gateway key: %#v", doc.Env)
	}
	if doc.Env["ANTHROPIC_AUTH_TOKEN"] != "sk-test" {
		t.Fatalf("client did not receive the gateway credential: %#v", doc.Env)
	}
}

// A condition describes current state, so it must not outlive the state it
// described: once the user confirms the takeover and the engine manages the
// client, the "left untouched" warning has to disappear.
func TestTakeoverConditionClearsAfterAConfirmedActivation(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	if _, err := env.Deps.Profiles.UpsertContext(context.Background(), gatewayProfile("gw1")); err != nil {
		t.Fatal(err)
	}
	writeClaudeSettings(t, env.Home, map[string]string{
		"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
		"ANTHROPIC_API_KEY":  "sk-ant-user-own-key",
	})
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	ctx := context.Background()

	// Unconfirmed: refused, and the refusal becomes a snapshot condition.
	if err := srv.activateRoute(ctx, "claude", refs.GatewayRef("gw1")); err == nil {
		t.Fatal("unconfirmed takeover must be refused")
	}
	if len(srv.clientConfigConditions()) != 1 {
		t.Fatalf("conditions = %+v, want the refusal", srv.clientConfigConditions())
	}

	// Confirmed: the engine manages the client, and the warning goes away.
	confirmed := activateRouteOptions{allowForeignConfig: true}
	if err := srv.activateRouteWith(ctx, "claude", refs.GatewayRef("gw1"), confirmed); err != nil {
		t.Fatalf("confirmed activation: %v", err)
	}
	if conditions := srv.clientConfigConditions(); len(conditions) != 0 {
		t.Fatalf("stale condition survived a successful activation: %+v", conditions)
	}
}

// A user who already has a saved route still has to be able to confirm the
// takeover. This is the branch that matters most in practice: the startup
// restore refused (binding present, config foreign), so the app offers
// "Manage with AnyPick" — and the route chip for the client's own source
// re-applies the STORED binding rather than planning a fresh activation.
// Consent must survive that branch, or the offer is a dead end.
func TestTakeoverConsentAppliesToAStoredBindingReapply(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	ctx := context.Background()

	if _, err := env.Deps.Profiles.UpsertContext(ctx, gatewayProfile("gw1")); err != nil {
		t.Fatal(err)
	}
	// A saved binding for claude, and a config the user pointed elsewhere.
	if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{
		Client: "claude",
		Spec: bindings.Spec{
			Client: "claude", Source: refs.GatewayRef("gw1"), Model: bindings.OmittedModel(),
			TransportPolicy: "auto",
		},
		Provenance: bindings.Provenance{Kind: "direct"},
	}); err != nil {
		t.Fatal(err)
	}
	path := writeClaudeSettings(t, env.Home, map[string]string{
		"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
		"ANTHROPIC_API_KEY":  "sk-ant-user-own-key",
	})

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

	snap := decodeJSON(t, readFrame(t, outR, "snapshot"))
	rev := int(snap["revision"].(float64))
	// The chip the user clicks to keep using the source they already saved.
	wantCurrent := func(row map[string]interface{}) bool {
		selected, _ := row["selected"].(bool)
		client, _ := row["clientId"].(string)
		src, _ := row["sourceId"].(string)
		return selected && client == "claude" && src == "gateway/gw1"
	}
	actionID := findAction(snap, wantCurrent)
	if actionID == "" {
		t.Fatal("selected current-route action missing for claude")
	}

	// Unconfirmed: refused, file untouched.
	refused := invokeWithConsent(t, srv, inW, outR, rev, actionID, "reapply-1", false)
	if refused["status"] != "error" || refused["code"] != "CLIENT_CONFIG_FOREIGN" {
		t.Fatalf("expected a CLIENT_CONFIG_FOREIGN refusal, got %+v", refused)
	}
	if before, _ := os.ReadFile(path); !strings.Contains(string(before), "api.anthropic.com") {
		t.Fatal("refused re-apply rewrote the file")
	}

	// Confirmed: the stored binding re-applies and the client is managed.
	rev, actionID = actionAfterInvoke(t, outR, wantCurrent)
	confirmed := invokeWithConsent(t, srv, inW, outR, rev, actionID, "reapply-2", true)
	if confirmed["status"] != "success" {
		t.Fatalf("consent was dropped on the stored-binding re-apply: %v", confirmed["message"])
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "sk-ant-user-own-key") {
		t.Fatalf("the user's own key survived a confirmed takeover: %s", raw)
	}
}

// The desktop service boots with SkipMaintenance, so startup maintenance never
// runs there. Rehydrate drops a Codex profile whose account is gone so the
// leftover is not replayed as a restore failure. The credential home stays.
func TestRehydrateSweepsOrphanedCodexProfiles(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	ctx := context.Background()

	store := env.Deps.Activation.ClientProfiles
	if _, err := store.UpsertContext(ctx, "codex", "orphan", bindings.Spec{
		Client: "codex", Source: refs.AccountRef("codex", "deleted"),
		Model: bindings.OmittedModel(), TransportPolicy: "auto",
	}); err != nil {
		t.Fatal(err)
	}
	home := client.CodexProfileHomePath(env.Root, "orphan")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	authPath := client.CodexProfileAuthPath(env.Root, "orphan")
	if err := os.WriteFile(authPath, []byte(`{"OPENAI_API_KEY":"sk-orphan"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	history := filepath.Join(home, "history.jsonl")
	if err := os.WriteFile(history, []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	if err := srv.rehydrateManagedBindings(ctx); err != nil {
		t.Fatalf("an orphaned profile must not fail startup: %v", err)
	}
	row, err := store.GetContext(ctx, "codex", "orphan")
	if err != nil {
		t.Fatal(err)
	}
	if row != nil {
		t.Fatalf("orphaned profile survived desktop startup: %#v", row)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("orphaned profile kept the deleted account's credential: %v", err)
	}
	if _, err := os.Stat(history); err != nil {
		t.Fatalf("desktop startup deleted history in the credential home: %v", err)
	}
}

func TestSnapshotNativeClaudeSupersedesStaleManagedBinding(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	source := bindWorkbuddyToClaude(t, env)
	ctx := context.Background()
	path := writeClaudeSettings(t, env.Home, map[string]string{})
	auth := filepath.Join(env.Home, ".claude", ".credentials.json")
	if err := os.WriteFile(auth, []byte(`{"claudeAiOauth":{"accessToken":"test-subscription","subscriptionType":"team"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := newWaitedServerOut(t, env.Deps, nil)

	for _, managed := range []bool{false, true, false} {
		if managed {
			cad, _ := env.Deps.Clients.Get("claude")
			if _, err := cad.Apply(&client.ApplyContext{Home: env.Home, AnyPickRoot: env.Root, Endpoint: "http://127.0.0.1:1234", APIKey: "test-proxy"}); err != nil {
				t.Fatal(err)
			}
		} else {
			writeClaudeSettings(t, env.Home, map[string]string{})
		}
		before, _ := os.ReadFile(path)
		if !managed {
			if err := srv.rehydrateManagedBindings(ctx); err != nil {
				t.Fatal(err)
			}
			if err := srv.reapplyClientsBoundTo(ctx, source, false); err != nil {
				t.Fatal(err)
			}
		}
		snap, err := srv.buildSnapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, route := range snap.Routes {
			if route["clientId"] != "claude" {
				continue
			}
			found = true
			want := "native"
			if managed {
				want = "ready"
			}
			if route["status"] != want {
				t.Fatalf("route = %+v, want %s", route, want)
			}
		}
		if !found {
			t.Fatal("Claude route missing")
		}
		offered := false
		for _, action := range snap.Actions {
			if action.ClientID != "claude" || action.SourceID != refs.SerializeRef(source) {
				continue
			}
			offered = true
			if action.Selected != managed {
				t.Fatalf("managed=%v: stale selection %+v", managed, action)
			}
		}
		if !offered {
			t.Fatal("saved source must remain available to select")
		}
		for _, config := range snap.ClientModelConfigs {
			if config["clientId"] == "claude" && !managed && config["sourceLabel"] != nil {
				t.Fatalf("native route exposes old model source: %+v", config)
			}
		}
		after, _ := os.ReadFile(path)
		if string(after) != string(before) {
			t.Fatal("snapshot modified live settings")
		}
		binding, err := env.Deps.Bindings.GetGlobalContext(ctx, "claude")
		if err != nil || binding == nil || binding.Spec.Source != source {
			t.Fatalf("snapshot changed saved binding: %+v, %v", binding, err)
		}
	}
}

func TestNativeClientsSupersedeStaleCrossProviderBindings(t *testing.T) {
	for _, clientID := range []string{"codex", "opencode"} {
		t.Run(clientID, func(t *testing.T) {
			env := newTrayEnv(t)
			wireActivation(t, env)
			source := bindWorkbuddyToClaude(t, env)
			ctx := context.Background()
			if err := env.Deps.Bindings.DeleteGlobalContext(ctx, "claude"); err != nil {
				t.Fatal(err)
			}
			if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{Client: clientID, Spec: bindings.Spec{Client: clientID, Source: source, Model: bindings.OmittedModel()}}); err != nil {
				t.Fatal(err)
			}
			env.writeCodexLive("native@example.com")
			authPath := filepath.Join(env.Home, "opencode-auth.json")
			t.Setenv("OPENCODE_AUTH_PATH", authPath)
			if err := os.WriteFile(authPath, []byte(`{"opencode":{"type":"api","key":"test-native"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			srv := newWaitedServerOut(t, env.Deps, nil)
			cad, _ := env.Deps.Clients.Get(clientID)
			for _, managed := range []bool{false, true, false} {
				if managed {
					if _, err := cad.Apply(&client.ApplyContext{Home: env.Home, AnyPickRoot: env.Root, Endpoint: "http://127.0.0.1:1234", APIKey: "test-proxy", DefaultModel: "test-model", ModelCatalog: []string{"test-model"}, AllowForeignConfig: true}); err != nil {
						t.Fatal(err)
					}
				} else if clientID == "codex" {
					path := filepath.Join(env.Home, ".codex", "config.toml")
					if err := os.WriteFile(path, []byte("model_provider = \"openai\"\n"), 0o600); err != nil {
						t.Fatal(err)
					}
				} else {
					path := filepath.Join(env.Home, ".config", "opencode", "opencode.json")
					if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte(`{"model":"opencode/native"}`), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				if !managed {
					if err := srv.rehydrateManagedBindings(ctx); err != nil {
						t.Fatal(err)
					}
					if err := srv.reapplyClientsBoundTo(ctx, source, false); err != nil {
						t.Fatal(err)
					}
				}
				snap, err := srv.buildSnapshot(ctx)
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, route := range snap.Routes {
					if route["clientId"] != clientID {
						continue
					}
					found = true
					expected := "native"
					if managed {
						expected = "ready"
					}
					if route["status"] != expected {
						t.Fatalf("managed=%v route=%+v, want %s", managed, route, expected)
					}
				}
				if !found {
					t.Fatal("missing client route")
				}
				offered := false
				for _, action := range snap.Actions {
					if action.ClientID == clientID && action.SourceID == refs.SerializeRef(source) {
						offered = true
						if action.Selected != managed {
							t.Fatalf("stale selected route: %+v", action)
						}
					}
				}
				if !offered {
					t.Fatal("saved source disappeared from picker")
				}
				persisted, err := env.Deps.Bindings.GetGlobalContext(ctx, clientID)
				if err != nil || persisted == nil || persisted.Spec.Source != source {
					t.Fatalf("snapshot mutated binding: %+v, %v", persisted, err)
				}
			}
		})
	}
}

func TestChangedSelectionsDoNotAdvertiseSavedRoutesAsReady(t *testing.T) {
	for _, clientID := range []string{"pi", "omp", "commandcode", "dsh", "zcode"} {
		t.Run(clientID, func(t *testing.T) {
			env := newTrayEnv(t)
			ctx := context.Background()
			source := bindWorkbuddyToClaude(t, env)
			if err := env.Deps.Bindings.DeleteGlobalContext(ctx, "claude"); err != nil {
				t.Fatal(err)
			}
			if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{Client: clientID, Spec: bindings.Spec{Client: clientID, Source: source, Model: bindings.OmittedModel()}}); err != nil {
				t.Fatal(err)
			}
			var path, content string
			switch clientID {
			case "pi":
				path = filepath.Join(env.Home, ".pi", "agent", "settings.json")
				content = `{"defaultProvider":"anthropic","defaultModel":"anthropic/native"}`
			case "omp":
				path = filepath.Join(env.Home, ".omp", "agent", "config.yml")
				content = "defaultProvider: anthropic\n"
			case "commandcode":
				path = filepath.Join(env.Home, ".commandcode", "config.json")
				content = `{"modelProvider":"other","model":"other/test"}`
			case "dsh":
				path = client.DshConfigPaths(env.Home)[2]
				content = `model = "native"`
			case "zcode":
				path = client.ZCodeConfigPaths(env.Home)[0]
				content = `{"provider":{"anypick":{}},"model":{"main":"zai/native"}}`
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			srv := newWaitedServerOut(t, env.Deps, nil)
			snap, err := srv.buildSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, route := range snap.Routes {
				if route["clientId"] != clientID {
					continue
				}
				found = true
				if route["status"] != "attention" || route["attentionReason"] == "" {
					t.Fatalf("changed live selection was called ready: %+v", route)
				}
			}
			if !found {
				t.Fatal("no route state for client")
			}
			for _, action := range snap.Actions {
				if action.ClientID == clientID && action.Selected {
					t.Fatalf("changed live selection still selects saved source: %+v", action)
				}
			}
		})
	}
}
