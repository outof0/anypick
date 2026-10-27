// PoolServer is the multi-account credential ring behind StartPoolProxy:
// one loopback listener, one pool token, and a ring of enabled member
// accounts resolved through the same upstream resolver path as
// single-account proxies.
//
// The persisted strategy picks where each request starts: failover keeps the
// account that last served (ADR-0024), round-robin rotates (ADR-0026), and
// soonest-reset starts where unused quota resets first (ADR-0035). Every
// strategy fails over inside one request on a quota-class refusal.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/observe"
	"github.com/outof0/anypick/go/internal/protocol"
	"github.com/outof0/anypick/go/internal/upstream"
)

// poolCandidate adapts a member account name to the QuotaGuard ordering input.
type poolCandidate struct{ account string }

func (c poolCandidate) GetAccountName() string { return c.account }

// DefaultPoolRingDeadline bounds the time spent waiting for an uncommitted
// response across the whole member ring. Once a member commits response
// headers, the deadline no longer cancels that stream.
const DefaultPoolRingDeadline = 2 * time.Minute

// PoolServer is one running multi-account pool instance. Members are enabled
// account names in ring order at start time.

// A member's egress description is resolved on its first request and then
// cached for the life of this server — StartPoolProxy rebuilds the server on
// every start (there is no instance adoption), so the cache cannot outlive a
// membership change. It is per-account, so one slow member's first resolve no
// longer blocks another's.
type PoolServer struct {
	ProviderID string
	InstanceID string
	Token      string
	Members    []string
	// Strategy is the persisted pool row ('failover' | 'round-robin').
	//
	// failover: the guard keeps the account that last served at the head of the
	// ring, so every request is sticky until an account is cooled down.
	// round-robin: requests rotate through the eligible members in ring order.
	// soonest-reset: requests start at the eligible member whose unused quota
	// resets soonest, ordered by ResetOrder (ADR-0035).
	// All skip cooling accounts and all fail over inside one request when the
	// member that answered is quota-class exhausted.
	Strategy string
	// ResetOrder orders member names by when their quota resets, soonest
	// first. Nil, or a cache with nothing in it, leaves failover order.
	ResetOrder func(names []string) []string
	// RingDeadline is an aggregate pre-commit budget. Zero uses
	// DefaultPoolRingDeadline; it never cuts a stream after commit.
	RingDeadline time.Duration
	Resolver     UpstreamResolver
	Guard        *upstream.Guard

	endpoint string
	srv      *http.Server
	errCh    chan error

	// rrCursor is the round-robin position. It lives in memory: StartPoolProxy
	// rebuilds the server on every start, so a restart begins at the first
	// member, which is the same place a fresh ring should begin.
	rrCursor atomic.Uint64

	resolvedMu sync.Mutex
	resolved   map[string]*Upstream
	// accountMu serializes per-account resolution only. The map lock above
	// guards the cache, never the resolve: ResolveUpstream reads the store and
	// may refresh a credential over the network, and holding one pool-wide
	// lock across it made every member wait for the slowest one's first
	// resolve.
	accountMu map[string]*sync.Mutex
}

// Handler builds the auth + failover pipeline. /health stays unauthenticated
// and echoes the instance id + pid + provider so callers can prove ownership
// of the process serving this port; every other route requires the pool token.
func (s *PoolServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"instanceId":"` + s.InstanceID +
			`","pid":` + strconv.Itoa(ownPID()) + `,"provider":"` + s.ProviderID +
			`","account":"","counters":` + string(observe.HealthCounters()) + `}`))
	})
	mux.Handle("/", observe.DefaultLimiter.Handler(observe.RoutePool,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Pool requests used to be the only path with no access log at all:
			// three of the four egress paths recorded a line and this one did not,
			// so a failing pool was invisible in proxy.log.
			start := time.Now()
			rec := NewStatusRecorder(w)
			req := observe.Default.Begin(observe.RoutePool)
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
			s.servePoolRequest(rec, r, req, observe.RoutePool)
		})))
	return mux
}

