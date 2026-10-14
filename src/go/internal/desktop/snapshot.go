package desktop

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/journal"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/transport"
)

// Snapshot is the desktop snapshot. Sections not populated yet are emitted
// as empty arrays so UI typing keeps working.
type Snapshot struct {
	ProxyCount         int                `json:"proxyCount"`
	Revision           int                `json:"revision"`
	Routes             []map[string]any   `json:"routes"`
	Actions            []ActionRow        `json:"actions"`
	ClientModelConfigs []map[string]any   `json:"clientModelConfigs"`
	Usage              []UsageSnapshotRow `json:"usage"`
	Proxies            []ProxyRow         `json:"proxies"`
	Accounts           []AccountRow       `json:"accounts"`
	HubSources         []map[string]any   `json:"hubSources"`
	HubConflicts       []map[string]any   `json:"hubConflicts"`
	HubPublishedModels []map[string]any   `json:"hubPublishedModels"`
	// HubCatalogs carries per-account model catalogs: {accountID: hub source
	// id, catalog: catalog provider id, models: [...]}. Model ids only —
	// keys and endpoints never cross this boundary. Additive and optional:
	// older readers ignore it, newer readers treat absence as "no catalogs".
	HubCatalogs         []map[string]any        `json:"hubCatalogs"`
	CodexProfiles       []CodexProfileRow       `json:"codexProfiles"`
	CodexProfileSources []CodexProfileSourceRow `json:"codexProfileSources"`
	LogSources          []LogSourceRow          `json:"logSources"`
	Gateways            []GatewayRow            `json:"gateways"`
	AccountProviders    []AccountProviderRow    `json:"accountProviders"`
	GatewayProviders    []GatewayProviderRow    `json:"gatewayProviders"`
	Settings            Preferences             `json:"settings"`
	Activity            []map[string]any        `json:"activity"`
	DegradedConditions  []DegradedCondition     `json:"degradedConditions"`
}

// DegradedCondition is a redacted, user-actionable engine condition. It is
// separate from Activity because it represents current state, not history.
type DegradedCondition struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

// ActionRow is one action row (subset emitted today).
type ActionRow struct {
	ID             string `json:"id"`
	ClientID       string `json:"clientId"`
	SourceID       string `json:"sourceId"`
	Client         string `json:"client"`
	Label          string `json:"label"`
	Detail         string `json:"detail,omitempty"`
	Kind           string `json:"kind"` // 'native' | 'gateway' | 'hub'
	Presentation   string `json:"presentation"`
	Selected       bool   `json:"selected"`
	Enabled        bool   `json:"enabled"`
	DisabledReason string `json:"disabledReason,omitempty"`
	RouteKind      string `json:"routeKind,omitempty"` // 'direct-account' | 'managed-account' | 'gateway' | 'hub'
}

// ProxyRow is one proxy row.
type ProxyRow struct {
	ID              string `json:"id"`
	ProviderID      string `json:"providerId"`
	Label           string `json:"label"`
	Detail          string `json:"detail"`
	Address         string `json:"address,omitempty"`
	Running         bool   `json:"running"`
	Enabled         bool   `json:"enabled"`
	LogsAvailable   bool   `json:"logsAvailable,omitempty"`
	ToggleActionID  string `json:"toggleActionId"`
	RestartActionID string `json:"restartActionId"`
	RotateActionID  string `json:"rotateActionId,omitempty"`
	// HasToken says a copy can be fetched. The bearer itself stays out of the
	// snapshot (ADR 0006); the desktop asks for it with the proxy-token command.
	HasToken bool `json:"hasToken,omitempty"`
}

// AccountRow is one managed-account row.
type AccountRow struct {
	ID             string `json:"id"`
	ProviderID     string `json:"providerId"`
	SourceID       string `json:"sourceId,omitempty"`
	Name           string `json:"name"`
	Label          string `json:"label"`
	Detail         string `json:"detail"`
	Active         bool   `json:"active"`
	CanRefresh     bool   `json:"canRefresh"`
	SwitchActionID string `json:"switchActionId"`
}

// LogSourceRow is one log-source row.
type LogSourceRow struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerId"`
	Name       string `json:"name"`
	Label      string `json:"label"`
	Detail     string `json:"detail"`
}

// GatewayRow is the gateway display subset (gateways arrive with the
// profile store port).
type GatewayRow = map[string]any

// AccountProviderRow is one account-provider row.
type AccountProviderRow struct {
	ID           string           `json:"id"`
	ProviderID   string           `json:"providerId"`
	ClientID     string           `json:"clientId,omitempty"`
	SourceID     string           `json:"sourceId,omitempty"`
	Label        string           `json:"label"`
	Detail       string           `json:"detail"`
	Installed    bool             `json:"installed"`
	LivePresent  bool             `json:"livePresent"`
	LiveIdentity string           `json:"liveIdentity,omitempty"`
	LoginMethods []LoginMethodRow `json:"loginMethods"`
	CanClear     bool             `json:"canClear,omitempty"`
	// CredentialKinds lists the explicit credential products this provider
	// accepts through account-save-input (API keys / plan keys for compatible
	// vendors). Native-only providers leave it empty: their accounts come
	// from a live login or a browser sign-in, never from typed input.
	// Definitions only — no secrets cross this boundary.
	CredentialKinds []CredentialKindRow `json:"credentialKinds,omitempty"`
	// AcceptsAuthPaste is true when the provider can save an account from its
	// own auth document without a browser login. Sheets branch on this bit.
	AcceptsAuthPaste bool `json:"acceptsAuthPaste,omitempty"`
}

// CredentialKindRow is one BackupInput credential product: its kind id, the
// label the UI shows, and the endpoint profiles the user can attach it to.
type CredentialKindRow struct {
	Kind     string                 `json:"kind"`
	Label    string                 `json:"label"`
	Profiles []CredentialProfileRow `json:"profiles"`
}

// CredentialProfileRow is one endpoint profile within a credential kind.
type CredentialProfileRow struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// LoginMethodRow is the non-secret provider-owned browser-login capability
// exposed to the native host. Launcher availability is recomputed per
// snapshot, so installing an official client takes effect without restart.
type LoginMethodRow struct {
	ID                string `json:"id"`
	Label             string `json:"label"`
	Detail            string `json:"detail,omitempty"`
	Provenance        string `json:"provenance"`
	Preferred         bool   `json:"preferred"`
	SourceID          string `json:"sourceId,omitempty"`
	SourceLabel       string `json:"sourceLabel,omitempty"`
	Available         bool   `json:"available"`
	UnavailableReason string `json:"unavailableReason,omitempty"`
}

