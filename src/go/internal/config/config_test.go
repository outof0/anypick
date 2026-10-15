package config

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/outof0/anypick/go/internal/db"
)

func newConfigEnv(t *testing.T) (*Store, *ConfigService) {
	t.Helper()
	root := t.TempDir()
	database, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	st := NewStore(root, database)
	return st, NewService(st)
}

func TestReadFallsBackToDefaults(t *testing.T) {
	store, _ := newConfigEnv(t)
	cfg, err := store.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := Defaults()
	if cfg != want {
		t.Fatalf("cfg = %+v, want %+v", cfg, want)
	}
	if LanguageOf(cfg) != LanguageAuto {
		t.Fatalf("default language = %q, want %q", LanguageOf(cfg), LanguageAuto)
	}
}

func TestWriteReadRoundTripMatchesTSShape(t *testing.T) {
	ctx := context.Background()
	store, _ := newConfigEnv(t)
	cfg := Defaults()
	yes, no := true, false
	three := 3
	cfg.DefaultClient = "codex"
	cfg.UI = &UI{
		DefaultSurface: "tray",
		QuotaGuard:     &QuotaGuardCfg{Enabled: &no, CooldownMinutes: &three},
		Tray:           &TrayCfg{StartEnabledProxies: &no, ShowQuota: &yes},
	}
	if err := store.Write(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := store.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultClient != "codex" || got.UI == nil || got.UI.DefaultSurface != "tray" ||
		got.UI.Tray == nil || got.UI.Tray.ShowQuota == nil || !*got.UI.Tray.ShowQuota {
		t.Fatalf("round trip lost data: %+v", got)
	}

	// The stored document must be readable by the TS codec: schemaVersion
	// present at the top level, ui.* nested exactly as in GlobalConfig.
	raw, rerr := os.ReadFile(filepath.Join(store.Root, "anypick.db"))
	_ = raw
	_ = rerr
	var doc map[string]any
	database, derr := db.Open(store.Root)
	if derr != nil {
		t.Fatal(derr)
	}
	defer database.Close()
	row := database.QueryRowContext(ctx, `SELECT value FROM config WHERE key = 'global'`)
	var value string
	if err := row.Scan(&value); err != nil {
		t.Fatal(err)
	}
	if jsonUnmarshalCheck(t, value, &doc) {
		if _, ok := doc["schemaVersion"]; !ok {
			t.Fatalf("schemaVersion missing from document: %s", value)
		}
		ui, ok := doc["ui"].(map[string]any)
		if !ok || ui["defaultSurface"] != "tray" {
			t.Fatalf("ui shape drifted: %s", value)
		}
	}
}

func TestEnsureIsIdempotentAndDoesNotClobber(t *testing.T) {
	ctx := context.Background()
	store, svc := newConfigEnv(t)
	first, err := svc.Ensure(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// A later write must survive another Ensure (it must not reset).
	next := first
	next.DefaultClient = "gemini"
	if werr := store.Write(ctx, next); werr != nil {
		t.Fatal(werr)
	}
	if _, err = svc.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Read(ctx)
	if got.DefaultClient != "gemini" {
		t.Fatalf("Ensure clobbered an existing row: %+v", got)
	}
}

func TestServiceMutationsPersistUnderLock(t *testing.T) {
	ctx := context.Background()
	_, svc := newConfigEnv(t)

	if _, err := svc.SetLaunchSurface(ctx, "bogus"); err == nil {
		t.Fatal("invalid surface accepted")
	}
	if _, err := svc.SetLanguage(ctx, "xx"); err == nil {
		t.Fatal("unsupported language accepted")
	}
	if _, err := svc.SetTrayPreference(ctx, "bogus", true); err == nil {
		t.Fatal("invalid tray key accepted")
	}

	if _, err := svc.SetLaunchSurface(ctx, "tray"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetLanguage(ctx, "vi"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetQuotaGuardEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetTrayPreference(ctx, "startEnabledProxies", false); err != nil {
		t.Fatal(err)
	}
	cfg, err := svc.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UI == nil || cfg.UI.DefaultSurface != "tray" || cfg.UI.Language != "vi" || cfg.UI.Tray == nil ||
		cfg.UI.Tray.StartEnabledProxies == nil || *cfg.UI.Tray.StartEnabledProxies {
		t.Fatalf("mutations not persisted: %+v", cfg)
	}
	if LanguageOf(cfg) != "vi" {
		t.Fatalf("LanguageOf = %q, want vi", LanguageOf(cfg))
	}
	if _, err := svc.SetLanguage(ctx, "auto"); err != nil {
		t.Fatal(err)
	}
	cfg, err = svc.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if LanguageOf(cfg) != LanguageAuto {
		t.Fatalf("auto preference = %q, want %q", LanguageOf(cfg), LanguageAuto)
	}
	policy := QuotaGuardPolicyOf(cfg)
	if !policy.Enabled || policy.CooldownMinutes != DefaultQuotaGuardCooldownMinutes {
		t.Fatalf("policy = %+v", policy)
	}
	prefs := TrayPreferencesOf(cfg, false)
	if prefs.StartEnabledProxies || !prefs.ShowQuota || !prefs.QuotaGuardEnabled {
		t.Fatalf("preferences = %+v", prefs)
	}
}

func TestQuotaGuardCooldownValidationBounds(t *testing.T) {
	tooHigh := 25 * 60
	tooLow := 0
	cfg := Defaults()
	cfg.UI = &UI{QuotaGuard: &QuotaGuardCfg{Enabled: boolPtr(true), CooldownMinutes: &tooHigh}}
	if got := QuotaGuardPolicyOf(cfg); got.CooldownMinutes != DefaultQuotaGuardCooldownMinutes {
		t.Fatalf("out-of-range cooldown must fall back: %+v", got)
	}
	cfg.UI.QuotaGuard.CooldownMinutes = &tooLow
	if got := QuotaGuardPolicyOf(cfg); got.CooldownMinutes != DefaultQuotaGuardCooldownMinutes {
		t.Fatalf("zero cooldown must fall back: %+v", got)
	}
	valid := 15
	cfg.UI.QuotaGuard.CooldownMinutes = &valid
	if got := QuotaGuardPolicyOf(cfg); got.CooldownMinutes != 15 {
		t.Fatalf("valid cooldown lost: %+v", got)
	}
}

func TestLaunchAtLoginEffectRequestShape(t *testing.T) {
	// The engine never touches OS state (ADR 0020 §7); it only shapes the
	// typed request its native host executes.
	req := NewLaunchAtLoginEffect(true)
	if req.Kind != "launch-at-login" || !req.Enabled {
		t.Fatalf("request = %+v", req)
	}
	off := NewLaunchAtLoginEffect(false)
	if off.Enabled || off.Kind != "launch-at-login" {
		t.Fatalf("off request = %+v", off)
	}
}

func boolPtr(b bool) *bool { return &b }

// jsonUnmarshalCheck decodes via encoding/json through a tiny indirection so
// the import stays local to this test.
func jsonUnmarshalCheck(t *testing.T, data string, into *map[string]any) bool {
	t.Helper()
	m, err := decodeJSONMap(data)
	if err != nil {
		t.Fatalf("document unreadable: %v (%s)", err, data)
	}
	*into = m
	return true
}

func decodeJSONMap(data string) (map[string]any, error) {
	var m map[string]any
	if err := json.Unmarshal([]byte(data), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func TestSettingsTogglePreservesWholeDocument(t *testing.T) {
	ctx := context.Background()
	store, svc := newConfigEnv(t)

	// Seed a document with fields this process's toggles never touch.
	seed := Defaults()
	seed.Defaults = &struct {
		ProxyHost string `json:"proxyHost,omitempty"`
	}{ProxyHost: "http://127.0.0.1:8317"}
	seed.ActiveProfile = "work"
	if err := store.Write(ctx, seed); err != nil {
		t.Fatal(err)
	}

	// A tray toggle is a read-modify-write; it must not erase proxyHost.
	if _, err := svc.SetTrayPreference(ctx, "showQuota", false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetLanguage(ctx, "zh-CN"); err != nil {
		t.Fatal(err)
	}
	got, rerr := store.Read(ctx)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if got.Defaults == nil || got.Defaults.ProxyHost != "http://127.0.0.1:8317" {
		t.Fatalf("defaults.proxyHost erased by settings write: %+v", got)
	}
	if got.ActiveProfile != "work" {
		t.Fatalf("activeProfile erased: %+v", got)
	}
	if got.UI == nil || got.UI.Language != "zh-CN" {
		t.Fatalf("language preference not persisted: %+v", got.UI)
	}
	if got.SchemaVersion != CurrentSchemaVersion {
		t.Fatalf("schemaVersion lost: %d", got.SchemaVersion)
	}
	if got.UI == nil || got.UI.Tray == nil || got.UI.Tray.ShowQuota == nil || *got.UI.Tray.ShowQuota {
		t.Fatalf("toggle not applied: %+v", got.UI)
	}

	// The raw stored document keeps the TS field name for defaults.
	database, derr := db.Open(store.Root)
	if derr != nil {
		t.Fatal(derr)
	}
	defer database.Close()
	var value string
	if err := database.QueryRowContext(ctx,
		`SELECT value FROM config WHERE key = 'global'`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(value), &doc); err != nil {
		t.Fatal(err)
	}
	defaults, ok := doc["defaults"].(map[string]any)
	if !ok || defaults["proxyHost"] != "http://127.0.0.1:8317" {
		t.Fatalf("stored defaults shape drifted: %s", value)
	}
}

// ServeWhenAllCooling is a Go-side extension to the ported policy: it decides
// whether a fully cooled pool keeps serving. Absent means yes — a pool whose
// accounts are all quota-blocked should hand the caller the vendor's verdict
// rather than a local guess — and an explicit false restores the old refusal.
func TestQuotaGuardServeWhenAllCoolingDefaultsOn(t *testing.T) {
	plain := QuotaGuardPolicyOf(GlobalConfig{})
	if !plain.ServeWhenAllCooling {
		t.Fatal("the default must keep serving when every member is cooling")
	}

	off := false
	explicit := QuotaGuardPolicyOf(GlobalConfig{UI: &UI{QuotaGuard: &QuotaGuardCfg{
		Enabled:             boolPtr(true),
		ServeWhenAllCooling: &off,
	}}})
	if explicit.ServeWhenAllCooling {
		t.Fatal("an explicit false must be honoured")
	}
	if !explicit.Enabled {
		t.Fatal("enabling the guard must still be read")
	}

	on := true
	back := QuotaGuardPolicyOf(GlobalConfig{UI: &UI{QuotaGuard: &QuotaGuardCfg{
		ServeWhenAllCooling: &on,
	}}})
	if !back.ServeWhenAllCooling {
		t.Fatal("an explicit true must be honoured")
	}
}
