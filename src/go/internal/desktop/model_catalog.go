package desktop

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
)

// Some account adapters must exchange an OAuth token before asking the model
// endpoint for its catalog. Z.ai's exchange client allows 30 seconds, then its
// catalog request allows another 6; keep this total budget long enough for
// both steps while staying inside DesktopActionTimeout.
const accountModelCatalogTimeout = 40 * time.Second

// warmAccountModelCatalog performs the live part of account model discovery
// after an explicit account action. The provider resolver owns credentials and
// wire details; desktop stores only model ids under an account-scoped cache
// key. A discovery failure is advisory and leaves the previous cached catalog
// intact; account routes never fall back to a provider-wide static list.
func (s *Server) warmAccountModelCatalog(ctx context.Context, providerID, name string) (int, error) {
	if s == nil || s.Deps.Proxy == nil || s.discoveryService() == nil {
		return 0, nil
	}
	catalogID := catalog.CatalogIdentityFor(providerID)
	warmCtx, cancel := context.WithTimeout(ctx, accountModelCatalogTimeout)
	defer cancel()
	models, err := s.Deps.Proxy.DiscoverModels(warmCtx, providerID, name)
	if err != nil {
		return 0, err
	}
	if len(models) == 0 {
		return 0, fmt.Errorf("provider returned an empty model catalog")
	}
	key := accountCatalogCacheKey(refs.AccountRef(providerID, name))
	if err := s.discoveryService().StoreLive(ctx, catalogID, key, models); err != nil {
		return 0, err
	}
	return len(models), nil
}

// refreshGatewayModelCatalog performs live discovery for a saved gateway.
// Known providers use their declared wire shape; compatible and custom
// gateways default to the OpenAI-compatible /models contract.
func (s *Server) refreshGatewayModelCatalog(ctx context.Context, name string) (discovery.Result, error) {
	if s == nil || s.Deps.Profiles == nil {
		return discovery.Result{}, fmt.Errorf("gateway model discovery unavailable")
	}
	pr, err := s.Deps.Profiles.GetContext(ctx, name)
	if err != nil {
		return discovery.Result{}, err
	}
	if pr == nil {
		return discovery.Result{}, fmt.Errorf("gateway not found")
	}
	catalogID := catalog.CatalogIdentityFor(pr.Meta.Provider)
	discoveryService := s.discoveryService()
	if discoveryService == nil {
		return discovery.Result{}, fmt.Errorf("gateway model discovery unavailable")
	}
	return discoveryService.List(ctx, discovery.Request{
		ProviderID: catalogID,
		Endpoint:   pr.Meta.Endpoint,
		CacheKey:   pr.Meta.Endpoint,
		APIKey:     pr.Secrets.APIKey,
		LiveStyle:  liveCatalogStyle(catalogID),
		Refresh:    true,
	}), nil
}

func liveCatalogStyle(catalogID string) string {
	if policy := catalog.Policy(catalogID); policy != nil && policy.LiveFetch != "" {
		return policy.LiveFetch
	}
	return "openai"
}

func (s *Server) warmGatewayModelCatalogBestEffort(ctx context.Context, name string) {
	if s == nil || s.Deps.Profiles == nil || s.discoveryService() == nil {
		return
	}
	if _, err := s.refreshGatewayModelCatalog(ctx, name); err != nil {
		s.logErr(err)
	}
}

func (s *Server) discoveryService() *discovery.Service {
	if s == nil {
		return nil
	}
	if s.Deps.Discovery != nil {
		return s.Deps.Discovery
	}
	if s.Deps.ModelCache == nil {
		return nil
	}
	return &discovery.Service{Root: s.Deps.Root, Cache: s.Deps.ModelCache}
}