// GatewayProviderRow is one gateway-provider row.
type GatewayProviderRow struct {
	ID                  string   `json:"id"`
	Label               string   `json:"label"`
	Detail              string   `json:"detail"`
	ProvidesEndpoint    bool     `json:"providesEndpoint,omitempty"`
	RequiresApiKey      bool     `json:"requiresApiKey"`
	DefaultEndpoint     string   `json:"defaultEndpoint,omitempty"`
	FirstPartyClientIDs []string `json:"firstPartyClientIds,omitempty"`
	Kind                string   `json:"kind,omitempty"`
	RequiresGatewayID   bool     `json:"requiresGatewayId,omitempty"`
	RequiresAccountID   bool     `json:"requiresAccountId,omitempty"`
}

// Preferences is the desktop settings surface.
type Preferences struct {
	LaunchAtLogin       bool `json:"launchAtLogin"`
	StartEnabledProxies bool `json:"startEnabledProxies"`
	ShowQuota           bool `json:"showQuota"`
	QuotaGuardEnabled   bool `json:"quotaGuardEnabled"`
}

// currentSettings reads tray preferences from the config service when wired,
// falling back to defaults (showQuota/startEnabledProxies true).
func (s *Server) currentSettings(ctx context.Context) Preferences {
	prefs := Preferences{StartEnabledProxies: true, ShowQuota: true}
	// Login-item state is platform truth: only a wired host-state provider
	// may report it (ADR 0020 §7). Absence reports disabled.
	if enabled, reported := s.reportedLaunchAtLogin(); reported {
		prefs.LaunchAtLogin = enabled
	} else if s.Deps.HostState != nil {
		prefs.LaunchAtLogin = s.Deps.HostState.LaunchAtLoginEnabled()
	}
	if s.Deps.Config != nil {
		if cfg, err := s.Deps.Config.Read(ctx); err == nil {
			p := config.TrayPreferencesOf(cfg, prefs.LaunchAtLogin)
			prefs.LaunchAtLogin = p.LaunchAtLogin
			prefs.StartEnabledProxies = p.StartEnabledProxies
			prefs.ShowQuota = p.ShowQuota
			prefs.QuotaGuardEnabled = p.QuotaGuardEnabled
		}
	}
	return prefs
}

// snapshotBuilder carries the mutable state one snapshot pass needs. It exists
// so buildSnapshot reads as a list of domain sections instead of one 500-line
// body: every section appends to the same Snapshot and registers handlers into
// the same registry, and threading four locals through N helpers is exactly how
// the original grew past the point where anyone could read it.
type snapshotBuilder struct {
	srv      *Server
	snap     *Snapshot
	registry map[string]actionHandler
	// modelRoles is this revision's model-option registry: every published
	// option id resolves to the (client, source, model) it was published for.
	// Stored on the Server alongside `actions` so applyModelRoles can resolve
	// an id without trusting any value the host sends (see modelRoleTarget).
	modelRoles map[string]modelRoleTarget
	rev        int
	seq        int
}

func (b *snapshotBuilder) actionID() string {
	b.seq++
	return fmt.Sprintf("act-%d-%03d", b.rev, b.seq)
}

// proxyRowLabel names a proxy row by account: two saved logins behind one
// provider (WorkBuddy ×2) are otherwise identical rows. It carries no slash
// so the native app keeps it verbatim instead of collapsing it to the bare
// provider name.
func proxyRowLabel(ctx context.Context, b *snapshotBuilder, providerID, name string) string {
	short := providerID
	if pv, err := b.srv.Deps.Providers.Get(providerID); err == nil && pv != nil {
		short = provider.ShortNameOf(pv)
	}
	display := ""
	if acc, err := b.srv.Deps.Accounts.CachedAccount(ctx, providerID, name); err == nil && acc != nil {
		for _, candidate := range []string{acc.Meta.Label, acc.Meta.Identity, acc.Meta.Name} {
			if strings.TrimSpace(candidate) != "" {
				display = strings.TrimSpace(candidate)
				break
			}
		}
	}
	if display == "" {
		return fmt.Sprintf("%s/%s proxy", providerID, name)
	}
	return fmt.Sprintf("%s proxy · %s", short, display)
}

func (b *snapshotBuilder) addProxyRow(ctx context.Context, pv provider.Provider, providerID, name, rowID string) {
	cfg, _ := b.srv.Deps.Proxy.ProxyConfig(ctx, providerID, name)
	st, statusErr := b.srv.Deps.Proxy.StatusContext(ctx, providerID, name)
	toggleID := b.actionID()
	restartID := b.actionID()
	rotateID := b.actionID()
	running, address := proxySnapshotState(st, statusErr)
	hasToken := false
	if running {
		if rst, _ := b.srv.Deps.Proxy.RuntimeState(ctx, providerID, name); rst != nil && rst.Token != "" {
			hasToken = true
		}
	}
	b.snap.Proxies = append(b.snap.Proxies, ProxyRow{
		ID: rowID, ProviderID: providerID,
		Label:           proxyRowLabel(ctx, b, providerID, name),
		Detail:          detailFor(running, cfg.Port),
		Address:         address,
		Running:         running,
		Enabled:         cfg.Enabled,
		LogsAvailable:   true,
		ToggleActionID:  toggleID,
		RestartActionID: restartID,
		RotateActionID:  rotateID,
		HasToken:        hasToken,
	})
	b.registry[toggleID] = func(c context.Context, opts actionOptions) error {
		// Re-check liveness inside the handler: `running` was captured
		// at snapshot build and the child may have died (or started)
		// since, which used to run the wrong branch with a false
		// success (PX2).
		if st, serr := b.srv.Deps.Proxy.StatusContext(c, providerID, name); serr == nil && st != nil && st.Running {
			return b.srv.Deps.Proxy.Stop(c, providerID, name)
		}
		if _, serr := b.srv.Deps.Proxy.StartProxy(c, providerID, name); serr != nil {
			return serr
		}
		return b.srv.reapplyClientsBoundTo(c, refs.AccountRef(providerID, name),
			opts.AllowForeignConfig)
	}
	b.registry[restartID] = func(c context.Context, opts actionOptions) error {
		if err := b.srv.Deps.Proxy.Stop(c, providerID, name); err != nil {
			return err
		}
		if _, serr := b.srv.Deps.Proxy.StartProxy(c, providerID, name); serr != nil {
			return serr
		}
		return b.srv.reapplyClientsBoundTo(c, refs.AccountRef(providerID, name),
			opts.AllowForeignConfig)
	}
	b.registry[rotateID] = func(c context.Context, opts actionOptions) error {
		if _, err := b.srv.Deps.Proxy.RotateToken(c, providerID, name); err != nil {
			return err
		}
		return b.srv.reapplyClientsBoundTo(c, refs.AccountRef(providerID, name),
			opts.AllowForeignConfig)
	}
	if cfg.Enabled {
		b.snap.ProxyCount++
	}
}

