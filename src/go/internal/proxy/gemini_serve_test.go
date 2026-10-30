package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/protocol/gemini"
)

// geminiMock echoes a canned generateContent response and records what it
// received, so the test can assert both translation (out) and envelope (in).
type geminiMock struct {
	server *httptest.Server
	mu     sync.Mutex
	last   geminiMockRequest
}

type geminiMockRequest struct {
	Path      string
	Method    string
	Body      map[string]interface{}
	APIKey    string
	Bearer    string
	UserAgent string
	Envelope  bool // Code Assist envelope present
}

// geminiMockResponse lets a responder control the HTTP status, headers, and
// body — needed to exercise 404 auto-fallback and 429 cooldown paths.
type geminiMockResponse struct {
	Status int
	Header http.Header
	Body   map[string]interface{}
}

func newGeminiMock(t *testing.T, responder func(r geminiMockRequest) geminiMockResponse) *geminiMock {
	t.Helper()
	m := &geminiMock{}
	m.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		_ = json.Unmarshal(raw, &body)
		req := geminiMockRequest{
			Path:      r.URL.Path,
			Method:    r.Method,
			Body:      body,
			APIKey:    r.Header.Get("x-goog-api-key"),
			Bearer:    strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "),
			UserAgent: r.Header.Get("User-Agent"),
		}
		_, hasModel := body["model"]
		_, hasRequest := body["request"]
		if hasModel && hasRequest {
			req.Envelope = true
		}
		m.mu.Lock()
		m.last = req
		m.mu.Unlock()
		resp := responder(req)
		for k, vs := range resp.Header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		code := resp.Status
		if code == 0 {
			code = http.StatusOK
		}
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(resp.Body)
	}))
	t.Cleanup(m.server.Close)
	return m
}

func (m *geminiMock) lastRequest() geminiMockRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last
}

func (m *geminiMock) url() *url.URL {
	u, _ := url.Parse(m.server.URL)
	return u
}

// textResponse is a minimal Gemini generateContent payload.
func geminiTextResponse(text string) map[string]interface{} {
	return map[string]interface{}{
		"candidates": []map[string]interface{}{{
			"content": map[string]interface{}{
				"parts": []map[string]interface{}{{"text": text}},
			},
			"finishReason": "STOP",
		}},
		"usageMetadata": map[string]interface{}{
			"promptTokenCount":     10,
			"candidatesTokenCount": 5,
			"totalTokenCount":      15,
		},
	}
}

