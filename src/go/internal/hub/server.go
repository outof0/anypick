package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/outof0/anypick/go/internal/upstream"

	"github.com/outof0/anypick/go/internal/observe"
	"github.com/outof0/anypick/go/internal/proxy"
)

// UpstreamResolver resolves a source into forwarding parameters.
type UpstreamResolver interface {
	ResolveUpstream(ctx context.Context, providerID, account string) (*proxy.Upstream, error)
}

// PoolRingResolver resolves a pool-backed source into its credential ring —
// the same guard-ordered, quota-class failover pipeline a standalone pool
// serves. Hub sources are account OR pool refs.
type PoolRingResolver interface {
	ResolvePoolRing(ctx context.Context, providerID string) (*proxy.PoolServer, error)
}

// Server is one running hub instance.
type Server struct {
	Config   Config
	Instance string
	Store    *Service
	Resolver UpstreamResolver
	// PoolRings serves pool-backed sources; nil makes them fail closed with a
	// clear upstream error instead of a panic.
	PoolRings PoolRingResolver
	// ModelsForProvider reports the model ids a provider can serve in this
	// install (its cached catalogs). Rotation uses it to spread one model over
	// every enabled account that can answer it, not only the account the model
	// happens to resolve to. Nil falls back to the resolved source's provider.
	ModelsForProvider func(providerID string) []string
	// NextReset reports when an account's unused quota resets (Unix ms, 0 when
	// unknown), for the soonest-reset strategy. Nil leaves failover order.
	NextReset func(providerID, account string) int64
	// Quotas cools down an account whose vendor refused it for quota reasons, so
	// the next request goes to another enabled account that can serve the model.
	// Hub-only: pool proxies keep their own guard. Nil disables it.
	Quotas *Quotas
	// ChainBudget bounds one request's attempts across accounts. Zero uses
	// DefaultChainBudget.
	ChainBudget time.Duration

	mu       sync.Mutex
	rotation rotationCursor
	httpSrv  interface {
		Shutdown() error
	}
	endpoint string
	errCh    chan error
}