func (b *snapshotBuilder) accountsAndProxies(ctx context.Context) {
	for _, providerID := range b.srv.Deps.Providers.IDs() {
		pv, err := b.srv.Deps.Providers.Get(providerID)
		if err != nil {
			continue
		}
		list, err := b.srv.Deps.Accounts.List(ctx, providerID)
		if err != nil {
			continue
		}
		active, _ := b.srv.Deps.Accounts.Active(ctx, providerID)

		sort.Slice(list, func(i, j int) bool { return list[i].Meta.Name < list[j].Meta.Name })
		for _, acc := range list {
			sourceID := refs.SerializeRef(refs.AccountRef(providerID, acc.Meta.Name))
			rowID := providerID + "/" + acc.Meta.Name
			clientID := nativeClientIDOf(pv, providerID)

			// Two distinct registrations per saved account: the accounts-panel
			// row switches the provider's active account (account-switch
			// operation), while the Switch-menu chip binds the client through
			// the persistent planner. One shared id cannot serve both.
			switchID := b.actionID()
			routeID := b.actionID()
			name := acc.Meta.Name
			_, canRefresh := pv.(interface{ RefreshAuth(string) error })
			b.snap.Accounts = append(b.snap.Accounts, AccountRow{
				ID: rowID, ProviderID: providerID, SourceID: sourceID,
				Name: name, Label: labelOr(acc.Meta.Label, name),
				Detail: displaySafeIdentity(acc.Meta.Identity),
				Active: active == name, CanRefresh: canRefresh,
				SwitchActionID: switchID,
			})
			b.registry[switchID] = b.srv.accountSwitchAction(providerID, name)
			// Route chips target a *client*. A provider whose native client is
			// not registered (WorkBuddy, temporarily) has no client to route
			// to, so the account stays manageable in the pane and in the
			// Proxies/Accounts rows without advertising a switch that client
			// cannot serve.
			if _, cerr := b.srv.Deps.Clients.Get(clientID); cerr == nil {
				b.registry[routeID] = b.srv.routeActivator(clientID, refs.AccountRef(providerID, acc.Meta.Name))
				selected := active == name
				short := shortNameOf(b.srv, pv)
				if clientID != providerID {
					short = designAppName(clientID)
				}
				b.snap.Actions = append(b.snap.Actions, ActionRow{
					ID:           routeID,
					ClientID:     clientID,
					SourceID:     sourceID,
					Client:       short,
					Label:        fmt.Sprintf("%s · %s", short, labelOr(acc.Meta.Label, acc.Meta.Name)),
					Detail:       displaySafeIdentity(acc.Meta.Identity),
					Kind:         "native",
					Presentation: "native-account",
					Selected:     selected,
					Enabled:      true,
					RouteKind:    routeKindForAccount(pv, clientID, name, acc.Proxy.Enabled),
				})
			}

			// Emit a row for every saved account behind a proxy-capable
			// provider, not just enabled ones: the Proxies pane is the only
			// place that offers the first Start, and without a row the
			// toggle action is never registered so enabling stays silent.
			if !pv.CanProxy() {
				continue
			}
			b.addProxyRow(ctx, pv, providerID, name, rowID)
		}

		b.accountProviders(ctx, pv, providerID)
	}
}

func (b *snapshotBuilder) accountProviders(ctx context.Context, pv provider.Provider, providerID string) {
	live, lerr := pv.DetectLive()
	live.Identity = displaySafeIdentity(live.Identity)
	methods, merr := b.srv.Deps.Accounts.LoginMethods(ctx, providerID, "")
	loginMethods := make([]LoginMethodRow, 0, len(methods))
	installed := lerr == nil && live.Present
	if merr == nil {
		for _, method := range methods {
			loginMethods = append(loginMethods, LoginMethodRow{
				ID: method.ID, Label: method.Label, Detail: method.Description,
				Provenance: method.Provenance, Preferred: method.Preferred,
				SourceID: method.Source, SourceLabel: method.SourceLabel,
				Available: method.Available, UnavailableReason: method.UnavailableReason,
			})
			installed = installed || method.Available
		}
	}
	clientID := nativeClientIDOf(pv, providerID)
	label := pv.Name()
	if clientID != providerID {
		label = designAppName(clientID)
	}
	row := AccountProviderRow{
		ID: providerID, ProviderID: providerID,
		// ClientID lets the native client resolve this provider to its
		// managed app row. Without it the Apps view can only see providers that already own actions, so
		// a provider with zero saved accounts (e.g. fresh WorkBuddy)
		// never appears.
		ClientID: clientID,
		Label:    label, Detail: pv.Description(),
		Installed: installed, LoginMethods: loginMethods,
	}
	if lerr == nil {
		row.LivePresent = live.Present
		row.LiveIdentity = live.Identity
		row.SourceID = live.Source
		if live.Identity != "" {
			row.Detail = live.Identity
		}
	}
	if clearer, ok := pv.(provider.LiveClearer); ok && clearer != nil {
		row.CanClear = true
		if policy, hasPolicy := pv.(provider.LiveClearPolicy); hasPolicy {
			row.CanClear = policy.CanClearLive(live.Source)
		}
	}
	// Providers may publish typed credential products even when they also have
	// a native login. Publishing the kinds/profiles is what lets the native Add
	// Account sheet offer a key path without teaching the host provider ids.
	if definer, ok := pv.(provider.CredentialDefinitionsProvider); ok {
		row.CredentialKinds = credentialKindRows(definer.CredentialDefinitions())
	}
	if _, ok := pv.(provider.AuthPaster); ok {
		row.AcceptsAuthPaste = true
	}
	b.snap.AccountProviders = append(b.snap.AccountProviders, row)
}

func (b *snapshotBuilder) settings(ctx context.Context) {
	b.snap.Settings = b.srv.currentSettings(ctx)
	// A client config AnyPick could not bring back to its saved route is the
	// most likely reason a user's CLI keeps failing while the app looks fine,
	// so it belongs in current state — not only in the engine log.
	b.snap.DegradedConditions = append(b.snap.DegradedConditions, b.srv.clientConfigConditions()...)
	if b.srv.Deps.PluginDiagnostics != nil {
		diagnostics := b.srv.Deps.PluginDiagnostics(ctx)
		if diagnostics.Host.State == "degraded" {
			b.snap.DegradedConditions = append(b.snap.DegradedConditions, DegradedCondition{
				ID: "plugin-host", Kind: "plugin-host", Title: "Plugin host unavailable",
				Detail: diagnostics.Host.Error,
			})
		}
		for _, failure := range diagnostics.Failures {
			title := "Plugin couldn’t load"
			if failure.Untrusted {
				title = "Plugin changed after trust"
			}
			b.snap.DegradedConditions = append(b.snap.DegradedConditions, DegradedCondition{
				ID: "plugin:" + failure.Name, Kind: "plugin", Title: title,
				Detail: failure.Name + ": " + failure.Reason,
			})
		}
	}
}

