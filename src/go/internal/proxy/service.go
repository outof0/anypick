package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/store"
)

// StartResult is the subset of the proxy handle the activation flow consumes.
// Token is owner-only material (invariant #2): never print it, never put it
// in JSON output boundaries.
type StartResult struct {
	Endpoint   string
	Token      string
	LeaseID    string
	InstanceID string
	Port       int
	StartedNow bool
	// PortMovedFrom is the configured port this start could not bind because
	// another process held it; the proxy moved to Port and the persisted config
	// follows. 0 means the configured port was used.
	PortMovedFrom int
}

// Status describes a proxy's enablement and liveness.
type Status struct {
	Enabled       bool   `json:"enabled"`
	Running       bool   `json:"running"`
	Port          int    `json:"port,omitempty"`
	Host          string `json:"host,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	Compatibility string `json:"compatibility,omitempty"`
	PID           int    `json:"pid,omitempty"`
	LogPath       string `json:"logPath,omitempty"`
	Detail        string `json:"detail,omitempty"`
}

// Upstream describes where the builtin proxy forwards traffic.
// OpenAI is the primary surface; Anthropic is optional — when present, POST
// /v1/messages forwards natively instead of being translated.
type Upstream struct {
	BaseURL *url.URL
	Auth    string // credential injected into forwarded requests
	// ModelDiscovery is an optional provider-owned live catalog operation. It
	// keeps model-list wire formats next to the upstream that understands them;
	// the proxy service only coordinates the account-scoped refresh.
	ModelDiscovery func(context.Context) ([]string, error)
	// CatalogScope separates in-memory discovery caches for accounts that share
	// an upstream origin. It is an opaque, non-secret identity supplied by the
	// service and never crosses an output boundary.
	CatalogScope string
	// AuthHeader / AuthValuePrefix present the credential per the vendor's
	// scheme; empty = Authorization: Bearer.
	AuthHeader      string
	AuthValuePrefix string
	// AuthProvider, when set, supplies the live credential per request so the
	// proxy can refresh short-lived tokens (OIDC/OAuth) without a restart.
	// Static Auth is ignored while AuthProvider is non-nil. It must be safe to
	// call concurrently and may block on a token refresh.
	AuthProvider func(ctx context.Context) (string, error)
	// ExtraHeaders are injected into every forwarded request (vendor probes,
	// client-version pins). They never carry the credential. DynamicHeaders
	// covers provider-owned request metadata that must be fresh per request.
	ExtraHeaders []ExtraHeader
	// DynamicHeaders lets a provider add non-secret request metadata such as
	// correlation IDs. It runs once per outbound request and must not return
	// credentials.
	DynamicHeaders func(context.Context) ([]ExtraHeader, error)
	// Anthropic: native /v1/messages target. When nil and TranslateAnthropic
	// is set, messages requests are translated into chat completions instead.
	Anthropic *UpstreamTarget
	// TranslateAnthropic: upstream speaks OpenAI only; POST /v1/messages is
	// translated into chat completions.
	TranslateAnthropic bool
	// TranslateGemini: upstream is Google Gemini (generateContent), which is
	// neither OpenAI- nor Anthropic-compatible. POST /v1/chat/completions,
	// /v1/responses and /v1/messages are each translated to a Gemini
	// generateContent request and the response translated back. Gemini is the
	// outlier backend that needs a full translate-and-reissue egress, so it
	// gets its own branch rather than riding TranslateAnthropic.
	TranslateGemini bool
	// OpenAIPath, when non-empty, is the upstream path serving the OpenAI
	// chat surface, joined onto the base path and REPLACING the inbound
	// /v1/chat/completions (or /v1/completions) path. Vendors whose
	// subscription channel lives under a versioned base (WorkBuddy: …/v2 +
	// /chat/completions) need this: plain reverse-proxy joining would send
	// …/v2/v1/chat/completions, which the vendor reads as an API-key
	// channel call and rejects (WorkBuddy code 11128). Empty keeps the
	// default join for vendors whose base carries no version segment.
	OpenAIPath string
	// SanitizeOpenAIBody, when set, rewrites a verbatim-forwarded OpenAI
	// request body before egress (e.g. stripping Anthropic billing metadata
	// the vendor's filter rejects). Nil passes the body through untouched.
	SanitizeOpenAIBody func([]byte) []byte
	// SanitizeAnthropicBody, when set, rewrites a verbatim-forwarded native
	// Anthropic body (POST /v1/messages, /messages) before egress. Grok's
	// subscription endpoint validates strictly where Claude Code is loose
	// (e.g. `"required": null` in a tool schema where the spec wants an
	// array). Nil passes the body through untouched.
	SanitizeAnthropicBody func([]byte) []byte
	// Gemini carries the mode-specific egress facts (api-key vs OAuth/code
	// assist) used by the serveGemini branch.
	Gemini *GeminiTarget
	// QuotaErrorPatterns: provider-declared regexes that mark a failure as
	// quota-class for pool failover. Empty → classification falls back to the
	// built-in 401/402/balance/credential-quota rules only.
	QuotaErrorPatterns []string
	// MapModel, when set, translates an inbound client model name (such as
	// a native Codex alias slug like gpt-5.6-sol) into the upstream provider's
	// concrete model identifier.
	MapModel func(string) string
}

// GeminiTarget holds the Gemini-specific egress facts consumed by serveGemini.
// It is the Gemini analogue of UpstreamTarget: provider-owned, never inferred
// from a generic flag.
type GeminiTarget struct {
	// APIKeyMode: true → call generativelanguage.googleapis.com with the
	// x-goog-api-key header (static key from Auth or AuthProvider). false →
	// call the Code Assist upstream with Authorization: Bearer + the
	// {model, project, session_id} envelope (OAuth).
	APIKeyMode bool
	// APIKeyBase overrides the API-key upstream; defaults to the Google
	// endpoint.
	APIKeyBase *url.URL
	// CodeAssistBase is the OAuth upstream (cloudcode-pa.googleapis.com or
	// daily-cloudcode-pa.googleapis.com). Ignored in APIKeyMode.
	CodeAssistBase *url.URL
	// IDEType is the ClientMetadata.ideType sent to loadCodeAssist, and
	// UserAgent is the client identity Code Assist gates on. Both come from
	// the OAuth profile that owns the credential: the endpoint rejects an
	// ideType that does not match the client (it answers 400 for the
	// historical "GEMINI"), and without the Antigravity User-Agent the same
	// credential gets 403 SUBSCRIPTION_REQUIRED on generateContent.
	IDEType   string
	UserAgent string
	// AltRoute, when set on an OAuth target, is the secondary Code Assist
	// identity retried once on 401/403/404 (gemini-cli ↔ antigravity
	// failover). The engine's multi-account pool also covers this, but AltRoute
	// lets one account carry both credentials.
	AltRoute *GeminiAltRoute
}

// GeminiAltRoute is the secondary OAuth identity used by auto auth fallback.
type GeminiAltRoute struct {
	CodeAssistBase *url.URL
	AuthProvider   func(ctx context.Context) (string, error)
	// IDEType / UserAgent mirror GeminiTarget: the alternate identity is a
	// different OAuth client and must present as one.
	IDEType   string
	UserAgent string
}

// UpstreamTarget is one protocol-specific forwarding target.
type UpstreamTarget struct {
	BaseURL         *url.URL
	Auth            string // empty → inherit Upstream.Auth
	AuthHeader      string // empty → Authorization
	AuthValuePrefix string // empty → "Bearer "
	// AuthProvider overrides the parent Upstream.AuthProvider for this target.
	AuthProvider func(ctx context.Context) (string, error)
	// ExtraHeaders are injected into requests to this target, after the
	// parent Upstream.ExtraHeaders.
	ExtraHeaders []ExtraHeader
}

// ExtraHeader is a static header forwarded to the upstream on every request
// (vendor probes, client-version pins). It must never carry the credential.
// Drop removes an inbound header of the same name instead of setting one:
// WorkBuddy's custom-model client already sends X-Agent-Intent: craft, and
// forwarding that (or overwriting it with craft) puts the subscription API
// into its write-agent loop.
type ExtraHeader struct {
	Name  string
	Value string
	Drop  bool
}

// UpstreamResolver lets each provider own its forwarding target without the
// proxy package importing providers (core must not grow per-provider branches).
type UpstreamResolver interface {
	ResolveUpstream(ctx context.Context, providerID, accountName string) (*Upstream, error)
}

// StartupUpstreamResolver reads an already-materialized snapshot and does not
// take the provider lock. ServeExisting uses it. The parent holds that lock
// until /health returns, so a locking read in the child deadlocks the start.
type StartupUpstreamResolver interface {
	ResolveStartupUpstream(ctx context.Context, providerID, accountName string) (*Upstream, error)
}

// Spawner launches a detached child that serves the proxy after this process
// exits. nil → in-process serving, used by library consumers and tests.
type Spawner func(providerID, account string, st store.ProxyRuntimeState, logPath string) (pid int, err error)

// PoolSpawner launches a detached `_serve-pool` child for a provider pool.
type PoolSpawner func(providerID string) (pid int, err error)

// Service manages per-account builtin proxies. State persists in proxy_state
// + proxy_leases so crashes leave recoverable records; every start runs under
// sorted scope locks (ADR 0009); ownership across processes is proven through
// an unauthenticated /health echo of the per-instance id (PROC-01) — a stale
// pid record must never adopt someone else's process.
type Service struct {
	Store    *store.AccountStore
	Jobs     *LeaseStore
	Resolver UpstreamResolver
	// Spawner enables detached-child mode. Composition wires ExecSpawner;
	// nil keeps everything in-process.
	Spawner Spawner
	// PoolSpawner enables detached `_serve-pool` children; nil keeps pools
	// in-process (tests/library).
	// RotateLockTimeout is RotateToken's acquisition budget for its mutation
	// scopes. The 5s default is sized for a single write; a rotation that has
	// to stop and restart a proxy legitimately takes longer, and timing out
	// would leave the caller holding a token the listener does not serve. A
	// field so a test can shorten it without a mutable package var becoming a
	// data race the day this package grows a t.Parallel().
	RotateLockTimeout time.Duration
	PoolSpawner       PoolSpawner
	// QuotaGuardPolicy reads the validated quota-guard settings; nil → the
	// policy defaults (disabled, 60-minute cooldown, keep serving when every
	// member is cooling).
	QuotaGuardPolicy func(ctx context.Context) config.QuotaGuardPolicy
	// DefaultPort returns a provider's advertised default proxy port; 0 when
	// unknown or unwired. Composition-root wiring only — core proxy never
	// imports providers (capability routing lives in the adapters,
	// invariant #1).
	DefaultPort func(providerID string) int
	// Pools owns the pools table; required for pool lifecycle methods.
	Pools *pools.Store

	servers     *registry
	poolServers *poolServerRegistry
	// hubRings keeps the ring a hub pool source serves through, so its
	// round-robin position survives from one hub request to the next.
	hubRingsMu sync.Mutex
	hubRings   map[string]hubRing

	heartbeatMu sync.Mutex
	heartbeats  map[string]context.CancelFunc
}

// ProxyConfig reads the persisted proxy settings for one account. The table
// belongs to internal/store; outer layers ask the service so a proxy setting is
// never reached by holding a handle on the table-owning store.
func (s *Service) ProxyConfig(ctx context.Context, providerID, name string) (store.ProxyConfig, error) {
	return s.Store.GetProxyConfig(ctx, providerID, name)
}

// accountCatalogScope names one account's provider-local catalog so two
// accounts on the same upstream origin cannot serve each other's entitlements.
func accountCatalogScope(providerID, accountName string) string {
	return "account/" + providerID + "/" + accountName
}

// AccountCatalogScope names one account so two accounts that share an
// upstream origin do not share a Gemini cooldown or a catalog cache.
func AccountCatalogScope(providerID, accountName string) string {
	return accountCatalogScope(providerID, accountName)
}

// DiscoverModels resolves one saved account and asks its provider-owned
// upstream for the current model ids. Credentials stay inside the resolver
// and callback; callers receive model ids only. The scope prevents Gemini's
// process-local catalog from leaking entitlements between two accounts that
// use the same Code Assist origin.
func (s *Service) DiscoverModels(ctx context.Context, providerID, accountName string) ([]string, error) {
	if s == nil || s.Resolver == nil {
		return nil, errors.New("proxy upstream resolver unavailable")
	}
	up, err := s.Resolver.ResolveUpstream(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}
	if up == nil {
		return nil, errors.New("proxy upstream unavailable")
	}
	up.CatalogScope = accountCatalogScope(providerID, accountName)
	return DiscoverModels(ctx, up)
}

// RuntimeState reads the persisted runtime state of a running proxy, nil when
// nothing is recorded. Same boundary as ProxyConfig: a caller that wants to
// know what a proxy is doing asks the service, not the table.
func (s *Service) RuntimeState(ctx context.Context, providerID, name string) (*store.ProxyRuntimeState, error) {
	return s.Store.ReadProxyState(ctx, providerID, name)
}

// RotateToken replaces the proxy's authentication token with a freshly minted
// secret. If the proxy is currently running, it is stopped and restarted so the
// new secret takes effect immediately.
//
// The read-modify-write of proxy_state runs under the same scopes as Configure:
// proxy_state is the only copy of the bearer, so a concurrent start that
// samples the row before the rotation and writes it back afterwards would leave
// the listener serving the pre-rotation secret while the caller is handed the
// new one (ADR 0009, invariant 5). Stop and StartProxy re-enter these scopes
// through the closure's context.
func (s *Service) RotateToken(ctx context.Context, providerID, accountName string) (string, error) {
	acc, err := s.Store.Get(ctx, providerID, accountName)
	if err != nil {
		return "", err
	}
	if acc == nil {
		return "", anyerr.Newf("Account "+providerID+"/"+accountName+" does not exist", "ACCOUNT_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound))
	}
	newToken, err := NewToken()
	if err != nil {
		return "", anyerr.Wrapf(err, "generate proxy token", "PROXY_ROTATE_FAILED")
	}
	err = lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), proxyScope(providerID, accountName), poolScope(providerID),
	}, func(c context.Context) error {
		// The pool's key lives on its primary member's row. Restarting that
		// row as an account proxy would replace the running pool with a
		// single-account listener, so the pool is restarted as a pool, serving
		// the rotated key.
		pooled, perr := s.poolOwnsRow(c, providerID, accountName)
		if perr != nil {
			return perr
		}
		if pooled {
			_, err := s.startPoolLockedWithToken(c, providerID, newToken)
			return err
		}
		st, serr := s.StatusContext(c, providerID, accountName)
		wasRunning := serr == nil && st != nil && st.Running
		if wasRunning {
			if err := s.Stop(c, providerID, accountName); err != nil {
				return err
			}
		}
		prior, _ := s.Store.ReadProxyState(c, providerID, accountName)
		state := store.ProxyRuntimeState{AccountName: accountName}
		if prior != nil {
			state = *prior
		}
		state.Token = newToken
		if err := s.Store.WriteProxyStateContext(c, providerID, accountName, state); err != nil {
			return err
		}
		if wasRunning {
			if _, err := s.StartProxy(c, providerID, accountName); err != nil {
				return err
			}
		}
		return nil
	}, s.rotateTimeout())
	if err != nil {
		return "", err
	}
	return newToken, nil
}

// GetPoolContext returns the pool config for a provider, nil when none is
// configured. The pools table belongs to internal/pools; outer layers ask the
// service instead of reaching through the raw store the service owns.
func (s *Service) GetPoolContext(ctx context.Context, providerID string) (*pools.Pool, error) {
	if s.Pools == nil {
		return nil, nil
	}
	return s.Pools.GetContext(ctx, providerID)
}

// HasPools reports whether this Service owns a pools table. The CLI/desktop use
// it to guard pool-lifecycle calls instead of reading the raw field (which the
// facade ratchet would keep counting as "Deps.Proxy.Pools").
func (s *Service) HasPools() bool {
	return s.Pools != nil
}

// ListPoolLeasesContext returns the NULL-account leases for a provider's shared
// pool. The lease table belongs to internal/proxy; outer layers ask the service
// instead of reaching through the raw store the service owns ("Deps.Proxy.Jobs").
func (s *Service) ListPoolLeasesContext(ctx context.Context, providerID string) ([]*Lease, error) {
	return s.Jobs.ListPoolLeasesContext(ctx, providerID)
}

// ListLeasesByAccountContext answers "does any live lease still reference this
// provider/account?" for the doctor's orphan-proxy guard. It exists so a caller
// outside this package never needs the lease store handle itself (the facade
// gate forbids reaching through to it).
func (s *Service) ListLeasesByAccountContext(ctx context.Context, providerID, accountName string) ([]*Lease, error) {
	if s.Jobs == nil {
		return nil, nil
	}
	return s.Jobs.ListByAccountContext(ctx, providerID, accountName)
}

// ReapStaleContext drops leases whose owning process is no longer live. Lives on
// the service so startup maintenance never holds the raw lease store.
func (s *Service) ReapStaleContext(ctx context.Context) (int, error) {
	return s.Jobs.ReapStaleContext(ctx)
}

func New(st *store.AccountStore, leases *LeaseStore) *Service {
	return &Service{
		Store: st, Jobs: leases, servers: newRegistry(), poolServers: newPoolServerRegistry(),
		heartbeats: map[string]context.CancelFunc{},
	}
}

// Close shuts down every in-process server this Service owns. Detached
// children are intentionally left running: their leases keep them recoverable.
// Idempotent — safe to call from app.Close on every exit path.
func (s *Service) Close() {
	s.heartbeatMu.Lock()
	for leaseID, cancel := range s.heartbeats {
		cancel()
		delete(s.heartbeats, leaseID)
	}
	s.heartbeatMu.Unlock()
	for _, srv := range s.servers.removeAll() {
		_ = srv.Close()
	}
	for _, srv := range s.poolServers.removeAll() {
		_ = srv.Close()
	}
}

const healthTimeout = 5 * time.Second

// rotateTimeout returns RotateToken's acquisition budget, defaulting when the
// composition left the field unset (tests and library callers construct
// Service literals directly).
func (s *Service) rotateTimeout() time.Duration {
	if s.RotateLockTimeout == 0 {
		return 30 * time.Second
	}
	return s.RotateLockTimeout
}

// Configure updates one account's proxy preference under the same scopes used
// by start/stop. A zero port asks the kernel for a free loopback port when
// enabling; disabled configurations may keep zero as their auto-port choice.
func (s *Service) Configure(
	ctx context.Context,
	providerID, accountName string,
	enabled bool,
	port int,
) (store.ProxyConfig, error) {
	if port < 0 || port > 65535 {
		return store.ProxyConfig{}, anyerr.Newf(
			"proxy port must be between 0 and 65535",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage),
		)
	}
	var result store.ProxyConfig
	err := lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), proxyScope(providerID, accountName),
	}, func(c context.Context) error {
		cfg, err := s.Store.GetProxyConfig(c, providerID, accountName)
		if err != nil {
			return err
		}
		cfg.Enabled = enabled
		if port != 0 {
			cfg.Port = port
		}
		if cfg.Enabled && cfg.Port == 0 {
			cfg.Port, err = PickFreePort()
			if err != nil {
				return anyerr.Wrapf(err, "pick port", "PROXY_START_FAILED")
			}
		}
		if err := s.Store.SetProxyConfigContext(c, providerID, accountName, cfg); err != nil {
			return err
		}
		result = cfg
		return nil
	}, 0)
	return result, err
}

// StartProxy starts (or reuses) the builtin proxy for an account under
// [providerScope, proxy/<p>/<a>] locks. Reuse requires the persisted instance
// id to match the running server — a stale pid record must never adopt
// someone else's process (PROC-01).
func (s *Service) StartProxy(ctx context.Context, providerID, accountName string) (*StartResult, error) {
	var result *StartResult
	err := lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), proxyScope(providerID, accountName),
	}, func(c context.Context) error {
		r, runErr := s.startLocked(c, providerID, accountName)
		if runErr != nil {
			return runErr
		}
		result = r
		return nil
	}, 0)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) startLocked(ctx context.Context, providerID, accountName string) (*StartResult, error) {
	account, err := s.Store.Get(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}
	if account == nil {
		return nil, anyerr.Newf(
			fmt.Sprintf(`No account "%s" for provider "%s".`, accountName, providerID),
			"ACCOUNT_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound))
	}

	if existing, ok := s.servers.get(providerID, accountName); ok {
		state, stateErr := s.Store.ReadProxyState(ctx, providerID, accountName)
		if stateErr != nil {
			return nil, stateErr
		}
		if state != nil && state.InstanceID == existing.InstanceID {
			return &StartResult{
				Endpoint: existing.Endpoint, Token: existing.Token,
				InstanceID: existing.InstanceID, Port: portOf(existing.Endpoint),
				StartedNow: false,
			}, nil
		}
		// Stale registry entry — drop it.
		_ = existing.Close()
		_, _ = s.servers.remove(providerID, accountName)
	}

	// Cross-process reuse: a detached child from an earlier invocation may
	// still be healthy. Adopt only when /health echoes OUR recorded instance
	// id — never trust the pid alone (PROC-01).
	state, err := s.Store.ReadProxyState(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}
	if state != nil && state.Endpoint != "" && state.InstanceID != "" &&
		state.Token != "" {
		if live := healthInstance(state.Endpoint); live == state.InstanceID {
			return &StartResult{
				Endpoint: state.Endpoint, Token: state.Token,
				InstanceID: state.InstanceID, Port: portOf(state.Endpoint),
				StartedNow: false,
			}, nil
		}
	}

	originalCfg := account.Proxy
	cfg := originalCfg
	if !cfg.Enabled {
		cfg.Enabled = true
	}
	if cfg.Port == 0 {
		port, perr := PickFreePort()
		if perr != nil {
			return nil, anyerr.Wrapf(perr, "pick port", "PROXY_START_FAILED")
		}
		cfg.Port = port
	}
	host := cfg.Host
	if host == "" {
		host = "127.0.0.1"
	}
	if err := AssertLoopbackHost(host); err != nil {
		return nil, err
	}
	port := cfg.Port
	// A configured port can be held by another process — most often a proxy
	// child that survived a force-killed app, since detached children are
	// setsid and outlive their parent. Refusing to start would strand the
	// account and every client pointed at it; moving to a free port keeps the
	// account usable, and the activation that follows rewrites bound client
	// configs with the new endpoint.
	movedFrom := 0
	if !portBindable(host, port) {
		movedFrom = port
		picked, perr := PickFreePort()
		if perr != nil {
			return nil, anyerr.Wrapf(perr, "pick port", "PROXY_START_FAILED")
		}
		cfg.Port = picked
		port = picked
	}

	upstream, err := s.Resolver.ResolveUpstream(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}

	instanceID, err := NewInstanceID()
	if err != nil {
		return nil, anyerr.Wrapf(err, "generate instance id", "PROXY_START_FAILED")
	}
	// The bearer token is stable per account: it is persisted in proxy_state
	// and reused across restarts so client configs written once at
	// activation keep working. Only a first-ever start (or a state row
	// without one) mints a fresh token. Rotating here would 401 every
	// configured app until the next activation rewrote it.
	token := ""
	mintedFresh := false
	if state != nil {
		token = state.Token
	}
	if token == "" {
		mintedFresh = true
		token, err = NewToken()
		if err != nil {
			return nil, anyerr.Wrapf(err, "generate proxy token", "PROXY_START_FAILED")
		}
	}
	endpoint := fmt.Sprintf("http://%s:%d", normalizedLoopback(host), port)
	if err := s.Store.SetProxyConfigContext(ctx, providerID, accountName, cfg); err != nil {
		return nil, err
	}

	// Persist BEFORE spawning so the child can read its own credentials and
	// so a parent crash leaves a coherent record.
	st := store.ProxyRuntimeState{
		AccountName: accountName, Endpoint: endpoint,
		PID: 0, InstanceID: instanceID, StartedAt: nowISO(), Token: token,
	}
	if err := s.Store.WriteProxyStateContext(ctx, providerID, accountName, st); err != nil {
		cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, 0, "", originalCfg, mintedFresh)
		return nil, errors.Join(err, cleanupErr)
	}

	var pid int
	if s.Spawner != nil {
		logPath := paths.ProxyLogPath(s.Store.Root, providerID, accountName)
		pid, err = s.Spawner(providerID, accountName, st, logPath)
		if err != nil {
			cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, 0, "", originalCfg, mintedFresh)
			return nil, errors.Join(
				anyerr.Wrapf(err, "spawn proxy child", "PROXY_START_FAILED"),
				cleanupErr,
			)
		}
	} else {
		// In-process mode (tests/library).
		server := s.buildServer(providerID, accountName, instanceID, token, upstream)
		if err := server.Listen(host, port); err != nil {
			cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, 0, "", originalCfg, mintedFresh)
			return nil, errors.Join(err, cleanupErr)
		}
		if err := server.WaitReady(healthTimeout); err != nil {
			_ = server.Close()
			cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, 0, "", originalCfg, mintedFresh)
			return nil, errors.Join(err, cleanupErr)
		}
		s.servers.put(providerID, accountName, server)
		pid = ownPID()
	}

	// Ownership proof before declaring success: the server must echo OUR new
	// instance id, whatever process hosts it.
	if err := waitHealthInstance(endpoint, instanceID, healthTimeout); err != nil {
		cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, pid, "", originalCfg, mintedFresh)
		return nil, errors.Join(err, cleanupErr)
	}

	leaseID, lErr2 := NewInstanceID()
	if lErr2 != nil {
		// Lease is bookkeeping; proxy already healthy - don't tear it down.
		leaseID = instanceID
	}
	// Persist the serving pid before publishing a lease or returning success.
	st.PID = pid
	if err := s.Store.WriteProxyStateContext(ctx, providerID, accountName, st); err != nil {
		cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, pid, "", originalCfg, mintedFresh)
		return nil, errors.Join(err, cleanupErr)
	}

	if lErr := s.Jobs.CreateContext(ctx, Lease{
		LeaseID: leaseID, Provider: providerID, Account: accountName,
		Port: portOf(endpoint), Host: host, Endpoint: endpoint,
		OwnerPID: pid, InstanceID: instanceID,
	}); lErr != nil {
		cleanupErr := s.abortStart(ctx, providerID, accountName, instanceID, endpoint, pid, leaseID, originalCfg, mintedFresh)
		return nil, errors.Join(lErr, cleanupErr)
	}
	s.startLeaseHeartbeat(leaseID, instanceID, pid)

	return &StartResult{
		Endpoint: endpoint, Token: token,
		LeaseID: leaseID, InstanceID: instanceID,
		Port: portOf(endpoint), StartedNow: true,
		PortMovedFrom: movedFrom,
	}, nil
}

// abortStart compensates every mutation made by a failed start. The cleanup
// context retains the caller's held-lock identity while ignoring cancellation,
// so rollback can finish without racing another provider mutation.
// mintedFresh tells whether this attempt minted the bearer token: only then
// is the state row dropped outright. A reused stable token survives the abort
// because live client configs may still hold it.
func (s *Service) abortStart(
	ctx context.Context,
	providerID, accountName, instanceID, endpoint string,
	pid int,
	leaseID string,
	originalCfg store.ProxyConfig,
	mintedFresh bool,
) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*healthTimeout)
	defer cancel()

	var cleanupErrs []error
	stopped := true
	if server, ok := s.servers.get(providerID, accountName); ok && server.InstanceID == instanceID {
		_, _ = s.servers.remove(providerID, accountName)
		if err := server.Close(); err != nil {
			cleanupErrs = append(cleanupErrs, err)
			stopped = false
		}
	} else if s.Spawner != nil && pid > 0 && processAlive(pid) {
		if err := signalPID(pid); err != nil {
			cleanupErrs = append(cleanupErrs, err)
			stopped = false
		} else {
			deadline := time.Now().Add(healthTimeout)
			for time.Now().Before(deadline) && healthInstance(endpoint) == instanceID {
				time.Sleep(50 * time.Millisecond)
			}
			if healthInstance(endpoint) == instanceID {
				cleanupErrs = append(cleanupErrs, anyerr.Newf(
					"proxy process survived failed-start cleanup",
					"PROXY_STOP_FAILED",
				))
				stopped = false
			}
		}
	}

	if stopped {
		if leaseID != "" {
			s.stopLeaseHeartbeat(leaseID)
			cleanupErrs = append(cleanupErrs, s.Jobs.DeleteContext(cleanupCtx, leaseID))
		}
		if mintedFresh {
			// Never served with this token and nothing referenced it:
			// drop it outright instead of persisting a stillborn secret.
			cleanupErrs = append(
				cleanupErrs,
				s.Store.ClearProxyStateContext(cleanupCtx, providerID, accountName),
			)
		} else {
			// Release (not full clear): the token predates this attempt
			// and may still back live client configs.
			cleanupErrs = append(
				cleanupErrs,
				s.Store.ReleaseProxyRuntimeContext(cleanupCtx, providerID, accountName),
			)
		}
	}
	cleanupErrs = append(
		cleanupErrs,
		s.Store.SetProxyConfigContext(cleanupCtx, providerID, accountName, originalCfg),
	)
	return errors.Join(cleanupErrs...)
}

func (s *Service) buildServer(providerID, accountName, instanceID, token string, upstream *Upstream) *Server {
	return &Server{
		ProviderID:              providerID,
		AccountName:             accountName,
		InstanceID:              instanceID,
		Token:                   token,
		Upstream:                upstream.BaseURL,
		UpstreamAuth:            upstream.Auth,
		UpstreamAuthHeader:      upstream.AuthHeader,
		UpstreamAuthValuePrefix: upstream.AuthValuePrefix,
		UpstreamAuthProvider:    upstream.AuthProvider,
		UpstreamExtraHeaders:    upstream.ExtraHeaders,
		UpstreamDynamicHeaders:  upstream.DynamicHeaders,
		UpstreamModelDiscovery:  upstream.ModelDiscovery,
		CatalogScope:            accountCatalogScope(providerID, accountName),
		TranslateAnthropic:      upstream.TranslateAnthropic,
		Anthropic:               upstream.Anthropic,
		// TranslateGemini + Gemini must travel with the rest: a dropped flag
		// does not fail loudly, it silently downgrades egressKindFor to
		// passthrough, so POST /v1/chat/completions is forwarded verbatim to
		// daily-cloudcode-pa and Google answers an HTML 404 — a Gemini proxy
		// that starts, answers /health, and serves no traffic.
		TranslateGemini:       upstream.TranslateGemini,
		Gemini:                upstream.Gemini,
		OpenAIPath:            upstream.OpenAIPath,
		SanitizeOpenAIBody:    upstream.SanitizeOpenAIBody,
		SanitizeAnthropicBody: upstream.SanitizeAnthropicBody,
		MapModel:              upstream.MapModel,
	}
}

// Stop stops an account's proxy — in-process when hosted here, otherwise the
// detached child, but ONLY after /health proves the running instance is the
// one our state recorded (PROC-01).
func (s *Service) Stop(ctx context.Context, providerID, accountName string) error {
	var pid int
	err := lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), proxyScope(providerID, accountName),
	}, func(c context.Context) error {
		var serr error
		pid, serr = s.stopLocked(c, providerID, accountName)
		return serr
	}, 0)
	if err != nil {
		return err
	}
	// The child closes its listener, then takes these same locks to release
	// its runtime row. Waiting for the pid inside the callback deadlocks that
	// cleanup, so the wait starts only after the locks are released.
	return waitForProxyExit(pid, func() bool { return true }, 5*time.Second)
}

// ProxyRunning reports the verified liveness of one account proxy without
// exposing its token. It is deliberately a small adapter-facing method so
// accounts.Use can coordinate a switch without importing this package.
func (s *Service) ProxyRunning(ctx context.Context, providerID, accountName string) (bool, error) {
	status, err := s.StatusContext(ctx, providerID, accountName)
	if err != nil {
		return false, err
	}
	return status != nil && status.Running, nil
}

// StopProxyForSwitch stops an account proxy but preserves its enabled config.
// Manual Stop intentionally persists Enabled=false so auto-start will not
// resurrect it; account switching has different semantics and must be able to
// restore the previous account's listener during rollback or a later switch.
func (s *Service) StopProxyForSwitch(ctx context.Context, providerID, accountName string) error {
	var pid int
	err := lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), proxyScope(providerID, accountName),
	}, func(c context.Context) error {
		cfg, err := s.Store.GetProxyConfig(c, providerID, accountName)
		if err != nil {
			return err
		}
		var serr error
		pid, serr = s.stopLocked(c, providerID, accountName)
		if serr != nil {
			return serr
		}
		if !cfg.Enabled {
			return nil
		}
		return s.Store.SetProxyConfigContext(c, providerID, accountName, cfg)
	}, 0)
	if err != nil {
		return err
	}
	return waitForProxyExit(pid, func() bool { return true }, 5*time.Second)
}

// StartProxyIfEnabled is the account-switch counterpart of StartProxy. A
// saved account can exist with its proxy disabled; switching native auth must
// not silently turn that setting on just because another account was running.
func (s *Service) StartProxyIfEnabled(ctx context.Context, providerID, accountName string) error {
	cfg, err := s.Store.GetProxyConfig(ctx, providerID, accountName)
	if err != nil {
		return err
	}
	if !cfg.Enabled {
		return nil
	}
	_, err = s.StartProxy(ctx, providerID, accountName)
	return err
}

func (s *Service) stopLocked(ctx context.Context, providerID, accountName string) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*healthTimeout)
	defer cancel()

	if server, ok := s.servers.remove(providerID, accountName); ok {
		closeErr := server.Close()
		// Drop the runtime state and every lease as ONE SQLite transaction;
		// a half-landed cleanup would strand the survivors (ADR 0004 discipline).
		// The bearer token survives: client configs written at activation
		// hold it, so stop must not rotate it.
		clearErr := s.Store.ReleaseProxyRuntimeContext(cleanupCtx, providerID, accountName)
		return 0, errors.Join(closeErr, clearErr,
			s.disableProxyConfigIfSet(cleanupCtx, providerID, accountName))
	}

	state, err := s.Store.ReadProxyState(cleanupCtx, providerID, accountName)
	if err != nil {
		return 0, err
	}
	if state == nil {
		return 0, s.disableProxyConfigIfSet(cleanupCtx, providerID, accountName)
	}
	health := healthOwnership(state.Endpoint)
	if health.InstanceID != state.InstanceID {
		// Not ours / already dead: drop stale records atomically, keep token.
		return 0, errors.Join(
			s.Store.ReleaseProxyRuntimeContext(cleanupCtx, providerID, accountName),
			s.disableProxyConfigIfSet(cleanupCtx, providerID, accountName))
	}
	pid := health.PID
	if pid <= 0 {
		pid = state.PID
	}
	if pid == ownPID() {
		// In-process pool listeners are stored on this account's runtime row
		// but registered in poolServers, so the s.servers lookup above missed
		// them. Their /health pid is this process. Signaling it shuts down
		// the desktop service and kills a test that has not caught SIGTERM.
		if _, ok := s.poolServers.get(providerID); ok {
			return 0, s.stopPoolLocked(ctx, providerID, accountName)
		}
		return 0, anyerr.Newf(
			"proxy listener is in this process and was not closed",
			"PROXY_STOP_FAILED",
		)
	}
	signaled := 0
	if pid > 0 && processAlive(pid) {
		if err := signalPID(pid); err != nil {
			return 0, anyerr.Wrapf(err, "signal proxy child", "PROXY_STOP_FAILED")
		}
		signaled = pid
		// Health only. The process is still alive on purpose: its cleanup
		// takes the provider lock this caller still holds, so reaping it here
		// deadlocks. The caller waits once that lock is released.
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) &&
			healthInstance(state.Endpoint) == state.InstanceID {
			time.Sleep(100 * time.Millisecond)
		}
		if healthInstance(state.Endpoint) == state.InstanceID {
			return 0, anyerr.Newf(
				"proxy process did not stop after SIGTERM",
				"PROXY_STOP_FAILED",
			)
		}
	}
	// Listener is down. Drop the runtime state and every lease as ONE SQLite
	// transaction, so neither half can strand the other (ADR 0004 discipline).
	// The bearer token survives like every other stop path.
	return signaled, errors.Join(
		s.Store.ReleaseProxyRuntimeContext(cleanupCtx, providerID, accountName),
		s.disableProxyConfigIfSet(cleanupCtx, providerID, accountName))
}

// disableProxyConfigIfSet records Enabled=false (preserving port/host) so a
// stopped proxy stays stopped across proxy auto-start (PX1). No-op when
// already disabled, so stopping a never-configured account writes nothing.
func (s *Service) disableProxyConfigIfSet(ctx context.Context, providerID, accountName string) error {
	cfg, err := s.Store.GetProxyConfig(ctx, providerID, accountName)
	if err != nil {
		return err
	}
	if !cfg.Enabled {
		return nil
	}
	cfg.Enabled = false
	return s.Store.SetProxyConfigContext(ctx, providerID, accountName, cfg)
}

func (s *Service) cleanupLeases(providerID, accountName, instanceID string) error {
	return s.cleanupLeasesContext(context.Background(), providerID, accountName, instanceID)
}

func (s *Service) cleanupLeasesContext(ctx context.Context, providerID, accountName, instanceID string) error {
	leases, lErr := s.Jobs.ListByAccountContext(ctx, providerID, accountName)
	if lErr != nil {
		return lErr
	}
	for _, l := range leases {
		if l.InstanceID == instanceID {
			if err := func() error {
				s.stopLeaseHeartbeat(l.LeaseID)
				return s.Jobs.DeleteContext(ctx, l.LeaseID)
			}(); err != nil {
				return err
			}
		}
	}
	return nil
}

// StopIfLeaseOwned stops only when the caller presents the instance id this
// activation created.
func (s *Service) StopIfLeaseOwned(ctx context.Context, providerID, accountName, instanceID, leaseID string) error {
	if instanceID == "" {
		return nil
	}
	var pid int
	err := lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), proxyScope(providerID, accountName),
	}, func(c context.Context) error {
		if server, ok := s.servers.get(providerID, accountName); ok && server.InstanceID == instanceID {
			var serr error
			pid, serr = s.stopLocked(c, providerID, accountName)
			return serr
		}
		// Detached child: stop only when the recorded instance matches.
		state, err := s.Store.ReadProxyState(c, providerID, accountName)
		if err != nil {
			return err
		}
		if state != nil && state.InstanceID == instanceID {
			var serr error
			pid, serr = s.stopLocked(c, providerID, accountName)
			return serr
		}
		if leaseID != "" {
			s.stopLeaseHeartbeat(leaseID)
			return s.Jobs.DeleteContext(c, leaseID)
		}
		return nil
	}, 0)
	if err != nil {
		return err
	}
	return waitForProxyExit(pid, func() bool { return true }, 5*time.Second)
}

// Status reports enablement and liveness without ever exposing the token.
// Liveness crosses processes through the instance echo, never the pid alone.
func (s *Service) Status(providerID, accountName string) (*Status, error) {
	return s.StatusContext(context.Background(), providerID, accountName)
}

func (s *Service) StatusContext(ctx context.Context, providerID, accountName string) (*Status, error) {
	cfg, err := s.Store.GetProxyConfig(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}
	out := &Status{Enabled: cfg.Enabled}
	if server, ok := s.servers.get(providerID, accountName); ok {
		out.Running = true
		out.Endpoint = server.Endpoint
		out.Port = portOf(server.Endpoint)
		out.PID = ownPID()
		return out, nil
	}
	state, err := s.Store.ReadProxyState(ctx, providerID, accountName)
	if err != nil {
		return nil, err
	}
	if state != nil && state.Endpoint != "" {
		health := healthOwnership(state.Endpoint)
		if health.InstanceID != state.InstanceID {
			return out, nil
		}
		out.Running = true
		out.Endpoint = state.Endpoint
		out.Port = portOf(state.Endpoint)
		out.PID = health.PID
		if out.PID <= 0 {
			out.PID = state.PID
		}
	}
	return out, nil
}

// waitForProxyExit blocks until /health has stopped echoing our instance and
// the child pid is gone. Stop used to return at the first condition. The
// process can still be writing the data directory after the listener closes.
func waitForProxyExit(pid int, healthGone func() bool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if healthGone() && (pid <= 0 || !processAlive(pid)) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return anyerr.Newf(
				"proxy process did not stop after SIGTERM",
				"PROXY_STOP_FAILED",
			)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// healthInstance returns the instanceId a live proxy echoes on its
// unauthenticated /health route; "" when unreachable or different-shaped.
func healthInstance(endpoint string) string {
	return healthOwnership(endpoint).InstanceID
}

type proxyHealth struct {
	InstanceID string `json:"instanceId"`
	PID        int    `json:"pid"`
}

func healthOwnership(endpoint string) proxyHealth {
	client := egress.NewClient(750 * time.Millisecond)
	resp, err := client.Get(strings.TrimSuffix(endpoint, "/") + "/health")
	if err != nil {
		return proxyHealth{}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if err != nil || resp.StatusCode != http.StatusOK {
		return proxyHealth{}
	}
	var payload proxyHealth
	if json.Unmarshal(raw, &payload) != nil {
		return proxyHealth{}
	}
	return payload
}

// waitHealthInstance polls until /health echoes want or the timeout expires.
func waitHealthInstance(endpoint, want string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if got := healthInstance(endpoint); got == want {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return anyerr.Newf("proxy did not become healthy at "+endpoint, "PROXY_START_FAILED")
}

func portOf(endpoint string) int {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return 0
	}
	// Schemeless "127.0.0.1:41401" (dynamic assignment, PX6) never parses as
	// a URL: split host:port instead. Bracketed IPv6 ("[::1]:5150") splits
	// on the last colon the same way.
	if u, err := url.Parse(endpoint); err == nil {
		if p := u.Port(); p != "" {
			if port, perr := strconv.Atoi(p); perr == nil {
				return port
			}
			return 0
		}
	}
	hostPort := endpoint
	if i := strings.Index(hostPort, "://"); i >= 0 {
		hostPort = hostPort[i+3:]
	}
	i := strings.LastIndex(hostPort, ":")
	if i < 0 {
		return 0
	}
	port, err := strconv.Atoi(hostPort[i+1:])
	if err != nil || strings.Contains(hostPort[i+1:], "/") {
		return 0
	}
	return port
}
