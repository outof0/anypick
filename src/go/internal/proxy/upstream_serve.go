package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/protocol"
)

// egressKind names which leaf serves one (request, upstream) pair.
//
// There is exactly one copy of this decision. Before it was extracted the
// single-account path and the pool ring each carried their own copy of the
// branch table, and they had already drifted: the ring's copy skipped the
// context-window rewrite every single-account branch applies, so a member
// that hit the context limit returned a raw vendor error and the client never
// compacted. Two copies of one decision is not duplication, it is a bug that
// has not happened yet — or, as here, one that already did.
type egressKind int

const (
	kindGemini egressKind = iota
	kindNativeAnthropic
	kindTranslatedMessages
	kindOpenAIPath
	kindPassthrough
)

func egressKindFor(r *http.Request, up *Upstream) egressKind {
	if up == nil {
		return kindPassthrough
	}
	isMessages := r.Method == http.MethodPost &&
		(r.URL.Path == "/v1/messages" || r.URL.Path == "/messages")
	isGemini := r.Method == http.MethodPost &&
		(r.URL.Path == "/v1/chat/completions" ||
			r.URL.Path == "/v1/responses" ||
			r.URL.Path == "/v1/messages")
	switch {
	case isGemini && up.TranslateGemini:
		return kindGemini
	case isMessages && up.Anthropic != nil:
		return kindNativeAnthropic
	case isMessages && up.TranslateAnthropic:
		return kindTranslatedMessages
	case r.Method == http.MethodPost &&
		(r.URL.Path == "/v1/responses" ||
			(up.OpenAIPath != "" && (r.URL.Path == "/v1/chat/completions" || r.URL.Path == "/v1/completions"))):
		return kindOpenAIPath
	default:
		return kindPassthrough
	}
}

// Serve forwards one authenticated inbound request to the described upstream.
// Dispatch order for POST /v1/messages: native Anthropic target when present,
// else translation into chat completions when TranslateAnthropic, else plain
// passthrough. Everything else forwards to the OpenAI surface. The per-account
// Server and the Proxy Hub share this single egress path so the security
// posture cannot diverge.
func Serve(w http.ResponseWriter, r *http.Request, up *Upstream) {
	if up == nil || up.BaseURL == nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "no upstream")
		return
	}
	// Model enumeration is answered locally for every upstream whose provider
	// owns a catalog (Gemini's live Google list, WorkBuddy's product
	// catalogue), so a client that asks the proxy sees exactly the ids the
	// proxy can serve. Left to passthrough the request reaches the vendor,
	// which answers an HTML or plain-text 404 where the client expects JSON.
	// Every other upstream keeps the previous behaviour, and the branch lives
	// in Serve (not in the per-account Handler) so the pool ring and the hub
	// cannot drift away from it.
	if isListModels(r) {
		if up.Gemini != nil {
			serveGeminiModels(w, r, up)
			return
		}
		if up.ModelDiscovery != nil {
			serveDiscoveredModels(w, r, up)
			return
		}
	}
	switch egressKindFor(r, up) {
	case kindGemini:
		serveGemini(w, r, up)
		return
	case kindNativeAnthropic:
		serveNativeAnthropic(w, r, up)
		return
	case kindTranslatedMessages:
		serveTranslatedMessagesWith(w, r, up)
		return
	case kindOpenAIPath:
		if r.URL.Path == "/v1/responses" {
			serveOpenAIResponsesWith(w, r, up)
			return
		}
		reverseEgress(r, up, &commitSink{w: w}, reverseOpts{
			baseURL:   up.BaseURL,
			chatPath:  up.OpenAIPath,
			sanitizer: up.SanitizeOpenAIBody,
		})
		return
	}
	reverseEgress(r, up, &commitSink{w: w}, reverseOpts{
		baseURL:   up.BaseURL,
		sanitizer: up.SanitizeOpenAIBody,
	})
}

// flattenedNativeUpstream flattens a native Anthropic target and its parent
// Upstream into one *Upstream: the target wins, the parent fills whatever the
// target leaves empty.
//
// Both callers need this shape and neither may own the merge. The pool ring
// needs a plain *Upstream to hand to its capture leaf; the single-account path
// needs the same fields to build its ReverseProxy. The copy that used to live
// in the pool skipped the header default that resolveUpstreamAuth applies, so
// a target that left AuthHeader empty was forwarded with an empty header name
// — a request the vendor answers 401, indistinguishable from a dead token.