func (b *snapshotBuilder) gatewayProviders(ctx context.Context) {
	// Gateway providers are compatible vendors (fixed endpoint) plus providers
	// that explicitly describe a gateway capability. The latter own both the
	// credential semantics and the endpoint metadata; providers that cannot
	// describe credentials the picker can collect simply omit the capability.
	// Compatible providers win on ID so there is no duplicate row.
	addedGateway := make(map[string]bool)
	for _, providerID := range b.srv.Deps.Providers.IDs() {
		pv, err := b.srv.Deps.Providers.Get(providerID)
		if err != nil {
			continue
		}
		if cp, ok := pv.(interface {
			Definition() *provider.CompatibleDefinition
		}); ok {
			def := cp.Definition()
			// The default base travels with the row: without it the sheet
			// sends an empty endpoint and both test and save fail closed.
			defaultEndpoint := ""
			if len(def.Credentials) > 0 && len(def.Credentials[0].Profiles) > 0 {
				if base := def.Credentials[0].Profiles[0].OpenAIBase; strings.Contains(base, "http") {
					defaultEndpoint = base
				}
			}
			b.snap.GatewayProviders = append(b.snap.GatewayProviders, GatewayProviderRow{
				ID: def.ID, Label: def.Name, Detail: def.Description,
				ProvidesEndpoint: defaultEndpoint != "",
				DefaultEndpoint:  defaultEndpoint,
				// Compatible vendors are bring-your-own-key gateways.
				RequiresApiKey: true,
			})
			addedGateway[def.ID] = true
			continue
		}
		if _, ok := pv.(provider.GatewayInfoProvider); !ok || addedGateway[providerID] {
			continue
		}
		// Providers opt into the gateway picker only when they expose a
		// provider-owned GatewayInfo capability. This keeps providers such as
		// OpenCode and WorkBuddy out until they can describe the credential the
		// picker can actually collect, without a core id allowlist.
		info := pv.(provider.GatewayInfoProvider).GatewayInfo()
		row := GatewayProviderRow{
			ID:                  providerID,
			Label:               pv.Name(),
			Detail:              pv.Description(),
			ProvidesEndpoint:    info.ProvidesEndpoint,
			DefaultEndpoint:     info.DefaultEndpoint,
			FirstPartyClientIDs: append([]string(nil), info.FirstPartyClientIDs...),
			RequiresApiKey:      info.RequiresAPIKey,
			Kind:                info.Kind,
			RequiresGatewayID:   info.RequiresGatewayID,
			RequiresAccountID:   info.RequiresAccountID,
		}
		b.snap.GatewayProviders = append(b.snap.GatewayProviders, row)
	}
}

func clientShortLabel(clientID string, cad client.Adapter) string {
	if sn, ok := cad.(provider.ShortNamer); ok && sn.ShortName() != "" {
		return sn.ShortName()
	}
	if fields := strings.Fields(cad.Name()); len(fields) > 0 {
		return fields[0]
	}
	return clientID
}

func (b *snapshotBuilder) crossProviderActions(ctx context.Context) {

	for _, clientID := range b.srv.Deps.Clients.IDs() {
		cad, cerr := b.srv.Deps.Clients.Get(clientID)
		if cerr != nil {
			continue
		}
		short := clientShortLabel(clientID, cad)
		// The client's current source already has its selected app-route row;
		// re-listing it as a switching chip shows the same account twice in the
		// picker. The chip's "account" routeKind makes the friendly copy differ
		// ("Saved account" vs "AnyPick proxy"), so the UI cannot dedupe them.
		boundSource := ""
		if b.srv.Deps.Bindings != nil {
			if binding, berr := b.srv.Deps.Bindings.GetGlobalContext(ctx, clientID); berr == nil && binding != nil {
				boundSource = refs.SerializeRef(binding.Spec.Source)
			}
		}
		for _, otherProviderID := range b.srv.Deps.Providers.IDs() {
			pv2, perr := b.srv.Deps.Providers.Get(otherProviderID)
			if perr != nil {
				continue
			}
			// A provider may be owned by a different first-party client. Its
			// own account routes were emitted above under that native client id;
			// do not emit a second cross-provider route (or a second app row)
			// for the same source. Z.ai is owned by ZCode, for example.
			if otherProviderID == clientID || nativeClientIDOf(pv2, otherProviderID) == clientID {
				continue // own accounts already emitted above
			}
			if !pv2.CanProxy() {
				continue
			}
			list, lerr := b.srv.Deps.Accounts.List(ctx, otherProviderID)
			if lerr != nil || len(list) == 0 {
				continue
			}
			sample := list[0]
			adapter := pv2.AccountAdapter(sample.Meta.Name, sample.Proxy.Enabled)
			if cap := adapter.TransportFor(clientID); cap != transport.ManagedBuiltinProxy {
				continue
			}
			sn := provider.ShortNameOf(pv2)
			for _, acc := range list {
				sourceID := refs.SerializeRef(refs.AccountRef(otherProviderID, acc.Meta.Name))
				if sourceID == boundSource {
					continue // already the client's selected app-route row
				}
				id := fmt.Sprintf("xprov-%d-%s-%s-%s", b.rev, clientID, otherProviderID, acc.Meta.Name)
				row := ActionRow{
					ID:           id,
					ClientID:     clientID,
					SourceID:     sourceID,
					Client:       short,
					Label:        fmt.Sprintf("%s · %s", sn, labelOr(acc.Meta.Label, acc.Meta.Name)),
					Detail:       displaySafeIdentity(acc.Meta.Identity),
					Kind:         "native",
					Presentation: "app-route",
					Selected:     false,
					Enabled:      true,
					RouteKind:    "account",
				}
				b.snap.Actions = append(b.snap.Actions, row)
				// The chip binds THIS client to the other provider's account;
				// switching that provider's own active account would be a
				// wrong-scope mutation.
				b.registry[id] = b.srv.routeActivator(clientID,
					refs.AccountRef(otherProviderID, acc.Meta.Name))
			}
		}
	}
}