func newGeminiServer(t *testing.T, base *url.URL, gemini *GeminiTarget) *Server {
	t.Helper()
	srv := &Server{
		ProviderID:      "gemini",
		AccountName:     "test",
		InstanceID:      "test-instance",
		Token:           "secret",
		Upstream:        base,
		UpstreamAuth:    "secret", // API-key mode posts this as x-goog-api-key
		TranslateGemini: true,
		Gemini:          gemini,
	}
	if err := srv.Listen("127.0.0.1", 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

// resetGeminiTestState isolates the package-level cooldown + catalog caches so
// tests do not leak shared state into one another (e.g. a 429 cooldown set by
// one test blocking another's first generateContent call).
func TestGeminiCooldownDoesNotParkADifferentAccount(t *testing.T) {
	resetGeminiTestState(t)
	var hitsA, hitsB int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("x-goog-api-key") {
		case "key-a":
			hitsA++
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
		case "key-b":
			hitsB++
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"candidates":[]}`))
		default:
			t.Errorf("unexpected key %q", r.Header.Get("x-goog-api-key"))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()
	base, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	up := func(key, scope string) *Upstream {
		return &Upstream{
			Auth:         key,
			CatalogScope: scope,
			Gemini:       &GeminiTarget{APIKeyMode: true, APIKeyBase: base},
		}
	}
	if _, err := callGemini(context.Background(), up("key-a", "account/gemini/a"), "gemini-2.5-flash", nil); err == nil {
		t.Fatal("account A should surface the 429")
	}
	if _, err := callGemini(context.Background(), up("key-b", "account/gemini/b"), "gemini-2.5-flash", nil); err != nil {
		t.Fatalf("account B was parked by A's cooldown: %v", err)
	}
	if _, err := callGemini(context.Background(), up("key-a", "account/gemini/a"), "gemini-2.5-flash", nil); err == nil {
		t.Fatal("account A should still be cooling")
	}
	if hitsA != 1 || hitsB != 1 {
		t.Fatalf("hits A=%d B=%d, want 1 and 1", hitsA, hitsB)
	}
}

func resetGeminiTestState(t *testing.T) {
	t.Helper()
	geminiCooldowns.mu.Lock()
	geminiCooldowns.until = map[string]time.Time{}
	geminiCooldowns.mu.Unlock()
	geminiCatalogMu.Lock()
	geminiCatalogCache = map[string]*geminiCatalogEntry{}
	geminiCatalogMu.Unlock()
}

func postProxy(t *testing.T, srv *Server, path, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.Endpoint+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func readBody(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestGeminiServeOpenAIChatNonStream(t *testing.T) {
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		return geminiMockResponse{Body: geminiTextResponse("Hello from Gemini")}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}],"max_tokens":100}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readBody(t, resp))
	}
	var out map[string]interface{}
	_ = json.Unmarshal(readBody(t, resp), &out)
	if out["object"] != "chat.completion" {
		t.Fatalf("object = %v", out["object"])
	}
	choices := out["choices"].([]interface{})
	msg := choices[0].(map[string]interface{})["message"].(map[string]interface{})
	if msg["content"] != "Hello from Gemini" {
		t.Fatalf("content = %v", msg["content"])
	}
	usage := out["usage"].(map[string]interface{})
	if int(usage["total_tokens"].(float64)) != 15 {
		t.Fatalf("usage = %v", usage)
	}
	// The mock must have received the generateContent path + x-goog-api-key.
	last := mock.lastRequest()
	if !strings.Contains(last.Path, ":generateContent") {
		t.Fatalf("path = %s", last.Path)
	}
	if last.APIKey != "secret" {
		t.Fatalf("api key = %q", last.APIKey)
	}
}

func TestGeminiServeOpenAIChatStream(t *testing.T) {
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		return geminiMockResponse{Body: geminiTextResponse("streamed answer")}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}],"stream":true}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	raw := readBody(t, resp)
	body := string(raw)
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("missing [DONE]: %s", body)
	}
	if !strings.Contains(body, `"content":"streamed answer"`) {
		t.Fatalf("missing content chunk: %s", body)
	}
	if !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Fatalf("missing finish chunk: %s", body)
	}
}

func TestGeminiServeThinkingAndToolCall(t *testing.T) {
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		return geminiMockResponse{Body: map[string]interface{}{
			"candidates": []map[string]interface{}{{
				"content": map[string]interface{}{
					"parts": []map[string]interface{}{
						{"text": "let me think", "thought": true, "thoughtSignature": "sig123"},
						{"text": "the answer"},
						{"functionCall": map[string]interface{}{
							"name": "get_weather",
							"args": map[string]interface{}{"city": "Hanoi"},
						}},
					},
				},
				"finishReason": "STOP",
			}},
			"usageMetadata": map[string]interface{}{
				"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2,
			},
		}}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`)
	var out map[string]interface{}
	_ = json.Unmarshal(readBody(t, resp), &out)
	msg := out["choices"].([]interface{})[0].(map[string]interface{})["message"].(map[string]interface{})
	if msg["reasoning_content"] != "let me think" {
		t.Fatalf("reasoning_content = %v", msg["reasoning_content"])
	}
	if msg["content"] != "the answer" {
		t.Fatalf("content = %v", msg["content"])
	}
	tools := msg["tool_calls"].([]interface{})
	if len(tools) != 1 {
		t.Fatalf("tool_calls = %v", msg["tool_calls"])
	}
	tc := tools[0].(map[string]interface{})
	if tc["function"].(map[string]interface{})["name"] != "get_weather" {
		t.Fatalf("tool name = %v", tc["function"])
	}
	if !strings.Contains(tc["function"].(map[string]interface{})["arguments"].(string), "Hanoi") {
		t.Fatalf("tool args = %v", tc["function"])
	}
}

func TestGeminiServeAnthropicMessages(t *testing.T) {
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		return geminiMockResponse{Body: geminiTextResponse("anthropic-style reply")}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp := postProxy(t, srv, "/v1/messages",
		`{"model":"gemini-2.5-pro","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readBody(t, resp))
	}
	var out map[string]interface{}
	_ = json.Unmarshal(readBody(t, resp), &out)
	if out["type"] != "message" {
		t.Fatalf("type = %v", out["type"])
	}
	blocks := out["content"].([]interface{})
	if len(blocks) != 1 || blocks[0].(map[string]interface{})["type"] != "text" {
		t.Fatalf("content = %v", out["content"])
	}
	if blocks[0].(map[string]interface{})["text"] != "anthropic-style reply" {
		t.Fatalf("text = %v", blocks[0])
	}
}

func TestGeminiServeResponses(t *testing.T) {
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		return geminiMockResponse{Body: geminiTextResponse("responses reply")}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp := postProxy(t, srv, "/v1/responses",
		`{"model":"gemini-2.5-pro","input":"hi"}`)
	var out map[string]interface{}
	_ = json.Unmarshal(readBody(t, resp), &out)
	if out["object"] != "response" {
		t.Fatalf("object = %v", out["object"])
	}
	outputs := out["output"].([]interface{})
	if len(outputs) == 0 {
		t.Fatalf("no output items: %v", out["output"])
	}
}

func TestGeminiServeOAuthEnvelope(t *testing.T) {
	var captured geminiMockRequest
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		captured = r
		if strings.Contains(r.Path, "loadCodeAssist") {
			return geminiMockResponse{Body: map[string]interface{}{"cloudaicompanionProject": "projects/123"}}
		}
		// Code Assist wraps the real response under .response.
		return geminiMockResponse{Body: map[string]interface{}{"response": geminiTextResponse("oauth reply")}}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{
		APIKeyMode:     false,
		CodeAssistBase: mock.url(),
	})
	// OAuth mode refreshes the Bearer token per request via AuthProvider.
	srv.UpstreamAuthProvider = func(ctx context.Context) (string, error) {
		return "oauth-token", nil
	}

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`)
	var out map[string]interface{}
	_ = json.Unmarshal(readBody(t, resp), &out)
	if out["choices"].([]interface{})[0].(map[string]interface{})["message"].(map[string]interface{})["content"] != "oauth reply" {
		t.Fatalf("content = %v", out["choices"])
	}
	if !captured.Envelope {
		t.Fatalf("expected Code Assist envelope; got body keys=%v", captured.Body)
	}
	if captured.Bearer != "oauth-token" {
		t.Fatalf("bearer = %q", captured.Bearer)
	}
	reqObj, ok := captured.Body["request"].(map[string]interface{})
	if !ok {
		t.Fatalf("envelope missing request: %v", captured.Body)
	}
	if _, ok := reqObj["session_id"]; !ok {
		t.Fatalf("envelope request missing session_id: %v", reqObj)
	}
}

// Code Assist identifies the caller two ways: the ideType in the
// loadCodeAssist body, and the User-Agent on generateContent. Get either
// wrong and the same credential is rejected (400 INVALID_ARGUMENT for the
// historical "GEMINI" ideType, 403 SUBSCRIPTION_REQUIRED with no
// User-Agent). The values come from the OAuth profile that owns the
// credential, so the proxy must forward what the target carries.
func TestGeminiServeCodeAssistClientIdentity(t *testing.T) {
	resetGeminiTestState(t)
	codeAssistProjects.mu.Lock()
	codeAssistProjects.byToken = map[string]string{}
	codeAssistProjects.mu.Unlock()

	const wantUA = "antigravity/hub/2.3.1 (aidev_client)"
	var ideType string
	var generateUA string
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		if strings.Contains(r.Path, "loadCodeAssist") {
			// A consumer account: 200 with no project at all.
			if md, ok := r.Body["metadata"].(map[string]interface{}); ok {
				ideType, _ = md["ideType"].(string)
			}
			return geminiMockResponse{Body: map[string]interface{}{"allowedTiers": []interface{}{}}}
		}
		generateUA = r.UserAgent
		return geminiMockResponse{Body: map[string]interface{}{"response": geminiTextResponse("antigravity reply")}}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{
		APIKeyMode:     false,
		CodeAssistBase: mock.url(),
		IDEType:        "ANTIGRAVITY",
		UserAgent:      wantUA,
	})
	srv.UpstreamAuthProvider = func(ctx context.Context) (string, error) {
		return "oauth-token", nil
	}

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}`)
	raw := readBody(t, resp)
	var out map[string]interface{}
	_ = json.Unmarshal(raw, &out)
	choices, ok := out["choices"].([]interface{})
	if !ok || len(choices) == 0 {
		t.Fatalf("no project must not fail the request; got %s", raw)
	}
	if got := choices[0].(map[string]interface{})["message"].(map[string]interface{})["content"]; got != "antigravity reply" {
		t.Fatalf("content = %v", got)
	}
	if ideType != "ANTIGRAVITY" {
		t.Fatalf("loadCodeAssist ideType = %q, want ANTIGRAVITY", ideType)
	}
	if generateUA != wantUA {
		t.Fatalf("generateContent User-Agent = %q, want %q", generateUA, wantUA)
	}
}

// The two Code Assist identities post different ClientMetadata. Ported from
// the reference implementation (npm anypick: providers/gemini-proxy/server.ts
// resolveOAuthProject): Antigravity sends {ideType} alone, gemini-cli adds
// platform + pluginType. Collapsing the two is how an accepted identity turns
// into a 400 the next time the endpoint tightens its validation.
func TestGeminiCodeAssistMetadataShapePerIdentity(t *testing.T) {
	antigravity := GeminiCodeAssistMetadata("ANTIGRAVITY")
	if _, leaked := antigravity["pluginType"]; leaked {
		t.Fatalf("ANTIGRAVITY metadata must not carry pluginType: %v", antigravity)
	}
	if _, leaked := antigravity["platform"]; leaked {
		t.Fatalf("ANTIGRAVITY metadata must not carry platform: %v", antigravity)
	}
	if antigravity["ideType"] != "ANTIGRAVITY" {
		t.Fatalf("ANTIGRAVITY ideType = %v", antigravity["ideType"])
	}
	cli := GeminiCodeAssistMetadata("GEMINI_CLI")
	if cli["pluginType"] != "GEMINI" {
		t.Fatalf("gemini-cli pluginType = %v, want GEMINI", cli["pluginType"])
	}
	if cli["platform"] == "" || cli["platform"] == nil {
		t.Fatalf("gemini-cli platform must be set: %v", cli)
	}
}

func TestGeminiServeOAuthAutoFallback(t *testing.T) {
	var primaryAttempts, altAttempts int
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		if strings.Contains(r.Path, "loadCodeAssist") {
			return geminiMockResponse{Body: map[string]interface{}{"cloudaicompanionProject": "projects/123"}}
		}
		// Live catalog discovery must succeed (and not count as a primary
		// attempt) so the auto-fallback assertion focuses on the egress call.
		if strings.Contains(r.Path, "fetchAvailableModels") {
			return geminiMockResponse{Body: map[string]interface{}{
				"models": map[string]interface{}{"models/gemini-2.5-pro": map[string]interface{}{}},
			}}
		}
		if strings.Contains(r.Path, "retrieveUserQuota") {
			return geminiMockResponse{Body: map[string]interface{}{"buckets": []interface{}{}}}
		}
		if strings.Contains(r.Path, ":generateContent") {
			if r.Bearer == "primary-token" {
				primaryAttempts++
				// Primary identity rejects the model (404 → auto-fallback).
				return geminiMockResponse{
					Status: http.StatusNotFound,
					Body:   map[string]interface{}{"error": map[string]interface{}{"message": "model not found", "status": "NOT_FOUND"}},
				}
			}
			altAttempts++
			return geminiMockResponse{Body: map[string]interface{}{"response": geminiTextResponse("fallback reply")}}
		}
		return geminiMockResponse{Body: geminiTextResponse("fallback reply")}
	})
	altURL, _ := url.Parse(mock.server.URL)
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{
		APIKeyMode:     false,
		CodeAssistBase: mock.url(),
		AltRoute: &GeminiAltRoute{
			CodeAssistBase: altURL,
			AuthProvider:   func(ctx context.Context) (string, error) { return "alt-token", nil },
		},
	})
	srv.UpstreamAuthProvider = func(ctx context.Context) (string, error) {
		return "primary-token", nil
	}

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`)
	var out map[string]interface{}
	_ = json.Unmarshal(readBody(t, resp), &out)
	if out["choices"].([]interface{})[0].(map[string]interface{})["message"].(map[string]interface{})["content"] != "fallback reply" {
		t.Fatalf("expected fallback reply; got %v", out["choices"])
	}
	if primaryAttempts != 1 {
		t.Fatalf("primary attempts = %d, want 1", primaryAttempts)
	}
	if altAttempts != 1 {
		t.Fatalf("alt attempts = %d, want 1 (auto-fallback must retry)", altAttempts)
	}
}