func flattenedNativeUpstream(up *Upstream) *Upstream {
	t := up.Anthropic
	if t == nil {
		return up
	}
	auth := t.Auth
	if auth == "" {
		auth = up.Auth
	}
	header, prefix := t.AuthHeader, t.AuthValuePrefix
	if header == "" {
		header, prefix = up.AuthHeader, up.AuthValuePrefix
	}
	provider := t.AuthProvider
	if provider == nil {
		provider = up.AuthProvider
	}
	headers := append(append([]ExtraHeader(nil), t.ExtraHeaders...), up.ExtraHeaders...)
	return &Upstream{
		BaseURL:         t.BaseURL,
		Auth:            auth,
		AuthHeader:      header,
		AuthValuePrefix: prefix,
		AuthProvider:    provider,
		ExtraHeaders:    headers,
		DynamicHeaders:  up.DynamicHeaders,
		// The native target carries no body sanitizer of its own; the
		// provider-owned Anthropic rewrite rides on the parent. Dropping it
		// here would silently turn strict-vendor validation failures (Grok's
		// `"required": null` rejection) back on for every native forward.
		SanitizeAnthropicBody: up.SanitizeAnthropicBody,
	}
}

// serveNativeAnthropic forwards /v1/messages verbatim to a vendor's native
// Anthropic-compatible endpoint (e.g. api.z.ai/api/anthropic). ReverseProxy
// joins the base path with the request path, so a base of …/anthropic plus
// /v1/messages lands on …/anthropic/v1/messages. The flattened upstream carries
// the resolved auth + headers, handed to the shared reverse egress.
func serveNativeAnthropic(w http.ResponseWriter, r *http.Request, up *Upstream) {
	flat := flattenedNativeUpstream(up)
	reverseEgress(r, flat, &commitSink{w: w}, reverseOpts{baseURL: flat.BaseURL, sanitizer: flat.SanitizeOpenAIBody, anthropicSanitizer: flat.SanitizeAnthropicBody})
}

// translatedBuildError carries the exact (status, type, message) a leaf must
// surface when the translated-request build fails, so the single shared builder
// and each caller's own sink (write vs capture) stay in agreement.
type translatedBuildError struct {
	status  int
	typ     string
	message string
}

func (e *translatedBuildError) Error() string { return e.message }

// buildTranslatedChatRequest translates an inbound /v1/messages body and
// constructs the outbound /chat/completions request. It is shared by the
// committing single-account path (serveTranslatedMessagesWith) and the pool
// ring's capturing path (translatedWithCapture): the request side is identical,
// so it lives in one place. The caller reads the capped body and injects auth,
// then maps any returned error to its own response (write vs capture).
//
// auth is intentionally left to the caller: the committing path logs the refresh
// failure (proxyLogf) before responding, and that side effect must not be lost
// by folding the call into the shared builder.
func buildTranslatedChatRequest(r *http.Request, up *Upstream, body []byte) (*http.Request, []byte, *translatedBuildError) {
	translated, terr := translateRequestBody(body)
	if terr != nil {
		return nil, nil, &translatedBuildError{http.StatusBadRequest, "invalid_request_error", terr.Error()}
	}
	if up.SanitizeOpenAIBody != nil {
		translated = up.SanitizeOpenAIBody(translated)
	}
	target := *up.BaseURL
	target.Path = strings.TrimSuffix(target.Path, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target.String(), bytes.NewReader(translated))
	if err != nil {
		// NewRequestWithContext only fails on a malformed URL; up.BaseURL is
		// always valid here, so this branch is unreachable in practice. The
		// committing path surfaces err.Error(); the capture path uses a fixed
		// "upstream unavailable" string — both are inert for a never-taken path.
		return nil, nil, &translatedBuildError{http.StatusBadGateway, "upstream_error", err.Error()}
	}
	return req, translated, nil
}