func (b *snapshotBuilder) gatewayActions(ctx context.Context) {
	if names, lerr := b.srv.Deps.Profiles.ListContext(ctx); lerr == nil {
		sort.Strings(names)
		for _, gwName := range names {
			pr, gerr := b.srv.Deps.Profiles.GetContext(ctx, gwName)
			if gerr != nil || pr == nil || pr.Meta.Endpoint == "" {
				continue
			}
			for _, clientID := range b.srv.Deps.Clients.IDs() {
				cad, cerr := b.srv.Deps.Clients.Get(clientID)
				if cerr != nil {
					continue
				}
				short := clientShortLabel(clientID, cad)
				id := fmt.Sprintf("gw-%d-%s-%s", b.rev, clientID, gwName)
				row := ActionRow{
					ID:           id,
					ClientID:     clientID,
					SourceID:     refs.SerializeRef(refs.GatewayRef(gwName)),
					Client:       short,
					Label:        gwName,
					Kind:         "gateway",
					Presentation: "app-route",
					Selected:     false,
					Enabled:      true,
					RouteKind:    "gateway",
				}
				b.snap.Actions = append(b.snap.Actions, row)
				// Gateway chips activate like any other source (through the
				// bindings service). A nil handler reported success without
				// mutating anything.
				b.registry[id] = b.srv.routeActivator(clientID, refs.GatewayRef(gwName))
			}
		}
	}
}

func (b *snapshotBuilder) hubActions(ctx context.Context) {
	// Offered while configured, even stopped: the macOS sheet and
	// tray disable the row while the hub is down, so an unstarted hub stays
	// visible in the switcher instead of vanishing from it.
	configs, err := b.srv.hubConfigs(ctx)
	if err != nil || len(configs) == 0 {
		return
	}
	multiple := len(configs) > 1
	for _, cfg := range configs {
		label := "Proxy Hub"
		if multiple {
			label = cfg.Name
		}
		for _, clientID := range b.srv.Deps.Clients.IDs() {
			cad, cerr := b.srv.Deps.Clients.Get(clientID)
			if cerr != nil {
				continue
			}
			short := clientShortLabel(clientID, cad)
			id := fmt.Sprintf("hub-%d-%s-%s", b.rev, clientID, cfg.Name)
			row := ActionRow{
				ID:           id,
				ClientID:     clientID,
				SourceID:     refs.SerializeRef(refs.ProxyHubRef(cfg.Name)),
				Client:       short,
				Label:        label,
				Detail:       "Shared models and accounts",
				Kind:         "hub",
				Presentation: "app-route",
				Selected:     false,
				Enabled:      true,
				RouteKind:    "hub",
			}
			b.snap.Actions = append(b.snap.Actions, row)
			// Hub chips activate like any other source (through the bindings
			// service).
			b.registry[id] = b.srv.routeActivator(clientID, refs.ProxyHubRef(cfg.Name))
		}
	}
}

func (b *snapshotBuilder) currentRouteActions(ctx context.Context, appIDs []string) error {
	// Current-route action per client — the Apps view subtitle reads the
	// selected action's label ("Uses …"), so it must exist even when there is
	// no binding (native login case).
	for _, clientID := range appIDs {
		short := designAppName(clientID)
		binding, berr := b.srv.Deps.Bindings.GetGlobalContext(ctx, clientID)
		if berr != nil {
			return berr
		}
		cur, _ := b.srv.Deps.Accounts.Current(ctx, clientID)

		var row *ActionRow
		switch {
		case binding != nil:
			srcRef := binding.Spec.Source
			label := refs.DisplayRef(srcRef)
			detail := ""
			kind := "gateway"
			routeKind := "gateway"
			if srcRef.Kind == refs.KindProxyHub {
				kind = "hub"
				routeKind = "hub"
				label = "Proxy Hub"
			}
			if srcRef.Kind == refs.KindAccount {
				kind = "native"
				routeKind = b.routeKindForSource(ctx, clientID, srcRef)
				if accRow, aerr := b.srv.Deps.Accounts.CachedAccount(ctx, srcRef.Provider, srcRef.Name); aerr == nil && accRow != nil {
					pv2, _ := b.srv.Deps.Providers.Get(srcRef.Provider)
					sn := srcRef.Provider
					if pv2 != nil {
						sn = provider.ShortNameOf(pv2)
					}
					label = fmt.Sprintf("%s · %s", sn, labelOr(accRow.Meta.Label, accRow.Meta.Name))
					detail = displaySafeIdentity(accRow.Meta.Identity)
				}
			}
			id := b.actionID()
			row = &ActionRow{
				ID: id, ClientID: clientID,
				SourceID:     refs.SerializeRef(srcRef),
				Client:       short,
				Label:        label,
				Detail:       detail,
				Kind:         kind,
				Presentation: "app-route",
				Selected:     true,
				Enabled:      true,
				RouteKind:    routeKind,
			}
			// Re-invoking the selected route re-applies its source through the
			// planner regardless of kind; never a silent no-op.
			b.registry[id] = b.srv.routeActivator(clientID, srcRef)
		case cur != nil && cur.Live.Present && cur.Active != "":
			pv2, perr := b.srv.Deps.Providers.Get(clientID)
			sn := clientID
			if perr == nil && pv2 != nil {
				sn = provider.ShortNameOf(pv2)
			}
			id := b.actionID()
			active := cur.Active
			row = &ActionRow{
				ID: id, ClientID: clientID,
				SourceID:     clientID,
				Client:       short,
				Label:        fmt.Sprintf("%s · %s", sn, active),
				Detail:       displaySafeIdentity(cur.Live.Identity),
				Kind:         "native",
				Presentation: "app-route",
				Selected:     true,
				Enabled:      true,
				RouteKind:    "direct-account",
			}
			b.registry[id] = b.srv.routeActivator(clientID, refs.AccountRef(clientID, active))
		}
		if row != nil {
			b.snap.Actions = append(b.snap.Actions, *row)
		}
	}
	return nil
}

func (b *snapshotBuilder) routes(ctx context.Context, appIDs []string) {
	for _, clientID := range appIDs {
		var binding *bindings.Global
		if b.srv.Deps.Bindings != nil {
			var berr error
			binding, berr = b.srv.Deps.Bindings.GetGlobalContext(ctx, clientID)
			if berr != nil {
				// A single client binding must not blank the whole snapshot
				// (Proxies pane included). Treat it as unbound.
				binding = nil
			}
		}
		nativePresent := false
		if _, perr := b.srv.Deps.Providers.Get(clientID); perr == nil {
			if cur, cerr2 := b.srv.Deps.Accounts.Current(ctx, clientID); cerr2 == nil && cur != nil {
				nativePresent = cur.Live.Present
			}
		}
		route := map[string]any{
			"clientId": clientID,
			"client":   designAppName(clientID),
			"status":   "unbound",
		}
		switch {
		case binding != nil:
			route["source"] = refs.DisplayRef(binding.Spec.Source)
			if model := primaryModelOf(binding.Spec); model != "" {
				route["model"] = model
			}
			route["status"] = "ready"
		case nativePresent:
			route["source"] = "native login"
			route["status"] = "native"
		}
		b.snap.Routes = append(b.snap.Routes, route)
	}
}