// gatewayCatalogList returns only a cached gateway response plus the profile's
// explicit model selections. It deliberately does not return the provider's
// static family list: activation must not write models the selected endpoint
// has never advertised.
func (s *Server) gatewayCatalogList(ctx context.Context, pr *profile.Runtime) ([]string, bool) {
	if s == nil || pr == nil {
		return nil, false
	}
	service := s.discoveryService()
	if service == nil {
		return configuredGatewayModels(pr), false
	}
	result := service.List(ctx, discovery.Request{
		ProviderID: catalog.CatalogIdentityFor(pr.Meta.Provider),
		Endpoint:   pr.Meta.Endpoint,
		CacheKey:   pr.Meta.Endpoint,
		NoLive:     true,
	})
	cached := result.Source == discovery.SourceCache || result.Source == discovery.SourceStale
	models := []string{}
	if cached {
		models = append(models, result.Models...)
	}
	models = append(models, configuredGatewayModels(pr)...)
	return uniqueModelIDs(models), cached
}

func configuredGatewayModels(pr *profile.Runtime) []string {
	if pr == nil {
		return nil
	}
	models := []string{pr.Meta.DefaultModel}
	for _, model := range pr.Meta.Models {
		models = append(models, model)
	}
	return uniqueModelIDs(models)
}

func uniqueModelIDs(models []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	return out
}

// warmAccountCatalogsForHub refreshes enabled account sources before a hub is
// started. Starting a hub is an explicit user action, so this is the right
// point to discover newly entitled models; periodic snapshots stay cache-only.
func (s *Server) warmAccountCatalogsForHub(ctx context.Context, hubName string) {
	if s == nil || s.Deps.Hub == nil {
		return
	}
	cfg, err := s.Deps.Hub.GetConfigContext(ctx, hubName)
	if err != nil || cfg == nil {
		return
	}
	for _, source := range cfg.Sources {
		if !source.IsEnabled() {
			continue
		}
		if poolProvider, ok := hub.PoolSourceProvider(source); ok {
			s.warmAccountPoolModelCatalog(ctx, poolProvider)
			continue
		}
		s.warmAccountModelCatalogBestEffort(ctx, source.ProviderID, source.Account)
	}
}

func (s *Server) warmAccountModelCatalogBestEffort(ctx context.Context, providerID, name string) {
	// Advisory by definition, so it also must not sit inside the action's time
	// budget: the discovery call can take seconds, which the host reads as an
	// action that never confirmed. It reports through the next snapshot.
	s.inFlight.Add(1)
	go func() {
		defer s.inFlight.Done()
		if _, err := s.warmAccountModelCatalog(ctx, providerID, name); err != nil {
			if errors.Is(err, proxy.ErrModelDiscoveryUnsupported) {
				return
			}
			// Account save/refresh stays successful when a vendor's model
			// endpoint is unavailable or an OAuth entitlement probe is denied.
			s.logErr(fmt.Errorf("model catalog refresh for %s/%s: %w", providerID, name, err))
		}
	}()
}

// accountCatalogList returns only a cached catalog for one saved account.
// Static provider policy is useful for gateway UX, but it is not evidence that
// a subscription proxy exposes those models. Route activation and the model
// picker must never turn that generic fallback into a client config.
func (s *Server) accountCatalogList(ctx context.Context, source refs.Ref) []string {
	if s == nil || source.Kind != refs.KindAccount || s.discoveryService() == nil {
		return nil
	}
	result := s.discoveryService().List(ctx, discovery.Request{
		ProviderID: catalog.CatalogIdentityFor(source.Provider),
		CacheKey:   accountCatalogCacheKey(source),
		NoLive:     true,
	})
	if result.Source != discovery.SourceCache && result.Source != discovery.SourceStale {
		return nil
	}
	return result.Models
}

func (s *Server) accountPoolCatalogList(ctx context.Context, providerID string) []string {
	if s == nil || s.Deps.Proxy == nil {
		return nil
	}
	pool, err := s.Deps.Proxy.GetPoolContext(ctx, providerID)
	if err != nil || pool == nil {
		return nil
	}
	var models []string
	for _, member := range pool.Members {
		if !member.Enabled || member.Account == "" {
			continue
		}
		models = append(models, s.accountCatalogList(ctx, refs.AccountRef(providerID, member.Account))...)
	}
	return uniqueModelIDs(models)
}