func TestGeminiServeRateLimitCooldown(t *testing.T) {
	resetGeminiTestState(t)
	// A 429 with Retry-After parks the route key in the cooldown registry; the
	// immediate next call must fail fast (429) without hitting the upstream
	// again, mirroring classifyUpstreamFailure → cooldowns.set for any mode.
	var hits int
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		// Live catalog ListModels must succeed and not consume the 429 slot.
		if strings.Contains(r.Path, "/v1beta/models") && !strings.Contains(r.Path, ":generateContent") {
			return geminiMockResponse{Body: map[string]interface{}{
				"models": []map[string]interface{}{
					{"name": "models/gemini-2.5-pro", "supportedGenerationMethods": []string{"generateContent"}},
				},
			}}
		}
		hits++
		if hits == 1 {
			return geminiMockResponse{
				Status: http.StatusTooManyRequests,
				Header: http.Header{"Retry-After": {"1"}},
				Body:   map[string]interface{}{"error": map[string]interface{}{"message": "rate limited", "status": "RESOURCE_EXHAUSTED"}},
			}
		}
		return geminiMockResponse{Body: geminiTextResponse("late")}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp1 := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`)
	if resp1.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("first call status = %d, want 429", resp1.StatusCode)
	}
	_ = readBody(t, resp1)
	if hits != 1 {
		t.Fatalf("unexpected upstream hits after first call = %d", hits)
	}

	// Second immediate call: cooldown should block it before any upstream hit.
	resp2 := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}]}`)
	if resp2.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second call status = %d, want 429 (cooldown should block)", resp2.StatusCode)
	}
	_ = readBody(t, resp2)
	if hits != 1 {
		t.Fatalf("cooldown did not block: upstream hits = %d, want 1", hits)
	}
}