func (b *snapshotBuilder) gateways(ctx context.Context) {
	if names, lerr := b.srv.Deps.Profiles.ListContext(ctx); lerr == nil {
		for _, name := range names {
			pr, gerr := b.srv.Deps.Profiles.GetContext(ctx, name)
			if gerr != nil || pr == nil {
				continue
			}
			defaultModel := pr.Meta.DefaultModel
			b.snap.Gateways = append(b.snap.Gateways, GatewayRow{
				"id":           name,
				"providerId":   pr.Meta.Provider,
				"name":         name,
				"detail":       orString(pr.Meta.Label, pr.Meta.Provider),
				"ready":        pr.Meta.Endpoint != "",
				"defaultModel": defaultModel,
			})
		}
	}
}

// buildSnapshot assembles the current state and registers opaque action
// handlers for this revision. Field names match the native app's snapshot
// contract exactly so it can consume it unchanged.
func (s *Server) buildSnapshot(ctx context.Context) (*Snapshot, error) {
	s.actionsMu.Lock() // see the revision field
	s.revision++
	rev := s.revision
	s.actionsMu.Unlock()
	snap := &Snapshot{
		Revision:            rev,
		Routes:              []map[string]any{},
		Actions:             []ActionRow{},
		ClientModelConfigs:  []map[string]any{},
		Usage:               []UsageSnapshotRow{},
		Proxies:             []ProxyRow{},
		Accounts:            []AccountRow{},
		HubSources:          []map[string]any{},
		HubConflicts:        []map[string]any{},
		HubPublishedModels:  []map[string]any{},
		HubCatalogs:         []map[string]any{},
		CodexProfiles:       []CodexProfileRow{},
		CodexProfileSources: []CodexProfileSourceRow{},
		LogSources:          []LogSourceRow{},
		Gateways:            []GatewayRow{},
		AccountProviders:    []AccountProviderRow{},
		GatewayProviders:    []GatewayProviderRow{},
		Settings:            Preferences{ShowQuota: true},
		Activity:            []map[string]any{},
		DegradedConditions:  []DegradedCondition{},
	}
	b := &snapshotBuilder{
		srv:        s,
		snap:       snap,
		registry:   map[string]actionHandler{},
		modelRoles: map[string]modelRoleTarget{},
		rev:        rev,
	}

	b.settings(ctx)
	b.accountsAndProxies(ctx)
	b.gatewayProviders(ctx)

	appIDs := s.managedAppClientIDs()
	b.crossProviderActions(ctx)
	b.gatewayActions(ctx)
	b.hubActions(ctx)
	if err := b.currentRouteActions(ctx, appIDs); err != nil {
		return nil, err
	}
	b.routes(ctx, appIDs)
	b.gateways(ctx)

	// Usage: quota/rate-limit for providers with a live login. Kept in a
	// separate builder so app-service mode can refresh this bounded section
	// without rebuilding and polling the full snapshot.
	snap.Usage = s.buildUsage(ctx)

	// Activity: mutation history from the operation journal (the single source
	// of truth — never re-derived). A nil journal or a read failure yields an
	// honest empty list, never a fabricated event.
	snap.Activity = s.buildActivity(ctx)

	snap.LogSources = logSourcesForProxies(snap.Proxies)

	if err := s.buildHubSections(ctx, snap, b.registry, b.actionID); err != nil {
		// Account proxy rows are already filled. A hub-store read must not
		// drop the snapshot and leave Proxies empty.
		s.logErr(err)
	}
	b.codexProfiles(ctx)

	// Model configuration runs last: a hub-bound app's options are the
	// hub's resolved catalog plus pinned route models, which buildHubSections
	// and compileHubRouting make available without live vendor calls.
	b.clientModelConfigs(ctx, appIDs)
	s.publishActions(snap, b)
	return snap, nil
}

// publishActions installs one revision's indexes — action handlers, rows and
// model-option targets — under a single lock, so a command can never resolve
// an id against a half-installed revision.
func (s *Server) publishActions(snap *Snapshot, b *snapshotBuilder) {
	s.actionsMu.Lock()
	defer s.actionsMu.Unlock()
	s.prevActions = s.actions
	s.actions = b.registry
	s.actionRows = snapActionsIndex(snap)
	s.actionOrder = snapActionsOrder(snap)
	s.modelRoleTargets = b.modelRoles
}

// buildActivity maps the operation journal to the Activity snapshot section.
// The journal is the single source of truth for mutation history (invariant:
// ActivationPlan.steps drives execution; the snapshot never re-derives it).
// Only display-safe fields cross the boundary: ids, timestamps, affected
// resource identities and the terminal state. Entry params may carry
// credential-adjacent metadata and are never read here.
func (s *Server) buildActivity(ctx context.Context) []map[string]any {
	out := []map[string]any{}
	if s.Deps.Journal == nil {
		return out
	}
	entries, err := s.Deps.Journal.ListRecentContext(ctx, 50)
	if err != nil {
		return out
	}
	for _, e := range entries {
		createdAt := e.StartedAt
		if createdAt == "" {
			createdAt = e.UpdatedAt
		}
		row := map[string]any{
			"id":        e.ID,
			"createdAt": createdAt,
			"message":   activityMessage(e),
			"isError":   activityIsError(e),
			"kind":      activityKind(e),
		}
		// Absent means unbranded: the client renders no provider mark rather
		// than a fallback glyph for an empty identity.
		if provider := activityProvider(e); provider != "" {
			row["provider"] = provider
		}
		out = append(out, row)
	}
	return out
}

// activityKind classifies a journal entry for the native client's subtitle and
// symbol mapping. Activation entries fall through to the client's default
// ("App routing updated.") — they bind a client to a source rather than
// changing a saved login, so the account/gateway/proxy/quota/settings kinds
// would all mistitle them.
func activityKind(e journal.Entry) string {
	t := e.Type
	switch {
	case strings.HasPrefix(t, "activate:"):
		return "activation"
	case strings.Contains(t, "gateway"):
		return "gateway"
	case strings.Contains(t, "proxy") || strings.Contains(t, "pool"):
		return "proxy"
	case strings.Contains(t, "quota"):
		return "quota"
	case strings.Contains(t, "setting") || strings.Contains(t, "config"):
		return "settings"
	default:
		return "activation"
	}
}

