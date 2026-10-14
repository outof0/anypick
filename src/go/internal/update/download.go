package update

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// maxRedirects caps how many redirects either allowlisted client will follow.
const maxRedirects = 5

// ErrDeniedURL is returned when the initial URL or a redirect hop fails the
// allowlist / https check. Callers must not treat it as ErrOffline.
type ErrDeniedURL struct{ Err error }

func (e *ErrDeniedURL) Error() string {
	if e.Err == nil {
		return "URL denied"
	}
	return e.Err.Error()
}
func (e *ErrDeniedURL) Unwrap() error { return e.Err }

// ErrDeniedDownloadURL is an alias kept for call sites that predate the
// shared ErrDeniedURL name (downloads and API fetches use the same type).
type ErrDeniedDownloadURL = ErrDeniedURL

// ErrHostNotAllowed is returned (possibly wrapped) when the initial URL or a
// redirect hop fails the host allowlist, the https-only check, or the redirect
// cap. Match with errors.Is — never by error text. Callers must not treat it
// as ErrOffline.
var ErrHostNotAllowed = errors.New("host not allowed")

// defaultAPIHosts returns a fresh copy of the production allowlist for GitHub
// Releases metadata fetches. Exact host match, https only, no wildcards.
func defaultAPIHosts() []string {
	return []string{"api.github.com"}
}

// defaultDownloadHosts returns a fresh copy of the production allowlist for
// release asset downloads. Exact host match, https only, no wildcards.
//
// release-assets.githubusercontent.com is included because GitHub 302-redirects
// real browser_download_url responses from github.com there (verified against
// v1.1.0 SHA256SUMS.txt). Without it every real download is refused.
func defaultDownloadHosts() []string {
	return []string{
		"github.com",
		"objects.githubusercontent.com",
		"release-assets.githubusercontent.com",
	}
}

// Transport is an allowlisted HTTPS client. Two production configurations
// exist — never mix them:
//
//   - API:     NewAPITransport / defaultAPIHosts (api.github.com only;
//     test-feed host may be added when ANYPICK_UPDATE_TESTING=1).
//   - Download: NewDownloadTransport / defaultDownloadHosts (the three
//     GitHub download hosts).
//
// allowedHosts defaults depend on Kind when nil/empty. Tests in this package
// inject their own hosts (e.g. "127.0.0.1") on the unexported field and
// typically set HTTP to an *http.Client whose Transport trusts
// httptest.NewTLSServer. A caller-supplied HTTP client is always wrapped: our
// CheckRedirect runs first on every hop, then theirs. The caller's proxy,
// dialer, and TLS settings are trusted; only host/https allowlist checks are
// enforced by AnyPick.
//
// The initial URL is validated before the request; every redirect hop is
// validated by CheckRedirect (host allowlist + https only, so an https→http
// downgrade is refused). There is no fallback to http.DefaultClient or a
// bare http.Client.
type TransportKind int

const (
	// KindDownload is the default when Kind is unset (zero value).
	KindDownload TransportKind = iota
	KindAPI
)

// Transport is the shared allowlisted HTTPS client used for API fetches,
// AttachChecksums, and asset downloads — always with an explicit host list.
type Transport struct {
	Kind         TransportKind // KindAPI or KindDownload (default)
	allowedHosts []string      // unexported; tests set same-package only
	HTTP         *http.Client
}

// NewAPITransport returns the production API client (api.github.com only,
// https, CheckRedirect on every hop). When env has ANYPICK_UPDATE_TESTING=1 and
// ANYPICK_UPDATE_FEED_URL set, that feed host is added to the allowlist; otherwise
// the feed URL is ignored.
func NewAPITransport(env Env) *Transport {
	hosts := defaultAPIHosts()
	if feed := HookFeedURL(env); feed != "" {
		if u, err := url.Parse(feed); err == nil {
			if h := strings.ToLower(u.Hostname()); h != "" {
				hosts = append(hosts, h)
			}
		}
	}
	return &Transport{Kind: KindAPI, allowedHosts: hosts}
}

// NewDownloadTransport returns the production download client (three GitHub
// hosts, https, CheckRedirect on every hop).
func NewDownloadTransport() *Transport {
	return &Transport{Kind: KindDownload, allowedHosts: defaultDownloadHosts()}
}