// ServeAuthorized handles one request whose authentication an outer listener
// already performed — the Proxy Hub verifies its own route token before
// delegating a pool-backed source here, so the pool token check is skipped.
//
// It counts on its own route: a ring reached through the hub is a different
// client population from a ring reached directly, and mixing them makes the
// failover counter unreadable for both.
func (s *PoolServer) ServeAuthorized(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rec := NewStatusRecorder(w)
	req := observe.Default.Begin(observe.RoutePoolHub)
	defer func() {
		req.End(rec.status, observe.Classify(rec.status, false))
		logProxyLine(r, rec.status, time.Since(start))
	}()
	s.servePoolRequest(rec, r, req, observe.RoutePoolHub)
}

// ringOrder resolves the members this request may use, in the order it will try
// them, and reports whether the ring is running on cooling members only.
func (s *PoolServer) ringOrder(candidates []upstream.Candidate) (ordered []upstream.Candidate, fromCooling bool, err error) {
	if strings.EqualFold(strings.TrimSpace(s.Strategy), "soonest-reset") {
		eligible, eerr := s.Guard.Eligible(candidates)
		if eerr != nil {
			return nil, false, eerr
		}
		if len(eligible) == 0 {
			return s.coolingOrder(candidates)
		}
		return orderByReset(eligible, s.ResetOrder), false, nil
	}
	if strings.EqualFold(strings.TrimSpace(s.Strategy), "round-robin") {
		eligible, eerr := s.Guard.Eligible(candidates)
		if eerr != nil {
			return nil, false, eerr
		}
		if len(eligible) == 0 {
			return s.coolingOrder(candidates)
		}
		if len(eligible) > 1 {
			// Advance once per request, then start the walk there: a rotation
			// that reused the same start would be the sticky policy with extra
			// steps, and one that advanced per attempt would skip a member for
			// every failover.
			start := int(s.rrCursor.Add(1)-1) % len(eligible)
			rotated := make([]upstream.Candidate, 0, len(eligible))
			rotated = append(rotated, eligible[start:]...)
			rotated = append(rotated, eligible[:start]...)
			eligible = rotated
		}
		return eligible, false, nil
	}
	ordered, oerr := s.Guard.Ordered(candidates)
	if oerr != nil {
		return nil, false, oerr
	}
	if len(ordered) > 0 {
		return ordered, false, nil
	}
	return s.coolingOrder(candidates)
}

// orderByReset reorders candidates by order(names). Candidates the ordering
// does not name keep their place after the ones it does.
func orderByReset(candidates []upstream.Candidate, order func([]string) []string) []upstream.Candidate {
	if order == nil || len(candidates) < 2 {
		return candidates
	}
	names := make([]string, len(candidates))
	byName := make(map[string][]upstream.Candidate, len(candidates))
	for i, c := range candidates {
		names[i] = c.GetAccountName()
		byName[names[i]] = append(byName[names[i]], c)
	}
	out := make([]upstream.Candidate, 0, len(candidates))
	for _, name := range order(names) {
		if queue := byName[name]; len(queue) > 0 {
			out = append(out, queue[0])
			byName[name] = queue[1:]
		}
	}
	for _, c := range candidates {
		if queue := byName[c.GetAccountName()]; len(queue) > 0 {
			out = append(out, queue[0])
			byName[c.GetAccountName()] = queue[1:]
		}
	}
	return out
}

// coolingOrder is the last resort: every member is cooling, so the ring may
// either attempt the one that recovers soonest or refuse. The caller decides
// through the guard's policy.
func (s *PoolServer) coolingOrder(candidates []upstream.Candidate) ([]upstream.Candidate, bool, error) {
	if !s.Guard.ServesWhenAllCooling() {
		return nil, false, nil
	}
	cooling, err := s.Guard.Cooling(candidates)
	if err != nil {
		return nil, false, err
	}
	return cooling, true, nil
}