// Start binds the hub on loopback and begins serving. Health stays
// unauthenticated; every model route requires its per-route token.
func (s *Server) Start() error {
	host := s.Config.Host
	if host == "" {
		host = "127.0.0.1"
	}
	if err := proxy.AssertLoopbackHost(host); err != nil {
		return err
	}
	port := s.Config.Port

	mux := http.NewServeMux()
	if s.Instance == "" {
		instance, err := proxy.NewInstanceID()
		if err != nil {
			return err
		}
		s.Instance = instance
	} // else: the detached parent seeded our instance so /health echoes the
	// recorded ownership id (ADR 0003 §3).

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"instanceId":%q,"hub":%q,"revision":%d,"counters":%s}`,
			s.Instance, s.Config.Name, s.Config.Revision, observe.HealthCounters())
	})
	mux.Handle("/", observe.DefaultLimiter.Handler(observe.RouteHub,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rec := proxy.NewStatusRecorder(w)
			req := observe.Default.Begin(observe.RouteHub)
			start := time.Now()
			// A closure, not `defer req.End(rec.Status(), ...)`: defer
			// evaluates its arguments now, which would file every request
			// under the recorder's initial 200 regardless of what the route
			// answered.
			defer func() {
				req.End(rec.Status(), observe.Classify(rec.Status(), false))
				proxy.LogProxyLine(r, rec.Status(), time.Since(start))
			}()
			s.serveRoute(rec, r)
		})))

	ln, err := listenLoopback(host, port)
	if err != nil {
		return err
	}
	// Publish every runtime field under mu: Endpoint() and Stop() read them
	// from other goroutines, and the accept loop publishes its failure through
	// errCh instead of discarding it. A hub whose listener died used to stay
	// "running" forever with no observable error.
	hs := proxy.ApplyServingLimits(&http.Server{Handler: mux})
	done := make(chan error, 1)
	go func() { done <- hs.Serve(ln) }()

	s.mu.Lock()
	s.endpoint = fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*tcpAddr).Port)
	s.errCh = done
	s.httpSrv = shutdownAdapter{srv: hs}
	s.mu.Unlock()
	return nil
}

// Endpoint returns http://127.0.0.1:<bound port> once started.
func (s *Server) Endpoint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.endpoint
}

// Err reports an accept-loop failure. It returns a nil channel before Start,
// which blocks forever rather than spinning on a closed one.
func (s *Server) Err() <-chan error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errCh
}

// config returns a snapshot of the running configuration. The request handler
// reads it on every request, so it is copied under mu instead of read
// unlocked. The Sources slice is shared with the copy, so it must be treated
// as immutable once Start has returned.
func (s *Server) config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Config
}

// Stop shuts the hub down; idempotent.
//
// The lock is released before Shutdown is called. Shutdown waits for in-flight
// requests, and every request calls config() under that same lock — holding it
// here would stall all of them until the shutdown context expires, and would
// block Endpoint() and Err() behind them.
func (s *Server) Stop() error {
	s.mu.Lock()
	srv := s.httpSrv
	s.httpSrv = nil
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown()
}

func (s *Server) serveRoute(w http.ResponseWriter, r *http.Request) {
	token, route, err := s.routeForRequest(r)
	if err != nil || !routeAuthenticated(route, token) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"type":"authentication_error","message":"invalid hub credentials"}}`))
		return
	}
	// The same key check every proxy answers, so a token rotation can prove
	// the new key works without depending on any upstream.
	if r.URL.Path == proxy.AuthCheckPath {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Opportunistic legacy-secret migration. Authentication has already
	// succeeded; this write converges pre-HMAC rows and is skipped for rows
	// that already match. It stays out of RouteByToken so the auth read path
	// is pure. A failure is logged, never swallowed: the legacy row keeps
	// authenticating, but silence would hide a broken store.
	if merr := s.Store.MigrateRouteTokenContext(r.Context(), route.RouteID, token); merr != nil {
		log.Printf("hub: route token migration failed for %s: %v", route.RouteID, merr)
	}
	cfg := s.config()
	if !cfg.Enabled {
		writeErr(w, http.StatusConflict, "PROXY_DISABLED", "hub "+cfg.Name+" is disabled")
		return
	}

	// The hub's own catalog (ADR-0036); a hub that knows none forwards the
	// listing to its default source as before.
	if r.Method == http.MethodGet && r.URL.Path == "/v1/models" && s.serveModels(w, &cfg, route) {
		return
	}

	sourceIdx := defaultSourceIndex(&cfg)
	var requestedModel string
	// outbound is the body the upstream receives: the client's bytes, or the
	// same bytes with the model field remapped by a pin.
	var outbound []byte
	if r.Method == http.MethodPost {
		body, readErr := proxy.ReadCappedBody(r, proxy.MaxBodyBytes)
		if errors.Is(readErr, proxy.ErrBodyTooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge, "invalid_request_error",
				fmt.Sprintf("request body exceeds %d bytes", proxy.MaxBodyBytes))
			return
		}
		if readErr != nil {
			writeErr(w, http.StatusBadRequest, "invalid_request_error", "unreadable body")
			return
		}
		var probe struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &probe)
		requestedModel = probe.Model
		// A combo name is the hub's own model id and wins over a pin
		// (ADR-0036): choosing it was an explicit decision.
		if combo := cfg.ComboNamed(requestedModel); combo != nil {
			s.serveCombo(w, r, &cfg, combo, body)
			return
		}
		// One lookup, used for both halves of the decision. Resolving the
		// source and the model remap from two passes over the same table
		// lets the halves pick different entries: with duplicate pins, the
		// source came from the first match while the remap came from the
		// first match that had an UpstreamModel — so a request could be sent
		// to one source under another source's model id.
		entry, pinned := routeModelEntry(route, requestedModel)
		if pinned {
			// A pin that names nothing attached (pruned source, legacy
			// row) falls back to default resolution instead of 404ing or
			// — worse — landing on a neighbor by stale index.
			if idx := ResolveOwnerIndex(cfg.Sources, entry); idx >= 0 {
				sourceIdx = idx
			} else {
				pinned = false
			}
		} else if strings.HasPrefix(requestedModel, "#") {
			// "#N" pins a source index explicitly.
			if n := parseIndex(requestedModel); n >= 0 && n < len(cfg.Sources) {
				sourceIdx = n
			} else {
				sourceIdx = -1
			}
		}
		// A model absent from the manifest falls through to the default source:
		// route.Models is a pinning table, not an allowlist. ADR 0013 §3's
		// "no first-source-wins" rule is about collisions — when two sources
		// claim the same model id, the id stays out of the catalog until the
		// user records an owner. It does not make an unlisted model an error.
		// Rebody for the upstream, re-encoding only when the pin actually
		// remaps the model. A body the hub was not asked to change must reach
		// the egress core as the bytes the client sent: every byte it
		// re-encodes is a byte it had to hold in memory first, and a
		// round trip through map[string]interface{} is a chance to change
		// something the client depended on.
		outbound = body
		if pinned && entry.UpstreamModel != "" && entry.UpstreamModel != requestedModel {
			if rewritten, ok := rewriteModelField(body, entry.UpstreamModel); ok {
				outbound = rewritten
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(outbound))
		r.ContentLength = int64(len(outbound))
	}
	if sourceIdx < 0 || sourceIdx >= len(cfg.Sources) {
		if len(cfg.Sources) == 0 {
			writeErr(w, http.StatusNotFound, "NO_SOURCE", "hub has no sources")
			return
		}
		writeErr(w, http.StatusNotFound, "NO_MODEL_SOURCE",
			fmt.Sprintf("no source in this route serves model %q", requestedModel))
		return
	}
	// The chain starts where the strategy says and handles the rest: rotation
	// picks a starting account, failover keeps the resolved one first, and the
	// hub's own quota guard moves a refused request to the next account.
	s.serveChain(w, r, &cfg, sourceIdx, requestedModel, outbound)
}

