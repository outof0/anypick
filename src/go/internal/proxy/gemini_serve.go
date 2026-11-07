package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/protocol/gemini"
)

// geminiUpstreamGoogle is the API-key upstream.
const geminiUpstreamGoogle = "https://generativelanguage.googleapis.com"

// geminiIDETypeDefault is the ClientMetadata.ideType used when a target does
// not name one. The historical "GEMINI" is no longer an accepted value — the
// endpoint answers 400 INVALID_ARGUMENT for it.
const geminiIDETypeDefault = "GEMINI_CLI"

// codeAssistProjectCache caches the resolved Code Assist project per auth token
// so each request does not re-call loadCodeAssist.
type codeAssistProjectCache struct {
	mu      sync.Mutex
	byToken map[string]string
}

var codeAssistProjects = &codeAssistProjectCache{byToken: map[string]string{}}

// maxCodeAssistProjectEntries bounds the cache. An OAuth refresh mints a new
// token, so a map keyed by token grows once per refresh and never shrinks —
// and this process is a proxy expected to run for days. Clearing outright is
// deliberate: an LRU costs more than the loadCodeAssist call it protects, and
// the cached value is only a resolved project id.
const maxCodeAssistProjectEntries = 64

func (c *codeAssistProjectCache) get(token string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.byToken[token]
	return v, ok
}

func (c *codeAssistProjectCache) set(token, project string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, present := c.byToken[token]; !present &&
		len(c.byToken) >= maxCodeAssistProjectEntries {
		c.byToken = map[string]string{}
	}
	c.byToken[token] = project
}

// serveGemini is the single egress for every Gemini-backed route. It translates
// the inbound OpenAI/Anthropic/Responses request to a Gemini generateContent
// call, issues it (API-key or OAuth/Code Assist), and translates the response
// back — synthesizing SSE for streaming requests from the single non-stream
// generateContent response.

// geminiBuildError carries the exact (status, type, message) a leaf must surface
// when the Gemini request build fails, so the shared egress and each caller's
// own sink (write vs capture) stay in agreement. Network errors are returned
// separately (cerr) so each leaf can reproduce writeGeminiError / w.capture
// exactly, including the credential-error vs upstream-error type split.

type geminiBuildError struct {
	status  int
	typ     string
	message string
}

func (e *geminiBuildError) Error() string { return e.message }

// geminiEgress translates the already-capped inbound body to a Gemini
// generateContent request and issues it. The body cap is enforced by the caller
// (serveGemini / geminiWithCapture) at the door — per TestPipelineBodyPolicy —
// which passes the capped bytes in. Sharing the request side here means the two
// leaves cannot diverge; the caller maps the result to its own sink (write vs
// capture), including the credential-error vs upstream-error type split.
func geminiEgress(r *http.Request, up *Upstream, body []byte) (resp *gemini.GeminiGenerateResponse, resolvedModel string, stream bool, berr *geminiBuildError, cerr error) {
	geminiReq, resolvedModel, upstreamModel, stream, terr := translateToGemini(up, r.Context(), r.URL.Path, body)
	if terr != nil {
		return nil, "", false, &geminiBuildError{http.StatusBadGateway, "upstream_error", terr.Error()}, nil
	}
	if resolvedModel == "" || upstreamModel == "" {
		return nil, "", false, &geminiBuildError{http.StatusBadRequest, "invalid_request_error",
			"model is required and no model could be discovered for this account"}, nil
	}
	resp, cerr = callGemini(r.Context(), up, upstreamModel, geminiReq)
	if cerr != nil {
		return nil, "", false, nil, cerr
	}
	return resp, resolvedModel, stream, nil, nil
}

func serveGemini(w http.ResponseWriter, r *http.Request, up *Upstream) {
	// Body cap enforced at the door (per TestPipelineBodyPolicy); the shared
	// egress takes the already-capped bytes.
	body, err := ReadCappedBody(r, MaxBodyBytes)
	if errors.Is(err, ErrBodyTooLarge) {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "invalid_request_error",
			fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes))
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "unreadable body")
		return
	}
	resp, resolvedModel, stream, berr, cerr := geminiEgress(r, up, body)
	if berr != nil {
		writeJSONError(w, berr.status, berr.typ, berr.message)
		return
	}
	if cerr != nil {
		writeGeminiError(w, cerr)
		return
	}
	writeGeminiResponse(w, r.URL.Path, resp, resolvedModel, stream)
}

