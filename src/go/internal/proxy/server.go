// Package proxy provides the ProxyService essentials and a real in-process
// builtin proxy server.
//
// Security model (PROXY-01 / ADR 0006):
//   - loopback bind only (assertLoopbackHost);
//   - every credentialed route requires the per-instance secret;
//   - constant-time token comparison;
//   - /health echoes the instance id without auth (ownership proof).
//
// The proxy runs in-process: ownership is trivially provable and shutdown
// is deterministic.
package proxy

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/observe"
)

// Listener hardening shared by every loopback server in this program
// (single-account proxy, pool ring, hub, and the serve daemon). Before this
// existed each site set ReadHeaderTimeout by hand and nothing else, so a
// client could park a connection open forever or send a megabyte of headers
// and neither would ever be refused.
const (
	// DefaultReadHeaderTimeout bounds request headers only. It must stay
	// short; the streaming responses this proxy exists to serve are bounded
	// by the request context, not by a write deadline, so no WriteTimeout is
	// set here on purpose.
	DefaultReadHeaderTimeout = 10 * time.Second
	// DefaultIdleTimeout bounds a keep-alive connection between requests. It
	// does not apply while a response is being written, so a long stream is
	// unaffected.
	DefaultIdleTimeout = 5 * time.Minute
	// DefaultMaxHeaderBytes is 64 KiB: enough for any vendor header set,
	// far below the 1 MiB Go default, which exists for servers that are not
	// talking to a fixed set of local clients.
	DefaultMaxHeaderBytes = 1 << 16
)

// ApplyServingLimits installs the loopback hardening defaults on a server that
// has not chosen its own. Every listener in this program goes through it, so
// "which limits does this one have" has one answer instead of four.
func ApplyServingLimits(srv *http.Server) *http.Server {
	if srv == nil {
		return nil
	}
	if srv.ReadHeaderTimeout <= 0 {
		srv.ReadHeaderTimeout = DefaultReadHeaderTimeout
	}
	if srv.IdleTimeout <= 0 {
		srv.IdleTimeout = DefaultIdleTimeout
	}
	if srv.MaxHeaderBytes <= 0 {
		srv.MaxHeaderBytes = DefaultMaxHeaderBytes
	}
	return srv
}

// LoopbackHosts is the accepted loopback set.
var loopbackHosts = map[string]bool{
	"127.0.0.1": true,
	"::1":       true,
	"localhost": true,
}

// AssertLoopbackHost refuses any non-loopback listen host.
func AssertLoopbackHost(host string) error {
	normalized := strings.ToLower(strings.TrimSpace(strings.Trim(host, "[]")))
	if !loopbackHosts[normalized] {
		return anyerr.Newf(
			fmt.Sprintf("Refusing to bind %q — local proxies are loopback-only.", host),
			"PROXY_UNSAFE_HOST")
	}
	return nil
}

// NewToken generates a per-instance secret: 32 random bytes, hex encoded.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// NewInstanceID generates a random instance id.
func NewInstanceID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const h = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, h[v>>4], h[v&0x0f])
	}
	return string(out), nil
}