// chainBudget is the pre-commit budget for one request across accounts.
func (s *Server) chainBudget() time.Duration {
	if s.ChainBudget > 0 {
		return s.ChainBudget
	}
	return DefaultChainBudget
}

// serveChain forwards the request to the resolved source and, when the vendor
// refuses it for a quota reason, to the next enabled account that can serve the
// same model.
//
// The order is the strategy's: rotation starts where the cursor points,
// failover starts at the resolved source. Cooling accounts are skipped unless
// every candidate is cooling, in which case the policy decides between trying
// the soonest-to-recover one (and passing its verdict through) and refusing
// locally. Nothing here retries after response headers commit: a stream is a
// verdict.
func (s *Server) serveChain(
	w http.ResponseWriter, r *http.Request, cfg *Config, resolved int, requestedModel string, body []byte,
) {
	chain := s.candidateChain(cfg, resolved, requestedModel)
	if len(chain) == 0 {
		writeErr(w, http.StatusBadGateway, "upstream_error", "no source can serve this request")
		return
	}
	deadline := time.Now().Add(s.chainBudget())
	var dead []string
	for i, index := range chain {
		src := cfg.Sources[index]
		if providerID, ok := poolSourceProvider(src); ok {
			// A pool source owns its own ring (ordering, quota guard, failover)
			// and serves the request in-process.
			if s.PoolRings == nil {
				writeErr(w, http.StatusBadGateway, "upstream_error",
					"pool sources are not served by this hub instance")
				return
			}
			ring, rerr := s.PoolRings.ResolvePoolRing(r.Context(), providerID)
			if rerr != nil {
				writeErr(w, http.StatusBadGateway, "upstream_error", rerr.Error())
				return
			}
			ring.ServeAuthorized(w, r)
			return
		}
		if last := i == len(chain)-1; last && time.Now().After(deadline) {
			writeErr(w, http.StatusGatewayTimeout, "upstream_timeout",
				"hub tried every account that can serve this model")
			return
		}
		up, uerr := s.Resolver.ResolveUpstream(r.Context(), src.ProviderID, src.Account)
		if uerr == nil && up != nil && strings.TrimSpace(up.CatalogScope) == "" {
			up.CatalogScope = proxy.AccountCatalogScope(src.ProviderID, src.Account)
		}
		if uerr != nil {
			// An unresolvable member (deleted account, stale snapshot) must
			// not poison the turn: skip it and let a healthy candidate serve.
			// Failover below only covers quota refusals, so without this one
			// ghost entry fails every request routed through the hub.
			dead = append(dead, src.ProviderID+"/"+src.Account+": "+uerr.Error())
			log.Printf("hub %s: skipping unresolvable source %s/%s: %s",
				cfg.Name, src.ProviderID, src.Account, uerr)
			continue
		}
		attempt := r.Clone(r.Context())
		if body != nil {
			attempt.Body = io.NopCloser(bytes.NewReader(body))
		}
		// Only an account step is metered here; a pool step meters each
		// member inside its own ring, and metering both would count twice.
		metered, finish := proxy.MeterUsage(w, observe.RouteHub, src.ProviderID, src.Account, requestedModel)
		writer := newAttemptWriter(metered)
		proxy.Serve(writer, attempt, up)
		finish()
		if writer.committedResponse() {
			if s.Quotas != nil {
				s.Quotas.clear(keyOf(*cfg, index))
			}
			return
		}
		quotaFailure := isQuotaRefusal(writer.statusCode(), writer.headerValue, writer.bodyPreview(), up.QuotaErrorPatterns)
		if i == len(chain)-1 || !quotaFailure {
			writer.replay()
			return
		}
		if s.Quotas != nil {
			retryAfter := upstream.ParseRetryAfter(writer.headerValue("Retry-After"), time.Now())
			s.Quotas.exhaust(keyOf(*cfg, index), retryAfter)
		}
	}
	// Every candidate failed to resolve (deleted accounts, stale snapshots):
	// name them so the client sees which hub entries rotted, not a bare 502.
	writeErr(w, http.StatusBadGateway, "upstream_error",
		fmt.Sprintf("no hub source could serve this request (%s)", strings.Join(dead, "; ")))
}