// translateToGemini routes the inbound body to the right converter and returns
// the Gemini request, the resolved model id, and whether the client asked for
// streaming. Converters get the upstream id: thinking config depends on the
// model generation, and a tier intent ("flash") names none until it is
// resolved to the vendor's route. Model resolution consults the live account catalog
// (liveGeminiCatalog) and falls back to the empty-catalog passthrough for
// unknown concrete ids.
func translateToGemini(up *Upstream, ctx context.Context, path string, body []byte) (*gemini.GeminiGenerateRequest, string, string, bool, error) {
	catalog := liveGeminiCatalog(ctx, up)
	switch path {
	case "/v1/chat/completions":
		var req gemini.OpenAIChatRequest
		if err := json.Unmarshal(body, &req); err != nil {
			return nil, "", "", false, fmt.Errorf("invalid OpenAI chat body: %w", err)
		}
		model := gemini.ResolveGeminiModel(req.Model, catalog, stringFromEffort(req))
		return signGeminiHistory(gemini.OpenAIToGemini(req, model.UpstreamID), model.UpstreamID), model.ID, model.UpstreamID, req.Stream, nil
	case "/v1/responses":
		var req gemini.OpenAIResponsesRequest
		if err := json.Unmarshal(body, &req); err != nil {
			return nil, "", "", false, fmt.Errorf("invalid OpenAI responses body: %w", err)
		}
		model := gemini.ResolveGeminiModel(req.Model, catalog, "")
		return signGeminiHistory(gemini.OpenAIResponsesToGemini(req, model.UpstreamID), model.UpstreamID), model.ID, model.UpstreamID, req.Stream, nil
	case "/v1/messages":
		var req gemini.AnthropicMessageRequest
		if err := json.Unmarshal(body, &req); err != nil {
			return nil, "", "", false, fmt.Errorf("invalid Anthropic messages body: %w", err)
		}
		if req.Model == "" {
			return nil, "", "", false, fmt.Errorf("model is required")
		}
		model := gemini.ResolveGeminiModel(req.Model, catalog, stringFromAnthropicEffort(req))
		g, _, err := gemini.AnthropicToGemini(body, model.UpstreamID)
		if err != nil {
			return nil, "", "", false, err
		}
		stream := req.Stream
		return signGeminiHistory(g, model.UpstreamID), model.ID, model.UpstreamID, stream, nil
	default:
		return nil, "", "", false, fmt.Errorf("unsupported gemini route %s", path)
	}
}

// signGeminiHistory fills tool calls that lost their thought signature and
// says so in proxy.log: the placeholder keeps the conversation going, but a
// signature lost on a fresh turn is a bug the log should still show.
func signGeminiHistory(req *gemini.GeminiGenerateRequest, upstreamModel string) *gemini.GeminiGenerateRequest {
	if n := gemini.FillMissingToolSignatures(req, upstreamModel); n > 0 {
		proxyLogf("gemini: %d tool call(s) without a thought signature sent with the placeholder", n)
	}
	return req
}

func stringFromEffort(req gemini.OpenAIChatRequest) string {
	if req.ReasoningEffort != "" {
		return req.ReasoningEffort
	}
	return req.Effort
}

func stringFromAnthropicEffort(req gemini.AnthropicMessageRequest) string {
	var oc map[string]interface{}
	if len(req.OutputConfig) > 0 {
		_ = json.Unmarshal(req.OutputConfig, &oc)
	}
	if oc != nil {
		if e, ok := oc["effort"].(string); ok {
			return e
		}
	}
	return ""
}

// callGemini issues one Gemini generateContent call. API-key mode posts to
// generativelanguage.googleapis.com with x-goog-api-key; OAuth mode posts to
// the Code Assist upstream with Authorization: Bearer + the {model, project,
// session_id} envelope, including its 429 cooldown and gemini-cli ↔
// antigravity auto-fallback on 401/403/404.
func callGemini(ctx context.Context, up *Upstream, model string, geminiReq *gemini.GeminiGenerateRequest) (*gemini.GeminiGenerateResponse, error) {
	keyMode := up.Gemini != nil && up.Gemini.APIKeyMode
	routeKey := geminiCooldownKey(up, model)
	if cooling := geminiCooldowns.remainingMs(routeKey); cooling > 0 {
		return nil, &geminiUpstreamError{
			status:  429,
			message: "Gemini route is cooling down after a rate limit.",
			body:    "",
		}
	}
	if keyMode {
		return callGeminiAPIKey(ctx, up, model, routeKey, geminiReq)
	}
	return callGeminiOAuth(ctx, up, model, geminiReq, routeKey, false)
}

