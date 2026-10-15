package desktop

// Desktop setting-* mutation regressions: every toggle persists through the
// config service (never the handler), and the snapshot echoes the new state.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/outof0/anypick/go/internal/config"
)

func TestDesktopSettingMutationsPersistAndEcho(t *testing.T) {
	env := newTrayEnv(t)
	env.Deps.HostState = staticHostState{enabled: true}
	var out syncedBuffer
	srv := newWaitedServerOut(t, env.Deps, &out)

	send := func(op string, enabled bool) Result {
		t.Helper()
		payload, _ := json.Marshal(Mutate{
			Version: 1, RequestID: op, Operation: op,
			ProviderID: "grok", Enabled: enabled,
		})
		if err := srv.handle(context.Background(), &Command{Kind: "mutate", Payload: payload}); err != nil {
			t.Fatal(err)
		}
		return waitForResultFor(t, &out, op)
	}

	if res := send("setting-show-quota", false); res.Status != "success" || res.Message != "Quota is hidden." {
		t.Fatalf("show-quota: %+v", res)
	}
	if res := send("setting-auto-start-proxies", true); res.Status != "success" ||
		res.Message != "Enabled proxies will start with AnyPick." {
		t.Fatalf("auto-start: %+v", res)
	}
	if res := send("setting-quota-guard", true); res.Status != "success" ||
		res.Message != "Quota Guard enabled for multi-account compatibility proxy pools." {
		t.Fatalf("quota-guard: %+v", res)
	}

	cfg, rerr := env.Deps.Config.Read(context.Background())
	if rerr != nil {
		t.Fatal(rerr)
	}
	prefs := config.TrayPreferencesOf(cfg, false)
	if prefs.ShowQuota || !prefs.StartEnabledProxies || !prefs.QuotaGuardEnabled {
		t.Fatalf("preferences not persisted: %+v", prefs)
	}

	snap := srv.currentSettings(context.Background())
	if snap.ShowQuota || !snap.StartEnabledProxies || !snap.QuotaGuardEnabled {
		t.Fatalf("snapshot settings drifted from store: %+v", snap)
	}
}

func TestSettingLaunchAtLoginIsTypedHostEffect(t *testing.T) {
	env := newTrayEnv(t)
	// Plant a decoy so the test proves the engine never writes LaunchAgents.
	home := t.TempDir()
	t.Setenv("HOME", home)
	agents := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(agents, 0o755); err != nil {
		t.Fatal(err)
	}

	env.Deps.HostState = staticHostState{enabled: true}
	var out syncedBuffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload, _ := json.Marshal(Mutate{
		Version: 1, RequestID: "lal-on", Operation: "setting-launch-at-login",
		Enabled: true,
	})
	if err := srv.handle(context.Background(), &Command{Kind: "mutate", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	res := waitForResultFor(t, &out, "lal-on")
	if res.Status != "success" || res.Message != "AnyPick will open at login." {
		t.Fatalf("result = %+v", res)
	}
	var effect config.HostEffectRequest
	if len(res.Payload) == 0 || json.Unmarshal(res.Payload, &effect) != nil {
		t.Fatalf("missing host-effect payload: %s", res.Payload)
	}
	if effect.Kind != "launch-at-login" || !effect.Enabled {
		t.Fatalf("effect = %+v", effect)
	}

	// Nothing was written under ~/Library/LaunchAgents.
	entries, _ := os.ReadDir(agents)
	if len(entries) != 0 {
		t.Fatalf("engine wrote OS state directly: %v", entries)
	}

	// Host-reported state flows into the snapshot only through HostState.
	if !srv.currentSettings(context.Background()).LaunchAtLogin {
		t.Fatal("wired host state ignored by snapshot")
	}
}

func TestSettingLanguagePersistsAndAppearsInSnapshot(t *testing.T) {
	env := newTrayEnv(t)
	var out syncedBuffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload, _ := json.Marshal(Mutate{
		Version: 1, RequestID: "language-vi", Operation: "setting-language",
		Name: "settings", Language: "vi",
	})
	if err := srv.handle(context.Background(), &Command{Kind: "mutate", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	res := waitForResultFor(t, &out, "language-vi")
	if res.Status != "success" {
		t.Fatalf("language mutation: %+v", res)
	}
	cfg, err := env.Deps.Config.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if config.LanguageOf(cfg) != "vi" {
		t.Fatalf("persisted language = %q, want vi", config.LanguageOf(cfg))
	}
	if got := srv.currentSettings(context.Background()).Language; got != "vi" {
		t.Fatalf("snapshot language = %q, want vi", got)
	}
}

type staticHostState struct{ enabled bool }

func (s staticHostState) LaunchAtLoginEnabled() bool { return s.enabled }
