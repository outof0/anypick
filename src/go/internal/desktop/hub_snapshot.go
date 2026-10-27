package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/ownership"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
)

// This file builds the Hub section of the snapshot: hub sources,
// conflicts, published models, the hub proxy row and its lifecycle actions.
// Previously the snapshot left all of these empty, so Proxy Hub was dead in
// production (empty state, disabled Start, zero models) — H1/H2/H3.
//
// Wire contract (both sides owned here):
//   HubSource row: id "hub/<hub>/<provider>/<account>", name = account,
//     hub = hub name. setHubSource sends Name=hub, ProviderID, SourceID=
//     account, Enabled. The toggle honors Enabled explicitly (no presence
//     guessing) and creates the hub config on first enable.
//   Hub proxy row: id "proxy-hub/<hub>", providerId "proxy-hub". Toggle =
//     start/stop, restart = stop-then-start with real errors (no swallowing).
//   HubConflicts and model-owner actions are compiled from the cache/static
//     per-account catalogs. Published models still come from pinned routes;
//     unambiguous catalog entries are derived by the native host.

func hubDir(root, name string) string { return filepath.Join(root, "runtime", "hub", name) }

func hubPIDPath(root, name string) string { return filepath.Join(hubDir(root, name), "service.pid") }

func hubLogPath(root, name string) string { return filepath.Join(hubDir(root, name), "service.log") }

// hubLive reports whether the hub child is ours and answering.
func (s *Server) hubLive(hubName string, port int, host string) (running bool, address string) {
	if host == "" {
		host = "127.0.0.1"
	}
	if port > 0 {
		address = fmt.Sprintf("http://%s:%d", host, port)
	}
	rec := ownership.Load(hubPIDPath(s.Deps.Root, hubName))
	if rec == nil || !rec.VerifyLive() {
		return false, address
	}
	if port > 0 && !hubHealthEcho(address+"/health", rec.InstanceID) {
		return false, address
	}
	return true, address
}

