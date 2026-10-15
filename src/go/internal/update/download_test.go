package update

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testTransport(t *testing.T, srv *httptest.Server) *Transport {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &Transport{
		Kind:         KindDownload,
		allowedHosts: []string{u.Hostname()},
		HTTP:         srv.Client(),
	}
}

// multiTLSClient returns a client that can follow redirects across local TLS
// httptest servers. InsecureSkipVerify is intentional: tests rewrite evil
// redirect hosts to the distinct name "localhost" so the allowlist (not TLS
// or DNS) is what refuses the hop.
func multiTLSClient(srvs ...*httptest.Server) *http.Client {
	_ = srvs
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test-only
		},
	}
}

func TestValidateDownloadURLAllowlist(t *testing.T) {
	ok := []string{
		"https://github.com/outof0/anypick/releases/download/v1.1.0/x.zip",
		"https://objects.githubusercontent.com/github-production-release-asset/123/x",
		"https://release-assets.githubusercontent.com/github-production-release-asset/123/x",
	}
	for _, u := range ok {
		if err := ValidateDownloadURL(u); err != nil {
			t.Fatalf("allow %q: %v", u, err)
		}
	}
	bad := []string{
		"http://github.com/outof0/anypick/x",
		"https://evil.com/x",
		"https://api.github.com/repos/outof0/anypick/x",
		"https://github.com.evil.com/x",
		"ftp://github.com/x",
		"",
	}
	for _, u := range bad {
		if err := ValidateDownloadURL(u); err == nil {
			t.Fatalf("expected reject for %q", u)
		}
	}
}

func TestValidateAPIURLAllowlist(t *testing.T) {
	if err := ValidateAPIURL("https://api.github.com/repos/outof0/anypick/releases/latest"); err != nil {
		t.Fatalf("api.github.com must be allowed: %v", err)
	}
	bad := []string{
		"http://api.github.com/repos/outof0/anypick/releases/latest",
		"https://github.com/outof0/anypick/releases/latest",
		"https://evil.com/x",
		"https://objects.githubusercontent.com/x",
	}
	for _, u := range bad {
		if err := ValidateAPIURL(u); err == nil {
			t.Fatalf("expected reject for %q", u)
		}
	}
}

func TestRedirectToReleaseAssetsAllowed(t *testing.T) {
	tr := NewDownloadTransport()
	req, err := http.NewRequest(http.MethodGet, "https://release-assets.githubusercontent.com/foo", nil)
	if err != nil {
		t.Fatal(err)
	}
	via := []*http.Request{mustReq(t, "https://github.com/outof0/anypick/releases/download/v1.1.0/x")}
	if err := tr.checkRedirect(req, via); err != nil {
		t.Fatalf("release-assets redirect must be allowed: %v", err)
	}
}

func TestRedirectToOtherHostRefused(t *testing.T) {
	// Both TLS servers bind 127.0.0.1; rewrite the redirect target to the
	// distinct hostname "localhost" so the allowlist (exact host match) is
	// what refuses — not DNS/TLS failure.
	evilHits := 0
	evil := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilHits++
		w.WriteHeader(200)
	}))
	defer evil.Close()
	evilOtherHost := strings.Replace(evil.URL, "127.0.0.1", "localhost", 1)

	good := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evilOtherHost+"/stolen", http.StatusFound)
	}))
	defer good.Close()

	tr := &Transport{
		Kind:         KindDownload,
		allowedHosts: []string{"127.0.0.1"},
		HTTP:         multiTLSClient(good, evil),
	}
	_, err := tr.Get(context.Background(), good.URL+"/start")
	if err == nil {
		t.Fatal("redirect to other host must be refused")
	}
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("want ErrHostNotAllowed, got %v", err)
	}
	if evilHits != 0 {
		t.Fatalf("evil host must receive ZERO requests, got %d", evilHits)
	}
}