// activityProvider derives the brand identity for an event row from affected
// resources (L9): account refs carry "account/<provider>/<name>". Gateway,
// hub, and pool refs carry no provider, so those rows stay unbranded rather
// than guessing.
func activityProvider(e journal.Entry) string {
	for _, r := range e.AffectedResources {
		if rest, ok := strings.CutPrefix(r, "account/"); ok {
			if provider, _, found := strings.Cut(rest, "/"); found && provider != "" {
				return provider
			}
		}
	}
	for _, r := range e.AffectedResources {
		if provider, ok := strings.CutPrefix(r, "provider/"); ok && provider != "" {
			return provider
		}
	}
	return ""
}

func activityIsError(e journal.Entry) bool {
	return e.State == journal.StateFailed || e.State == journal.StateRolledBack
}

// activityMessage renders a human title from affected resources and terminal
// state. Affected entries use SerializeRef identities ("account/grok/a",
// "gateway/gw1") plus the "client/<id>" scope the executor records — plain
// display names, never secrets.
func activityMessage(e journal.Entry) string {
	client, source := splitAffected(e.AffectedResources)
	clientLabel := ""
	if client != "" {
		clientLabel = designAppName(client)
	}
	switch e.State {
	case journal.StateCommitted:
		if clientLabel != "" && source != "" {
			return clientLabel + " now uses " + source + "."
		}
		if clientLabel != "" {
			return clientLabel + " updated."
		}
		return "Operation completed."
	case journal.StateFailed:
		if clientLabel != "" {
			return clientLabel + " change failed."
		}
		return "Operation failed."
	case journal.StateRolledBack:
		if clientLabel != "" {
			return clientLabel + " change was rolled back."
		}
		return "Operation was rolled back."
	case journal.StateRollingBack:
		if clientLabel != "" {
			return clientLabel + " change is rolling back."
		}
		return "Operation is rolling back."
	default:
		if clientLabel != "" {
			return clientLabel + " change in progress."
		}
		return "Operation in progress."
	}
}

func splitAffected(affected []string) (client, source string) {
	for _, r := range affected {
		if c, ok := strings.CutPrefix(r, "client/"); ok {
			if client == "" {
				client = c
			}
			continue
		}
		if source == "" {
			source = displayAffected(r)
		}
	}
	return client, source
}

func displayAffected(r string) string {
	if name, ok := strings.CutPrefix(r, "account/"); ok {
		return name
	}
	if name, ok := strings.CutPrefix(r, "gateway/"); ok {
		return name
	}
	if name, ok := strings.CutPrefix(r, "hub/"); ok {
		return "hub:" + name
	}
	if name, ok := strings.CutPrefix(r, "pool/"); ok {
		return "pool:" + name
	}
	if name, ok := strings.CutPrefix(r, "preset/"); ok {
		return "@" + name
	}
	return r
}

// credentialKindRows maps provider-declared credential products to
// snapshot rows. Profiles with an empty label fall back to their id so the
// picker never shows a blank option.
func credentialKindRows(defs []provider.CredentialDefinition) []CredentialKindRow {
	out := make([]CredentialKindRow, 0, len(defs))
	for _, c := range defs {
		profiles := make([]CredentialProfileRow, 0, len(c.Profiles))
		for _, ep := range c.Profiles {
			label := ep.Label
			if label == "" {
				label = ep.ID
			}
			profiles = append(profiles, CredentialProfileRow{ID: ep.ID, Label: label})
		}
		label := c.Label
		if label == "" {
			label = c.Kind
		}
		out = append(out, CredentialKindRow{Kind: c.Kind, Label: label, Profiles: profiles})
	}
	return out
}