func hubHealthEcho(healthURL, wantInstanceID string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(healthURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false
	}
	var payload struct {
		OK         bool   `json:"ok"`
		InstanceID string `json:"instanceId"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&payload) != nil {
		return false
	}
	return payload.OK && (wantInstanceID == "" || payload.InstanceID == wantInstanceID)
}

// hubConfigs returns all hub configs, or nil when the hub store is unwired
// (legacy tests). A corrupt row fails closed with an error: serving half a
// hub set is worse than showing none.
func (s *Server) hubConfigs(ctx context.Context) ([]hub.Config, error) {
	if s.Deps.Hub == nil {
		return nil, nil
	}
	return s.Deps.Hub.ListConfigsContext(ctx)
}

// buildHubSections fills HubSources, HubConflicts, HubPublishedModels,
// LogSources (hub entries) and appends one proxy row per hub with lifecycle
// actions registered in the caller's registry.
func (s *Server) buildHubSections(ctx context.Context, snap *Snapshot,
	registry map[string]actionHandler, actionID func() string) error {
	configs, err := s.hubConfigs(ctx)
	if err != nil {
		return err
	}
	byHub := map[string]*hub.Config{}
	for i := range configs {
		byHub[configs[i].Name] = &configs[i]
	}
	// The UI always offers the "default" hub, creating it on first use, so
	// an empty install still shows sources to enable and a Start button.
	names := []string{}
	seen := map[string]bool{}
	for _, c := range configs {
		if !seen[c.Name] {
			seen[c.Name] = true
			names = append(names, c.Name)
		}
	}
	if !seen["default"] {
		names = append(names, "default")
	}
	sort.Strings(names)

	pinned := s.hubPinnedCatalogs(ctx, names)

	// present tracks every live account so config sources that name a
	// deleted account surface as ghost rows below instead of vanishing:
	// the loop above only visits live accounts, which is exactly how a
	// stale source stays invisible until a request trips over it.
	present := map[string]bool{}
	for _, providerID := range s.Deps.Providers.IDs() {
		_, err := s.Deps.Providers.Get(providerID)
		if err != nil || s.Deps.Accounts == nil {
			continue
		}
		list, err := s.Deps.Accounts.List(ctx, providerID)
		if err != nil {
			continue
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Meta.Name < list[j].Meta.Name })
		for _, acc := range list {
			name := acc.Meta.Name
			label := labelOr(acc.Meta.Label, name)
			detail := displaySafeIdentity(acc.Meta.Identity)
			for _, hubName := range names {
				enabled := false
				if cfg := byHub[hubName]; cfg != nil {
					for _, src := range cfg.Sources {
						if src.ProviderID == providerID && src.Account == name && src.IsEnabled() {
							enabled = true
							break
						}
					}
				}
				snap.HubSources = append(snap.HubSources, map[string]any{
					"id":         "hub/" + hubName + "/" + providerID + "/" + name,
					"providerId": providerID,
					"name":       name,
					"label":      label,
					"detail":     detail,
					"enabled":    enabled,
					"hub":        hubName,
				})
				present[providerID+"/"+name] = true
			}
			snap.HubCatalogs = append(snap.HubCatalogs, s.hubCatalogRows(ctx, names, pinned, providerID, name, acc.SnapshotDir)...)
		}
		if len(list) > 0 {
			for _, hubName := range names {
				if row, ok := s.hubPoolSourceRow(ctx, hubName, providerID, byHub[hubName]); ok {
					snap.HubSources = append(snap.HubSources, row)
				}
			}
		}
	}

	rotatingAccounts := s.hubRotatableAccounts(ctx, names, byHub)
	for _, hubName := range names {
		snap.HubSources = append(snap.HubSources, s.hubGhostRows(byHub[hubName], hubName, present)...)
	}
	for _, hubName := range names {
		var cfg *hub.Config
		if c := byHub[hubName]; c != nil {
			cp := *c
			cfg = &cp
		}
		snap.HubSources = append(snap.HubSources,
			s.hubRotationRow(hubName, cfg, rotatingAccounts[hubName]))
		port, host := 0, ""
		cfgEnabled := false
		if cfg != nil {
			port, host, cfgEnabled = cfg.Port, cfg.Host, cfg.Enabled
		}
		running, address := s.hubLive(hubName, port, host)
		toggleID, restartID, rotateID := actionID(), actionID(), actionID()
		label := "Proxy Hub"
		if hubName != "default" {
			label += " " + hubName
		}
		detail := "stopped"
		if running {
			detail = fmt.Sprintf("running on port %d", port)
		}
		// A configured hub can mint a key when the user copies it. Display must
		// not mint, and must not carry the bearer (ADR 0006).
		snap.Proxies = append(snap.Proxies, ProxyRow{
			ID: rowIDHub(hubName), ProviderID: "proxy-hub",
			Label: label, Detail: detail, Address: address,
			Running: running, Enabled: cfgEnabled,
			LogsAvailable:   true,
			ToggleActionID:  toggleID,
			RestartActionID: restartID,
			RotateActionID:  rotateID,
			HasToken:        cfg != nil,
		})
		registry[toggleID] = s.hubToggleActivator(hubName)
		registry[restartID] = s.hubRestartActivator(hubName)
		registry[rotateID] = func(c context.Context, opts actionOptions) error {
			if s.Deps.Hub == nil {
				return nil
			}
			if _, err := s.Deps.Hub.RotateHubTokenContext(c, hubName); err != nil {
				return err
			}
			if running {
				return s.hubRestartActivator(hubName)(c, opts)
			}
			return nil
		}
		snap.LogSources = append(snap.LogSources, LogSourceRow{
			ID: rowIDHub(hubName), ProviderID: "proxy-hub",
			Name: hubName, Label: label, Detail: detail,
		})
		if err := s.appendHubPublished(ctx, snap, hubName); err != nil {
			s.logErr(err)
		}
	}
	// Catalog rows are now available in the same snapshot, so publish the
	// exact conflict groups the native app renders and register the durable
	// owner actions behind their candidate ids.
	s.registerHubRoutingActions(snap, registry)
	return nil
}

// hubGhostRows publishes one row per hub source whose account no longer
// exists. The live-account loop above can never emit these (it visits live
// accounts only), so without this a deleted account rots in the config while
// the UI looks healthy — until serving resolves it and fails the request.
// Pool refs name a pool, not an account, and are owned by the pool lifecycle.
func (s *Server) hubGhostRows(cfg *hub.Config, hubName string, present map[string]bool) []map[string]any {
	if cfg == nil {
		return nil
	}
	var out []map[string]any
	for _, src := range cfg.Sources {
		if strings.HasPrefix(src.Account, "pool:") {
			continue
		}
		if present[src.ProviderID+"/"+src.Account] {
			continue
		}
		out = append(out, map[string]any{
			"id":         "hub/" + hubName + "/" + src.ProviderID + "/" + src.Account,
			"providerId": src.ProviderID,
			"name":       src.Account,
			"label":      src.Account,
			"detail":     "Account missing",
			"enabled":    src.IsEnabled(),
			"hub":        hubName,
			"ghost":      true,
			"unavailableReason": "Account " + src.ProviderID + "/" + src.Account +
				" no longer exists. Hub requests routed here fail; remove the source.",
		})
	}
	return out
}

func rowIDHub(hubName string) string { return "proxy-hub/" + hubName }

// appendHubPublished maps the hub's pinned route models to published-model
// rows. Only pinned models appear: unpinned catalog models need per-account
// catalogs the snapshot does not (and must not, per-tick) fetch.
func (s *Server) appendHubPublished(ctx context.Context, snap *Snapshot, hubName string) error {
	if s.Deps.Hub == nil {
		return nil
	}
	models, err := s.Deps.Hub.RouteModelsContext(ctx, hubName)
	if err != nil {
		return err
	}
	if len(models) == 0 {
		return nil
	}
	cfg, err := s.Deps.Hub.GetConfigContext(ctx, hubName)
	if err != nil {
		return err
	}
	for _, m := range models {
		ownerLabel, ownerProvider, ownerRef := "", "", ""
		if cfg != nil {
			if idx := hub.ResolveOwnerIndex(cfg.Sources, m); idx >= 0 {
				src := cfg.Sources[idx]
				ownerProvider = src.ProviderID
				// The native routing compiler keys candidates by the complete hub
				// source id. Keep that identity on the wire so a pinned owner can
				// be restored without guessing which hub owns the account.
				ownerRef = "hub/" + hubName + "/" + src.ProviderID + "/" + src.Account
				ownerLabel = src.Account
				if acc, aerr := s.Deps.Accounts.CachedAccount(ctx, src.ProviderID, src.Account); aerr == nil && acc != nil && acc.Meta.Label != "" {
					ownerLabel = acc.Meta.Label
				}
			} else if m.Owner != "" {
				ownerLabel = m.Owner + " (missing)"
			}
		}
		row := map[string]any{
			"id": m.Model, "ownerLabel": ownerLabel,
			"ownerProviderId": ownerProvider, "needsChoice": false,
		}
		if ownerRef != "" {
			row["ownerAccountId"] = ownerRef
		}
		snap.HubPublishedModels = append(snap.HubPublishedModels, row)
	}
	return nil
}

// tailHubLog tails a hub child's service.log. Hub output carries no
// account secrets, but the generic credential patterns are still screened
// before framing.
func tailHubLog(root, hubName string, lines int) (string, error) {
	raw, err := os.ReadFile(hubLogPath(root, hubName))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if len(raw) == 0 {
		return "", nil
	}
	all := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if lines > 0 && len(all) > lines {
		all = all[len(all)-lines:]
	}
	return proxy.RedactSecrets(strings.Join(all, "\n"), nil), nil
}

// hubToggleActivator flips the hub: running → verified stop (+Enabled=false
// so it stays stopped, matching account proxies after PX1); stopped →
// enable the config (creating "default") and spawn the child.
func (s *Server) hubToggleActivator(hubName string) actionHandler {
	// Hub start/stop does not touch a client config: no actionOptions here.
	return func(c context.Context, _ actionOptions) error {
		cfg, err := s.hubConfigOrNil(c, hubName)
		if err != nil {
			return err
		}
		port, host := 0, ""
		if cfg != nil {
			port, host = cfg.Port, cfg.Host
		}
		if running, _ := s.hubLive(hubName, port, host); running {
			return s.stopHub(c, hubName)
		}
		return s.startHub(c, hubName)
	}
}

func (s *Server) hubRestartActivator(hubName string) actionHandler {
	// Like the toggle: no client config is written, so no actionOptions.
	return func(c context.Context, _ actionOptions) error {
		if err := s.stopHub(c, hubName); err != nil {
			return err
		}
		return s.startHub(c, hubName)
	}
}

func (s *Server) hubConfigOrNil(ctx context.Context, hubName string) (*hub.Config, error) {
	if s.Deps.Hub == nil {
		return nil, anyerr.Newf("hub store unavailable", "HUB_UNAVAILABLE")
	}
	return s.Deps.Hub.GetConfigContext(ctx, hubName)
}

// hubPinnedCatalogs maps hub source ids to their pinned route models, so
// catalog rows carry everything publishable (discovery catalogs plus pins)
// and Swift compiles conflicts and published models from a single input.
// Best-effort per hub: a route or config read failure drops that hub's pins,
// never the snapshot.
func (s *Server) hubPinnedCatalogs(ctx context.Context, hubs []string) map[string][]string {
	out := map[string][]string{}
	if s.Deps.Hub == nil {
		return out
	}
	for _, hubName := range hubs {
		models, err := s.Deps.Hub.RouteModelsContext(ctx, hubName)
		if err != nil || len(models) == 0 {
			continue
		}
		cfg, err := s.Deps.Hub.GetConfigContext(ctx, hubName)
		if err != nil || cfg == nil {
			continue
		}
		for _, m := range models {
			if hub.ResolveOwnerIndex(cfg.Sources, m) < 0 {
				continue
			}
			src := cfg.Sources[hub.ResolveOwnerIndex(cfg.Sources, m)]
			id := "hub/" + hubName + "/" + src.ProviderID + "/" + src.Account
			out[id] = append(out[id], m.Model)
		}
	}
	return out
}

// hubCatalogRows returns one HubCatalog row per hub for a saved account:
// {accountID: hub source id, catalog: catalog provider id, models: [...]}.
// Only model ids cross the boundary — endpoints and keys never do.
// Resolution is cache-or-static (discovery NoLive): a cold cache never
// triggers per-tick egress. Live models warm the cache explicitly on hub
// start. Accounts with no discovered models emit no row: absence reads as
// "no catalog", never as an error.
func (s *Server) hubCatalogRows(ctx context.Context, hubs []string, pinned map[string][]string, providerID, name, snapshotDir string) []map[string]any {
	catalogID := catalog.CatalogIdentityFor(providerID)
	models := map[string]bool{}
	if providerID == "opencode" {
		for _, id := range provider.OpenCodeSnapshotCatalog(snapshotDir) {
			models[id] = true
		}
		for _, service := range provider.OpenCodeSnapshotServices(snapshotDir) {
			endpoint := provider.OpenCodeServiceEndpoint(service)
			if endpoint == "" {
				continue
			}
			for _, id := range s.catalogList(ctx, catalogID, endpoint, "") {
				models[id] = true
			}
		}
	} else {
		cacheKey := accountCatalogCacheKey(refs.AccountRef(providerID, name))
		for _, id := range s.catalogList(ctx, catalogID, "", cacheKey) {
			models[id] = true
		}
	}
	if len(models) == 0 && len(pinned) == 0 {
		return nil
	}
	list := make([]string, 0, len(models))
	for id := range models {
		list = append(list, id)
	}
	rows := make([]map[string]any, 0, len(hubs))
	for _, hubName := range hubs {
		sourceID := "hub/" + hubName + "/" + providerID + "/" + name
		set := map[string]bool{}
		for _, id := range list {
			set[id] = true
		}
		for _, id := range pinned[sourceID] {
			set[id] = true
		}
		if len(set) == 0 {
			continue
		}
		union := make([]string, 0, len(set))
		for id := range set {
			union = append(union, id)
		}
		sort.Strings(union)
		rows = append(rows, map[string]any{
			"accountID": sourceID,
			"catalog":   catalogID,
			"models":    union,
		})
	}
	return rows
}

// catalogList resolves one provider/endpoint pair without egress: fresh or
// stale cache, else the static policy list. A legacy composition without the
// injected discovery service falls back to static only.
func (s *Server) catalogList(ctx context.Context, catalogID, endpoint, cacheKey string) []string {
	if s.Deps.Discovery == nil {
		return discovery.StaticModels(catalogID)
	}
	return s.Deps.Discovery.List(ctx, discovery.Request{
		ProviderID: catalogID, Endpoint: endpoint, CacheKey: cacheKey, NoLive: true,
	}).Models
}

// openCodeWarmTimeout bounds one catalog fetch during hub start.
const openCodeWarmTimeout = 6 * time.Second

// warmOpenCodeCatalogs refreshes the opencode model cache from saved-mirror
// platform keys. Explicit user action (hub start) only — snapshot ticks stay
// cache-only, so a cold cache never triggers per-tick egress. Keys stay in
// Go: only model ids reach the cache. Advisory throughout: failures log and
// the start proceeds; an unwarmable catalog simply reads empty on the next
// ticks until a later start warms it.
func (s *Server) warmOpenCodeCatalogs(ctx context.Context, fetch func(ctx context.Context, endpoint, key string) ([]string, error)) {
	if s.Deps.Accounts == nil || s.Deps.Discovery == nil {
		return
	}
	accs, err := s.Deps.Accounts.List(ctx, "opencode")
	if err != nil || len(accs) == 0 {
		return
	}
	type job struct{ endpoint, key string }
	seen := map[string]bool{}
	jobs := []job{}
	for _, acc := range accs {
		for service, key := range provider.OpenCodeMirrorKeys(acc.SnapshotDir) {
			endpoint := provider.OpenCodeServiceEndpoint(service)
			if endpoint == "" || key == "" || seen[endpoint] {
				continue
			}
			seen[endpoint] = true
			jobs = append(jobs, job{endpoint, key})
		}
	}
	if len(jobs) == 0 {
		return
	}
	for _, j := range jobs {
		fetchCtx, cancel := context.WithTimeout(ctx, openCodeWarmTimeout)
		models, err := fetch(fetchCtx, j.endpoint, j.key)
		cancel()
		if err != nil || len(models) == 0 {
			s.logErr(catalogEmptyError(j.endpoint, err))
			continue
		}
		if werr := s.Deps.Discovery.StoreLive(ctx, "opencode", j.endpoint, models); werr != nil {
			s.logErr(werr)
		}
	}
}

func catalogEmptyError(endpoint string, err error) error {
	if err != nil {
		return err
	}
	return anyerr.Newf("opencode catalog at "+endpoint+" returned no models", "CATALOG_EMPTY")
}

func (s *Server) startHub(ctx context.Context, hubName string) error {
	if s.Deps.Activation == nil || s.Deps.Activation.SpawnHubChild == nil {
		return anyerr.Newf("hub spawn unavailable in this composition",
			"ACTIVATION_UNAVAILABLE")
	}
	var spawnErr error
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.MutationScopeForRef(refs.ProxyHubRef(hubName)), func(c context.Context) error {
		cfg, gerr := s.hubConfigOrNil(c, hubName)
		if gerr != nil {
			return gerr
		}
		if cfg == nil {
			cfg = &hub.Config{Name: hubName, Sources: []hub.Source{}}
		}
		cfg.Enabled = true
		rec := ownership.Load(hubPIDPath(s.Deps.Root, hubName))
		childLive := rec != nil && rec.VerifyLive()
		if hub.ShouldPublishPort(cfg.Port, childLive) {
			picked, perr := proxy.PickFreePort()
			if perr != nil {
				return perr
			}
			cfg.Port = picked
		}
		if _, uerr := s.Deps.Hub.UpsertConfigContext(c, *cfg); uerr != nil {
			return uerr
		}
		if _, serr := s.Deps.Activation.SpawnHubChild(hubName); serr != nil {
			spawnErr = serr
			return serr
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Warm opencode catalogs after spawn: explicit start is the one user action
	// allowed live egress, so the next snapshot ticks read warmed cache instead
	// of cold emptiness. Advisory — never fails the start, and never blocks it:
	// the warming budget is per source (8s) plus per job (6s), which is longer
	// than the host's confirm window, so doing it inline made a successful hub
	// start look like a service that never confirmed.
	s.inFlight.Add(1)
	go func() {
		defer s.inFlight.Done()
		s.warmAccountCatalogsForHub(ctx, hubName)
		s.warmOpenCodeCatalogs(ctx, func(c context.Context, endpoint, key string) ([]string, error) {
			return catalog.FetchLiveModels(c, "openai", &catalog.FetchContext{Endpoint: endpoint, APIKey: key})
		})
	}()
	return spawnErr
}

func (s *Server) stopHub(ctx context.Context, hubName string) error {
	var stopped bool
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.MutationScopeForRef(refs.ProxyHubRef(hubName)), func(c context.Context) error {
		cfg, gerr := s.hubConfigOrNil(c, hubName)
		if gerr != nil {
			return gerr
		}
		port, host := 0, ""
		if cfg != nil {
			port, host = cfg.Port, cfg.Host
		}
		addr := ""
		if port > 0 {
			if host == "" {
				host = "127.0.0.1"
			}
			addr = fmt.Sprintf("http://%s:%d/health", host, port)
		}
		stopped = ownership.Stop(hubPIDPath(s.Deps.Root, hubName), ownership.StopOptions{
			Health: func(r ownership.Record) bool {
				if addr == "" {
					return true
				}
				return hubHealthEcho(addr, r.InstanceID)
			},
		})
		if cfg != nil && cfg.Enabled {
			cfg.Enabled = false
			if _, uerr := s.Deps.Hub.UpsertConfigContext(c, *cfg); uerr != nil {
				return uerr
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !stopped {
		return anyerr.Newf("hub "+hubName+" is not running", "HUB_NOT_RUNNING")
	}
	return nil
}

// handleHubSourceToggle honors the explicit Enabled flag: true attaches the
// source (creating the hub config on first use), false detaches it. The old
// presence-toggle ignored Enabled and misread Name, inverting the switch.
// hubRotationRow is the hub-wide request mode: one row per hub, not one per
// provider. Enabling it makes every request spread across the accounts that
// can serve it (the resolved source's provider), which is what a hub with
// several saved accounts of one provider is for.
//
// The row is not a source: it carries no account value, so it is rendered and
// toggled through hub-rotation rather than hub-source-toggle.
// hubPoolSourceRow describes a provider whose hub source is an account pool
// ("pool:<provider>") instead of one account. A hub keeps exactly one source per
// provider, so this row is the only way the app can show — and clear — that
// choice: without it the provider's accounts look switchable while every attempt
// to enable one is refused.
func (s *Server) hubPoolSourceRow(
	ctx context.Context, hubName, providerID string, cfg *hub.Config,
) (map[string]any, bool) {
	account := hub.PoolSourceAccount(providerID)
	if cfg == nil {
		return nil, false
	}
	enabled := false
	for _, src := range cfg.Sources {
		if src.ProviderID == providerID && src.Account == account {
			enabled = src.IsEnabled()
			break
		}
	}
	if !enabled {
		return nil, false
	}
	poolEnabled := false
	if s.Deps.Pools != nil {
		if pool, err := s.Deps.Pools.GetContext(ctx, providerID); err == nil && pool != nil &&
			pool.Enabled && pool.Mode == "multi" {
			poolEnabled = true
		}
	}
	detail := "Legacy: turn this off, then switch accounts on individually"
	if !poolEnabled {
		detail += " (its account pool is also switched off in Proxies)"
	}
	return map[string]any{
		"id":         "hub/" + hubName + "/" + providerID + "/" + account,
		"providerId": providerID,
		"name":       account,
		"label":      "All " + providerID + " accounts (pool)",
		"detail":     detail,
		"enabled":    true,
		"hub":        hubName,
		"poolSource": true,
	}, true
}

// hubRotatableAccounts counts, per hub, the enabled sources that share a
// provider with at least one other enabled source. Those are the accounts the
// mode actually rotates over; a lone account per provider adds nothing.
func (s *Server) hubRotatableAccounts(
	ctx context.Context, names []string, byHub map[string]*hub.Config,
) map[string]int {
	counts := make(map[string]int, len(names))
	groups := map[string]map[string]int{}
	for _, providerID := range s.Deps.Providers.IDs() {
		if _, err := s.Deps.Providers.Get(providerID); err != nil || s.Deps.Accounts == nil {
			continue
		}
		list, err := s.Deps.Accounts.List(ctx, providerID)
		if err != nil || len(list) < 2 {
			continue
		}
		for _, hubName := range names {
			if groups[hubName] == nil {
				groups[hubName] = map[string]int{}
			}
			groups[hubName][providerID] = len(list)
		}
	}
	for _, hubName := range names {
		cfg := byHub[hubName]
		if cfg == nil {
			continue
		}
		enabled := 0
		for _, src := range cfg.Sources {
			if !src.IsEnabled() {
				continue
			}
			if groups[hubName][src.ProviderID] > 1 {
				enabled++
			}
		}
		counts[hubName] = enabled
	}
	return counts
}

func (s *Server) hubRotationRow(hubName string, cfg *hub.Config, accounts int) map[string]any {
	enabled := cfg != nil && cfg.SpreadsRequests()
	strategy := hub.StrategyFailover
	if cfg != nil && cfg.Strategy != "" {
		strategy = cfg.Strategy
	}
	detail := "Spread each model across the accounts that serve it"
	if strategy == hub.StrategySoonestReset {
		detail = "Start with the account whose unused quota resets soonest"
	}
	if strategy != hub.StrategyFailover && accounts < 2 {
		detail = "Needs two or more accounts in this hub"
	}
	return map[string]any{
		"id":           "hub/" + hubName + "/rotation",
		"providerId":   "",
		"name":         "rotation",
		"label":        "Rotate across accounts",
		"detail":       detail,
		"enabled":      enabled,
		"strategy":     strategy,
		"hub":          hubName,
		"rotates":      true,
		"accountCount": accounts,
	}
}

// handleHubRotation is the hub-wide mode switch (operation "hub-rotation").
func (s *Server) handleHubRotation(ctx context.Context, m Mutate) Result {
	result := Result{Version: ProtocolVersion, RequestID: m.RequestID}
	name := orString(strings.TrimSpace(m.Name), "default")
	return s.toggleHubRotation(ctx, m, result, name)
}

func (s *Server) handleHubSourceToggle(ctx context.Context, m Mutate) Result {
	result := Result{Version: ProtocolVersion, RequestID: m.RequestID}
	name := orString(strings.TrimSpace(m.Name), "default")
	account := strings.TrimSpace(orString(m.SourceID, m.Label))
	if m.ProviderID == "" || account == "" {
		return errorResult(m.RequestID, anyerr.Newf(
			"hub-source-toggle needs providerId and sourceId", "INVALID_USAGE"))
	}
	if poolProvider, isPool := hubPoolSourceProvider(account); isPool {
		return s.toggleHubPoolSource(ctx, m, result, name, poolProvider)
	}
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.MutationScopeForRef(refs.ProxyHubRef(name)), func(c context.Context) error {
		cfg, gerr := s.hubConfigOrNil(c, name)
		if gerr != nil {
			return gerr
		}
		if cfg == nil {
			if !m.Enabled {
				return nil
			}
			cfg = &hub.Config{Name: name, Sources: []hub.Source{}}
		}
		// Rotation owns the provider's source row: an individual account added
		// beside it would give the same models two owners, and the manifest
		// refuses to route a model whose owner is ambiguous.
		if m.Enabled {
			for _, src := range cfg.Sources {
				if src.ProviderID == m.ProviderID && src.IsEnabled() {
					if _, pooled := hubPoolSourceProvider(src.Account); pooled {
						return anyerr.Newf(
							"This hub serves every "+m.ProviderID+" account through one pool.",
							"POOL_SOURCE_ACTIVE",
							anyerr.WithSuggestions(
								"Turn off \"All "+m.ProviderID+" accounts (pool)\" in Proxy Hub to pick one account instead.",
								"Or use the hub-wide Rotate across accounts switch to spread requests over all of them."))
					}
				}
			}
		}
		kept := make([]hub.Source, 0, len(cfg.Sources))
		for _, src := range cfg.Sources {
			if src.ProviderID == m.ProviderID && src.Account == account {
				continue
			}
			kept = append(kept, src)
		}
		if m.Enabled {
			// Attaching a source for an account that does not exist would
			// fail later at the foreign key with a raw constraint error;
			// fail here with the account named. Toggling off is always
			// allowed: detaching a missing source is a no-op success.
			if s.Deps.Accounts != nil {
				acc, aerr := s.Deps.Accounts.CachedAccount(ctx, m.ProviderID, account)
				if aerr != nil {
					return aerr
				}
				if acc == nil {
					return anyerr.Newf(
						"Account "+m.ProviderID+"/"+account+" does not exist; nothing was attached.",
						"ACCOUNT_NOT_FOUND",
						anyerr.WithExitCode(anyerr.NotFound))
				}
			}
			enabled := true
			kept = append(kept, hub.Source{ProviderID: m.ProviderID, Account: account, Enabled: &enabled})
		}
		cfg.Sources = kept
		_, uerr := s.Deps.Hub.UpsertConfigContext(c, *cfg)
		return uerr
	})
	if err != nil {
		return result.Fail(err)
	}
	if err := s.hubReload(ctx, name); err != nil {
		// The source list is written; only applying it to the running hub
		// failed. Saying "nothing changed" would be a lie.
		return result.Fail(anyerr.Wrapf(err,
			"Saved the source, but the running hub did not restart",
			"HUB_RELOAD_FAILED", anyerr.WithMutated(true)))
	}
	if m.Enabled {
		result.Status, result.Message = "success", "Added to the hub."
	} else {
		result.Status, result.Message = "success", "Removed from the hub."
	}
	return result
}

// toggleHubPoolSource retires a legacy pooled source.
//
// A hub keeps exactly one source per provider, so a pool source replaces every
// account toggle for that provider with a single ring — the opposite of
// per-account state. Rotation is the hub-wide switch now, so this row can only
// be turned off: turning it on is refused with the two things to do instead.
func (s *Server) toggleHubPoolSource(
	ctx context.Context, m Mutate, result Result, hubName, providerID string,
) Result {
	if providerID != m.ProviderID {
		return result.Fail(anyerr.Newf(
			"That source does not belong to provider "+m.ProviderID, "INVALID_USAGE"))
	}
	if m.Enabled {
		// A hub keeps one source per provider, so this row would replace every
		// account toggle with one ring — the opposite of per-account state.
		return result.Fail(anyerr.Newf(
			"Proxy Hub rotates across the accounts you switch on; it does not pool them.",
			"POOL_SOURCE_RETIRED",
			anyerr.WithSuggestions(
				"Turn this row off, then switch on the "+providerID+" accounts you want.",
				"Use the hub-wide Rotate across accounts switch to spread requests over all of them.")))
	}
	err := lock.WithMutationLock(ctx, s.Deps.Root,
		refs.SerializeRef(refs.ProxyHubRef(hubName)), func(c context.Context) error {
			cfg, gerr := s.hubConfigOrNil(c, hubName)
			if gerr != nil {
				return gerr
			}
			if cfg == nil {
				return nil
			}
			account := hub.PoolSourceAccount(providerID)
			kept := make([]hub.Source, 0, len(cfg.Sources))
			for _, src := range cfg.Sources {
				if src.ProviderID == providerID && src.Account == account {
					continue
				}
				kept = append(kept, src)
			}
			cfg.Sources = kept
			_, uerr := s.Deps.Hub.UpsertConfigContext(c, *cfg)
			return uerr
		})
	if err != nil {
		return result.Fail(err)
	}
	if err := s.hubReload(ctx, hubName); err != nil {
		return result.Fail(anyerr.Wrapf(err,
			"Removed the pooled source, but the running hub did not restart",
			"HUB_RELOAD_FAILED", anyerr.WithMutated(true)))
	}
	result.Status = "success"
	result.Message = fmt.Sprintf("Stopped pooling %s accounts; switch on the ones you want.", providerID)
	return result
}

// hubPoolSourceProvider splits a pool source value ("pool:<provider>").
func hubPoolSourceProvider(account string) (string, bool) {
	const prefix = "pool:"
	if !strings.HasPrefix(account, prefix) || len(account) == len(prefix) {
		return "", false
	}
	return strings.TrimPrefix(account, prefix), true
}

// toggleHubRotation flips the hub-wide request mode.
//
// The mode lives in the hub config, not in a per-provider row: the hub resolves
// each request to a source and then spreads it across that source's provider,
// so "which accounts rotate" is a property of the request, not of a switch the
// user has to set per provider. A running hub is restarted because its config
// is a start-time snapshot.
func (s *Server) toggleHubRotation(
	ctx context.Context, m Mutate, result Result, hubName string,
) Result {
	strategy := m.Strategy
	if strategy == "" {
		// An older host: its switch is round-robin on or off.
		strategy = hub.StrategyFailover
		if m.Enabled {
			strategy = hub.StrategyRoundRobin
		}
	}
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.SerializeRef(refs.ProxyHubRef(hubName)), func(c context.Context) error {
		cfg, gerr := s.hubConfigOrNil(c, hubName)
		if gerr != nil {
			return gerr
		}
		if cfg == nil {
			if strategy == hub.StrategyFailover {
				return nil
			}
			cfg = &hub.Config{Name: hubName, Sources: []hub.Source{}}
		}
		cfg.Strategy = strategy
		_, uerr := s.Deps.Hub.UpsertConfigContext(c, *cfg)
		return uerr
	})
	if err != nil {
		return result.Fail(err)
	}
	if err := s.hubReload(ctx, hubName); err != nil {
		return result.Fail(anyerr.Wrapf(err,
			"Saved the mode, but the running hub did not restart",
			"HUB_RELOAD_FAILED", anyerr.WithMutated(true)))
	}
	switch strategy {
	case hub.StrategyRoundRobin:
		result.Status, result.Message = "success", "Spreading requests across this hub's accounts."
	case hub.StrategySoonestReset:
		result.Status, result.Message = "success", "Starting with the account whose quota resets soonest."
	default:
		result.Status, result.Message = "success", "Each model is served by one account again."
	}
	return result
}

// hubReload applies a source change to a hub that is already serving. The route
// manifest — which source index each model is pinned to — is compiled when the
// hub starts, so a config write alone changes nothing for running requests and a
// switch that appeared to work would route nothing new. Stop+start is the honest
// apply: rebuilding the manifest in place would renumber the indices the
// already-published routes are pinned to.
func (s *Server) hubReload(ctx context.Context, hubName string) error {
	if !s.hubServing(ctx, hubName) {
		return nil
	}
	if err := s.stopHub(ctx, hubName); err != nil {
		return err
	}
	return s.startHub(ctx, hubName)
}

// hubServing reports whether a hub process is answering its own health echo.
func (s *Server) hubServing(ctx context.Context, hubName string) bool {
	cfg, err := s.hubConfigOrNil(ctx, hubName)
	if err != nil || cfg == nil {
		return false
	}
	running, _ := s.hubLive(hubName, cfg.Port, cfg.Host)
	return running
}
