package update

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testAPIFetcher(t *testing.T, srv *httptest.Server, env Env) *GitHubFetcher {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if env == nil {
		env = MapEnv{}
	}
	return &GitHubFetcher{
		HTTP:         srv.Client(),
		BaseURL:      srv.URL,
		Env:          env,
		allowedHosts: []string{u.Hostname()},
	}
}

func TestFetcherETag304(t *testing.T) {
	var hits int
	var sawIfNone string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		sawIfNone = r.Header.Get("If-None-Match")
		if sawIfNone == `"abc"` {
			w.Header().Set("ETag", `"abc"`)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"abc"`)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name":     "v1.2.0",
			"body":         "notes",
			"draft":        false,
			"prerelease":   false,
			"html_url":     "https://example/rel",
			"published_at": time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
			"assets":       []map[string]any{},
		})
	}))
	defer srv.Close()

	f := testAPIFetcher(t, srv, MapEnv{})
	rel, etag, mod, err := f.Latest(context.Background(), "")
	if err != nil || mod || etag != `"abc"` || rel.Version != "1.2.0" {
		t.Fatalf("first: rel=%+v etag=%q mod=%v err=%v", rel, etag, mod, err)
	}
	_, etag2, mod2, err := f.Latest(context.Background(), `"abc"`)
	if err != nil || !mod2 || etag2 != `"abc"` {
		t.Fatalf("second: etag=%q mod=%v err=%v", etag2, mod2, err)
	}
	if sawIfNone != `"abc"` {
		t.Fatalf("If-None-Match not re-sent: %q", sawIfNone)
	}
	if hits != 2 {
		t.Fatalf("hits=%d", hits)
	}
}

func TestFetcherRateLimited(t *testing.T) {
	for _, code := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
			}))
			defer srv.Close()
			f := testAPIFetcher(t, srv, nil)
			_, _, _, err := f.Latest(context.Background(), "")
			if !errors.Is(err, ErrRateLimited) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestFetcherOffline(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	u := srv.URL
	host, _ := url.Parse(u)
	client := srv.Client()
	srv.Close()
	f := &GitHubFetcher{HTTP: client, BaseURL: u, allowedHosts: []string{host.Hostname()}}
	_, _, _, err := f.Latest(context.Background(), "")
	var off *ErrOffline
	if !errors.As(err, &off) {
		t.Fatalf("want ErrOffline, got %v", err)
	}
}

func TestFetcherIgnoresPrerelease(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name":   "v1.2.0-rc.1",
			"prerelease": true,
			"draft":      false,
			"assets":     []any{},
		})
	}))
	defer srv.Close()
	f := testAPIFetcher(t, srv, nil)
	_, _, _, err := f.Latest(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for prerelease")
	}
}

func TestFetcherUnparseableTag(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "not-a-version", "draft": false, "prerelease": false, "assets": []any{},
		})
	}))
	defer srv.Close()
	f := testAPIFetcher(t, srv, nil)
	_, _, _, err := f.Latest(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for unparseable tag")
	}
}

func TestFetcherRejectsPathLikeAssetName(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.2.0", "draft": false, "prerelease": false,
			"assets": []map[string]any{{"name": "../evil.zip", "browser_download_url": "https://github.com/x", "size": 1}},
		})
	}))
	defer srv.Close()
	f := testAPIFetcher(t, srv, nil)
	_, _, _, err := f.Latest(context.Background(), "")
	if err == nil {
		t.Fatal("expected reject for path-like asset name")
	}
}

func TestFetcherFeedURLHook(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases/latest" {
			t.Errorf("path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.1.0", "draft": false, "prerelease": false, "assets": []any{},
		})
	}))
	defer srv.Close()
	env := MapEnv{EnvTesting: "1", EnvFeedURL: srv.URL}
	// No allowedHosts: NewAPITransport must add the feed host when gate is open.
	f := &GitHubFetcher{HTTP: srv.Client(), BaseURL: "https://api.github.com/repos/outof0/anypick", Env: env}
	rel, _, _, err := f.Latest(context.Background(), "")
	if err != nil || rel.Version != "1.1.0" {
		t.Fatalf("rel=%+v err=%v", rel, err)
	}
}

func TestFetcherFeedURLHookClosed(t *testing.T) {
	feedHits := 0
	feed := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		feedHits++
		t.Fatal("must not hit override server when gate closed")
	}))
	defer feed.Close()

	// Gate closed — FEED_URL ignored; BaseURL (default api path) used.
	// Use an injected allowlisted mock as BaseURL to stay offline-safe, and
	// assert base() ignores the feed + allowlist excludes feed host.
	real := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.1.0", "draft": false, "prerelease": false, "assets": []any{},
		})
	}))
	defer real.Close()
	env := MapEnv{EnvFeedURL: feed.URL} // no TESTING=1
	f := testAPIFetcher(t, real, env)
	if f.base() != strings.TrimRight(real.URL, "/") {
		t.Fatalf("gate closed base=%q want real mock", f.base())
	}
	tr := NewAPITransport(env)
	if err := tr.ValidateURL(feed.URL + "/releases/latest"); err == nil {
		t.Fatal("gate closed: feed host must not be allowlisted")
	}
	rel, _, _, err := f.Latest(context.Background(), "")
	if err != nil || rel.Version != "1.1.0" {
		t.Fatalf("rel=%+v err=%v", rel, err)
	}
	if feedHits != 0 {
		t.Fatalf("feed server hits=%d", feedHits)
	}
}

func TestAPIClientRefusesNonAPIHost(t *testing.T) {
	hits := 0
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(200)
	}))
	defer srv.Close()
	// Production API allowlist (api.github.com only); httptest host not listed.
	f := &GitHubFetcher{HTTP: srv.Client(), BaseURL: srv.URL, Env: MapEnv{}}
	_, _, _, err := f.Latest(context.Background(), "")
	if err == nil {
		t.Fatal("non-api.github.com host must be refused")
	}
	var denied *ErrDeniedURL
	if !errors.As(err, &denied) {
		t.Fatalf("want ErrDeniedURL, got %v", err)
	}
	if hits != 0 {
		t.Fatalf("must not make a request, hits=%d", hits)
	}
}

func TestAPIClientRefusesHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("http must not be reached")
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	f := &GitHubFetcher{HTTP: srv.Client(), BaseURL: srv.URL, allowedHosts: []string{u.Hostname()}}
	_, _, _, err := f.Latest(context.Background(), "")
	if err == nil {
		t.Fatal("http scheme must be refused")
	}
	var denied *ErrDeniedURL
	if !errors.As(err, &denied) {
		t.Fatalf("want ErrDeniedURL, got %v", err)
	}
}

func TestAPIClientRefusesRedirectOffAPI(t *testing.T) {
	evilHits := 0
	evil := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilHits++
		w.WriteHeader(200)
	}))
	defer evil.Close()
	evilOtherHost := strings.Replace(evil.URL, "127.0.0.1", "localhost", 1)

	good := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evilOtherHost+"/repos/x/releases/latest", http.StatusFound)
	}))
	defer good.Close()

	f := &GitHubFetcher{
		HTTP:         multiTLSClient(good, evil),
		BaseURL:      good.URL,
		allowedHosts: []string{"127.0.0.1"},
	}
	_, _, _, err := f.Latest(context.Background(), "")
	if err == nil {
		t.Fatal("redirect off API allowlist must be refused")
	}
	var denied *ErrDeniedURL
	if !errors.As(err, &denied) {
		t.Fatalf("want ErrDeniedURL, got %v", err)
	}
	if evilHits != 0 {
		t.Fatalf("evil must get zero hits, got %d", evilHits)
	}
}

func TestAPIClientFollowsSameHost301(t *testing.T) {
	// GitHub renamed-repo style: 301 to /repositories/<id>/releases/latest on
	// the same api host — must be followed, not reported as GitHub down.
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/outof0/anypick/releases/latest" {
			http.Redirect(w, r, srv.URL+"/repositories/123456/releases/latest", http.StatusMovedPermanently)
			return
		}
		if r.URL.Path != "/repositories/123456/releases/latest" {
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.1.0", "draft": false, "prerelease": false, "assets": []any{},
		})
	}))
	defer srv.Close()

	f := testAPIFetcher(t, srv, nil)
	// Base mimics api.github.com/repos/... so first hop path matches.
	f.BaseURL = srv.URL + "/repos/outof0/anypick"
	rel, _, _, err := f.Latest(context.Background(), "")
	if err != nil {
		t.Fatalf("same-host 301 must be followed: %v", err)
	}
	if rel.Version != "1.1.0" {
		t.Fatalf("version %q", rel.Version)
	}
}

func TestAPIClientConstructorNoUnguarded(t *testing.T) {
	tr := NewAPITransport(nil)
	c := tr.Client()
	if c == nil || c.CheckRedirect == nil {
		t.Fatal("NewAPITransport().Client must install CheckRedirect")
	}
	if c == http.DefaultClient {
		t.Fatal("must not be http.DefaultClient")
	}
	// Injected client with nil CheckRedirect still gets ours.
	bare := &http.Client{}
	tr2 := &Transport{Kind: KindAPI, allowedHosts: defaultAPIHosts(), HTTP: bare}
	c2 := tr2.Client()
	if c2.CheckRedirect == nil {
		t.Fatal("injected bare client must be wrapped with CheckRedirect")
	}
	// Production fetcher with nil HTTP still allowlists api.github.com only.
	f := &GitHubFetcher{}
	tr3 := f.apiTransport()
	if err := tr3.ValidateURL("https://evil.com/x"); err == nil {
		t.Fatal("nil-HTTP fetcher must still deny non-API hosts")
	}
	if err := tr3.ValidateURL("https://api.github.com/repos/outof0/anypick/releases/latest"); err != nil {
		t.Fatalf("nil-HTTP fetcher must allow api.github.com: %v", err)
	}
}

func testChecksumTransport(t *testing.T, srv *httptest.Server) *Transport {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &Transport{Kind: KindDownload, allowedHosts: []string{u.Hostname()}, HTTP: srv.Client()}
}

func TestAttachChecksums(t *testing.T) {
	goodBody := strings.Repeat("ab", 32) + "  file.bin\n"
	t.Run("200", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			_, _ = w.Write([]byte(goodBody))
		}))
		defer srv.Close()
		tr := testChecksumTransport(t, srv)
		rel := Release{Assets: []Asset{
			{Name: "file.bin", URL: "https://github.com/x/file.bin"},
			{Name: "SHA256SUMS.txt", URL: srv.URL},
		}}
		out, err := AttachChecksums(context.Background(), tr, rel)
		if err != nil {
			t.Fatal(err)
		}
		if out.Assets[0].SHA256 != strings.Repeat("ab", 32) {
			t.Fatalf("hash %q", out.Assets[0].SHA256)
		}
	})
	t.Run("missing file", func(t *testing.T) {
		rel := Release{Assets: []Asset{{Name: "file.bin"}}}
		if _, err := AttachChecksums(context.Background(), nil, rel); err == nil {
			t.Fatal("missing SHA256SUMS.txt must fail closed")
		}
	})
	t.Run("404", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(404)
		}))
		defer srv.Close()
		tr := testChecksumTransport(t, srv)
		rel := Release{Assets: []Asset{
			{Name: "file.bin"},
			{Name: "SHA256SUMS.txt", URL: srv.URL},
		}}
		if _, err := AttachChecksums(context.Background(), tr, rel); err == nil {
			t.Fatal("404 must fail")
		}
	})
	t.Run("500", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(500)
		}))
		defer srv.Close()
		tr := testChecksumTransport(t, srv)
		rel := Release{Assets: []Asset{
			{Name: "file.bin"},
			{Name: "SHA256SUMS.txt", URL: srv.URL},
		}}
		if _, err := AttachChecksums(context.Background(), tr, rel); err == nil {
			t.Fatal("500 must fail")
		}
	})
	t.Run("unparseable body", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("not-a-sums-file\n"))
		}))
		defer srv.Close()
		tr := testChecksumTransport(t, srv)
		rel := Release{Assets: []Asset{
			{Name: "file.bin"},
			{Name: "SHA256SUMS.txt", URL: srv.URL},
		}}
		if _, err := AttachChecksums(context.Background(), tr, rel); err == nil {
			t.Fatal("unparseable must fail")
		}
	})
	t.Run("offline", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		u := srv.URL
		host, _ := url.Parse(u)
		client := srv.Client()
		srv.Close()
		tr := &Transport{Kind: KindDownload, allowedHosts: []string{host.Hostname()}, HTTP: client}
		rel := Release{Assets: []Asset{
			{Name: "file.bin"},
			{Name: "SHA256SUMS.txt", URL: u},
		}}
		_, err := AttachChecksums(context.Background(), tr, rel)
		var off *ErrOffline
		if !errors.As(err, &off) {
			t.Fatalf("want ErrOffline, got %v", err)
		}
	})
	t.Run("non-allowlisted URL refused without request", func(t *testing.T) {
		var hits int
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits++
			w.WriteHeader(200)
		}))
		defer srv.Close()
		tr := NewDownloadTransport()
		rel := Release{Assets: []Asset{
			{Name: "file.bin"},
			{Name: "SHA256SUMS.txt", URL: srv.URL},
		}}
		_, err := AttachChecksums(context.Background(), tr, rel)
		if err == nil {
			t.Fatal("non-allowlisted URL must be refused")
		}
		var denied *ErrDeniedURL
		if !errors.As(err, &denied) {
			t.Fatalf("want ErrDeniedURL, got %v", err)
		}
		if hits != 0 {
			t.Fatalf("must not make a request, hits=%d", hits)
		}
	})
	t.Run("applies hashes without requiring every asset", func(t *testing.T) {
		body := strings.Repeat("ab", 32) + "  file.bin\n"
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		defer srv.Close()
		tr := testChecksumTransport(t, srv)
		rel := Release{Assets: []Asset{
			{Name: "file.bin"},
			{Name: "other.bin"},
			{Name: "SHA256SUMS.txt", URL: srv.URL},
		}}
		out, err := AttachChecksums(context.Background(), tr, rel)
		if err != nil {
			t.Fatal(err)
		}
		if out.Assets[0].SHA256 != strings.Repeat("ab", 32) {
			t.Fatalf("file.bin hash %q", out.Assets[0].SHA256)
		}
		if out.Assets[1].SHA256 != "" {
			t.Fatalf("other.bin should remain empty, got %q", out.Assets[1].SHA256)
		}
	})
}

func TestNoUnguardedHTTPInProductionUpdate(t *testing.T) {
	// Grep-style guard: production files under internal/update must not call
	// http.Get, use http.DefaultClient, or construct a bare http.Client{}
	// outside the Transport.Client / New*Transport constructors.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var offenders []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(data), "\n") {
			trim := strings.TrimSpace(line)
			if strings.HasPrefix(trim, "//") {
				continue
			}
			lineno := i + 1
			switch {
			case strings.Contains(line, "http.Get("):
				offenders = append(offenders, filepath.Base(path)+":"+strconv.Itoa(lineno)+": http.Get(")
			case strings.Contains(line, "http.DefaultClient"):
				// Mentions in comments already skipped; code refs are banned.
				offenders = append(offenders, filepath.Base(path)+":"+strconv.Itoa(lineno)+": http.DefaultClient")
			case strings.Contains(line, "http.Client{"):
				// Bare http.Client{...} literals are banned in production files.
				// Transport.Client uses `var c http.Client` (no brace literal).
				offenders = append(offenders, filepath.Base(path)+":"+strconv.Itoa(lineno)+": http.Client{")
			}
		}
	}
	if len(offenders) > 0 {
		t.Fatalf("unguarded HTTP in production update files:\n  %s", strings.Join(offenders, "\n  "))
	}
}