func (s *Server) warmAccountPoolModelCatalog(ctx context.Context, providerID string) {
	if s == nil || s.Deps.Proxy == nil {
		return
	}
	pool, err := s.Deps.Proxy.GetPoolContext(ctx, providerID)
	if err != nil || pool == nil {
		return
	}
	for _, member := range pool.Members {
		if member.Enabled && member.Account != "" {
			s.warmAccountModelCatalogBestEffort(ctx, providerID, member.Account)
		}
	}
}

// sourceModelCatalog returns the cache-backed model ids for the exact source
// being activated. Account subscriptions use an account identity because two
// accounts can have different entitlements; gateways use their endpoint. A
// cold account cache deliberately returns empty rather than a provider-wide
// fallback, so a client adapter never publishes a model its proxy may reject.
func (s *Server) sourceModelCatalog(ctx context.Context, source refs.Ref) []string {
	switch source.Kind {
	case refs.KindAccount:
		return s.accountCatalogList(ctx, source)
	case refs.KindGateway:
		if s == nil || s.Deps.Profiles == nil {
			return nil
		}
		pr, err := s.Deps.Profiles.GetContext(ctx, source.Name)
		if err != nil || pr == nil {
			return nil
		}
		models, _ := s.gatewayCatalogList(ctx, pr)
		return models
	case refs.KindAccountPool:
		return s.accountPoolCatalogList(ctx, source.Provider)
	case refs.KindProxyHub:
		return s.hubCatalogList(ctx, source.Name)
	default:
		return nil
	}
}

func (s *Server) hubCatalogList(ctx context.Context, hubName string) []string {
	if s == nil || s.Deps.Hub == nil {
		return nil
	}
	// Pins LEAD the union instead of replacing it: the aggregation below is
	// the surface the hub actually serves (candidateChain resolves any model
	// its sources publish), so a pinned hub that returned only its pins told
	// the app "7 models" while its accounts publish 23. Pin order is kept so
	// the head of the list stays the planning default. This mirrors
	// cmd/anypick/models.go hubActivationModels.
	var pinned []string
	if routes, err := s.Deps.Hub.RouteModelsContext(ctx, hubName); err == nil {
		for _, r := range routes {
			if m := strings.TrimSpace(r.Model); m != "" {
				pinned = append(pinned, m)
			}
		}
	}
	cfg, err := s.Deps.Hub.GetConfigContext(ctx, hubName)
	if err != nil || cfg == nil {
		return uniqueModelIDs(pinned)
	}
	// Combos are the hub's own model ids (ADR-0036), as deliberate as pins.
	for _, combo := range cfg.Combos {
		pinned = append(pinned, combo.Name)
	}
	var out []string
	for _, src := range cfg.Sources {
		if !src.IsEnabled() {
			continue
		}
		if poolProvider, ok := hub.PoolSourceProvider(src); ok {
			out = append(out, s.accountPoolCatalogList(ctx, poolProvider)...)
			continue
		}
		if src.ProviderID != "" && src.Account != "" {
			models := s.accountCatalogList(ctx, refs.AccountRef(src.ProviderID, src.Account))
			if len(models) > 0 {
				out = append(out, models...)
			} else if pol := catalog.Policy(src.ProviderID); pol != nil {
				if def := strings.TrimSpace(pol.RoleDefaults["default"]); def != "" {
					out = append(out, def)
				}
				for _, m := range pol.StaticFallback {
					if m = strings.TrimSpace(m); m != "" {
						out = append(out, m)
					}
				}
			} else if s.Deps.Providers != nil {
				if pv, err := s.Deps.Providers.Get(src.ProviderID); err == nil && pv != nil {
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
	return uniqueModelIDs(append(pinned, out...))
}