func TestHTTPSToHTTPDowngradeRefused(t *testing.T) {
	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("http hop must not be reached")
	}))
	defer httpSrv.Close()

	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, httpSrv.URL+"/downgrade", http.StatusFound)
	}))
	defer tlsSrv.Close()

	tr := testTransport(t, tlsSrv)
	_, err := tr.Get(context.Background(), tlsSrv.URL+"/start")
	if err == nil {
		t.Fatal("https→http downgrade must be refused")
	}
	if !strings.Contains(err.Error(), "https only") && !strings.Contains(err.Error(), "scheme") {
		t.Fatalf("want scheme refusal, got %v", err)
	}
}

func TestTooManyRedirectsRefused(t *testing.T) {
	var hops int
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, fmt.Sprintf("%s/n%d", srv.URL, hops), http.StatusFound)
	}))
	defer srv.Close()

	tr := testTransport(t, srv)
	_, err := tr.Get(context.Background(), srv.URL+"/start")
	if err == nil {
		t.Fatal("too many redirects must be refused")
	}
	if !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("want redirect cap error, got %v", err)
	}
	// Literal 5 — not maxRedirects — so raising the cap to 50 fails this test.
	if hops != 5 {
		t.Fatalf("exactly 5 hops must be followed before refusal, got %d (maxRedirects=%d)", hops, maxRedirects)
	}
	if maxRedirects != 5 {
		t.Fatalf("maxRedirects drifted to %d; update the hop assertion deliberately", maxRedirects)
	}
}

func TestRedirectSameAllowlistedHostOK(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, srv.URL+"/final", http.StatusFound)
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	tr := testTransport(t, srv)
	resp, err := tr.Get(context.Background(), srv.URL+"/start")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Fatalf("body %q", body)
	}
}

func TestDefaultHTTPClientNoDefaultClient(t *testing.T) {
	c := DefaultDownloadHTTPClient()
	if c == nil || c.CheckRedirect == nil {
		t.Fatal("DefaultDownloadHTTPClient must install CheckRedirect")
	}
	if c == http.DefaultClient {
		t.Fatal("must not return http.DefaultClient")
	}
	api := DefaultAPIHTTPClient()
	if api == nil || api.CheckRedirect == nil {
		t.Fatal("DefaultAPIHTTPClient must install CheckRedirect")
	}
	if api == http.DefaultClient {
		t.Fatal("API client must not be http.DefaultClient")
	}
}

func TestTransportInstallsCheckRedirectOnInjectedClient(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()
	tr := testTransport(t, srv)
	c := tr.Client()
	if c.CheckRedirect == nil {
		t.Fatal("CheckRedirect must be installed on injected client")
	}
	resp, err := tr.Get(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func TestCheckRedirectAlwaysWrapsCaller(t *testing.T) {
	// Caller CheckRedirect allows everything; ours must still refuse off-list.
	evilHits := 0
	evil := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilHits++
		w.WriteHeader(200)
	}))
	defer evil.Close()
	evilOtherHost := strings.Replace(evil.URL, "127.0.0.1", "localhost", 1)

	good := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evilOtherHost+"/x", http.StatusFound)
	}))
	defer good.Close()

	permissive := multiTLSClient(good, evil)
	permissive.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return nil // allow everything
	}
	tr := &Transport{
		Kind:         KindDownload,
		allowedHosts: []string{"127.0.0.1"},
		HTTP:         permissive,
	}
	_, err := tr.Get(context.Background(), good.URL+"/start")
	if err == nil {
		t.Fatal("permissive caller CheckRedirect must not bypass allowlist")
	}
	if evilHits != 0 {
		t.Fatalf("evil must get zero hits, got %d", evilHits)
	}

	// Same for API kind.
	apiPermissive := multiTLSClient(good, evil)
	apiPermissive.CheckRedirect = func(req *http.Request, via []*http.Request) error { return nil }
	apiTr := &Transport{
		Kind:         KindAPI,
		allowedHosts: []string{"127.0.0.1"},
		HTTP:         apiPermissive,
	}
	_, err = apiTr.Get(context.Background(), good.URL+"/start")
	if err == nil {
		t.Fatal("API client: permissive CheckRedirect must not bypass allowlist")
	}
}