func (t *Transport) hostSet() map[string]struct{} {
	var hosts []string
	if t != nil && len(t.allowedHosts) > 0 {
		hosts = t.allowedHosts
	} else if t != nil && t.Kind == KindAPI {
		hosts = defaultAPIHosts()
	} else {
		hosts = defaultDownloadHosts()
	}
	out := make(map[string]struct{}, len(hosts))
	for _, h := range hosts {
		out[strings.ToLower(h)] = struct{}{}
	}
	return out
}

// ValidateURL reports whether raw is an https URL on an allowlisted exact host.
func (t *Transport) ValidateURL(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("empty download URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse download URL: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("%w: download URL scheme %q (https only)", ErrHostNotAllowed, u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if _, ok := t.hostSet()[host]; !ok {
		return fmt.Errorf("%w: download host %q", ErrHostNotAllowed, host)
	}
	return nil
}

// ValidateDownloadURL validates raw against the production download allowlist.
func ValidateDownloadURL(raw string) error {
	return NewDownloadTransport().ValidateURL(raw)
}

// ValidateAPIURL validates raw against the production API allowlist
// (api.github.com only; no test-feed host).
func ValidateAPIURL(raw string) error {
	return (&Transport{Kind: KindAPI}).ValidateURL(raw)
}

// checkRedirect validates each redirect target and caps hop count.
func (t *Transport) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return fmt.Errorf("%w: stopped after %d redirects", ErrHostNotAllowed, maxRedirects)
	}
	if req.URL == nil {
		return fmt.Errorf("%w: redirect missing URL", ErrHostNotAllowed)
	}
	return t.ValidateURL(req.URL.String())
}

// Client returns the HTTP client with per-hop redirect checks. When t.HTTP is
// set (tests), its Transport/Timeout are kept. Our allowlist CheckRedirect is
// always installed and runs first; a caller-supplied CheckRedirect runs after
// ours succeeds (so a permissive injected check cannot bypass the allowlist).
func (t *Transport) Client() *http.Client {
	var c http.Client
	if t != nil && t.HTTP != nil {
		c = *t.HTTP
	}
	inner := c.CheckRedirect
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := t.checkRedirect(req, via); err != nil {
			return err
		}
		if inner != nil {
			return inner(req, via)
		}
		return nil
	}
	return &c
}

// DefaultDownloadHTTPClient returns the production download client.
func DefaultDownloadHTTPClient() *http.Client {
	return NewDownloadTransport().Client()
}

// DefaultAPIHTTPClient returns the production API client (no test-feed host).
func DefaultAPIHTTPClient() *http.Client {
	return NewAPITransport(nil).Client()
}

// DefaultHTTPClient is the production download client. Prefer
// DefaultDownloadHTTPClient or NewDownloadTransport; kept so existing call
// sites that mean "download" keep working.
func DefaultHTTPClient() *http.Client {
	return DefaultDownloadHTTPClient()
}

// Get validates rawURL against the allowlist, then GETs it with a client that
// checks every redirect hop. Used by AttachChecksums, asset downloads, and
// (with an API Transport) release metadata. Allowlist failures return
// *ErrDeniedURL (no request is made).
func (t *Transport) Get(ctx context.Context, rawURL string) (*http.Response, error) {
	if t == nil {
		t = NewDownloadTransport()
	}
	if err := t.ValidateURL(rawURL); err != nil {
		return nil, &ErrDeniedURL{Err: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := t.Client().Do(req)
	if err != nil {
		if errors.Is(err, ErrHostNotAllowed) {
			return nil, &ErrDeniedURL{Err: err}
		}
		return nil, err
	}
	return resp, nil
}

// DownloadAsset GETs an installable release asset through the download
// allowlisted client (initial URL + every redirect hop). Callers that install
// the bytes are wired in a later slice; this helper is ready now.
func DownloadAsset(ctx context.Context, tr *Transport, rawURL string) (*http.Response, error) {
	if tr == nil {
		tr = NewDownloadTransport()
	}
	return tr.Get(ctx, rawURL)
}

// ValidateAssetName rejects asset names that contain path separators or "..".
// No basename trimming — a renamed or path-like name fails closed.
func ValidateAssetName(name string) error {
	if name == "" {
		return fmt.Errorf("empty asset name")
	}
	if strings.Contains(name, "..") {
		return fmt.Errorf("asset name %q contains a parent-directory segment", name)
	}
	if strings.ContainsAny(name, "/\\") {
		return fmt.Errorf("asset name %q contains path separator", name)
	}
	return nil
}