// TestGeminiServeResolvesAliasFromLiveCatalog proves the live catalog actually
// drives model resolution: a friendly alias ("gemini") resolves to a concrete
// id drawn from the account-scoped ListModels response, and the upstream
// generateContent call uses that concrete id.
func TestGeminiServeResolvesAliasFromLiveCatalog(t *testing.T) {
	resetGeminiTestState(t)
	var paths []string
	mock := newGeminiMock(t, func(r geminiMockRequest) geminiMockResponse {
		paths = append(paths, r.Path)
		if strings.Contains(r.Path, "/v1beta/models") && !strings.Contains(r.Path, ":generateContent") {
			return geminiMockResponse{Body: map[string]interface{}{
				"models": []map[string]interface{}{
					{"name": "models/gemini-2.5-pro", "supportedGenerationMethods": []string{"generateContent"}},
					{"name": "models/gemini-1.5-flash", "supportedGenerationMethods": []string{"generateContent"}},
				},
			}}
		}
		return geminiMockResponse{Body: geminiTextResponse("resolved reply")}
	})
	srv := newGeminiServer(t, mock.url(), &GeminiTarget{APIKeyMode: true, APIKeyBase: mock.url()})

	resp := postProxy(t, srv, "/v1/chat/completions",
		`{"model":"gemini","messages":[{"role":"user","content":"hi"}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readBody(t, resp))
	}
	_ = readBody(t, resp)

	var sawGenerateContent bool
	for _, p := range paths {
		if strings.Contains(p, ":generateContent") {
			sawGenerateContent = true
			if !strings.Contains(p, "gemini-2.5-pro") && !strings.Contains(p, "gemini-1.5-flash") {
				t.Fatalf("alias resolved to unexpected model path: %s", p)
			}
		}
	}
	if !sawGenerateContent {
		t.Fatalf("no generateContent call recorded; paths=%v", paths)
	}
}

// Codex reads the completed item from response.output_item.done and drops a
// reasoning item that has no summary field. The one carrying a tool call's
// thought signature has no summary text, so it must still arrive with
// "summary":[] or Gemini rejects the next tool turn.
func TestResponsesStreamDoneEventKeepsTheToolSignatureCarrier(t *testing.T) {
	res := &gemini.GeminiGenerateResponse{Candidates: []gemini.GeminiCandidate{{Content: &gemini.GeminiContent{Role: "model", Parts: []gemini.GeminiPart{
		{Text: "I will check the date."},
		{FunctionCall: &gemini.GeminiFunctionCall{Name: "exec_command", Args: map[string]interface{}{"cmd": "date"}}, ThoughtSignature: "sig-1"},
	}}}}}
	rec := httptest.NewRecorder()
	writeOpenAIResponsesStream(rec, gemini.GeminiToOpenAIResponses(res, "gemini-3.8-flash-tiered"))
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok || !strings.Contains(data, `"response.output_item.done"`) || !strings.Contains(data, "sig-1") {
			continue
		}
		var event struct {
			Item map[string]json.RawMessage `json:"item"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			t.Fatal(err)
		}
		if string(event.Item["type"]) != `"reasoning"` || string(event.Item["summary"]) != "[]" {
			t.Fatalf("done item = %s", data)
		}
		return
	}
	t.Fatalf("no output_item.done carries the signature:\n%s", rec.Body.String())
}