func TestNewAPITransportFeedHostGated(t *testing.T) {
	feed := "https://127.0.0.1:9443/repos/outof0/anypick"
	open := NewAPITransport(MapEnv{EnvTesting: "1", EnvFeedURL: feed})
	if err := open.ValidateURL(feed + "/releases/latest"); err != nil {
		t.Fatalf("gate open: feed host must be allowed: %v", err)
	}
	if err := open.ValidateURL("https://api.github.com/repos/x/releases/latest"); err != nil {
		t.Fatalf("gate open: api.github.com still allowed: %v", err)
	}

	closed := NewAPITransport(MapEnv{EnvFeedURL: feed}) // TESTING unset
	if err := closed.ValidateURL(feed + "/releases/latest"); err == nil {
		t.Fatal("gate closed: feed host must NOT be on allowlist")
	}
	if err := closed.ValidateURL("https://api.github.com/repos/x/releases/latest"); err != nil {
		t.Fatalf("gate closed: default api.github.com must be used: %v", err)
	}

	// TESTING not exactly "1"
	almost := NewAPITransport(MapEnv{EnvTesting: "true", EnvFeedURL: feed})
	if err := almost.ValidateURL(feed + "/releases/latest"); err == nil {
		t.Fatal("TESTING=true must not open the gate")
	}
}

func TestDownloadAssetHappyAndDenied(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("asset-bytes"))
	}))
	defer srv.Close()

	tr := testTransport(t, srv)
	resp, err := DownloadAsset(context.Background(), tr, srv.URL+"/AnyPick.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "asset-bytes" {
		t.Fatalf("body %q", body)
	}

	// Off-list refused with no request (nil transport → production download list).
	var hits int
	evil := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
	}))
	defer evil.Close()
	_, err = DownloadAsset(context.Background(), nil, evil.URL+"/x")
	if err == nil {
		t.Fatal("off-list DownloadAsset must be refused")
	}
	var denied *ErrDeniedURL
	if !errors.As(err, &denied) {
		t.Fatalf("want ErrDeniedURL, got %v", err)
	}
	if hits != 0 {
		t.Fatalf("no request on deny, hits=%d", hits)
	}
}

func TestLiveGitHubSHA256SUMS(t *testing.T) {
	if os.Getenv("ANYPICK_UPDATE_LIVE_TEST") != "1" {
		t.Skip("set ANYPICK_UPDATE_LIVE_TEST=1 to enable live GitHub download")
	}
	const rawURL = "https://github.com/outof0/anypick/releases/download/v1.1.0/SHA256SUMS.txt"
	tr := NewDownloadTransport()
	resp, err := tr.Get(context.Background(), rawURL)
	if err != nil {
		t.Fatalf("live download: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d", resp.StatusCode)
	}
	sums, err := ParseSHA256SUMS(resp.Body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(sums) == 0 {
		t.Fatal("expected checksum entries from real v1.1.0 SHA256SUMS.txt")
	}
	if _, ok := sums["AnyPick-macos-universal.zip"]; !ok {
		t.Fatalf("missing expected asset in sums: keys=%d", len(sums))
	}
}

func TestLiveGitHubAPILatest(t *testing.T) {
	if os.Getenv("ANYPICK_UPDATE_LIVE_TEST") != "1" {
		t.Skip("set ANYPICK_UPDATE_LIVE_TEST=1 to enable live GitHub API fetch")
	}
	f := &GitHubFetcher{Env: MapEnv{}} // production API client, no hooks
	rel, etag, mod, err := f.Latest(context.Background(), "")
	if err != nil {
		t.Fatalf("live API: %v", err)
	}
	if mod {
		t.Fatal("first fetch must not be 304")
	}
	if rel.Version == "" || rel.Tag == "" {
		t.Fatalf("empty release: %+v", rel)
	}
	if etag == "" {
		t.Log("warning: no ETag from GitHub (unusual but not fatal)")
	}
	// Spot-check: a known asset name pattern from recent releases.
	if len(rel.Assets) == 0 {
		t.Fatal("expected assets on latest release")
	}
}

func mustReq(t *testing.T, raw string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestAllowedHostsNotExported(t *testing.T) {
	// Fail if Transport or GitHubFetcher expose any exported field or setter
	// that can replace the host allowlists.
	for _, typ := range []reflect.Type{
		reflect.TypeOf(Transport{}),
		reflect.TypeOf(GitHubFetcher{}),
	} {
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if f.PkgPath != "" {
				continue // unexported
			}
			name := strings.ToLower(f.Name)
			if strings.Contains(name, "allowedhost") ||
				strings.Contains(name, "allowlist") ||
				strings.Contains(name, "hostlist") ||
				name == "hosts" {
				t.Errorf("%s exported field %s can replace host lists", typ.Name(), f.Name)
			}
		}
		ptr := reflect.PointerTo(typ)
		for i := 0; i < ptr.NumMethod(); i++ {
			m := ptr.Method(i)
			name := strings.ToLower(m.Name)
			if strings.Contains(name, "allowedhost") ||
				strings.Contains(name, "allowlist") ||
				(strings.HasPrefix(name, "set") && strings.Contains(name, "host")) {
				t.Errorf("%s exported method %s can replace host lists", typ.Name(), m.Name)
			}
		}
	}

	// Package-level: no exported var may hold a host list ([]string). Error
	// sentinels (Err*) stay allowed; a re-exported DefaultAllowed* var must fail.
	assertNoExportedHostListVars(t)
}

func assertNoExportedHostListVars(t *testing.T) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, ent := range entries {
		name := ent.Name()
		if ent.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		filename := filepath.Join(dir, name)
		file, err := parser.ParseFile(fset, filename, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.VAR {
				continue
			}
			for _, spec := range gen.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, ident := range vs.Names {
					if !ident.IsExported() {
						continue
					}
					if isStringSliceVar(vs, i) || looksLikeHostListName(ident.Name) {
						t.Errorf("%s: exported package var %s can hold/replace host lists", name, ident.Name)
					}
				}
			}
		}
	}
}