// servePoolRequest walks the guard-ordered member ring. Statuses pass through
// verbatim unless the failure is quota-class AND a next candidate exists AND
// the guard is enabled.
//
// obs may be nil when a caller has its own accounting; every method on it is
// nil-safe, so the ring never needs to care whether it is being watched.
func (s *PoolServer) servePoolRequest(w http.ResponseWriter, r *http.Request, obs *observe.Request, route string) {
	start := time.Now()
	// The aggregate deadline applies only until one member commits. Each
	// attempt receives a cancellable context with the same absolute deadline;
	// commit stops that timer so a valid stream can outlive ring selection.
	var ringDeadline time.Time
	if budget := s.ringDeadline(); budget > 0 {
		ringDeadline = start.Add(budget)
	}

	// Reuse a buffered body for every ring attempt; ReverseProxy drains
	// r.Body on the first hop, so snapshot it once and replay per member.
	var bodyBytes []byte
	if r.Body != nil {
		raw, err := ReadCappedBody(r, MaxBodyBytes)
		_ = r.Body.Close()
		if errors.Is(err, ErrBodyTooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "invalid_request_error",
				fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes))
			return
		}
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "unreadable body")
			return
		}
		bodyBytes = raw
	}
	requestModel := requestModelOf(bodyBytes)
	candidates := make([]upstream.Candidate, len(s.Members))
	for i, m := range s.Members {
		candidates[i] = poolCandidate{account: m}
	}
	ordered, fromCooling, err := s.ringOrder(candidates)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "upstream_error", "quota guard state unreadable")
		return
	}
	if len(ordered) == 0 {
		writeJSONError(w, http.StatusTooManyRequests, "rate_limit_error", "All accounts are cooling down.")
		return
	}

	for i, c := range ordered {
		// A client that hung up, or an uncommitted ring whose aggregate budget
		// expired, must not be billed for later members. A committed stream is
		// already inside serveMember and uses the original request context.
		if r != nil && r.Context() != nil && r.Context().Err() != nil {
			return
		}
		if !ringDeadline.IsZero() && !time.Now().Before(ringDeadline) {
			writeJSONError(w, http.StatusGatewayTimeout, "upstream_timeout", "pool ring deadline exceeded")
			return
		}
		account := c.GetAccountName()
		attemptCtx := r.Context()
		var attemptCancel context.CancelFunc
		var attemptTimer *time.Timer
		if !ringDeadline.IsZero() {
			attemptCtx, attemptCancel = context.WithCancel(r.Context())
			attemptTimer = time.AfterFunc(time.Until(ringDeadline), attemptCancel)
		}
		attempt := r.Clone(attemptCtx)
		up := s.upstreamFor(attempt, account)
		if up == nil || up.BaseURL == nil {
			continue
		}
		if bodyBytes != nil {
			attempt.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		} else {
			attempt.Body = nil
		}
		metered, finish := MeterUsage(w, route, s.ProviderID, account, requestModel)
		cw := &captureWriter{ResponseWriter: metered}
		if attemptTimer != nil {
			cw.onCommit = func() { attemptTimer.Stop() }
		}
		s.serveMember(cw, attempt, up)
		finish()
		if attemptTimer != nil {
			attemptTimer.Stop()
			attemptCancel()
		}
		if cw.committed {
			_ = s.Guard.Activate(account)
			// A committed response is a stream, not a selection: its duration
			// says nothing about how fast the ring picks a member, so it is
			// kept out of the latency average.
			obs.Stream(time.Since(start))
			return
		}
		// The attempt died with the budget rather than with an upstream
		// verdict. Reporting the transport error verbatim would tell the
		// caller "upstream is broken" when the truth is "we ran out of
		// members to try", and would burn the ring's cooldown bookkeeping
		// on a failure no member actually produced.
		if !ringDeadline.IsZero() && !time.Now().Before(ringDeadline) {
			writeJSONError(w, http.StatusGatewayTimeout, "upstream_timeout", "pool ring deadline exceeded")
			return
		}
		// fromCooling stops after the one attempt: every member is cooling, so
		// walking the rest would spend the request's whole budget repeating a
		// verdict the caller can already read.
		if i+1 >= len(ordered) || fromCooling || !s.Guard.Enabled() ||
			!isQuotaClassFailure(cw.status, cw.headerValue, cw.body.String(),
				quotaErrorPatterns(up)) {
			cw.flushCaptured()
			return
		}
		// Counted before the swap, not after: if the guard write fails the
		// ring still moved on, and a failover counter that only counts the
		// successful ones under-reports the thing it exists to measure.
		obs.Failover()
		next := ordered[i+1].GetAccountName()
		retryAfter := upstream.ParseRetryAfter(cw.headerValue("Retry-After"), time.Now())
		if gerr := s.Guard.Exhausted(account, next, retryAfter); gerr != nil {
			// State-file failure must not leak credentials or kill the swap.
			_ = gerr
		}
	}
	if !ringDeadline.IsZero() && !time.Now().Before(ringDeadline) {
		writeJSONError(w, http.StatusGatewayTimeout, "upstream_timeout", "pool ring deadline exceeded")
		return
	}
	// Every candidate lacked a usable upstream target.
	writeJSONError(w, http.StatusServiceUnavailable, "upstream_error", "No eligible pool account.")
}

