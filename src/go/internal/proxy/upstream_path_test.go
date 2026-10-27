package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Vendors document their OpenAI base with its version, and clients send the
// version too. Every egress kind must land on the vendor's real path: a plain
// join sent /v1/v1/chat/completions for Codex (Responses) and for pi and omp
// (chat passthrough), while Claude Code's translated path happened to work.
func TestEveryEgressKindLandsOnTheVendorPath(t *testing.T) {
	type hit struct{ path, auth string }
	var got []hit
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, hit{r.URL.Path, r.Header.Get("Authorization")})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}`))
	}))
	t.Cleanup(stub.Close)

	requests := []struct{ method, path, body string }{
		{"POST", "/v1/chat/completions", `{"model":"m","messages":[{"role":"user","content":"x"}]}`},
		{"POST", "/v1/responses", `{"model":"m","input":"x"}`},
		{"POST", "/v1/messages", `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":"x"}]}`},
	}
	for _, base := range []struct {
		name, path string
		want       string
	}{
		// The usual declaration: https://api.example.test/v1.
		{"versioned base", "/v1", "/v1/chat/completions"},
		// A base that is the host alone must still get the client's /v1.
		{"bare base", "", "/v1/chat/completions"},
	} {
		parsed, _ := url.Parse(stub.URL + base.path)
		up := &Upstream{BaseURL: parsed, Auth: "upstream-key", TranslateAnthropic: true}
		for _, rq := range requests {
			got = nil
			req := httptest.NewRequest(rq.method, rq.path, strings.NewReader(rq.body))
			req.Header.Set("Content-Type", "application/json")
			Serve(httptest.NewRecorder(), req, up)
			if len(got) != 1 {
				t.Fatalf("%s %s: upstream saw %d requests", base.name, rq.path, len(got))
			}
			want := base.want
			if base.name == "bare base" && rq.path == "/v1/messages" {
				// The translated leaf appends /chat/completions to the base as
				// declared; a bare host is not a valid OpenAI base for it.
				want = "/chat/completions"
			}
			if got[0].path != want {
				t.Errorf("%s %s reached %q, want %q", base.name, rq.path, got[0].path, want)
			}
		}
	}
}

// A keyless upstream (a local model server) must receive no auth header, not
// `Authorization: Bearer ` with nothing after it.
func TestKeylessUpstreamGetsNoAuthHeader(t *testing.T) {
	var sawHeader bool
	var value string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, sawHeader = r.Header["Authorization"]
		value = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","choices":[]}`))
	}))
	t.Cleanup(stub.Close)
	base, _ := url.Parse(stub.URL + "/v1")
	up := &Upstream{BaseURL: base}
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		sawHeader, value = false, ""
		body := `{"model":"m","messages":[{"role":"user","content":"x"}]}`
		if path == "/v1/responses" {
			body = `{"model":"m","input":"x"}`
		}
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		// The proxy's own bearer must never be forwarded either.
		req.Header.Set("Authorization", "Bearer proxy-secret")
		Serve(httptest.NewRecorder(), req, up)
		if sawHeader {
			t.Errorf("%s: keyless upstream got Authorization %q", path, value)
		}
	}
}

func TestJoinUpstreamPath(t *testing.T) {
	for _, tc := range []struct{ base, inbound, want string }{
		{"/v1", "/v1/chat/completions", "/v1/chat/completions"},
		{"/v1/", "/v1/models", "/v1/models"},
		{"", "/v1/chat/completions", "/v1/chat/completions"},
		{"/api/v1", "/v1/chat/completions", "/api/v1/chat/completions"},
		{"/compatible-mode/v1", "/v1/embeddings", "/compatible-mode/v1/embeddings"},
		// A base that does not end in /v1 keeps the inbound path whole.
		{"/v2", "/v1/chat/completions", "/v2/v1/chat/completions"},
		{"/v1", "/v10/x", "/v1/v10/x"},
	} {
		if got := joinUpstreamPath(tc.base, tc.inbound); got != tc.want {
			t.Errorf("joinUpstreamPath(%q, %q) = %q, want %q", tc.base, tc.inbound, got, tc.want)
		}
	}
}

// A passthrough path keeps its escaping. An id with an escaped slash used to
// reach the vendor decoded, as two path segments, and came back 404.
func TestPassthroughKeepsEscapedPathSegments(t *testing.T) {
	var seen string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(stub.Close)
	parsed, _ := url.Parse(stub.URL + "/v1")
	req := httptest.NewRequest(http.MethodGet, "/v1/models/org%2Fmodel", nil)
	Serve(httptest.NewRecorder(), req, &Upstream{BaseURL: parsed, Auth: "upstream-key"})
	if seen != "/v1/models/org%2Fmodel" {
		t.Fatalf("upstream saw %q, want the escaped segment kept", seen)
	}
}
