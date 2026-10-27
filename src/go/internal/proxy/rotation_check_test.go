package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

// The auth check must answer from the proxy itself. A rotation check that
// reached upstream would fail whenever the vendor is unreachable, which says
// nothing about the key.
func TestAuthCheckNeverReachesUpstream(t *testing.T) {
	var upstreamHits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamHits.Add(1)
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(upstream.Close)
	base, _ := url.Parse(upstream.URL)
	srv := &Server{Token: "proxy-secret", Upstream: base, UpstreamAuth: "upstream-secret"}
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)

	for _, tc := range []struct {
		token string
		want  int
	}{
		{"proxy-secret", http.StatusNoContent},
		{"wrong", http.StatusUnauthorized},
		{"", http.StatusUnauthorized},
	} {
		req, _ := http.NewRequest(http.MethodGet, front.URL+AuthCheckPath, nil)
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("token %q: status %d, want %d", tc.token, resp.StatusCode, tc.want)
		}
	}
	if n := upstreamHits.Load(); n != 0 {
		t.Fatalf("the auth check reached upstream %d time(s)", n)
	}
}

// The check is only worth running if it can fail: a rotation whose old key
// still works, or whose new key is refused, must be reported, and neither key
// may appear in the report.
func TestVerifyTokenRotationOnARunningProxy(t *testing.T) {
	ts := newTestServices(t)
	ctx := context.Background()
	seedAccount(t, ts.Service, "rotate-verify", true)
	t.Cleanup(ts.Service.Close)

	started, err := ts.Service.StartProxy(ctx, "codex", "rotate-verify")
	if err != nil {
		t.Fatal(err)
	}
	previous := started.Token
	rotated, err := ts.Service.RotateToken(ctx, "codex", "rotate-verify")
	if err != nil {
		t.Fatal(err)
	}
	st, err := ts.Service.StatusContext(ctx, "codex", "rotate-verify")
	if err != nil || st == nil || !st.Running {
		t.Fatalf("status after rotate = %+v, %v", st, err)
	}

	if err := VerifyTokenRotation(ctx, st.Endpoint, rotated, previous); err != nil {
		t.Fatalf("a good rotation was reported as failed: %v", err)
	}
	// Swapped: the "new" key is the dead one.
	err = VerifyTokenRotation(ctx, st.Endpoint, previous, rotated)
	if err == nil {
		t.Fatal("a refused new key was reported as verified")
	}
	for _, secret := range []string{previous, rotated} {
		if strings.Contains(err.Error(), secret) {
			t.Fatal("the rotation error quoted a proxy key")
		}
	}
}

// A listener that accepts any key models a rotation that did not take.
func TestVerifyTokenRotationReportsAnOldKeyThatStillWorks(t *testing.T) {
	lenient := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(lenient.Close)
	err := VerifyTokenRotation(context.Background(), lenient.URL, "new-key", "old-key")
	if err == nil || !strings.Contains(err.Error(), "previous key is still accepted") {
		t.Fatalf("an old key that still works must be reported, got %v", err)
	}
	if strings.Contains(err.Error(), "old-key") || strings.Contains(err.Error(), "new-key") {
		t.Fatal("the rotation error quoted a key")
	}
}