func (s *PoolServer) ringDeadline() time.Duration {
	if s.RingDeadline > 0 {
		return s.RingDeadline
	}
	return DefaultPoolRingDeadline
}

// accountLock returns the mutex guarding one member's first resolve. The
// per-account map is bounded by the member list, so entries are never evicted.
func (s *PoolServer) accountLock(account string) *sync.Mutex {
	s.resolvedMu.Lock()
	defer s.resolvedMu.Unlock()
	if s.accountMu == nil {
		s.accountMu = map[string]*sync.Mutex{}
	}
	mu := s.accountMu[account]
	if mu == nil {
		mu = &sync.Mutex{}
		s.accountMu[account] = mu
	}
	return mu
}

// upstreamFor resolves and caches one member's egress description through the
// shared resolver path used by single-account proxies.
//
// Only the per-account mutex is held across ResolveUpstream. Concurrent
// requests for different members resolve in parallel; concurrent requests for
// the same member collapse onto one resolve instead of stampeding the store.
func (s *PoolServer) upstreamFor(r *http.Request, account string) *Upstream {
	mu := s.accountLock(account)
	mu.Lock()
	defer mu.Unlock()

	s.resolvedMu.Lock()
	up, ok := s.resolved[account]
	s.resolvedMu.Unlock()
	if ok {
		return up
	}
	if s.Resolver == nil {
		return nil
	}
	// Resolve under the caller's context, not context.Background(): a client
	// that hangs up mid-request must not leave resolver work running.
	ctx := context.Background()
	if r != nil && r.Context() != nil {
		ctx = r.Context()
	}
	up, err := s.Resolver.ResolveUpstream(ctx, s.ProviderID, account)
	if err != nil || up == nil {
		return nil
	}
	if strings.TrimSpace(up.CatalogScope) == "" {
		up.CatalogScope = accountCatalogScope(s.ProviderID, account)
	}
	s.resolvedMu.Lock()
	if s.resolved == nil {
		s.resolved = map[string]*Upstream{}
	}
	s.resolved[account] = up
	s.resolvedMu.Unlock()
	return up
}

