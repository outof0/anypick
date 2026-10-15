// Package config owns the SQLite-backed global config document plus the
// service-owned mutations that keep every persisted write under the
// coordinator (ADR 0009).
package config

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/i18n"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/paths"
)

// CurrentSchemaVersion is the global config document schema version.
const CurrentSchemaVersion = 2

const globalKey = "global"
const LanguageAuto = i18n.LanguageAuto

// UI is the global config's UI section. Pointers keep absent fields absent
// so the JSON round-trips without inventing values.
type UI struct {
	Color          *bool          `json:"color,omitempty"`
	DefaultSurface string         `json:"defaultSurface,omitempty"` // 'tui' | 'tray'
	Language       string         `json:"language,omitempty"`
	QuotaGuard     *QuotaGuardCfg `json:"quotaGuard,omitempty"`
	Tray           *TrayCfg       `json:"tray,omitempty"`
}

// QuotaGuardCfg is the raw stored form of the quota-guard policy.
type QuotaGuardCfg struct {
	// ServeWhenAllCooling keeps a pool serving when every member is cooling
	// (absent → true). It is an extension over the stored policy, which
	// otherwise holds only a cooldown.
	ServeWhenAllCooling *bool `json:"serveWhenAllCooling,omitempty"`
	Enabled             *bool `json:"enabled,omitempty"`
	CooldownMinutes     *int  `json:"cooldownMinutes,omitempty"`
}

// TrayCfg holds tray-local toggles from the global config document.
type TrayCfg struct {
	StartEnabledProxies *bool `json:"startEnabledProxies,omitempty"`
	ShowQuota           *bool `json:"showQuota,omitempty"`
	GuideSeen           *bool `json:"guideSeen,omitempty"` // legacy one-time marker
}

// GlobalConfig is the persisted global config document.
type GlobalConfig struct {
	SchemaVersion int    `json:"schemaVersion"`
	DefaultClient string `json:"defaultClient,omitempty"`
	ActiveProfile string `json:"activeProfile,omitempty"`
	Defaults      *struct {
		ProxyHost string `json:"proxyHost,omitempty"`
	} `json:"defaults,omitempty"`
	UI *UI `json:"ui,omitempty"`
}

// Defaults returns the default global config.
func Defaults() GlobalConfig {
	return GlobalConfig{
		SchemaVersion: CurrentSchemaVersion,
		DefaultClient: "claude",
	}
}

// Store is the SQLite-backed global config store (GlobalConfigStore).
type Store struct {
	Root string
	DB   *db.DB
}

func NewStore(root string, database *db.DB) *Store {
	return &Store{Root: paths.Root(root), DB: database}
}