// candidateChain is the ordered list of sources this request may use.
//
// Rotation starts at the cursor and walks the eligible accounts; failover keeps
// the resolved source first and treats the rest as a fallback for quota
// refusals. Cooling accounts are dropped, unless every candidate is cooling —
// then the policy either tries the soonest-to-recover one alone or refuses.
func (s *Server) candidateChain(cfg *Config, resolved int, requestedModel string) []int {
	capable := make([]int, 0, len(cfg.Sources))
	for i, src := range cfg.Sources {
		if !src.IsEnabled() {
			continue
		}
		if i == resolved || src.ProviderID == cfg.Sources[resolved].ProviderID ||
			s.providerServes(src.ProviderID, requestedModel) {
			capable = append(capable, i)
		}
	}
	if len(capable) == 0 {
		if cfg.Sources[resolved].IsEnabled() {
			capable = append(capable, resolved)
		} else {
			return nil
		}
	}
	if cfg.SpreadsRequests() {
		// Rotate within the capable set, so consecutive requests start at
		// consecutive accounts.
		step := int(s.rotation.next(rotationKey(requestedModel, cfg.Sources[resolved].ProviderID)) % uint64(len(capable)))
		capable = append(append([]int{}, capable[step:]...), capable[:step]...)
	} else {
		capable = moveFirst(capable, resolved)
		if cfg.Strategy == StrategySoonestReset {
			capable = s.bySoonestReset(cfg, capable)
		}
	}
	if s.Quotas == nil {
		return capable
	}
	eligible, cooling := s.Quotas.partition(cfg, capable)
	if len(eligible) > 0 {
		return eligible
	}
	if !s.Quotas.servesWhenAllCooling() {
		return nil
	}
	// Every candidate is cooling: try the one that recovers first and let its
	// verdict reach the caller. One attempt only — the ring walks for a
	// different reason (a fresh pick per account), and repeating a verdict the
	// caller can already read spends the request's whole budget.
	soonest := s.Quotas.soonestToRecover(keysOf(*cfg, cooling))
	for _, index := range cooling {
		if keyOf(*cfg, index) == soonest {
			return []int{index}
		}
	}
	return nil
}

// bySoonestReset stable-sorts sources so the one whose unused quota resets
// soonest leads. Sources with no reading keep failover order after the rest,
// so a hub with an empty cache behaves exactly like failover.
func (s *Server) bySoonestReset(cfg *Config, list []int) []int {
	if s.NextReset == nil || len(list) < 2 {
		return list
	}
	keys := make(map[int]int64, len(list))
	for _, index := range list {
		src := cfg.Sources[index]
		keys[index] = s.NextReset(src.ProviderID, src.Account)
	}
	out := append([]int(nil), list...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := keys[out[i]], keys[out[j]]
		switch {
		case a == 0:
			return false
		case b == 0:
			return true
		default:
			return a < b
		}
	})
	return out
}