// serveMember forwards one request to one member's upstream using the SAME
// dispatch order as Serve (native Anthropic → translated messages → plain
// passthrough), but captures non-2xx responses instead of committing them so
// the ring loop can decide whether to fail over.
func (s *PoolServer) serveMember(w *captureWriter, r *http.Request, up *Upstream) {
	// Same table as Serve, from the same function. The leaves differ because
	// this path must hold a failed response back for the ring instead of
	// sending it, not because it makes a different decision about which
	// upstream surface to speak.
	switch egressKindFor(r, up) {
	case kindGemini:
		s.geminiWithCapture(w, r, up)
	case kindNativeAnthropic:
		// Same merge as the single-account path, from the same function:
		// serveNativeAnthropic flattens through flattenedNativeUpstream, so
		// this leaf cannot disagree with it about which credential wins.
		// It stays on reverseWithCapture rather than reusing that leaf
		// outright because a pool member must hold a failed response back
		// for the ring — serveNativeAnthropic commits unconditionally and
		// would stream a 4xx past the failover decision.
		flat := flattenedNativeUpstream(up)
		s.reverseWithCapture(w, r, flat.BaseURL, flat, "")
	case kindTranslatedMessages:
		s.translatedWithCapture(w, r, up)
	case kindOpenAIPath:
		// The bridge buffers internally, so letting it write into the
		// capture writer keeps the ring's failover decision intact. Without
		// this leaf a pool member forwarded /v1/responses to the vendor's
		// own path (the one OpenAIPath exists to avoid, e.g. WorkBuddy 11128).
		if r.URL.Path == "/v1/responses" {
			serveOpenAIResponsesWith(w, r, up)
			return
		}
		s.reverseWithCapture(w, r, up.BaseURL, up, up.OpenAIPath)
	default:
		s.reverseWithCapture(w, r, up.BaseURL, up, "")
	}
}

// geminiWithCapture ports serveGemini's manual egress with capture semantics:
// a Gemini-backed member still accepts /v1/messages + /v1/responses +
// /v1/chat/completions and translates them to generateContent, capturing
// non-2xx responses so the ring can fail over like any other member.
func (s *PoolServer) geminiWithCapture(w *captureWriter, r *http.Request, up *Upstream) {
	// Body cap enforced at the door (per TestPipelineBodyPolicy); the shared
	// egress takes the already-capped bytes, matching serveGemini exactly.
	body, err := ReadCappedBody(r, MaxBodyBytes)
	if errors.Is(err, ErrBodyTooLarge) {
		w.commitJSON(http.StatusRequestEntityTooLarge, jsonErrorBody("invalid_request_error",
			fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes)))
		return
	}
	if err != nil {
		w.commitJSON(http.StatusBadRequest, jsonErrorBody("invalid_request_error", "unreadable body"))
		return
	}
	resp, resolvedModel, stream, berr, cerr := geminiEgress(r, up, body)
	if berr != nil {
		w.commitJSON(berr.status, jsonErrorBody(berr.typ, berr.message))
		return
	}
	if cerr != nil {
		// Capture the upstream failure so the ring loop can decide failover.
		status, msg := geminiErrorStatusMessage(cerr)
		w.capture(status, http.Header{"Content-Type": []string{"application/json"}},
			[]byte(jsonErrorBody("proxy_error", msg)))
		return
	}
	w.commit()
	writeGeminiResponse(w, r.URL.Path, resp, resolvedModel, stream)
}

// reverseWithCapture streams committed responses straight through and buffers
// non-committed (≥400) responses into the capture writer, so the ring can decide
// failover. It is the capture-door spelling of reverseEgress: the *captureWriter
// itself implements egressSink, so the single shared ReverseProxy in
// reverseEgress drives the capturing behavior without a second copy of the proxy
// logic (and without the context-window rewrite the old copy silently dropped).
// A non-empty chatPath rewrites the upstream path like Serve's kindOpenAIPath.
func (s *PoolServer) reverseWithCapture(w *captureWriter, r *http.Request, baseURL *url.URL, up *Upstream, chatPath string) {
	reverseEgress(r, up, w, reverseOpts{baseURL: baseURL, chatPath: chatPath, sanitizer: up.SanitizeOpenAIBody, anthropicSanitizer: up.SanitizeAnthropicBody})
}