func callGeminiAPIKey(ctx context.Context, up *Upstream, model, routeKey string, geminiReq *gemini.GeminiGenerateRequest) (*gemini.GeminiGenerateResponse, error) {
	token := up.Auth
	if up.AuthProvider != nil {
		got, perr := up.AuthProvider(ctx)
		if perr != nil {
			return nil, anyerr.Wrapf(perr, "Gemini credential refresh failed", "GEMINI_OAUTH")
		}
		token = got
	}
	if token == "" {
		return nil, anyerr.Newf("no Gemini API key available", "GEMINI_NO_KEY")
	}
	apiBase := geminiUpstreamGoogle
	if up.Gemini != nil && up.Gemini.APIKeyBase != nil {
		apiBase = strings.TrimSuffix(up.Gemini.APIKeyBase.String(), "/")
	}
	target := fmt.Sprintf("%s/v1beta/models/%s:generateContent", apiBase, url.PathEscape(model))
	reqBody, err := json.Marshal(geminiReq)
	if err != nil {
		return nil, anyerr.Wrapf(err, "marshal gemini request", "GEMINI_ENCODE")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(reqBody))
	if err != nil {
		return nil, anyerr.Wrapf(err, "build gemini request", "GEMINI_ENCODE")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", token)

	client := egress.StreamClient()
	resp, err := client.Do(req)
	if err != nil {
		return nil, anyerr.Wrapf(err, "Gemini network error", "GEMINI_UPSTREAM")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, anyerr.Wrapf(err, "read gemini response", "GEMINI_UPSTREAM")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 429 backoff, applied for every mode, not just OAuth.
		if resp.StatusCode == 429 {
			if ra := retryAfterMs(resp.Header.Get("Retry-After")); ra > 0 {
				geminiCooldowns.set(routeKey, ra)
			}
		}
		return nil, &geminiUpstreamError{
			status:  resp.StatusCode,
			message: extractGeminiErrorMessage(string(raw), resp.StatusCode),
			body:    string(raw),
		}
	}
	var parsed gemini.GeminiGenerateResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, anyerr.Wrapf(err, "decode gemini response", "GEMINI_UPSTREAM")
	}
	return &parsed, nil
}

// callGeminiOAuth performs one Code Assist request and, on 401/403/404, retries
// once through up.Gemini.AltRoute. routeKey tags the cooldown bucket so a 429
// sets a backoff the next call observes.
func callGeminiOAuth(ctx context.Context, up *Upstream, model string, geminiReq *gemini.GeminiGenerateRequest, routeKey string, isFallback bool) (*gemini.GeminiGenerateResponse, error) {
	if up.AuthProvider == nil {
		return nil, anyerr.Newf("no Gemini OAuth provider available", "GEMINI_NO_OAUTH")
	}
	token, err := up.AuthProvider(ctx)
	if err != nil {
		return nil, anyerr.Wrapf(err, "Gemini OAuth refresh failed", "GEMINI_OAUTH")
	}
	base := geminiUpstreamGoogle
	if up.Gemini != nil && up.Gemini.CodeAssistBase != nil {
		base = strings.TrimSuffix(up.Gemini.CodeAssistBase.String(), "/")
	}
	project, perr := resolveCodeAssistProject(ctx, base, token, geminiString(up.Gemini, func(t *GeminiTarget) string { return t.IDEType }))
	if perr != nil {
		return nil, perr
	}
	status, header, raw, rerr := doCodeAssistRequest(ctx, base, token, model, geminiReq, project,
		geminiString(up.Gemini, func(t *GeminiTarget) string { return t.UserAgent }))
	if rerr != nil {
		return nil, rerr
	}
	if status < 200 || status >= 300 {
		// 429 backoff.
		if status == 429 {
			if ra := retryAfterMs(header.Get("Retry-After")); ra > 0 {
				geminiCooldowns.set(routeKey, ra)
			}
		}
		// Auto auth fallback: one retry through the alternate identity.
		if !isFallback && up.Gemini != nil && up.Gemini.AltRoute != nil &&
			isAutoFallbackStatus(status) {
			alt := up.Gemini.AltRoute
			altToken, aerr := alt.AuthProvider(ctx)
			if aerr == nil {
				altBase := geminiUpstreamGoogle
				if alt.CodeAssistBase != nil {
					altBase = strings.TrimSuffix(alt.CodeAssistBase.String(), "/")
				}
				if altProject, perr := resolveCodeAssistProject(ctx, altBase, altToken, alt.IDEType); perr == nil {
					if s2, _, r2, e2 := doCodeAssistRequest(ctx, altBase, altToken, model, geminiReq, altProject, alt.UserAgent); e2 == nil && s2 >= 200 && s2 < 300 {
						return unwrapCodeAssist(r2, s2)
					}
				}
			}
		}
		return nil, &geminiUpstreamError{
			status:  status,
			message: extractGeminiErrorMessage(string(raw), status),
			body:    string(raw),
		}
	}
	return unwrapCodeAssist(raw, status)
}

