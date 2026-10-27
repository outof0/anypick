package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/cli"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/modelcache"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
)

// cmdModels answers the question the MODEL_NOT_PINNED warning raises but never
// answered: "Re-run with --model <id>" — which ids?
//
// It lists the ids the bound source can serve, resolved the same way the
// desktop snapshot resolves its picker options (catalog.CatalogProviderFor for
// account/gateway sources, the hub's routed models for hub sources), so the
// CLI and the app cannot disagree about what is pinnable.
//
// Go-only command, listed in testdata/parity/cli-tree.json's omitted list
// because it has no command-line counterpart in any earlier CLI.
func cmdModels(ctx context.Context, a *app.App, args []string) int {
	if cli.WantsHelp(args) {
		cliPrint("usage: anypick models <client> [--with <source>] [--json]\n\n" +
			"Lists the model ids one connection can serve. Without --with it uses\n" +
			"the client's current binding. The source must exist: an account or\n" +
			"gateway that does not is an error, not an empty catalog.\n")
		return int(anyerr.Success)
	}
	fs := fsFor(args)
	with := fs.String("with", "", "source reference (defaults to the client's current binding)")
	if err := fs.Parse(reorder(args)); err != nil {
		return int(anyerr.InvalidUsage)
	}
	if fs.NArg() != 1 {
		cliFprintln(os.Stderr, "usage: anypick models <client> [--with <source>]")
		return int(anyerr.InvalidUsage)
	}
	clientID := fs.Arg(0)
	if _, err := a.Clients.Get(clientID); err != nil {
		return reportErr(err)
	}
	source, err := modelsSource(ctx, a, clientID, *with)
	if err != nil {
		return reportErr(err)
	}
	catalogID, models, err := modelsForSource(ctx, a, source)
	if err != nil {
		return reportErr(err)
	}
	// Whatever the client already pins stays listed: a connection must never
	// be unable to re-select the model it is running.
	models = mergeModelIDs(models, pinnedModelIDs(ctx, a, clientID))
	if len(models) == 0 {
		return reportErr(anyerr.Newf(
			"no model catalog is known for "+refs.DisplayRef(source)+
				"; run `anypick proxy hub preview` for hub routes, or check the provider id",
			"MODEL_CATALOG_UNKNOWN"))
	}

	if globals.JSON {
		jsonOut(map[string]any{
			"client":  clientID,
			"source":  refs.DisplayRef(source),
			"catalog": catalogID,
			"models":  models,
		})
		return int(anyerr.Success)
	}
	// Context goes to stderr so stdout stays a plain id-per-line stream that
	// `--quiet` (and any pipe) can consume untouched.
	if !globals.Quiet {
		context := fmt.Sprintf("%s ← %s", clientID, refs.DisplayRef(source))
		if catalogID != "" {
			context += " · " + catalogID + " catalog"
		}
		cliFprintln(os.Stderr, context)
	}
	for _, model := range models {
		cliPrintlnRaw(model)
	}
	return int(anyerr.Success)
}

// modelsSource resolves --with, falling back to the client's persisted
// binding. Unknown or missing sources are errors, never an empty list: "no
// models" and "no route" are different answers.
func modelsSource(ctx context.Context, a *app.App, clientID, with string) (refs.Ref, error) {
	if with != "" {
		providerSet := map[string]bool{}
		for _, id := range a.Providers.IDs() {
			providerSet[id] = true
		}
		return refs.ParseRef(with, &refs.ParseContext{AccountProviders: providerSet})
	}
	binding, err := a.BindingSvc.GetGlobalContext(ctx, clientID)
	if err != nil {
		return refs.Ref{}, err
	}
	if binding == nil {
		return refs.Ref{}, anyerr.Newf(
			"client "+clientID+" has no binding to list models for; pass --with <source>",
			"BINDING_NOT_FOUND")
	}
	return binding.Spec.Source, nil
}