// moveFirst puts index at the head, preserving the order of the rest.
func moveFirst(list []int, index int) []int {
	out := make([]int, 0, len(list))
	out = append(out, index)
	for _, item := range list {
		if item != index {
			out = append(out, item)
		}
	}
	return out
}

func keysOf(cfg Config, indexes []int) []string {
	keys := make([]string, 0, len(indexes))
	for _, index := range indexes {
		keys = append(keys, keyOf(cfg, index))
	}
	return keys
}

// isQuotaRefusal reports whether a vendor response blames the credential rather
// than the request. It checks standard quota classifications as well as
// provider-declared QuotaErrorPatterns.
func isQuotaRefusal(status int, headerValue func(string) string, bodyPreview string, patterns []string) bool {
	if status == 401 || status == 402 {
		return true
	}
	if upstream.IsInsufficientBalanceFailure(status, bodyPreview) {
		return true
	}
	if upstream.IsCredentialQuotaFailure(status, headerValue, bodyPreview) {
		return true
	}
	return upstream.MatchesQuotaErrorPattern(patterns, bodyPreview)
}

// poolSourceProvider reports whether the source references a provider pool and
// returns that provider id.
// PoolSourceAccount is the source account value that delegates to a provider's
// multi-account credential ring. Writer and reader must agree on this string or
// a pool source silently becomes an account named "pool:<provider>".
func PoolSourceAccount(providerID string) string { return poolSourcePrefix + providerID }

const poolSourcePrefix = "pool:"

// DefaultChainBudget bounds one hub request across accounts before it commits a
// response. Like the pool ring's budget (ADR 0024) it governs queuing and
// failover, never a stream that already started.
const DefaultChainBudget = 2 * time.Minute

// PoolSourceProvider reports whether the source references a provider pool and
// returns that provider id.
func PoolSourceProvider(src Source) (string, bool) {
	if !strings.HasPrefix(src.Account, poolSourcePrefix) || len(src.Account) == len(poolSourcePrefix) {
		return "", false
	}
	return strings.TrimPrefix(src.Account, poolSourcePrefix), true
}

func poolSourceProvider(src Source) (string, bool) {
	return PoolSourceProvider(src)
}

// routeModelEntry resolves a requested model against the route's pinning
// table. It is the only lookup: source selection and model remapping must
// agree, or a route can send a request to one source under another source's
// model id. Duplicate pins for the same model are a data error; they resolve
// to the first entry for both halves of the decision rather than letting each
// half pick its own.
func routeModelEntry(route *Route, model string) (ModelRoute, bool) {
	for _, m := range route.Models {
		if m.Model == model {
			return m, true
		}
	}
	return ModelRoute{}, false
}

// ResolveOwnerIndex maps a pin to its position in the current source list.
// Value pins resolve by owner identity; legacy positional pins resolve
// bounds-checked. -1 means the pin names nothing attached: callers fall
// back to default resolution (serve) or render it missing (preview), never
// a neighboring source.
func ResolveOwnerIndex(sources []Source, entry ModelRoute) int {
	if entry.Owner != "" {
		for i, src := range sources {
			if ownerOf(src) == entry.Owner {
				return i
			}
		}
		return -1
	}
	if entry.SourceIndex >= 0 && entry.SourceIndex < len(sources) {
		return entry.SourceIndex
	}
	return -1
}

// rewriteModel applies the route's model remap to a request body. It
// re-encodes only when the pin actually remaps the model, and returns the
// original bytes unchanged otherwise or when the body will not survive the
// round trip.
func rewriteModel(body []byte, route *Route, model string) []byte {
	entry, ok := routeModelEntry(route, model)
	if !ok || entry.UpstreamModel == "" || entry.UpstreamModel == model {
		return body
	}
	out, ok := rewriteModelField(body, entry.UpstreamModel)
	if !ok {
		return body
	}
	return out
}

// rewriteModelField relabels the top-level "model" field.
//
// It decodes with UseNumber. Unmarshalling into interface{} turns every JSON
// number into a float64, so re-marshalling rewrites large integers that cannot
// survive the round trip — a proxy has no business changing numbers it was
// only asked to relabel.
func rewriteModelField(body []byte, upstreamModel string) ([]byte, bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var doc map[string]interface{}
	if dec.Decode(&doc) != nil {
		return nil, false
	}
	doc["model"] = upstreamModel
	out, err := json.Marshal(doc)
	if err != nil {
		return nil, false
	}
	return out, true
}