// geminiString reads one string field off a possibly-nil Gemini target.
func geminiString(t *GeminiTarget, pick func(*GeminiTarget) string) string {
	if t == nil {
		return ""
	}
	return pick(t)
}

func doCodeAssistRequest(ctx context.Context, base, token, model string, geminiReq *gemini.GeminiGenerateRequest, project, userAgent string) (int, http.Header, []byte, error) {
	geminiReq.SessionID = geminiSessionID
	envelope := &gemini.GeminiCodeAssistEnvelope{
		Model:        model,
		Project:      project,
		UserPromptID: gemini.RandomID(),
		Request:      geminiReq,
	}
	reqBody, err := json.Marshal(envelope)
	if err != nil {
		return 0, nil, nil, anyerr.Wrapf(err, "marshal gemini request", "GEMINI_ENCODE")
	}
	target := fmt.Sprintf("%s/v1internal:generateContent", base)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(reqBody))
	if err != nil {
		return 0, nil, nil, anyerr.Wrapf(err, "build gemini request", "GEMINI_ENCODE")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	// Code Assist gates generateContent on the client identity: the same
	// credential answers 403 SUBSCRIPTION_REQUIRED without the User-Agent
	// its OAuth client is registered under.
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	client := egress.StreamClient()
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, nil, anyerr.Wrapf(err, "Gemini network error", "GEMINI_UPSTREAM")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return 0, nil, nil, anyerr.Wrapf(err, "read gemini response", "GEMINI_UPSTREAM")
	}
	return resp.StatusCode, resp.Header, raw, nil
}

// unwrapCodeAssist returns the inner generateContent response, peeling the
// Code Assist {response: ...} wrapper when present (parsed.response ?? parsed).
func unwrapCodeAssist(raw []byte, status int) (*gemini.GeminiGenerateResponse, error) {
	var parsed gemini.GeminiGenerateResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, anyerr.Wrapf(err, "decode gemini response", "GEMINI_UPSTREAM")
	}
	var wrapped struct {
		Response *gemini.GeminiGenerateResponse `json:"response"`
	}
	if json.Unmarshal(raw, &wrapped) == nil && wrapped.Response != nil {
		return wrapped.Response, nil
	}
	return &parsed, nil
}

func isAutoFallbackStatus(status int) bool {
	return status == 401 || status == 403 || status == 404
}

func retryAfterMs(header string) int64 {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0
	}
	if secs, err := strconv.Atoi(header); err == nil && secs > 0 {
		return int64(secs) * 1000
	}
	if t, perr := http.ParseTime(header); perr == nil {
		ms := time.Until(t).Milliseconds()
		if ms > 0 {
			return ms
		}
	}
	return 0
}

// geminiSessionID is the per-process Code Assist session id (one value for
// the server's lifetime).
var geminiSessionID = gemini.RandomID()