// modelsForSource returns the catalog id (empty for hub routes) and the model
// ids that connection publishes.
func modelsForSource(ctx context.Context, a *app.App, source refs.Ref) (string, []string, error) {
	switch source.Kind {
	case refs.KindProxyHub:
		if a.ProxyHub == nil {
			return "", nil, nil
		}
		models, err := hubActivationModels(ctx, a, source.Name)
		if err != nil {
			return "", nil, err
		}
		return "", mergeModelIDs(models), nil
	case refs.KindAccount:
		// Resolve the account before serving a catalog. The gateway branch
		// refuses an unknown gateway with GATEWAY_NOT_FOUND; this branch used
		// to print the provider's static catalog for a typo'd account and exit
		// 0, so a user pinned a model against a source that does not exist.
		// CachedAccount, not Get: this is a display read of metadata only.
		acct, aerr := a.Accounts.CachedAccount(ctx, source.Provider, source.Name)
		if aerr != nil {
			return "", nil, aerr
		}
		if acct == nil {
			return "", nil, anyerr.Newf(
				"Account not found: "+source.Provider+"/"+source.Name,
				"ACCOUNT_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound))
		}
		catalogID := catalog.CatalogIdentityFor(source.Provider)
		// Account providers own their live catalog and credentials. Ask the
		// proxy resolver first so subscription accounts (for example WorkBuddy)
		// can publish newly entitled model ids without an app release; static
		// policy remains the advisory fallback for providers without discovery.
		if a.Proxy != nil {
			if models, derr := a.Proxy.DiscoverModels(ctx, source.Provider, source.Name); derr == nil && len(models) > 0 {
				ordered := mergeModelIDsOrdered(models)
				rememberAccountModelCatalog(ctx, a, source.Provider, source.Name, ordered)
				return catalogID, ordered, nil
			}
		}
		return catalogID, discovery.StaticModels(catalogID), nil
	case refs.KindGateway:
		catalogID, models, err := gatewayModelCatalog(ctx, a, source.Name, true, false, true)
		return catalogID, models, err
	case refs.KindAccountPool:
		models := activationPoolModelCatalog(ctx, a, source.Provider, true)
		return catalog.CatalogIdentityFor(source.Provider), models, nil
	default:
		return "", nil, anyerr.Newf(
			"models are not listed for "+string(source.Kind)+" sources", "MODEL_CATALOG_UNKNOWN")
	}
}

// hubActivationModels returns the models a proxy hub exposes: its explicit route
// pins first, in pin order, then every model its enabled sources can serve.
//
// Pins used to replace the rest of the surface rather than lead it. That made a
// hub publish only what an operator had pinned, while candidateChain still
// serves every same-provider source for an unpinned model (see
// hub.Server.candidateChain) — so a client was told a hub cannot select a model
// the hub accepts, and a hub with one pin reported nothing about its other
// sources at all. Pins stay first because they are the operator's chosen order
// and the head of the list is the planning default.
func hubActivationModels(ctx context.Context, a *app.App, hubName string) ([]string, error) {
	pinned, err := hubPinnedModels(ctx, a, hubName)
	if err != nil {
		return nil, err
	}
	// Combos are the hub's own model ids (ADR-0036), chosen as deliberately
	// as pins, so they follow the pins.
	if a != nil && a.ProxyHub != nil {
		if cfg, cerr := a.ProxyHub.GetConfig(ctx, hubName); cerr == nil && cfg != nil {
			for _, combo := range cfg.Combos {
				pinned = append(pinned, combo.Name)
			}
		}
	}
	return mergeModelIDsOrdered(pinned, hubSourceModels(ctx, a, hubName, !globals.DryRun)), nil
}

// hubPinnedModels returns the hub's explicit route pins in pin order.
func hubPinnedModels(ctx context.Context, a *app.App, hubName string) ([]string, error) {
	if a == nil || a.ProxyHub == nil {
		return nil, nil
	}
	routes, err := a.ProxyHub.RouteModelsContext(ctx, hubName)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, route := range routes {
		if m := strings.TrimSpace(route.Model); m != "" {
			out = append(out, m)
		}
	}
	return out, nil
}

// hubSourceModels aggregates the models every enabled hub source can serve
// (pools and accounts). It is the part of the hub surface that is not pinned, so
// it can legitimately be empty — a hub whose sources publish no catalog is a
// real state, not an error.
//
// live selects discovery over the cached catalog. Callers that only render a
// view (preview) pass false: a preview must not spend saved credentials on
// vendor egress, exactly like a dry run.
func hubSourceModels(ctx context.Context, a *app.App, hubName string, live bool) []string {
	if a == nil || a.ProxyHub == nil {
		return nil
	}
	cfg, err := a.ProxyHub.GetConfig(ctx, hubName)
	if err != nil || cfg == nil {
		return nil
	}
	var out []string
	for _, src := range cfg.Sources {
		if !src.IsEnabled() {
			continue
		}
		if poolProvider, ok := hub.PoolSourceProvider(src); ok {
			out = append(out, activationPoolModelCatalog(ctx, a, poolProvider, live)...)
			continue
		}
		if src.ProviderID != "" && src.Account != "" {
			if a.Proxy != nil && live {
				if models, derr := a.Proxy.DiscoverModels(ctx, src.ProviderID, src.Account); derr == nil && len(models) > 0 {
					ordered := mergeModelIDsOrdered(models)
					rememberAccountModelCatalog(ctx, a, src.ProviderID, src.Account, ordered)
					out = append(out, ordered...)
					continue
				}
			}
			cached := cachedAccountModelCatalog(ctx, a, src.ProviderID, src.Account)
			if len(cached) > 0 {
				out = append(out, cached...)
				continue
			}
			catID := catalog.CatalogIdentityFor(src.ProviderID)
			stat := discovery.StaticModels(catID)
			if len(stat) > 0 {
				out = append(out, stat...)
				continue
			}
			if a.Providers != nil {
				if pv, err := a.Providers.Get(src.ProviderID); err == nil && pv != nil {
					if c, ok := pv.(*provider.Compatible); ok && c != nil {
						for _, m := range c.Def.Models {
							if m = strings.TrimSpace(m); m != "" {
								out = append(out, m)
							}
						}
					}
				}
			}
		}
	}
	return mergeModelIDsOrdered(out)
}

// activationModelCatalog returns only models proven by the selected source.
// The CLI uses this before planning so native clients such as DSH receive the
// same source-scoped list as the desktop service. Static provider policy is
// intentionally excluded here: it describes a family, not this account's
// entitlement or a gateway's live /models response.
//
// Order follows discovery (the vendor's own preferred order, newest first),
// never alphabetical: every surface bootstraps the same default from the same
// source, so re-running an activation cannot flip the model. Display paths
// use mergeModelIDs for a sorted list; planning must not.
//
// The returned error preserves the discovery failure (if any) so the planner
// can tailor its missing-model error. Callers that only need the list may
// ignore it.
func activationModelCatalog(ctx context.Context, a *app.App, source refs.Ref) ([]string, error) {
	if a == nil {
		return nil, nil
	}
	switch source.Kind {
	case refs.KindAccount:
		if a.Proxy == nil {
			return nil, nil
		}
		if globals.DryRun {
			// A dry run prints a plan; it must not perform live vendor egress
			// with the saved credential. The last successful discovery is
			// enough to bootstrap a model for clients that require one, so a
			// preview of `use dsh --with …` still plans instead of failing
			// with MODEL_REQUIRED.
			return cachedAccountModelCatalog(ctx, a, source.Provider, source.Name), nil
		}
		models, err := a.Proxy.DiscoverModels(ctx, source.Provider, source.Name)
		if err != nil {
			return nil, err
		}
		ordered := mergeModelIDsOrdered(models)
		rememberAccountModelCatalog(ctx, a, source.Provider, source.Name, ordered)
		return ordered, nil
	case refs.KindProxyHub:
		return hubActivationModels(ctx, a, source.Name)
	case refs.KindGateway:
		_, models, err := gatewayModelCatalog(ctx, a, source.Name, !globals.DryRun, globals.DryRun, globals.DryRun)
		if err != nil {
			return nil, err
		}
		return models, nil
	case refs.KindAccountPool:
		return activationPoolModelCatalog(ctx, a, source.Provider, !globals.DryRun), nil
	default:
		return nil, nil
	}
}

// gatewayModelCatalog resolves the models for one saved gateway. A gateway is
// its own model source: the live /models response is preferred on every
// explicit CLI action, while discovery's cache/static fallback keeps the
// command useful when the upstream is temporarily unavailable. Saved profile
// selections are merged so a gateway can keep serving an id that the vendor's
// list endpoint intentionally omits.
func gatewayModelCatalog(ctx context.Context, a *app.App, name string, refresh, noLive, allowStatic bool) (string, []string, error) {
	if a == nil || a.Runtime == nil || a.Runtime.ProfileSvc == nil {
		return "", nil, anyerr.Newf("gateway model discovery is unavailable", "MODEL_CATALOG_UNKNOWN")
	}
	profile, err := a.Runtime.ProfileSvc.GetContext(ctx, name)
	if err != nil {
		return "", nil, err
	}
	if profile == nil {
		return "", nil, anyerr.Newf("gateway "+name+" does not exist", "GATEWAY_NOT_FOUND")
	}
	catalogID := catalog.CatalogIdentityFor(profile.Meta.Provider)
	service := &discovery.Service{
		Root:  a.Root,
		Cache: &modelcache.Store{DB: a.DB},
	}
	result := service.List(ctx, discovery.Request{
		ProviderID: catalogID,
		Endpoint:   profile.Meta.Endpoint,
		CacheKey:   profile.Meta.Endpoint,
		APIKey:     profile.Secrets.APIKey,
		LiveStyle:  gatewayLiveCatalogStyle(catalogID),
		Refresh:    refresh,
		NoLive:     noLive,
	})
	models := []string{}
	if allowStatic || result.Source != discovery.SourceCatalog {
		models = append(models, result.Models...)
	}
	models = mergeModelIDs(models,
		[]string{profile.Meta.DefaultModel},
		mapValues(profile.Meta.Models))
	return catalogID, models, nil
}

func gatewayLiveCatalogStyle(catalogID string) string {
	if policy := catalog.Policy(catalogID); policy != nil && policy.LiveFetch != "" {
		return policy.LiveFetch
	}
	return "openai"
}

func mapValues(values map[string]string) []string {
	models := make([]string, 0, len(values))
	for _, model := range values {
		models = append(models, model)
	}
	return models
}

// activationPoolModelCatalog unions the catalogs of enabled members. A pool
// can rotate accounts with different entitlements, so publishing only a
// provider-wide static list is as unsafe as doing so for one account. When
// live is false (a dry run) each member's last successful discovery is used:
// a preview must not spend the saved credentials on vendor egress.
func activationPoolModelCatalog(ctx context.Context, a *app.App, providerID string, live bool) []string {
	if a == nil || a.PoolSvc == nil || (live && a.Proxy == nil) {
		return nil
	}
	pool, err := a.PoolSvc.GetContext(ctx, providerID)
	if err != nil || pool == nil {
		return nil
	}
	var all [][]string
	for _, member := range pool.Members {
		if !member.Enabled || member.Account == "" {
			continue
		}
		if !live {
			all = append(all, cachedAccountModelCatalog(ctx, a, providerID, member.Account))
			continue
		}
		models, derr := a.Proxy.DiscoverModels(ctx, providerID, member.Account)
		if derr == nil {
			ordered := mergeModelIDsOrdered(models)
			rememberAccountModelCatalog(ctx, a, providerID, member.Account, ordered)
			all = append(all, ordered)
		}
	}
	return mergeModelIDsOrdered(all...)
}

// cachedAccountModelCatalog reads the last successful live discovery for one
// saved account without touching the vendor. Dry runs use it because a preview
// must not spend the saved credential on egress; a cold cache stays empty
// rather than falling back to a provider-wide static list the account may not
// be entitled to.
func cachedAccountModelCatalog(ctx context.Context, a *app.App, providerID, name string) []string {
	if a == nil || a.DB == nil {
		return nil
	}
	service := &discovery.Service{Root: a.Root, Cache: &modelcache.Store{DB: a.DB}}
	result := service.List(ctx, discovery.Request{
		ProviderID: catalog.CatalogIdentityFor(providerID),
		CacheKey:   catalog.AccountCatalogKey(providerID, name),
		NoLive:     true,
	})
	if result.Source != discovery.SourceCache && result.Source != discovery.SourceStale {
		return nil
	}
	return mergeModelIDsOrdered(result.Models)
}

// rememberAccountModelCatalog persists a live discovery so the next dry run
// and the desktop picker reuse it without another vendor request. Failure is
// advisory: the caller already holds the list.
func rememberAccountModelCatalog(ctx context.Context, a *app.App, providerID, name string, models []string) {
	if a == nil || a.DB == nil || len(models) == 0 {
		return
	}
	service := &discovery.Service{Root: a.Root, Cache: &modelcache.Store{DB: a.DB}}
	_ = service.StoreLive(ctx,
		catalog.CatalogIdentityFor(providerID),
		catalog.AccountCatalogKey(providerID, name),
		models)
}

// pinnedModelIDs collects every model the client's binding currently stores —
// the explicit selection plus each role override.
func pinnedModelIDs(ctx context.Context, a *app.App, clientID string) []string {
	binding, err := a.BindingSvc.GetGlobalContext(ctx, clientID)
	if err != nil || binding == nil {
		return nil
	}
	var out []string
	if binding.Spec.Model.Mode == "explicit" {
		out = append(out, binding.Spec.Model.ID)
	}
	roles, _ := binding.Spec.ClientOptions["modelRoles"].(map[string]interface{})
	for _, value := range roles {
		if model, ok := value.(string); ok {
			out = append(out, model)
		}
	}
	return out
}

func mergeModelIDs(lists ...[]string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, list := range lists {
		for _, id := range list {
			if id != "" && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	sort.Strings(out)
	return out
}

// mergeModelIDsOrdered dedupes like mergeModelIDs but keeps first-seen order
// for planning: the default model is the list head, so it must be the
// vendor's preferred id on every surface, not the alphabetically first.
func mergeModelIDsOrdered(lists ...[]string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, list := range lists {
		for _, id := range list {
			if id = strings.TrimSpace(id); id != "" && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}