func parseIndex(model string) int {
	n := 0
	for i := 1; i < len(model); i++ {
		if model[i] < '0' || model[i] > '9' {
			return -1
		}
		n = n*10 + int(model[i]-'0')
	}
	if len(model) <= 1 {
		return -1
	}
	return n
}

// providerServes reports whether the provider's catalogs advertise the model.
// An empty catalog or an empty model is a miss: guessing here would send a
// request to a vendor that cannot answer it.
func (s *Server) providerServes(providerID, model string) bool {
	if s.ModelsForProvider == nil || model == "" {
		return false
	}
	for _, id := range s.ModelsForProvider(providerID) {
		if id == model {
			return true
		}
	}
	return false
}

// rotationKey names the counter a candidate set uses. Rotation is per requested
// model, so two models served by different account sets do not consume each
// other's turns; the provider is part of the key because the fallback set is the
// provider's accounts.
func rotationKey(model, providerID string) string {
	if model == "" {
		return providerID
	}
	return providerID + "\x00" + model
}

// rotationCursor hands out a per-provider turn per request. A single hub-wide
// counter would be simpler but not round-robin: requests for other providers
// interleave and consume turns, so a provider's accounts would drift apart
// whenever its request rate differs from the rest of the hub.
type rotationCursor struct {
	mu      sync.Mutex
	cursors map[string]*atomic.Uint64
}

func (c *rotationCursor) next(providerID string) uint64 {
	c.mu.Lock()
	counter, ok := c.cursors[providerID]
	if !ok {
		if c.cursors == nil {
			c.cursors = map[string]*atomic.Uint64{}
		}
		counter = new(atomic.Uint64)
		c.cursors[providerID] = counter
	}
	c.mu.Unlock()
	return counter.Add(1) - 1
}

func defaultSourceIndex(cfg *Config) int {
	if len(cfg.Sources) == 0 {
		return -1
	}
	return 0
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	payload, _ := json.Marshal(map[string]interface{}{
		"error": map[string]string{"type": code, "message": message},
	})
	_, _ = w.Write(payload)
}

type tcpAddr = net.TCPAddr

func listenLoopback(host string, port int) (net.Listener, error) {
	// Start checks too. The bind itself refuses a non-loopback host so a
	// future caller cannot skip the check (ADR 0006 §5).
	if err := proxy.AssertLoopbackHost(host); err != nil {
		return nil, err
	}
	return net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(port)))
}

type shutdownAdapter struct{ srv *http.Server }

func (a shutdownAdapter) Shutdown() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.srv.Shutdown(ctx)
}

// presentedToken mirrors the per-account server: Authorization Bearer or
// x-api-key. serveRoute tries both, because Claude Code sends its OAuth
// bearer and the route secret as x-api-key on the same request (ADR 0006).
func presentedToken(r *http.Request) string {
	bearer, apiKey := presentedHubCredentials(r)
	if bearer != "" {
		return bearer
	}
	return apiKey
}

func presentedHubCredentials(r *http.Request) (bearer, apiKey string) {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		bearer = strings.TrimSpace(auth[len("Bearer "):])
	}
	apiKey = strings.TrimSpace(r.Header.Get("x-api-key"))
	return bearer, apiKey
}

func (s *Server) routeForRequest(r *http.Request) (string, *Route, error) {
	bearer, apiKey := presentedHubCredentials(r)
	if route, err := s.lookupRouteToken(bearer); route != nil || err != nil {
		return bearer, route, err
	}
	if apiKey != bearer {
		if route, err := s.lookupRouteToken(apiKey); route != nil || err != nil {
			return apiKey, route, err
		}
	}
	return "", nil, nil
}

func (s *Server) lookupRouteToken(token string) (*Route, error) {
	if token == "" {
		return nil, nil
	}
	route, err := s.Store.RouteByToken(token)
	if err != nil || !routeAuthenticated(route, token) {
		return nil, err
	}
	return route, nil
}

// routeAuthenticated reports whether RouteByToken proved this bearer. The
// proof is the stored-digest compare inside the store. route.Token is only
// an echo of the presented bearer, so comparing the two is not a check.
func routeAuthenticated(route *Route, token string) bool {
	return route != nil && route.proven && token != "" && route.Token == token
}