// geminiCooldownKey includes the account scope. A key of only mode and model
// parks every same-mode account in the process after one 429, so a pool or
// hub never reaches the next account.
func geminiCooldownKey(up *Upstream, model string) string {
	mode := "oauth"
	scope := ""
	if up != nil {
		scope = up.CatalogScope
		if up.Gemini != nil && up.Gemini.APIKeyMode {
			mode = "api-key"
		}
	}
	return "gemini:" + mode + ":" + scope + ":" + model
}

// geminiCooldowns tracks per-route cooldowns: a 429 from any route parks that
// route's key for the Retry-After window so the next call fails fast instead
// of hammering the upstream.
type geminiCooldown struct {
	mu    sync.Mutex
	until map[string]time.Time
}

var geminiCooldowns = &geminiCooldown{until: map[string]time.Time{}}

func (c *geminiCooldown) remainingMs(key string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	u, ok := c.until[key]
	if !ok {
		return 0
	}
	rem := time.Until(u).Milliseconds()
	if rem <= 0 {
		delete(c.until, key)
		return 0
	}
	return rem
}

func (c *geminiCooldown) set(key string, ms int64) {
	if ms <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// Without this sweep an entry is removed only when that exact key is
	// queried again, so a key that is set and never asked for lives for the
	// lifetime of the process.
	if len(c.until) >= maxGeminiCooldownEntries {
		now := time.Now()
		for k, u := range c.until {
			if !u.After(now) {
				delete(c.until, k)
			}
		}
	}
	c.until[key] = time.Now().Add(time.Duration(ms) * time.Millisecond)
}

// maxGeminiCooldownEntries is the size at which set() sweeps expired entries.
const maxGeminiCooldownEntries = 512

// geminiErrorStatusMessage extracts an HTTP status + message from a Gemini
// egress error so the pool ring can decide whether to fail over.
func geminiErrorStatusMessage(err error) (int, string) {
	var ge *geminiUpstreamError
	if errorsAsGemini(err, &ge) {
		return ge.status, ge.message
	}
	return http.StatusBadGateway, err.Error()
}

// GeminiCodeAssistMetadata builds the ClientMetadata for loadCodeAssist. The
// two identities do not take the same shape: Antigravity's endpoint is sent
// {ideType} alone, while gemini-cli additionally carries platform +
// pluginType. Sending the gemini-cli shape to the Antigravity upstream is the
// gemini-cli shape to the Antigravity upstream is the kind of extra field the
// endpoint later rejects, so the shapes stay separate. Provider-owned quota
// reads in internal/provider/usage_gemini.go call this too, so the wire shape
// lives in one place.
func GeminiCodeAssistMetadata(ideType string) map[string]interface{} {
	if ideType == "ANTIGRAVITY" {
		return map[string]interface{}{"ideType": ideType}
	}
	platform := "PLATFORM_UNSPECIFIED"
	if runtime.GOOS == "darwin" {
		platform = "DARWIN_ARM64"
	}
	return map[string]interface{}{
		"ideType":    ideType,
		"platform":   platform,
		"pluginType": "GEMINI",
	}
}