// translatedWithCapture ports serveTranslatedMessagesWith's manual egress with
// capture semantics: OpenAI-only members still accept /v1/messages requests.
func (s *PoolServer) translatedWithCapture(w *captureWriter, r *http.Request, up *Upstream) {
	body, err := ReadCappedBody(r, MaxBodyBytes)
	if errors.Is(err, ErrBodyTooLarge) {
		w.commitJSON(http.StatusRequestEntityTooLarge,
			jsonErrorBody("invalid_request_error", fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes)))
		return
	}
	if err != nil {
		w.commitJSON(http.StatusBadRequest, `{"error":{"type":"invalid_request_error","message":"unreadable body"}}`)
		return
	}
	req, translated, be := buildTranslatedChatRequest(r, up, body)
	if be != nil {
		w.commitJSON(be.status, jsonErrorBody(be.typ, be.message))
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if err := injectUpstreamAuthFields(r.Context(), req, up); err != nil {
		w.commitJSON(http.StatusBadGateway, jsonErrorBody("proxy_error", "credential refresh failed"))
		return
	}

	client := egress.StreamClient()
	resp, err := client.Do(req)
	if err != nil {
		w.commitJSON(http.StatusBadGateway, `{"error":{"type":"upstream_error","message":"upstream unavailable"}}`)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		// Same classifier as the single-account path. The copy that used to
		// live here skipped the context-window conversion, so a member that
		// hit the limit was captured as a raw vendor error: the ring saw a
		// 400 it could not price, and when it was the last member the client
		// got the vendor body and never compacted.
		f := classifyTranslatedFailure(resp, body, translated, raw)
		w.capture(f.Status, f.Header, f.Body)
		return
	}
	w.commit()
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "text/event-stream") || strings.Contains(ct, "stream") {
		_ = protocol.TranslateStreamingResponse(resp, w)
		return
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return
	}
	out, terr := protocol.TranslateResponse(raw)
	if terr != nil {
		w.Header().Set("Content-Type", "application/json")
		writeJSONError(w.ResponseWriter, http.StatusBadGateway, "upstream_error", terr.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

func jsonErrorBody(typ, message string) string {
	payload, _ := json.Marshal(map[string]interface{}{
		"error": map[string]string{"type": typ, "message": message},
	})
	return string(payload)
}

// isQuotaClassFailure reports quota-class exhaustion: 401/402, insufficient
// balance, explicit credential-quota attribution, or a provider-declared
// quotaErrorPatterns regex matching the body.
func isQuotaClassFailure(status int, headerValue func(string) string, bodyPreview string, patterns []string) bool {
	if status == 401 || status == 402 {
		return true
	}
	if upstream.IsInsufficientBalanceFailure(status, bodyPreview) {
		return true
	}
	if upstream.IsCredentialQuotaFailure(status, headerValue, bodyPreview) {
		return true
	}
	return matchesQuotaErrorPattern(patterns, bodyPreview)
}

func matchesQuotaErrorPattern(patterns []string, body string) bool {
	return upstream.MatchesQuotaErrorPattern(patterns, body)
}

// quotaErrorPatterns surfaces the resolved member's provider-declared quota
// patterns; nil-safe for members without a usable upstream.
func quotaErrorPatterns(up *Upstream) []string {
	if up == nil {
		return nil
	}
	return up.QuotaErrorPatterns
}

// captureWriter lets ReverseProxy stream committed responses while silently
// buffering responses the ring may replace with a later member's answer.
// Once commit happens, it switches to the original request context's stream;
// ring selection may time out, but a valid stream must continue.
// Until a response commits, Header() hands out a scratch map so a failed
// member's headers can never pollute the real response.
type captureWriter struct {
	http.ResponseWriter
	committed  bool
	commitOnce sync.Once
	onCommit   func()
	status     int
	header     http.Header
	scratch    http.Header
	body       bytes.Buffer
}

func (w *captureWriter) commit() {
	w.commitOnce.Do(func() {
		w.committed = true
		if w.onCommit != nil {
			w.onCommit()
		}
	})
}

func (w *captureWriter) Header() http.Header {
	if !w.committed {
		if w.scratch == nil {
			w.scratch = http.Header{}
		}
		return w.scratch
	}
	return w.ResponseWriter.Header()
}

// capture records a non-committed response for the ring loop to inspect or
// replay verbatim.
func (w *captureWriter) capture(status int, header http.Header, body []byte) {
	w.status = status
	w.header = header
	w.body.Reset()
	w.body.Write(body)
}

// reject terminates the request before any upstream call (oversized body or
// credential-refresh failure). Like a captured upstream failure it is held in
// the buffer for the ring to inspect or fail over on — TestPool* assert exactly
// this (e.g. body-too-large is captured, not streamed to the client).
func (w *captureWriter) reject(status int, header http.Header, body []byte) {
	w.capture(status, header, body)
}

// onNon2xx handles a non-2xx upstream response from inside ModifyResponse. It
// records the response and hands ReverseProxy an empty body so the captured
// bytes are replayed exactly once by flushCaptured, never twice (the proxy
// would otherwise stream resp.Body into this same uncommitted writer).
func (w *captureWriter) onNon2xx(resp *http.Response) error {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	if err != nil {
		raw = nil
	}
	w.capture(resp.StatusCode, resp.Header, raw)
	resp.Body = io.NopCloser(bytes.NewReader(nil))
	return nil
}

// asResponseWriter returns the writer ReverseProxy streams into. Until commit()
// the bytes buffer; on <400 commit() flips it to the underlying client stream
// (so an SSE response reaches the caller rather than being held), and on ≥400
// flushCaptured replays the held bytes.
func (w *captureWriter) asResponseWriter() http.ResponseWriter { return w }

// headerValue reads captured headers; safe on transport-error paths where no
// upstream response ever arrived.
func (w *captureWriter) headerValue(name string) string {
	if w.header == nil {
		return ""
	}
	return w.header.Get(name)
}

func (w *captureWriter) WriteHeader(code int) {
	if w.committed {
		w.ResponseWriter.WriteHeader(code)
		return
	}
	w.status = code
}

func (w *captureWriter) Write(p []byte) (int, error) {
	if w.committed {
		return w.ResponseWriter.Write(p)
	}
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(p)
}

func (w *captureWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok && w.committed {
		f.Flush()
	}
}

// flushCaptured replays a captured non-committed response to the client
// verbatim — statuses that never trigger failover reach the caller unchanged.
// Content-Length is dropped: the captured body may be truncated by the
// preview limit and Go recomputes the framing.
func (w *captureWriter) flushCaptured() {
	header := w.header
	if header == nil {
		header = w.scratch
	}
	for k, vs := range header {
		if strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vs {
			w.ResponseWriter.Header().Add(k, v)
		}
	}
	if w.status == 0 {
		w.status = http.StatusInternalServerError
	}
	w.ResponseWriter.WriteHeader(w.status)
	_, _ = w.ResponseWriter.Write(w.body.Bytes())
}

func (w *captureWriter) commitJSON(status int, body string) {
	w.commit()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// Listen binds loopback and starts serving (same lifecycle contract as
// Server.Listen). The listener reserves the port before Serve so health
// checks can race safely.
func (s *PoolServer) Listen(host string, port int) error {
	if err := AssertLoopbackHost(host); err != nil {
		return err
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return anyerr.Wrapf(err, "listen "+addr, "PROXY_START_FAILED")
	}
	s.endpoint = "http://" + normalizedLoopback(host) + ":" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	s.srv = ApplyServingLimits(&http.Server{Handler: s.Handler()})
	s.errCh = make(chan error, 1)
	go func() { s.errCh <- s.srv.Serve(ln) }()
	return nil
}

// Endpoint returns the bound loopback URL (set by Listen).
func (s *PoolServer) Endpoint() string { return s.endpoint }

// WaitReady polls /health until it answers or times out.
func (s *PoolServer) WaitReady(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := egress.NewClient(2 * time.Second).Get(s.endpoint + "/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = err
		} else {
			lastErr = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr != nil {
		return anyerr.Newf("pool did not become healthy: "+lastErr.Error(), "PROXY_START_FAILED")
	}
	return anyerr.Newf("pool did not become healthy", "PROXY_START_FAILED")
}

// Close stops serving. Idempotent. The listener closes before any record
// cleanup so a stop never races an in-flight bind.
func (s *PoolServer) Close() error {
	if s.srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := s.srv.Shutdown(ctx)
	s.srv = nil
	return err
}

// Err reports a serve failure (accept loop crash).
func (s *PoolServer) Err() <-chan error { return s.errCh }