func looksLikeHostListName(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "allowedhost") ||
		strings.Contains(lower, "allowlist") ||
		strings.Contains(lower, "hostlist") ||
		(strings.Contains(lower, "host") && strings.Contains(lower, "default"))
}

// isStringSliceVar reports whether the i-th name in vs is typed or initialized
// as []string (the shape of a host allowlist).
func isStringSliceVar(vs *ast.ValueSpec, i int) bool {
	if vs.Type != nil && isStringSliceType(vs.Type) {
		return true
	}
	if i < len(vs.Values) && isStringSliceComposite(vs.Values[i]) {
		return true
	}
	if len(vs.Values) == 1 && isStringSliceComposite(vs.Values[0]) {
		return true
	}
	return false
}

func isStringSliceType(expr ast.Expr) bool {
	arr, ok := expr.(*ast.ArrayType)
	if !ok || arr.Len != nil {
		return false
	}
	id, ok := arr.Elt.(*ast.Ident)
	return ok && id.Name == "string"
}

func isStringSliceComposite(expr ast.Expr) bool {
	comp, ok := expr.(*ast.CompositeLit)
	return ok && isStringSliceType(comp.Type)
}

func TestErrHostNotAllowedIsTyped(t *testing.T) {
	err := ValidateDownloadURL("https://evil.example/x.zip")
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("want ErrHostNotAllowed, got %v", err)
	}
	// Rewording the wrapped message must still match via errors.Is.
	wrapped := fmt.Errorf("totally reworded refusal: %w", ErrHostNotAllowed)
	if !errors.Is(wrapped, ErrHostNotAllowed) {
		t.Fatal("reworded wrap must still be ErrHostNotAllowed")
	}
	denied := &ErrDeniedURL{Err: fmt.Errorf("different words about a bad host: %w", ErrHostNotAllowed)}
	if !errors.Is(denied, ErrHostNotAllowed) {
		t.Fatal("ErrDeniedURL chain must still unwrap to ErrHostNotAllowed")
	}
}

func TestValidateURLSchemeIsHostNotAllowed(t *testing.T) {
	err := ValidateDownloadURL("http://github.com/x")
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("https-only refusal must be ErrHostNotAllowed, got %v", err)
	}
}