// resolveCodeAssistProject calls loadCodeAssist to discover the project for the
// OAuth account, caching by token.
func resolveCodeAssistProject(ctx context.Context, base, token, ideType string) (string, error) {
	if p, ok := codeAssistProjects.get(token); ok {
		return p, nil
	}
	if ideType == "" {
		ideType = geminiIDETypeDefault
	}
	target := fmt.Sprintf("%s/v1internal:loadCodeAssist", base)
	reqBody, _ := json.Marshal(map[string]interface{}{
		"metadata": GeminiCodeAssistMetadata(ideType),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(reqBody))
	if err != nil {
		return "", anyerr.Wrapf(err, "build loadCodeAssist request", "GEMINI_OAUTH")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := egress.NewClient(30 * time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return "", anyerr.Wrapf(err, "loadCodeAssist network error", "GEMINI_OAUTH")
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", anyerr.Newf(fmt.Sprintf("loadCodeAssist HTTP %d", resp.StatusCode), "GEMINI_OAUTH")
	}
	var parsed struct {
		CloiudCompanionProject string `json:"cloudaicompanionProject"`
	}
	_ = json.Unmarshal(raw, &parsed)
	project := parsed.CloiudCompanionProject
	if project == "" {
		// A consumer account has no Cloud project to bind, and Code Assist
		// answers loadCodeAssist 200 without one. Rejecting here broke every
		// request for those accounts even though generateContent accepts an
		// empty project; the empty value is cached so the call is not repeated.
		codeAssistProjects.set(token, "")
		return "", nil
	}
	codeAssistProjects.set(token, project)
	return project, nil
}

type geminiUpstreamError struct {
	status  int
	message string
	body    string
}

func (e *geminiUpstreamError) Error() string { return e.message }

func extractGeminiErrorMessage(body string, status int) string {
	var parsed struct {
		Error *gemini.GeminiError `json:"error"`
	}
	if json.Unmarshal([]byte(body), &parsed) == nil && parsed.Error != nil {
		if parsed.Error.Message != "" {
			msg := strings.TrimSpace(parsed.Error.Message)
			// Vendor-authored message only, bounded so a compromised
			// upstream cannot smuggle secrets through the error path.
			if len(msg) > 300 {
				msg = msg[:300]
			}
			return msg
		}
	}
	return fmt.Sprintf("Gemini upstream error (HTTP %d)", status)
}

func writeGeminiError(w http.ResponseWriter, err error) {
	var ge *geminiUpstreamError
	if errorsAsGemini(err, &ge) {
		writeJSONError(w, ge.status, "proxy_error", ge.message)
		return
	}
	writeJSONError(w, http.StatusBadGateway, "upstream_error", err.Error())
}

func errorsAsGemini(err error, target **geminiUpstreamError) bool {
	if e, ok := err.(*geminiUpstreamError); ok {
		*target = e
		return true
	}
	return false
}

// writeGeminiResponse translates the Gemini generateContent response back to
// the inbound wire format and writes it. Streaming requests get a faked SSE
// lifecycle built from the single non-stream response (which always calls
// non-stream generateContent and synthesizes SSE).
func writeGeminiResponse(w http.ResponseWriter, path string, resp *gemini.GeminiGenerateResponse, model string, stream bool) {
	switch path {
	case "/v1/chat/completions":
		openai := gemini.GeminiToOpenAI(resp, model)
		if openai.Error != nil {
			writeJSONError(w, http.StatusBadGateway, openai.Error.Type, openai.Error.Message)
			return
		}
		if stream {
			writeOpenAIChatStream(w, openai, model)
			return
		}
		writeGeminiJSON(w, http.StatusOK, openai)
	case "/v1/messages":
		anthropic := gemini.GeminiToAnthropic(resp, model, 0)
		if anthropic.IsAnthropicError() {
			typ, msg, code := anthropic.AnthropicError()
			writeAnthropicError(w, typ, msg, code)
			return
		}
		if stream {
			writeAnthropicStream(w, anthropic, model)
			return
		}
		writeGeminiJSON(w, http.StatusOK, anthropic)
	case "/v1/responses":
		responses := gemini.GeminiToOpenAIResponses(resp, model)
		if stream {
			writeOpenAIResponsesStream(w, responses)
			return
		}
		writeGeminiJSON(w, http.StatusOK, responses)
	default:
		writeJSONError(w, http.StatusNotFound, "not_found_error", "unsupported gemini route")
	}
}

func writeGeminiJSON(w http.ResponseWriter, status int, v interface{}) {
	raw, err := json.Marshal(v)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "proxy_error", "encode gemini response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func writeAnthropicError(w http.ResponseWriter, typ, msg, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	payload, _ := json.Marshal(map[string]interface{}{
		"type":  "error",
		"error": map[string]string{"type": typ, "message": msg, "code": code},
	})
	_, _ = w.Write(payload)
}

func flushWriter(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func writeSseEvent(w http.ResponseWriter, event string, data interface{}) {
	raw, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(raw))
	flushWriter(w)
}