// serveTranslatedMessagesWith is the shared implementation used by both the
// per-account Server and the hub.
func serveTranslatedMessagesWith(w http.ResponseWriter, r *http.Request, up *Upstream) {
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
	req, translated, be := buildTranslatedChatRequest(r, up, body)
	if be != nil {
		writeJSONError(w, be.status, be.typ, be.message)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if err := injectUpstreamAuthFields(r.Context(), req, up); err != nil {
		proxyLogf("credential refresh failed: %s", redactAuthError(err))
		writeJSONError(w, http.StatusBadGateway, "proxy_error", "credential refresh failed")
		return
	}

	client := egress.StreamClient()
	resp, err := client.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "upstream unavailable")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		rawBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		f := classifyTranslatedFailure(resp, body, translated, rawBody)
		if f.ContextWindow {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("request-id", extractRequestID(f.Body))
		} else {
			w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		}
		w.WriteHeader(f.Status)
		_, _ = w.Write(f.Body)
		return
	}
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "text/event-stream") || strings.Contains(ct, "stream") {
		_ = protocol.TranslateStreamingResponse(resp, w)
		return
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "truncated response")
		return
	}
	out, terr := protocol.TranslateResponse(raw)
	if terr != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", terr.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

// translatedFailure is one non-2xx upstream answer on the translated
// /v1/messages path, already converted: a context-window error becomes the
// canonical 400 compaction body, everything else passes through verbatim.
//
// It carries the upstream headers for a caller that replays the response
// later (the pool ring needs Retry-After to price a cooldown). A caller that
// writes straight through sets Content-Type itself and ignores them.
type translatedFailure struct {
	Status        int
	Body          []byte
	ContextWindow bool
	Header        http.Header
}

// classifyTranslatedFailure logs why an upstream rejected a translated
// request and decides what the client should receive. It is shared by the
// committing path and the pool's capturing path, which differ in *where* the
// bytes go — not in what they are. The pool used to have its own copy without
// the context-window branch, so a member that hit the limit returned a raw
// vendor error and the client never compacted.
func classifyTranslatedFailure(resp *http.Response, sent, forwarded, raw []byte) translatedFailure {
	status := resp.StatusCode
	if status >= 400 && status < 500 {
		// Log the vendor envelope on 4xx: it names the real rejection
		// (channel/quota/model variants) that the client would otherwise
		// see only opaquely. Vendor-authored text only, safe to log.
		proxyLogf("upstream %d; vendor says: %s", status, describeVendorError(string(raw), status))
		proxyLogf("upstream %d; failed shape: %s", status, describeAnthropicShape(sent))
		if strings.Contains(string(raw), "11128") {
			proxyLogf("upstream 11128; sanitized: %s", describeSanitizedOpenAI(forwarded))
		}
	}
	if IsContextWindowError(string(raw)) {
		body := anthropicContextWindowErrorBody(string(raw), resp.Header.Get("request-id"))
		header := resp.Header.Clone()
		header.Set("Content-Type", "application/json")
		header.Set("request-id", extractRequestID(body))
		return translatedFailure{
			Status:        http.StatusBadRequest,
			Body:          body,
			ContextWindow: true,
			Header:        header,
		}
	}
	return translatedFailure{Status: status, Body: raw, Header: resp.Header}
}

// resolveUpstreamAuth returns the header/prefix/token to forward for an
// OpenAI-surface request. A configured AuthProvider wins over static Auth.
// On provider error it fails closed with an error: forwarding an empty or
// stale token would surface only as an upstream 401 and hide the real cause.
func resolveUpstreamAuth(ctx context.Context, up *Upstream) (header, prefix, token string, err error) {
	header, prefix = up.AuthHeader, up.AuthValuePrefix
	if header == "" {
		header = "Authorization"
		prefix = "Bearer "
	}
	token = up.Auth
	if up.AuthProvider != nil {
		got, perr := up.AuthProvider(ctx)
		if perr != nil {
			return header, prefix, "", perr
		}
		token = got
	}
	return header, prefix, token, nil
}

func applyExtraHeaders(out *http.Request, headers []ExtraHeader) {
	for _, h := range headers {
		if h.Name == "" {
			continue
		}
		if h.Drop {
			out.Header.Del(h.Name)
			continue
		}
		out.Header.Set(h.Name, h.Value)
	}
}