// A fresh tool turn round-trips Gemini's own signature: what the proxy
// answered, echoed back the way Codex does, reaches Gemini with the real
// signature and no placeholder. If a future change loses it again, this fails
// instead of the placeholder hiding it.
func TestResponsesToolTurnKeepsTheRealSignatureWithoutAPlaceholder(t *testing.T) {
	var logs strings.Builder
	t.Cleanup(SetLogSinkForTest(&logs))
	res := &gemini.GeminiGenerateResponse{Candidates: []gemini.GeminiCandidate{{Content: &gemini.GeminiContent{Role: "model", Parts: []gemini.GeminiPart{
		{Text: "I will check the date."},
		{FunctionCall: &gemini.GeminiFunctionCall{Name: "exec_command", Args: map[string]interface{}{"cmd": "date"}}, ThoughtSignature: "real-sig"},
	}}}}}
	out := gemini.GeminiToOpenAIResponses(res, "gemini-3.8-flash-tiered")
	echoed := []interface{}{map[string]interface{}{"type": "message", "role": "user", "content": "date?"}}
	for _, item := range out.Output {
		raw, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		echoed = append(echoed, m)
		if m["type"] == "function_call" {
			echoed = append(echoed, map[string]interface{}{"type": "function_call_output", "call_id": m["call_id"], "output": "Thu"})
		}
	}
	input, _ := json.Marshal(echoed)
	req := signGeminiHistory(gemini.OpenAIResponsesToGemini(gemini.OpenAIResponsesRequest{Input: input}, "gemini-3.8-flash-tiered"), "gemini-3.8-flash-tiered")
	found := false
	for _, content := range req.Contents {
		for _, part := range content.Parts {
			if part.FunctionCall != nil {
				found = true
				if part.ThoughtSignature != "real-sig" {
					t.Fatalf("functionCall signature = %q, want the real one", part.ThoughtSignature)
				}
			}
		}
	}
	if !found {
		t.Fatal("no functionCall reached Gemini")
	}
	if strings.Contains(logs.String(), "placeholder") {
		t.Fatalf("placeholder logged on a fresh turn: %s", logs.String())
	}
}

// History that lost its signature is filled, and proxy.log says so.
func TestSignGeminiHistoryLogsAFilledPlaceholder(t *testing.T) {
	var logs strings.Builder
	t.Cleanup(SetLogSinkForTest(&logs))
	req := &gemini.GeminiGenerateRequest{Contents: []gemini.GeminiContent{
		{Role: "model", Parts: []gemini.GeminiPart{{FunctionCall: &gemini.GeminiFunctionCall{Name: "a"}}}},
	}}
	signGeminiHistory(req, "gemini-3.8-flash-tiered")
	if req.Contents[0].Parts[0].ThoughtSignature != gemini.SkipThoughtSignature || !strings.Contains(logs.String(), "placeholder") {
		t.Fatalf("signature %q, log %q", req.Contents[0].Parts[0].ThoughtSignature, logs.String())
	}
}