func writeOpenAIChatStream(w http.ResponseWriter, openai *gemini.OpenAIChatResponse, model string) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	id := openai.ID
	if id == "" {
		id = "chatcmpl_" + gemini.RandomID()
	}
	var content, reasoning string
	if len(openai.Choices) > 0 {
		content = gemini.MessageText(openai.Choices[0].Message)
		reasoning = openai.Choices[0].Message.ReasoningContent
	}
	if reasoning != "" {
		writeSseEvent(w, "chat.completion.chunk", map[string]interface{}{
			"id":     id,
			"object": "chat.completion.chunk",
			"model":  model,
			"choices": []map[string]interface{}{{
				"index":         0,
				"delta":         map[string]interface{}{"role": "assistant", "reasoning_content": reasoning},
				"finish_reason": nil,
			}},
		})
	}
	writeSseEvent(w, "chat.completion.chunk", map[string]interface{}{
		"id":     id,
		"object": "chat.completion.chunk",
		"model":  model,
		"choices": []map[string]interface{}{{
			"index":         0,
			"delta":         map[string]interface{}{"role": "assistant", "content": content},
			"finish_reason": nil,
		}},
	})
	writeSseEvent(w, "chat.completion.chunk", map[string]interface{}{
		"id":     id,
		"object": "chat.completion.chunk",
		"model":  model,
		"choices": []map[string]interface{}{{
			"index":         0,
			"delta":         map[string]interface{}{},
			"finish_reason": "stop",
		}},
	})
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flushWriter(w)
}

func writeAnthropicStream(w http.ResponseWriter, msg *gemini.AnthropicMessageResponse, model string) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	id := msg.ID
	if id == "" {
		id = "msg_" + gemini.RandomID()
	}
	inputTokens := 0
	if msg.Usage != nil {
		inputTokens = msg.Usage.InputTokens
	}
	writeSseEvent(w, "message_start", map[string]interface{}{
		"type": "message_start",
		"message": map[string]interface{}{
			"id":            id,
			"type":          "message",
			"role":          "assistant",
			"model":         model,
			"content":       []interface{}{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage":         map[string]interface{}{"input_tokens": inputTokens, "output_tokens": 0},
		},
	})
	for index, block := range msg.Content {
		switch block.Type {
		case "thinking":
			writeSseEvent(w, "content_block_start", map[string]interface{}{
				"type":          "content_block_start",
				"index":         index,
				"content_block": map[string]interface{}{"type": "thinking", "thinking": "", "signature": ""},
			})
			if block.Thinking != "" {
				writeSseEvent(w, "content_block_delta", map[string]interface{}{
					"type":  "content_block_delta",
					"index": index,
					"delta": map[string]interface{}{"type": "thinking_delta", "thinking": block.Thinking},
				})
			}
			if block.Signature != "" {
				writeSseEvent(w, "content_block_delta", map[string]interface{}{
					"type":  "content_block_delta",
					"index": index,
					"delta": map[string]interface{}{"type": "signature_delta", "signature": block.Signature},
				})
			}
		case "tool_use":
			cb := map[string]interface{}{"type": "tool_use", "id": block.ID, "name": block.Name, "input": map[string]interface{}{}}
			if block.ThoughtSignature != "" {
				cb["thought_signature"] = block.ThoughtSignature
			}
			writeSseEvent(w, "content_block_start", map[string]interface{}{
				"type":          "content_block_start",
				"index":         index,
				"content_block": cb,
			})
			writeSseEvent(w, "content_block_delta", map[string]interface{}{
				"type":  "content_block_delta",
				"index": index,
				"delta": map[string]interface{}{"type": "input_json_delta", "partial_json": string(block.Input)},
			})
		case "redacted_thinking":
			writeSseEvent(w, "content_block_start", map[string]interface{}{
				"type":          "content_block_start",
				"index":         index,
				"content_block": block,
			})
		default:
			writeSseEvent(w, "content_block_start", map[string]interface{}{
				"type":          "content_block_start",
				"index":         index,
				"content_block": map[string]interface{}{"type": "text", "text": ""},
			})
			if block.Text != "" {
				writeSseEvent(w, "content_block_delta", map[string]interface{}{
					"type":  "content_block_delta",
					"index": index,
					"delta": map[string]interface{}{"type": "text_delta", "text": block.Text},
				})
			}
		}
		writeSseEvent(w, "content_block_stop", map[string]interface{}{"type": "content_block_stop", "index": index})
	}
	stopReason := msg.StopReason
	delta := map[string]interface{}{"stop_reason": stopReason}
	if msg.StopSequence != nil {
		delta["stop_sequence"] = *msg.StopSequence
	}
	outputTokens := 0
	if msg.Usage != nil {
		outputTokens = msg.Usage.OutputTokens
	}
	writeSseEvent(w, "message_delta", map[string]interface{}{
		"type":  "message_delta",
		"delta": delta,
		"usage": map[string]interface{}{"output_tokens": outputTokens},
	})
	writeSseEvent(w, "message_stop", map[string]interface{}{"type": "message_stop"})
}