// Read returns the config merged over defaults; corrupt rows fall back to
// the defaults.
func (s *Store) Read(ctx context.Context) (GlobalConfig, error) {
	out := Defaults()
	var raw string
	err := s.DB.QueryRowContext(ctx,
		`SELECT value FROM config WHERE key = ?`, globalKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	stored := GlobalConfig{}
	if json.Unmarshal([]byte(raw), &stored) != nil {
		// Corrupt rows fall back to the defaults.
		return out, nil
	}
	// The stored document is authoritative: a read-modify-write cycle must
	// preserve every field — including ones set by other runtimes, such as
	// defaults.proxyHost — not reconstruct a subset of it.
	out = stored
	if out.SchemaVersion == 0 {
		out.SchemaVersion = CurrentSchemaVersion
	}
	if out.DefaultClient == "" {
		out.DefaultClient = "claude"
	}
	return out, nil
}

// Write replaces the whole config document. The caller owns coordination —
// services go through ConfigService instead.
func (s *Store) Write(ctx context.Context, cfg GlobalConfig) error {
	if cfg.SchemaVersion == 0 {
		cfg.SchemaVersion = CurrentSchemaVersion
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	_, werr := s.DB.ExecContext(ctx,
		`INSERT INTO config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		globalKey, string(raw))
	return werr
}

// Ensure bootstraps the row; used under .migrate.lock where startup already
// serializes open/migrate.
func (s *Store) Ensure(ctx context.Context) (GlobalConfig, error) {
	var probe string
	err := s.DB.QueryRowContext(ctx,
		`SELECT value FROM config WHERE key = ?`, globalKey).Scan(&probe)
	if errors.Is(err, sql.ErrNoRows) {
		cfg := Defaults()
		if werr := s.Write(ctx, cfg); werr != nil {
			return GlobalConfig{}, werr
		}
		return cfg, nil
	}
	if err != nil {
		return GlobalConfig{}, err
	}
	return s.Read(ctx)
}

// ConfigService owns persisted global-config mutations (ADR 0009). Call sites
// must not take config/global locks themselves.
type ConfigService struct {
	store *Store
}

func NewService(store *Store) *ConfigService { return &ConfigService{store: store} }

const configScope = "config/global"

// Read proxies the store read (no mutation, no lock needed).
func (s *ConfigService) Read(ctx context.Context) (GlobalConfig, error) { return s.store.Read(ctx) }

func (s *ConfigService) Ensure(ctx context.Context) (GlobalConfig, error) {
	return s.store.Ensure(ctx)
}

// Write replaces the whole document under the coordinator.
func (s *ConfigService) Write(ctx context.Context, cfg GlobalConfig) error {
	return lock.WithMutationLock(ctx, s.store.Root, configScope, func(c context.Context) error {
		return s.store.Write(c, cfg)
	})
}

// Update performs one locked read-modify-write so concurrent updaters cannot
// clobber each other's toggles.
func (s *ConfigService) Update(ctx context.Context, mutate func(GlobalConfig) GlobalConfig) (GlobalConfig, error) {
	var out GlobalConfig
	err := lock.WithMutationLock(ctx, s.store.Root, configScope, func(c context.Context) error {
		cur, rerr := s.store.Read(c)
		if rerr != nil {
			return rerr
		}
		next := mutate(cur)
		if nerr := s.store.Write(c, next); nerr != nil {
			return nerr
		}
		out = next
		return nil
	})
	return out, err
}

// SetLaunchSurface persists ui.defaultSurface ('tui' | 'tray').
func (s *ConfigService) SetLaunchSurface(ctx context.Context, surface string) (GlobalConfig, error) {
	if surface != "tui" && surface != "tray" {
		return GlobalConfig{}, anyerr.Newf("Unknown launch surface "+surface+".", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return s.Update(ctx, func(cfg GlobalConfig) GlobalConfig {
		ui := ensureUI(cfg.UI)
		ui.DefaultSurface = surface
		cfg.UI = ui
		return cfg
	})
}

// SetLanguage persists ui.language. "auto" defers to the operating-system
// locale, while every other value must have an embedded message catalog.
func (s *ConfigService) SetLanguage(ctx context.Context, value string) (GlobalConfig, error) {
	language, ok := i18n.NormalizePreference(value)
	if !ok {
		return GlobalConfig{}, anyerr.Newf("Unknown language preference "+value+".", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return s.Update(ctx, func(cfg GlobalConfig) GlobalConfig {
		ui := ensureUI(cfg.UI)
		ui.Language = language
		cfg.UI = ui
		return cfg
	})
}

// SetQuotaGuardEnabled persists ui.quotaGuard.enabled.
func (s *ConfigService) SetQuotaGuardEnabled(ctx context.Context, enabled bool) (GlobalConfig, error) {
	return s.Update(ctx, func(cfg GlobalConfig) GlobalConfig {
		ui := ensureUI(cfg.UI)
		qg := ui.QuotaGuard
		if qg == nil {
			qg = &QuotaGuardCfg{}
		}
		t := enabled
		qg.Enabled = &t
		ui.QuotaGuard = qg
		cfg.UI = ui
		return cfg
	})
}

// SetTrayPreference persists ui.tray.startEnabledProxies / showQuota.
func (s *ConfigService) SetTrayPreference(ctx context.Context, key string, enabled bool) (GlobalConfig, error) {
	if key != "startEnabledProxies" && key != "showQuota" {
		return GlobalConfig{}, anyerr.Newf("Unknown tray preference "+key+".", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return s.Update(ctx, func(cfg GlobalConfig) GlobalConfig {
		ui := ensureUI(cfg.UI)
		tray := ui.Tray
		if tray == nil {
			tray = &TrayCfg{}
		}
		t := enabled
		if key == "startEnabledProxies" {
			tray.StartEnabledProxies = &t
		} else {
			tray.ShowQuota = &t
		}
		ui.Tray = tray
		cfg.UI = ui
		return cfg
	})
}

func ensureUI(ui *UI) *UI {
	if ui != nil {
		return ui
	}
	return &UI{}
}

// LaunchSurfaceOf returns the configured launch surface, or "" when unset.
func LaunchSurfaceOf(cfg GlobalConfig) string {
	if cfg.UI == nil {
		return ""
	}
	return cfg.UI.DefaultSurface
}

// LanguageOf returns the configured language or auto-detect for older or
// malformed config documents.
func LanguageOf(cfg GlobalConfig) string {
	if cfg.UI == nil {
		return i18n.LanguageAuto
	}
	value, ok := i18n.NormalizePreference(cfg.UI.Language)
	if !ok {
		return i18n.LanguageAuto
	}
	return value
}

// DefaultQuotaGuardCooldownMinutes is the fallback cooldown in minutes.
const DefaultQuotaGuardCooldownMinutes = 60

// QuotaGuardPolicy is the validated view of the stored quota-guard settings.
// Quota Guard only governs multi-account compatibility proxies — it never
// changes a native tool login or sends a saved credential anywhere.
type QuotaGuardPolicy struct {
	Enabled         bool
	CooldownMinutes int
	// ServeWhenAllCooling is true unless the operator turned it off: a pool
	// whose accounts are all quota-blocked should tell the caller what the
	// vendor said, not refuse with a local guess.
	ServeWhenAllCooling bool
}

// QuotaGuardPolicyOf validates the stored quota-guard settings, including
// the strict integer 1..24*60 cooldown validation with fallback to the default.
func QuotaGuardPolicyOf(cfg GlobalConfig) QuotaGuardPolicy {
	policy := QuotaGuardPolicy{
		Enabled:             false,
		CooldownMinutes:     DefaultQuotaGuardCooldownMinutes,
		ServeWhenAllCooling: true,
	}
	if cfg.UI == nil || cfg.UI.QuotaGuard == nil {
		return policy
	}
	raw := cfg.UI.QuotaGuard
	if raw.Enabled != nil && *raw.Enabled {
		policy.Enabled = true
	}
	if raw.ServeWhenAllCooling != nil {
		policy.ServeWhenAllCooling = *raw.ServeWhenAllCooling
	}
	if raw.CooldownMinutes != nil &&
		*raw.CooldownMinutes >= 1 && *raw.CooldownMinutes <= 24*60 {
		policy.CooldownMinutes = *raw.CooldownMinutes
	}
	return policy
}

// TrayPreferencesOf resolves the effective tray preferences.
type TrayPreferences struct {
	LaunchAtLogin       bool
	StartEnabledProxies bool
	ShowQuota           bool
	QuotaGuardEnabled   bool
}

func TrayPreferencesOf(cfg GlobalConfig, launchAtLogin bool) TrayPreferences {
	prefs := TrayPreferences{
		LaunchAtLogin:       launchAtLogin,
		StartEnabledProxies: true,
		ShowQuota:           true,
		QuotaGuardEnabled:   false,
	}
	if cfg.UI != nil && cfg.UI.Tray != nil {
		if cfg.UI.Tray.StartEnabledProxies != nil {
			prefs.StartEnabledProxies = *cfg.UI.Tray.StartEnabledProxies
		}
		if cfg.UI.Tray.ShowQuota != nil {
			prefs.ShowQuota = *cfg.UI.Tray.ShowQuota
		}
	}
	prefs.QuotaGuardEnabled = QuotaGuardPolicyOf(cfg).Enabled
	return prefs
}