func requestExtraHeaders(ctx context.Context, up *Upstream) ([]ExtraHeader, error) {
	headers := append([]ExtraHeader(nil), up.ExtraHeaders...)
	if up.DynamicHeaders == nil {
		return headers, nil
	}
	dynamic, err := up.DynamicHeaders(ctx)
	if err != nil {
		return nil, err
	}
	return append(headers, dynamic...), nil
}

func clearUpstreamAuthHeaders(out *http.Request) {
	out.Header.Del("Authorization")
	out.Header.Del("x-api-key")
	out.Header.Del("api-key")
}

// joinUpstreamPath appends an inbound path to an upstream base path. Vendors
// document their OpenAI base with its version (https://api.deepseek.com/v1)
// and clients send the version too (/v1/chat/completions), so a plain join
// sent .../v1/v1/chat/completions, which vendors answer 404. One /v1 is dropped
// only when the base already ends in it: a base without a version segment
// (Grok's CLI proxy) keeps the inbound path whole.
func joinUpstreamPath(basePath, inbound string) string {
	base := strings.TrimSuffix(basePath, "/")
	if strings.HasSuffix(base, "/v1") && (inbound == "/v1" || strings.HasPrefix(inbound, "/v1/")) {
		inbound = strings.TrimPrefix(inbound, "/v1")
	}
	if inbound != "" && !strings.HasPrefix(inbound, "/") {
		inbound = "/" + inbound
	}
	return base + inbound
}

// setUpstreamAuth presents token the vendor's way. A keyless upstream (a local
// model server) gets no auth header at all: `Authorization: Bearer ` with
// nothing after it is a malformed credential some servers reject, where no
// header is simply "unauthenticated".
func setUpstreamAuth(out *http.Request, header, prefix, token string) {
	if token == "" {
		return
	}
	out.Header.Set(header, prefix+token)
}

func injectUpstreamAuthFields(ctx context.Context, out *http.Request, up *Upstream) error {
	header, prefix, token, err := resolveUpstreamAuth(ctx, up)
	if err != nil {
		return err
	}
	extraHeaders, err := requestExtraHeaders(ctx, up)
	if err != nil {
		return err
	}
	clearUpstreamAuthHeaders(out)
	setUpstreamAuth(out, header, prefix, token)
	applyExtraHeaders(out, extraHeaders)
	return nil
}