func writeOpenAIResponsesStream(w http.ResponseWriter, response *gemini.OpenAIResponsesResponse) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	sequence := 0
	emit := func(typ string, payload map[string]interface{}) {
		payload["type"] = typ
		payload["sequence_number"] = sequence
		sequence++
		writeSseEvent(w, typ, payload)
	}
	inProgress := map[string]interface{}{
		"id":                  response.ID,
		"object":              response.Object,
		"created_at":          response.CreatedAt,
		"status":              "in_progress",
		"error":               nil,
		"incomplete_details":  nil,
		"model":               response.Model,
		"output":              []interface{}{},
		"parallel_tool_calls": response.ParallelToolCalls,
		"usage":               nil,
	}
	emit("response.created", map[string]interface{}{"response": inProgress})
	emit("response.in_progress", map[string]interface{}{"response": inProgress})

	for outputIndex, item := range response.Output {
		addedItem := map[string]interface{}{
			"id":                item.ID,
			"type":              item.Type,
			"summary":           item.Summary,
			"encrypted_content": item.EncryptedContent,
			"role":              item.Role,
			"content":           item.Content,
			"call_id":           item.CallID,
			"name":              item.Name,
			"arguments":         item.Arguments,
			"output":            item.Output,
		}
		addedItem["status"] = "in_progress"
		switch item.Type {
		case "reasoning":
			addedItem["summary"] = []interface{}{}
		case "message":
			addedItem["content"] = []interface{}{}
		case "function_call":
			addedItem["arguments"] = ""
		}
		emit("response.output_item.added", map[string]interface{}{"output_index": outputIndex, "item": addedItem})

		switch item.Type {
		case "reasoning":
			for summaryIndex, part := range item.Summary {
				emit("response.reasoning_summary_part.added", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "summary_index": summaryIndex,
					"part": map[string]interface{}{"type": "summary_text", "text": ""},
				})
				if part.Text != "" {
					emit("response.reasoning_summary_text.delta", map[string]interface{}{
						"item_id": item.ID, "output_index": outputIndex, "summary_index": summaryIndex,
						"delta": part.Text,
					})
				}
				emit("response.reasoning_summary_text.done", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "summary_index": summaryIndex,
					"text": part.Text,
				})
				emit("response.reasoning_summary_part.done", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "summary_index": summaryIndex,
					"part": part,
				})
			}
		case "message":
			for contentIndex, part := range item.Content {
				emptyPart := part
				emptyPart.Text = ""
				emit("response.content_part.added", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "content_index": contentIndex,
					"part": emptyPart,
				})
				if part.Text != "" {
					emit("response.output_text.delta", map[string]interface{}{
						"item_id": item.ID, "output_index": outputIndex, "content_index": contentIndex,
						"delta": part.Text, "logprobs": []interface{}{},
					})
				}
				emit("response.output_text.done", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "content_index": contentIndex,
					"text": part.Text, "logprobs": []interface{}{},
				})
				emit("response.content_part.done", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "content_index": contentIndex,
					"part": part,
				})
			}
		case "function_call":
			if item.Arguments != "" {
				emit("response.function_call_arguments.delta", map[string]interface{}{
					"item_id": item.ID, "output_index": outputIndex, "delta": item.Arguments,
				})
			}
			emit("response.function_call_arguments.done", map[string]interface{}{
				"item_id": item.ID, "output_index": outputIndex, "arguments": item.Arguments,
			})
		}
		// Emit the real (completed) item so the client sees final content.
		emit("response.output_item.done", map[string]interface{}{"output_index": outputIndex, "item": item})
	}
	// A 200 from the vendor can still carry an error payload (e.g. WorkBuddy
	// error codes). Codex reads the terminal event as the outcome, so a failed
	// response must be reported as response.failed — never as completed.
	if response.Status == "failed" {
		emit("response.failed", map[string]interface{}{"response": response})
		return
	}
	emit("response.completed", map[string]interface{}{"response": response})
}