// logSourcesForProxies mirrors the proxies that can actually serve ProxyLogs.
// Each source id is the proxy id (providerID/accountName) so the logs command
// resolves to the same proxy.log file the engine tails.
func logSourcesForProxies(proxies []ProxyRow) []LogSourceRow {
	out := []LogSourceRow{}
	for _, p := range proxies {
		name := p.ID
		if i := strings.Index(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		if name == "" {
			continue
		}
		out = append(out, LogSourceRow{
			ID:         p.ID,
			ProviderID: p.ProviderID,
			Name:       name,
			Label:      p.Label,
			Detail:     p.Detail,
		})
	}
	return out
}

// suppressUsageRow reports whether a live-usage readout must be withheld:
// the quota is read from the live credential, so when the active account is
// known not to be that login (the Codex desktop app keeps its own account),
// showing it on the active row misattributes someone else's quota. Unknown
// comparisons fail open and keep today's behavior.
func suppressUsageRow(ctx context.Context, s *Server, providerID, active string) bool {
	if active == "" {
		return false
	}
	cur, err := s.Deps.Accounts.Current(ctx, providerID)
	if err != nil || cur == nil {
		return false
	}
	return cur.LiveMatchKnown && !cur.IsLiveMatch
}

func (s *Server) buildUsage(ctx context.Context) []UsageSnapshotRow {
	rows := make([]UsageSnapshotRow, 0)
	for _, providerID := range s.Deps.Providers.IDs() {
		pv, err := s.Deps.Providers.Get(providerID)
		if err != nil {
			continue
		}
		lup, ok := pv.(provider.LiveUsageProvider)
		if !ok {
			continue
		}
		account := ""
		if active, _ := s.Deps.Accounts.Active(ctx, providerID); active != "" {
			account = active
		}
		if suppressUsageRow(ctx, s, providerID, account) {
			continue
		}
		usage, uerr := lup.LiveUsage(ctx)
		if uerr != nil || usage == nil || len(usage.Windows) == 0 {
			continue
		}
		short := provider.ShortNameOf(pv)
		var windows []map[string]interface{}
		for _, w := range usage.Windows {
			label := strings.TrimSpace(w.Label)
			entry := map[string]interface{}{
				"label":            label,
				"remainingPercent": w.RemainingPercent,
			}
			if w.ResetsAtMs != nil {
				entry["resetsAtMs"] = *w.ResetsAtMs
			}
			if w.LimitWindowSeconds != nil {
				entry["limitWindowSeconds"] = *w.LimitWindowSeconds
			}
			if g := strings.TrimSpace(w.Group); g != "" {
				entry["group"] = g
			}
			windows = append(windows, entry)
		}
		rows = append(rows, UsageSnapshotRow{
			Client:  short,
			Account: orString(account, providerID),
			Windows: windows,
		})
	}
	return rows
}

// primaryModelOf resolves the effective model: explicit selection wins,
// then the default model role from client options.
func primaryModelOf(spec bindings.Spec) string {
	if spec.Model.Mode == "explicit" {
		return spec.Model.ID
	}
	return modelRolesFromSpec(spec)["default"]
}

func providerNameOf(s *Server, providerID string) string {
	if pv, err := s.Deps.Providers.Get(providerID); err == nil {
		return pv.Name()
	}
	return providerID
}

func labelOr(label, fallback string) string {
	if label != "" {
		return label
	}
	return fallback
}

func detailFor(running bool, port int) string {
	if running {
		return fmt.Sprintf("running on port %d", port)
	}
	return "stopped"
}

// routeKindForAccount keeps managed account routes out of the native-login
// presentation. A provider may own the same client id while still requiring
// its account-specific proxy (WorkBuddy and Z.ai are examples); the adapter is
// the authority for that distinction.
func routeKindForAccount(
	pv provider.Provider, clientID, accountName string, proxyEnabled bool,
) string {
	if pv == nil {
		return "direct-account"
	}
	capability := pv.AccountAdapter(accountName, proxyEnabled).TransportFor(clientID)
	if capability == transport.ManagedBuiltinProxy || capability == transport.ManagedExternalProxy {
		return "managed-account"
	}
	return "direct-account"
}

func (b *snapshotBuilder) routeKindForSource(
	ctx context.Context, clientID string, source refs.Ref,
) string {
	if source.Kind != refs.KindAccount {
		return "direct-account"
	}
	pv, err := b.srv.Deps.Providers.Get(source.Provider)
	if err != nil || pv == nil {
		return "direct-account"
	}
	account, err := b.srv.Deps.Accounts.CachedAccount(ctx, source.Provider, source.Name)
	if err != nil || account == nil {
		return routeKindForAccount(pv, clientID, source.Name, false)
	}
	return routeKindForAccount(pv, clientID, source.Name, account.Proxy.Enabled)
}

// nativeClientIDOf returns the first-party client that owns a provider's
// native account surface. Most providers use the provider id itself; a
// borrowing provider such as Z.ai publishes its account routes under ZCode
// so the Apps pane has one stable app row and one route identity.
func nativeClientIDOf(pv provider.Provider, providerID string) string {
	if native, ok := pv.(provider.NativeClientProvider); ok {
		if clientID := strings.TrimSpace(native.NativeClientID()); clientID != "" {
			return clientID
		}
	}
	return providerID
}

// proxySnapshotState keeps Status failures and absent status records on the
// stopped path. Go evaluates function arguments eagerly, so selecting
// st.Endpoint through a generic ternary helper would still dereference nil.
func proxySnapshotState(st *proxy.Status, err error) (bool, string) {
	if err != nil || st == nil || !st.Running {
		return false, ""
	}
	return true, st.Endpoint
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// shortNameOf returns the compact display name for a provider row.
func shortNameOf(s *Server, pv interface{ Name() string }) string {
	if p, ok := pv.(provider.Provider); ok {
		return provider.ShortNameOf(p)
	}
	return pv.Name()
}

// designAppName returns the display name for a client row, and mirrors
// designAppName in ProductionModel.swift.
//
// This is NOT client.Adapter.ShortName(): that is the compact form ("Claude"),
// while a row title is the product name ("Claude Code"). The two are different
// values, which is why this table cannot simply defer to the adapter.
//
// The default branch used to capitalise the id, which is how workbuddy shipped
// as "Workbuddy" while macOS and the Tauri map both said "WorkBuddy": a client
// added without a case here got a plausible-looking wrong name instead of no
// name, and nothing failed. TestEveryRegisteredClientHasADisplayName now fails
// when a registered client has no explicit case, so the next one cannot ship
// silently. An empty id returns "" rather than panicking on client[:1].
func designAppName(client string) string {
	if name, ok := designAppNameExplicit(client); ok {
		return name
	}
	if strings.TrimSpace(client) == "" {
		return ""
	}
	return strings.ToUpper(client[:1]) + client[1:]
}

// designAppNameExplicit reports the name from the explicit table, and whether
// the id had a case at all. The default branch of designAppName fabricates a
// plausible name from any id, which is how workbuddy shipped as "Workbuddy"
// while macOS and the Tauri map both said "WorkBuddy": nothing failed, and the
// wrong name looked intentional. Splitting the lookup out lets a test assert
// that every registered client has a real case instead of a fabricated one.
func designAppNameExplicit(client string) (string, bool) {
	switch strings.ToLower(client) {
	case "claude":
		return "Claude Code", true
	case "codex":
		return "Codex", true
	case "gemini":
		return "Gemini", true
	case "kiro":
		return "Kiro", true
	case "grok":
		return "Grok", true
	case "opencode":
		return "OpenCode", true
	case "zcode":
		return "ZCode", true
	case "dsh":
		return "DeepSeek Harness", true
	case "commandcode":
		return "Command Code", true
	case "workbuddy", "codebuddy":
		// The same product ships as WorkBuddy outside mainland China and
		// CodeBuddy inside it; AnyPick keys everything on "workbuddy" and
		// treats the other as an alias, as macOS anypickDisplayName does.
		return "WorkBuddy", true
	case "pi":
		return "Pi", true
	case "omp":
		return "Omp", true
	default:
		return "", false
	}
}

// managedAppClientIDs lists every clientId that appears on any action,
// appears on any action, first-occurrence order, plus every registered client
// so unbound/absent apps still render a row.
//
// The registered clients are the source of truth for "which apps exist". A
// hand-kept list here silently dropped dsh: its persisted binding produced no
// selected current-route action and no route row on the first snapshot after
// a launch, so the app rendered "Not Configured" until a later mutation
// rebuilt the snapshot.
func (s *Server) managedAppClientIDs() []string {
	var out []string
	seen := map[string]bool{}
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	for _, id := range s.actionOrder {
		if a, ok := s.actionRows[id]; ok {
			add(a.ClientID)
		}
	}
	if s.Deps.Clients != nil {
		for _, id := range s.Deps.Clients.IDs() {
			add(id)
		}
	}
	return out
}

func snapActionsIndex(snap *Snapshot) map[string]ActionRow {
	out := make(map[string]ActionRow, len(snap.Actions))
	for _, a := range snap.Actions {
		out[a.ID] = a
	}
	return out
}

func snapActionsOrder(snap *Snapshot) []string {
	out := make([]string, len(snap.Actions))
	for i, a := range snap.Actions {
		out[i] = a.ID
	}
	return out
}

// UsageSnapshotRow is one live-usage readout row.
type UsageSnapshotRow struct {
	Client  string                   `json:"client"`
	Account string                   `json:"account"`
	Windows []map[string]interface{} `json:"windows"`
}