// redactAuthError keeps credential-refresh failures diagnosable without
// letting vendor/OIDC payloads cross the output boundary. Callers log this
// and return a generic "credential refresh failed" to the client.
func redactAuthError(err error) string {
	if err == nil {
		return "unknown"
	}
	msg := err.Error()
	// anyerr messages are already safe (no raw bodies after the OAuth
	// redaction); still bound the length so a compromised endpoint cannot
	// smuggle bulk data through logs.
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

func extractRequestID(body []byte) string {
	var payload struct {
		RequestID string `json:"request_id"`
	}
	if json.Unmarshal(body, &payload) == nil {
		return payload.RequestID
	}
	return ""
}

func rewriteContextWindowResponse(resp *http.Response, req *http.Request) error {
	if resp.StatusCode != 400 && resp.StatusCode != 413 {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil
	}
	_ = resp.Body.Close()
	if !IsContextWindowError(string(raw)) {
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		return nil
	}
	path := req.URL.Path
	isAnthropic := path == "/v1/messages" || path == "/messages"
	// OpenAI Responses SSE compaction signal
	if path == "/v1/responses" {
		if req.Header.Get("Accept") == "text/event-stream" || strings.Contains(req.URL.RawQuery, "stream") {
			sse := openAIResponsesContextWindowSSE()
			resp.StatusCode = 200
			resp.Header.Set("Content-Type", "text/event-stream; charset=utf-8")
			resp.Header.Set("Cache-Control", "no-cache, no-transform")
			resp.Header.Set("Connection", "keep-alive")
			resp.Header.Del("Content-Length")
			resp.ContentLength = int64(len(sse))
			resp.Body = io.NopCloser(bytes.NewReader(sse))
			return nil
		}
	}
	var body []byte
	var status int
	if isAnthropic {
		body = anthropicContextWindowErrorBody(string(raw), resp.Header.Get("request-id"))
		status = 400
		resp.Header.Set("request-id", extractRequestID(body))
	} else {
		body = openAIContextWindowErrorBody()
		status = 400
	}
	resp.StatusCode = status
	resp.Header.Set("Content-Type", "application/json; charset=utf-8")
	resp.Header.Del("Content-Length")
	resp.Header.Del("Content-Encoding")
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	return nil
}

func openAIResponsesContextWindowSSE() []byte {
	// Minimal response.failed SSE that Codex/OpenAI Responses clients treat as compaction trigger.
	payload := `{"type":"response.failed","sequence_number":0,"response":{"id":"resp_context","object":"response","status":"failed","error":{"code":"context_length_exceeded","message":"` + openAIContextWindowMessage + `"}}}` + "\n"
	return []byte("event: response.failed\ndata: " + payload + "\n\n")
}

// describeAnthropicShape summarizes an Anthropic request for diagnostics:
// model, top-level keys, per-message roles with block types and sizes.
// Block TEXT is never logged.
func describeAnthropicShape(body []byte) string {
	var v map[string]any
	if json.Unmarshal(body, &v) != nil {
		return "unparseable"
	}
	var sb strings.Builder
	if m, ok := v["model"].(string); ok {
		sb.WriteString("model=" + m + " ")
	}
	if sys, ok := v["system"]; ok && sys != nil {
		switch s := sys.(type) {
		case string:
			if s != "" {
				sb.WriteString("system=text#" + strconv.Itoa(len(s)) + " ")
			}
		case []any:
			sb.WriteString("system=blocks#" + strconv.Itoa(len(s)) + " ")
		default:
			sb.WriteString("system=yes ")
		}
	}
	if s, ok := v["stream"].(bool); ok && s {
		if n, ok := v["max_tokens"].(float64); ok {
			sb.WriteString("maxtokens=" + strconv.Itoa(int(n)) + " ")
		}
		if t, ok := v["temperature"].(float64); ok {
			sb.WriteString("temp=" + strconv.FormatFloat(t, 'f', -1, 64) + " ")
		}
		if tc, ok := v["tool_choice"].(map[string]any); ok {
			sb.WriteString("toolchoice=")
			sb.WriteString(stringOrEmpty(tc["type"]))
			sb.WriteString(" ")
		}
		sb.WriteString("stream ")
	}
	if t, ok := v["thinking"].(map[string]any); ok {
		sb.WriteString("thinking=")
		sb.WriteString(stringOrEmpty(t["type"]))
		sb.WriteString(" ")
	}
	if msgs, ok := v["messages"].([]any); ok {
		sb.WriteString("msgs=[")
		for i, m := range msgs {
			if i > 0 {
				sb.WriteString(",")
			}
			mm, _ := m.(map[string]any)
			role, _ := mm["role"].(string)
			sb.WriteString(role + ":")
			switch c := mm["content"].(type) {
			case string:
				sb.WriteString("text#" + strconv.Itoa(len(c)))
			case []any:
				var parts []string
				for _, b := range c {
					if bm, ok := b.(map[string]any); ok {
						t, _ := bm["type"].(string)
						switch t {
						case "text":
							s, _ := bm["text"].(string)
							parts = append(parts, "text#"+strconv.Itoa(len(s)))
						case "tool_use", "tool_result", "thinking", "redacted_thinking", "image", "document", "server_tool_use", "web_search_tool_result", "mcp_tool_use", "mcp_tool_result", "container_upload":
							parts = append(parts, t)
						default:
							parts = append(parts, "other:"+t)
						}
					}
				}
				sb.WriteString(strings.Join(parts, "+"))
			}
		}
		sb.WriteString("]")
	}
	if tools, ok := v["tools"].([]any); ok {
		// Counts only: tool names are user-defined and must not reach logs.
		sb.WriteString("tools=" + strconv.Itoa(len(tools)))
	}
	return sb.String()
}

func stringOrEmpty(v any) string {
	s, _ := v.(string)
	return s
}

// Fingerprints only — no prompt text, no raw dump: a raw body could hold
// prompts, history, file contents and pasted secrets (P0). Diagnostics stay in
// the redacted log line above.

func describeSanitizedOpenAI(body []byte) string {
	var v map[string]any
	if json.Unmarshal(body, &v) != nil {
		return "unparseable"
	}
	var sb strings.Builder
	if m, ok := v["model"].(string); ok {
		sb.WriteString("model=" + m + " ")
	}
	raw := strings.ToLower(string(body))
	for _, p := range []string{
		"official cli", "x-anthropic-billing-header", "github.com/anthropics",
		"claude-haiku", "claude-sonnet", "claude-opus", "codex", "openai",
		"mcp",
	} {
		if strings.Contains(raw, p) {
			sb.WriteString("has=" + strings.ReplaceAll(p, " ", "_") + " ")
		}
	}
	if msgs, ok := v["messages"].([]any); ok {
		sb.WriteString("n=" + strconv.Itoa(len(msgs)) + " ")
		if len(msgs) > 0 {
			if mm, ok := msgs[0].(map[string]any); ok {
				sb.WriteString("lead=" + stringOrEmpty(mm["role"]) + " ")
			}
		}
	}
	if tools, ok := v["tools"].([]any); ok {
		sb.WriteString("tools=" + strconv.Itoa(len(tools)))
	}
	return sb.String()
}

// describeVendorError extracts an allowlisted fingerprint from the vendor
// envelope: numeric code and request id only. Vendor message text and raw
// bytes never reach logs: a compromised or chatty upstream can echo prompts,
// tool arguments or secrets into its error message, and proxy.log gets
// attached to bug reports.
func describeVendorError(raw string, status int) string {
	var env struct {
		Code      int    `json:"code"`
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal([]byte(raw), &env) != nil || (env.Code == 0 && env.RequestID == "") {
		// Vendor edges (APISIX/openresty) answer 502/504 with HTML; the title
		// is the only part that says who failed, and it is vendor-authored.
		if title := htmlTitle(raw); title != "" {
			return "html title=" + strconv.Quote(title)
		}
		return "unparseable status=" + strconv.Itoa(status) + " len=" + strconv.Itoa(len(raw))
	}
	out := "code=" + strconv.Itoa(env.Code)
	if env.RequestID != "" {
		out += " req=" + env.RequestID
	}
	return out
}

// htmlTitle extracts a short <title> from a gateway error page. Bounded: the
// log must not carry bulk vendor HTML.
func htmlTitle(raw string) string {
	lower := strings.ToLower(raw)
	start := strings.Index(lower, "<title>")
	if start < 0 {
		return ""
	}
	rest := lower[start+len("<title>"):]
	end := strings.Index(rest, "</title>")
	if end < 0 {
		return ""
	}
	title := strings.TrimSpace(raw[start+len("<title>") : start+len("<title>")+end])
	if len(title) > 120 {
		title = title[:120]
	}
	return title
}

// nullLeafPaths lists JSON paths whose value is null, for vendor-rejection
// diagnostics. Paths and key names only — never values — so no prompt,
// history, or secret can cross into the log. Bounded to 20 paths.
func nullLeafPaths(body []byte) string {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "unparseable"
	}
	var out []string
	var walk func(v any, path string)
	walk = func(v any, path string) {
		if len(out) >= 20 {
			return
		}
		switch node := v.(type) {
		case map[string]any:
			for k, val := range node {
				p := path + "/" + k
				if val == nil {
					out = append(out, p)
					continue
				}
				walk(val, p)
			}
		case []any:
			for i, item := range node {
				walk(item, path+"["+strconv.Itoa(i)+"]")
			}
		}
	}
	walk(payload, "")
	if len(out) == 0 {
		return "none"
	}
	return strings.Join(out, ",")
}

func translateRequestBody(body []byte) ([]byte, error) { return protocol.TranslateRequest(body) }

// egressSink unifies the committing single-account reverse path and the pool
// ring's capturing path behind one ReverseProxy. commit()/reject()/onNon2xx()
// let the shared ModifyResponse behave correctly for each without a type switch
// at the call site; asResponseWriter() is the writer ReverseProxy streams into.
// Keeping the two paths behind one implementation is what stops them drifting
// (the ring's old copy had already dropped the context-window rewrite).
type egressSink interface {
	// commit marks a <400 response as streaming to the real client. The
	// committing sink is already there; the capture sink flips from buffering to
	// the underlying stream so an SSE response reaches the caller.
	commit()
	// reject terminates the request before any upstream call (oversized body or
	// credential-refresh failure). The committing sink writes it to the client;
	// the capture sink holds it for the ring to inspect or fail over on.
	reject(status int, header http.Header, body []byte)
	// onNon2xx handles a non-2xx upstream response from inside ModifyResponse.
	// The committing sink lets ReverseProxy stream the real response; the capture
	// sink records it and suppresses the duplicate body write.
	onNon2xx(resp *http.Response) error
	// asResponseWriter is the writer ReverseProxy streams the response into.
	asResponseWriter() http.ResponseWriter
}

// peekedBody replays a body prefix read for diagnostics while still closing
// the original stream, so ReverseProxy's Close reaches the vendor connection.
type peekedBody struct {
	io.Reader
	closer io.Closer
}

func (b *peekedBody) Close() error { return b.closer.Close() }

// reverseOpts selects the ReverseProxy target and request shaping for one
// reverse egress. chatPath pins the OpenAI chat surface onto a non-default
// path; sanitizer rewrites an OpenAI chat body for either that path or the
// vendor's default /v1/chat/completions passthrough; anthropicSanitizer
// rewrites a native Anthropic messages body for the same passthrough.
type reverseOpts struct {
	baseURL            *url.URL
	chatPath           string
	sanitizer          func([]byte) []byte
	anthropicSanitizer func([]byte) []byte
}

// commitSink is the committing egressSink: bytes go straight to the client.
type commitSink struct{ w http.ResponseWriter }

func (c *commitSink) commit() {}

func (c *commitSink) reject(status int, header http.Header, body []byte) {
	for k, vs := range header {
		for _, v := range vs {
			c.w.Header().Add(k, v)
		}
	}
	c.w.WriteHeader(status)
	_, _ = c.w.Write(body)
}

func (c *commitSink) onNon2xx(_ *http.Response) error { return nil }

func (c *commitSink) asResponseWriter() http.ResponseWriter { return c.w }

func jsonErrorHeader() http.Header {
	return http.Header{"Content-Type": []string{"application/json"}}
}

// reverseEgress builds the single ReverseProxy for every reverse surface
// (generic passthrough, OpenAI-path pinning, native Anthropic flattening) and
// drives it through the given sink. The committing callers pass a commitSink;
// the pool ring passes its captureWriter (which implements egressSink). The body
// cap is enforced here at the reverse door (per TestPipelineBodyPolicy): the
// bytes are read once, capped, and re-fed to ReverseProxy, so the reverse path
// is capped too — not only the gemini/translated doors, and not the
// pre-existing gap where the generic passthrough streamed the body untouched.
func reverseEgress(r *http.Request, up *Upstream, sink egressSink, opts reverseOpts) {
	body, err := ReadCappedBody(r, MaxBodyBytes)
	if errors.Is(err, ErrBodyTooLarge) {
		sink.reject(http.StatusRequestEntityTooLarge, jsonErrorHeader(),
			[]byte(jsonErrorBody("invalid_request_error",
				fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes))))
		return
	}
	if err != nil {
		sink.reject(http.StatusBadRequest, jsonErrorHeader(),
			[]byte(jsonErrorBody("invalid_request_error", "unreadable body")))
		return
	}
	var sanitized []byte
	sanitizing := false
	if opts.sanitizer != nil && r.Method == http.MethodPost &&
		(r.URL.Path == "/v1/chat/completions" || r.URL.Path == "/v1/completions") {
		sanitized = opts.sanitizer(body)
		sanitizing = true
	}
	if opts.anthropicSanitizer != nil && r.Method == http.MethodPost &&
		(r.URL.Path == "/v1/messages" || r.URL.Path == "/messages") {
		before := len(body)
		sanitized = opts.anthropicSanitizer(body)
		sanitizing = true
		if os.Getenv("ANYPICK_DEBUG_GROK_BODY") == "1" {
			proxyLogf("anthropic-sanitize changed=%v inlen=%d outlen=%d nullpaths=%s",
				string(sanitized) != string(body), before, len(sanitized), nullLeafPaths(body))
		}
	}
	// Re-feed the (capped, possibly sanitized) body so ReverseProxy streams the
	// right bytes. ReverseProxy drains r.Body, so this single read is the one
	// that counts for the cap.
	outBody := body
	if sanitizing {
		outBody = sanitized
	}
	r.Body = io.NopCloser(bytes.NewReader(outBody))
	r.ContentLength = int64(len(outBody))
	if r.GetBody == nil {
		b := outBody
		r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }
	}

	header, prefix, token, aerr := resolveUpstreamAuth(r.Context(), up)
	if aerr != nil {
		sink.reject(http.StatusBadGateway, jsonErrorHeader(),
			[]byte(jsonErrorBody("proxy_error", "credential refresh failed")))
		return
	}
	extraHeaders, aerr := requestExtraHeaders(r.Context(), up)
	if aerr != nil {
		sink.reject(http.StatusBadGateway, jsonErrorHeader(),
			[]byte(jsonErrorBody("proxy_error", "credential refresh failed")))
		return
	}
	target := *opts.baseURL
	if opts.chatPath != "" {
		target.Path = strings.TrimSuffix(target.Path, "/") + opts.chatPath
		target.RawPath = ""
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&target)
			pr.Out.Host = target.Host
			if opts.chatPath != "" {
				pr.Out.URL.Path = target.Path
				pr.Out.URL.RawPath = ""
			} else {
				pr.Out.URL.Path = joinUpstreamPath(target.Path, pr.In.URL.Path)
				// Keep an escaped segment escaped: "a%2Fb" decoded to "a/b"
				// becomes two segments, and the vendor answers 404.
				pr.Out.URL.RawPath = ""
				if raw := pr.In.URL.RawPath; raw != "" {
					pr.Out.URL.RawPath = joinUpstreamPath(target.EscapedPath(), raw)
				}
			}
			if sanitizing {
				pr.Out.Body = io.NopCloser(bytes.NewReader(sanitized))
				pr.Out.ContentLength = int64(len(sanitized))
				pr.Out.GetBody = func() (io.ReadCloser, error) {
					return io.NopCloser(bytes.NewReader(sanitized)), nil
				}
			}
			clearUpstreamAuthHeaders(pr.Out)
			setUpstreamAuth(pr.Out, header, prefix, token)
			applyExtraHeaders(pr.Out, extraHeaders)
		},
		Transport:     egress.Transport(),
		FlushInterval: 10 * time.Millisecond,
		ErrorLog:      ErrorLogger(),
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, err error) {
			// Transport errors surface as a verbatim 502; the transient class
			// never triggers failover. For the capture sink rw is the
			// captureWriter, so the ring sees the 502; for the committing sink
			// it is the real client writer. The cause goes to the log or the
			// user only ever sees "upstream unavailable".
			proxyLogf("upstream transport error: %s", redactAuthError(err))
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusBadGateway)
			_, _ = rw.Write([]byte(`{"error":{"type":"upstream_error","message":"upstream unavailable"}}`))
		},
		ModifyResponse: func(resp *http.Response) error {
			if err := rewriteContextWindowResponse(resp, r); err != nil {
				return err
			}
			if resp.StatusCode >= 500 {
				// A vendor edge failure (APISIX/openresty 502/504) is passed
				// through verbatim, which reads as "the local proxy broke".
				// Log the vendor's own status line so proxy.log names the
				// failing side; the response body keeps flowing untouched.
				peek, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
				resp.Body = &peekedBody{
					Reader: io.MultiReader(bytes.NewReader(peek), resp.Body),
					closer: resp.Body,
				}
				proxyLogf("upstream %d; vendor says: %s", resp.StatusCode,
					describeVendorError(string(peek), resp.StatusCode))
			}
			if resp.StatusCode < 400 {
				sink.commit()
				return nil
			}
			return sink.onNon2xx(resp)
		},
	}
	// Log-only degenerate-stream tripwire. Aborting the TCP connection and
	// injecting stop+[DONE] were both observed to kill the client turn
	// (STREAM_CLOSED / WorkBuddy dropping the task). The bytes originate
	// upstream; this tap only fingerprints them.
	rw := sink.asResponseWriter()
	if shouldInspectStream(r) {
		rw = newDegenerateTap(rw)
	}
	rp.ServeHTTP(rw, r)
}