// SafeEqual compares secrets in constant time; an empty expected value fails
// closed.
func SafeEqual(expected, provided string) bool {
	if expected == "" {
		return false
	}
	a := []byte(expected)
	b := []byte(provided)
	if len(a) != len(b) {
		// Still burn comparable time to avoid a length oracle.
		subtle.ConstantTimeCompare(a, a)
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// bearerToken extracts Authorization: Bearer <token>, falling back to
// x-api-key when no Bearer is present. Prefer presentedProxyCredentials when
// both headers may be set: Claude Code can send a claude.ai OAuth Bearer
// alongside the proxy token in x-api-key, and the Bearer must not win just
// because it arrived first.
func bearerToken(r *http.Request) string {
	bearer, apiKey := presentedProxyCredentials(r)
	if bearer != "" {
		return bearer
	}
	return apiKey
}

func presentedProxyCredentials(r *http.Request) (bearer, apiKey string) {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		bearer = strings.TrimSpace(auth[len("Bearer "):])
	}
	apiKey = strings.TrimSpace(r.Header.Get("x-api-key"))
	return bearer, apiKey
}

// requireProxyAuth gates credential-authority routes (ADR 0006): 401 JSON on
// missing/incorrect credentials, fail-closed on empty secret. Either the
// Bearer or x-api-key matching is enough — Claude Code may present both, and
// the one that is the proxy token is not always Authorization.
func requireProxyAuth(w http.ResponseWriter, r *http.Request, expectedToken string) bool {
	bearer, apiKey := presentedProxyCredentials(r)
	okBearer := SafeEqual(expectedToken, bearer)
	okKey := SafeEqual(expectedToken, apiKey)
	if !okBearer && !okKey {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"type":"authentication_error","message":"invalid proxy credentials"}}`))
		return false
	}
	return true
}

// unauthenticatedLiveness is Claude Code's connectivity probe against
// ANTHROPIC_BASE_URL: HEAD / (and GET /) with no credentials. It is not a
// credential-authority route — it never reaches upstream — so it stays open
// like /health (ADR 0006). Returning 401 here is what the WorkBuddy × Claude
// Code session surfaces as a hard 401 even when POST /v1/messages would work.
func unauthenticatedLiveness(r *http.Request) bool {
	if r.URL.Path != "/" && r.URL.Path != "" {
		return false
	}
	return r.Method == http.MethodHead || r.Method == http.MethodGet
}

// AuthCheckPath answers 204 to a caller holding the proxy secret and the usual
// 401 to anyone else, and never reaches upstream. Token rotation probes it to
// prove the new secret is live and the old one is refused; a model request
// would also prove that, but only when the vendor is reachable, so a rotation
// on a train would report a failure that has nothing to do with the token.
const AuthCheckPath = "/_anypick/auth-check"

// serveAuthCheck answers an authenticated AuthCheckPath request. The caller
// has already passed requireProxyAuth.
func serveAuthCheck(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != AuthCheckPath {
		return false
	}
	w.WriteHeader(http.StatusNoContent)
	return true
}

func writeLiveness(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

// Server is one running builtin proxy instance.
type Server struct {
	ProviderID   string
	AccountName  string
	InstanceID   string
	Token        string
	Endpoint     string // http://127.0.0.1:<port>
	Upstream     *url.URL
	UpstreamAuth string // credential injected into forwarded requests
	// CatalogScope names this account's provider-local model catalog so two
	// accounts sharing an upstream origin cannot serve each other's
	// entitlements (see accountCatalogScope).
	CatalogScope string
	// Upstream auth presentation; empty = Authorization: Bearer.
	UpstreamAuthHeader      string
	UpstreamAuthValuePrefix string
	// UpstreamAuthProvider, when set, supplies the live credential per request
	// (OIDC/OAuth refresh) and overrides UpstreamAuth.
	UpstreamAuthProvider func(ctx context.Context) (string, error)
	// UpstreamExtraHeaders are injected into every forwarded request.
	UpstreamExtraHeaders []ExtraHeader
	// UpstreamDynamicHeaders supplies provider-owned metadata per request.
	UpstreamDynamicHeaders func(context.Context) ([]ExtraHeader, error)
	// UpstreamModelDiscovery is the provider-owned model-catalog operation
	// (WorkBuddy's product catalogue). It must travel like every other egress
	// fact: a dropped copy silently turns GET /v1/models into vendor
	// passthrough, so clients enumerate models from a 404 instead of the ids
	// this proxy can serve (see the TranslateGemini warning in buildServer).
	UpstreamModelDiscovery func(context.Context) ([]string, error)
	// TranslateAnthropic: upstream is OpenAI-only, so /v1/messages requests
	// are translated into chat completions (body + response + SSE stream).
	TranslateAnthropic bool
	// TranslateGemini: upstream is Google Gemini (generateContent), so
	// /v1/chat/completions, /v1/responses and /v1/messages are translated to
	// Gemini and the response translated back. See Upstream.TranslateGemini.
	TranslateGemini bool
	// Gemini holds the Gemini-specific egress facts (api-key vs OAuth mode).
	Gemini *GeminiTarget
	// Anthropic: optional native /v1/messages target (vendor /anthropic base).
	Anthropic *UpstreamTarget
	// OpenAIPath: upstream path serving the OpenAI chat surface (see
	// Upstream.OpenAIPath). Composed into the egress by upstreamValue().
	OpenAIPath string
	// SanitizeOpenAIBody rewrites verbatim-forwarded OpenAI bodies before
	// egress. Composed into the egress by upstreamValue().
	SanitizeOpenAIBody func([]byte) []byte
	// SanitizeAnthropicBody rewrites verbatim-forwarded native Anthropic
	// bodies before egress. Composed into the egress by upstreamValue().
	SanitizeAnthropicBody func([]byte) []byte
	// MapModel translates an inbound client model name into the upstream
	// provider's model identifier.
	MapModel func(string) string

	srv   *http.Server
	errCh chan error
	// Deliberately no translateAnthropic mirror: the live flag is read from the
	// Upstream that upstreamValue() composes. A cached copy next to the field it
	// caches is how a future reader ends up trusting the wrong one.
	clientOnce sync.Once
	client     *http.Client
}

// injectUpstreamAuth applies the configured scheme, never forwarding the
// proxy token. Provider errors fail closed to the caller.
func (s *Server) injectUpstreamAuth(out *http.Request) error {
	return injectUpstreamAuthFields(out.Context(), out, &Upstream{
		BaseURL:         s.Upstream,
		Auth:            s.UpstreamAuth,
		AuthHeader:      s.UpstreamAuthHeader,
		AuthValuePrefix: s.UpstreamAuthValuePrefix,
		AuthProvider:    s.UpstreamAuthProvider,
		ExtraHeaders:    s.UpstreamExtraHeaders,
		DynamicHeaders:  s.UpstreamDynamicHeaders,
	})
}

// Handler builds the auth + forwarding pipeline. Health stays unauthenticated
// and echoes the instance id so callers can prove the process is ours; every
// other route requires the per-instance secret (PROXY-01).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(
			`{"ok":true,"instanceId":%q,"pid":%d,"provider":%q,"account":%q,"counters":%s}`,
			s.InstanceID, ownPID(), s.ProviderID, s.AccountName, observe.HealthCounters())))
	})
	mux.Handle("/", observe.DefaultLimiter.Handler(observe.RouteSingle,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := NewStatusRecorder(w)
			req := observe.Default.Begin(observe.RouteSingle)
			// One deferred close for every exit path. The previous shape
			// repeated logProxyLine at each return, and the one path that
			// mattered most — a panic in Serve — recorded nothing at all.
			defer func() {
				req.End(rec.status, observe.Classify(rec.status, false))
				logProxyLine(r, rec.status, time.Since(start))
			}()
			if unauthenticatedLiveness(r) {
				writeLiveness(rec, r)
				return
			}
			if !requireProxyAuth(rec, r, s.Token) {
				return
			}
			if serveAuthCheck(rec, r) {
				return
			}
			metered, finish := MeterUsage(rec, observe.RouteSingle, s.ProviderID, s.AccountName, "")
			Serve(metered, r, s.upstreamValue())
			finish()
		})))
	return mux
}

// StatusRecorder captures the status Serve commits so the access log can
// report it. The proxy never logs headers, query strings, or bodies:
// only method, path, status, and latency cross into proxy.log.
//
// It is exported because the hub needs the same thing and a second copy is
// how the two end up disagreeing about what a "status" is.
type StatusRecorder struct {
	http.ResponseWriter
	status int
}

// NewStatusRecorder wraps w, defaulting the recorded status to 200 — the
// status a handler that writes a body without calling WriteHeader commits.
func NewStatusRecorder(w http.ResponseWriter) *StatusRecorder {
	return &StatusRecorder{ResponseWriter: w, status: http.StatusOK}
}

func (rec *StatusRecorder) Status() int { return rec.status }

func (rec *StatusRecorder) WriteHeader(status int) {
	rec.status = status
	rec.ResponseWriter.WriteHeader(status)
}

// Flush delegates when the underlying writer supports it. Without this
// method *StatusRecorder does NOT implement http.Flusher (the embedded
// http.ResponseWriter interface only carries Header/Write/WriteHeader),
// so TranslateStreamingResponse bailed before writing a byte and every
// streamed translation came back `200` with an empty body.
func (rec *StatusRecorder) Flush() {
	if f, ok := rec.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logProxyLine(r *http.Request, status int, latency time.Duration) {
	path := r.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	// Design ngJKM ("Activity · Live Logs") shapes every console line as
	// `HH:MM:SS  <message>` — timestamp first, human message after. No
	// headers/query/bodies: only method, path, status, latency cross into
	// proxy.log, so Fprintf (not log.Printf, whose own date prefix would
	// fight the design format).
	proxyLogf("%s %s → %d in %d ms", r.Method, path, status, latency.Milliseconds())
}

// proxyLogSink is os.Stderr in production (the spawned child redirects it
// to proxy.log); tests point it at a buffer. It is a package-level variable,
// so every writer shares one mutex — concurrent handlers interleaving partial
// lines into the same file is worse than the cost of the lock.
var (
	proxyLogMu   sync.Mutex
	proxyLogSink io.Writer = os.Stderr
)

// proxyLogf writes one design-shaped console line to the child log.
func proxyLogf(format string, args ...any) {
	line := fmt.Sprintf("%s  %s\n",
		time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
	proxyLogMu.Lock()
	defer proxyLogMu.Unlock()
	_, _ = io.WriteString(proxyLogSink, line)
}

// LogProxyLine logs an incoming HTTP request in design format (`HH:MM:SS  METHOD PATH → STATUS in X ms`).
func LogProxyLine(r *http.Request, status int, latency time.Duration) {
	logProxyLine(r, status, latency)
}

// Logf writes one design-shaped console line (`HH:MM:SS  <message>`) to the child log.
func Logf(format string, args ...any) {
	proxyLogf(format, args...)
}

type logWriterFunc func([]byte) (int, error)

func (f logWriterFunc) Write(p []byte) (int, error) { return f(p) }

// ErrorLogger returns a *log.Logger that routes lines to the proxy child log
// in design format without double timestamping.
func ErrorLogger() *log.Logger {
	return log.New(logWriterFunc(func(p []byte) (int, error) {
		msg := strings.TrimSpace(string(p))
		if msg != "" {
			proxyLogf("%s", msg)
		}
		return len(p), nil
	}), "", 0)
}

// SetLogSinkForTest redirects proxy child output to w for tests and returns
// a restore function.
func SetLogSinkForTest(w io.Writer) func() {
	proxyLogMu.Lock()
	old := proxyLogSink
	proxyLogSink = w
	proxyLogMu.Unlock()
	return func() {
		proxyLogMu.Lock()
		proxyLogSink = old
		proxyLogMu.Unlock()
	}
}

// upstreamValue composes the single egress description consumed by Serve.
// It must carry AuthProvider + ExtraHeaders — buildServer sets them on the
// Server, and the per-request path needs them to refresh short-lived tokens
// and inject vendor headers. A cached copy of any of these next to the field
// it caches is how a future reader ends up trusting the wrong one, so every
// egress fact lives only in the Upstream upstreamValue() returns.
func (s *Server) upstreamValue() *Upstream {
	return &Upstream{
		BaseURL:               s.Upstream,
		Auth:                  s.UpstreamAuth,
		AuthHeader:            s.UpstreamAuthHeader,
		AuthValuePrefix:       s.UpstreamAuthValuePrefix,
		AuthProvider:          s.UpstreamAuthProvider,
		ExtraHeaders:          s.UpstreamExtraHeaders,
		DynamicHeaders:        s.UpstreamDynamicHeaders,
		ModelDiscovery:        s.UpstreamModelDiscovery,
		CatalogScope:          s.CatalogScope,
		Anthropic:             s.Anthropic,
		TranslateAnthropic:    s.TranslateAnthropic,
		TranslateGemini:       s.TranslateGemini,
		Gemini:                s.Gemini,
		OpenAIPath:            s.OpenAIPath,
		SanitizeOpenAIBody:    s.SanitizeOpenAIBody,
		SanitizeAnthropicBody: s.SanitizeAnthropicBody,
		MapModel:              s.MapModel,
	}
}

func writeJSONError(w http.ResponseWriter, status int, typ, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	payload, _ := json.Marshal(map[string]interface{}{
		"error": map[string]string{"type": typ, "message": message},
	})
	_, _ = w.Write(payload)
}

func (s *Server) httpClient() *http.Client {
	s.clientOnce.Do(func() {
		if s.client == nil {
			s.client = egress.StreamClient()
		}
	})
	return s.client
}

// Listen binds loopback and starts serving. The listener reserves the port
// before Serve so health checks can race safely.
func (s *Server) Listen(host string, port int) error {
	if err := AssertLoopbackHost(host); err != nil {
		return err
	}
	addr := net.JoinHostPort(host, fmt.Sprint(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return anyerr.Wrapf(err, "listen "+addr, "PROXY_START_FAILED")
	}
	s.Endpoint = fmt.Sprintf("http://%s:%d", normalizedLoopback(host), ln.Addr().(*net.TCPAddr).Port)
	s.srv = ApplyServingLimits(&http.Server{Handler: s.Handler()})
	s.errCh = make(chan error, 1)
	go func() { s.errCh <- s.srv.Serve(ln) }()
	return nil
}

// WaitReady polls /health until it answers or times out.
func (s *Server) WaitReady(timeout time.Duration) error {
	client := egress.NewClient(2 * time.Second)
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.Get(s.Endpoint + "/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("health status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr != nil {
		return anyerr.Newf("proxy did not become healthy: "+lastErr.Error(), "PROXY_START_FAILED")
	}
	return anyerr.Newf("proxy did not become healthy", "PROXY_START_FAILED")
}

// Close stops serving. Idempotent.
func (s *Server) Close() error {
	if s.srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return s.srv.Shutdown(ctx)
}

// Err reports a serve failure (accept loop crash).
func (s *Server) Err() <-chan error { return s.errCh }

func normalizedLoopback(host string) string {
	n := strings.ToLower(strings.TrimSpace(strings.Trim(host, "[]")))
	if n == "localhost" || n == "::1" {
		return "127.0.0.1"
	}
	return n
}

// PickFreePort asks the kernel for a free loopback port.
func PickFreePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// portBindable reports whether host:port can be bound right now. It is a
// pre-flight probe only: the listener closes immediately, so a racing bind
// still fails later and surfaces as a normal start failure.
func portBindable(host string, port int) bool {
	if port <= 0 {
		return false
	}
	// The probe listens for real. Refuse before that bind so a configured
	// public host is never opened, even briefly (ADR 0006 §5).
	if err := AssertLoopbackHost(host); err != nil {
		return false
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

type registry struct {
	mu sync.Mutex
	m  map[string]*Server
}

func key(providerID, accountName string) string { return providerID + "\x00" + accountName }

func newRegistry() *registry { return &registry{m: map[string]*Server{}} }

func (r *registry) get(providerID, accountName string) (*Server, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.m[key(providerID, accountName)]
	return s, ok
}

func (r *registry) put(providerID, accountName string, s *Server) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.m[key(providerID, accountName)] = s
}

func (r *registry) remove(providerID, accountName string) (*Server, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.m[key(providerID, accountName)]
	if ok {
		delete(r.m, key(providerID, accountName))
	}
	return s, ok
}

// removeAll drains the registry for shutdown; callers close each server.
func (r *registry) removeAll() []*Server {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Server, 0, len(r.m))
	for k, s := range r.m {
		out = append(out, s)
		delete(r.m, k)
	}
	return out
}
