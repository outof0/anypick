package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultAPIBase = "https://api.github.com/repos/outof0/anypick"
	userAgent      = "AnyPick-Update/1.0"
)

// ErrNotModified is returned (with notModified=true) when the server answers 304.
var ErrNotModified = errors.New("not modified")

// ErrRateLimited is returned for HTTP 403/429 from the GitHub API.
var ErrRateLimited = errors.New("rate limited")

// ErrOffline wraps a transport-level failure (DNS, dial, timeout).
type ErrOffline struct{ Err error }

func (e *ErrOffline) Error() string {
	if e.Err == nil {
		return "offline"
	}
	return "offline: " + e.Err.Error()
}
func (e *ErrOffline) Unwrap() error { return e.Err }

// Fetcher loads the latest published release.
type Fetcher interface {
	Latest(ctx context.Context, etag string) (rel Release, newETag string, notModified bool, err error)
}

// GitHubFetcher talks to the GitHub Releases API through a dedicated API
// client that allows ONLY api.github.com (https, CheckRedirect on every hop,
// same redirect cap as downloads). There is no fallback to an unrestricted
// client: a nil HTTP field uses NewAPITransport; a caller-supplied HTTP
// client (tests) is always wrapped so the API allowlist still applies.
//
// Tests inject allowedHosts (e.g. httptest loopback) on the unexported field
// and optionally HTTP for TLS trust — not a raw unguarded client.
//
// When ANYPICK_UPDATE_TESTING=1 and ANYPICK_UPDATE_FEED_URL is set, that feed host is
// added to the API allowlist; otherwise the feed URL is ignored and the
// default api.github.com base is used.
type GitHubFetcher struct {
	HTTP         *http.Client // optional; always wrapped with API allowlist
	BaseURL      string       // API base, e.g. https://api.github.com/repos/outof0/anypick
	Env          Env
	allowedHosts []string // unexported API allowlist override; empty → NewAPITransport(Env)
}

// apiTransport returns the allowlisted API Transport. Injected allowedHosts
// replace the default list (tests, same package). Otherwise NewAPITransport(Env)
// applies api.github.com plus an optional gated feed host. Injected HTTP is
// kept for TLS/timeout but CheckRedirect is always ours (wrapping theirs).
func (f *GitHubFetcher) apiTransport() *Transport {
	if f != nil && len(f.allowedHosts) > 0 {
		return &Transport{Kind: KindAPI, allowedHosts: f.allowedHosts, HTTP: f.HTTP}
	}
	tr := NewAPITransport(f.env())
	if f != nil && f.HTTP != nil {
		tr.HTTP = f.HTTP
	}
	return tr
}

func (f *GitHubFetcher) env() Env {
	if f != nil && f.Env != nil {
		return f.Env
	}
	return OSEnv{}
}

func (f *GitHubFetcher) base() string {
	if override := HookFeedURL(f.env()); override != "" {
		return override
	}
	if f != nil && f.BaseURL != "" {
		return strings.TrimRight(f.BaseURL, "/")
	}
	return defaultAPIBase
}

type ghRelease struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	HTMLURL     string    `json:"html_url"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// Latest fetches /releases/latest through the API allowlisted client. The
// first URL and every redirect hop must be https on an API-allowlisted host
// (production: api.github.com only). Drafts and prereleases are rejected even
// if the API somehow returns them. 304 sets notModified. 403/429 return
// ErrRateLimited without panicking. Allowlist failures return *ErrDeniedURL
// (no request). Transport errors return *ErrOffline.
func (f *GitHubFetcher) Latest(ctx context.Context, etag string) (Release, string, bool, error) {
	rawURL := f.base() + "/releases/latest"
	tr := f.apiTransport()
	if err := tr.ValidateURL(rawURL); err != nil {
		return Release{}, "", false, &ErrDeniedURL{Err: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Release{}, "", false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := tr.Client().Do(req)
	if err != nil {
		var denied *ErrDeniedURL
		if errors.As(err, &denied) {
			return Release{}, "", false, err
		}
		// CheckRedirect failures wrap ErrHostNotAllowed; treat as denied rather
		// than offline (never match on error text).
		if isDeniedRedirect(err) {
			return Release{}, "", false, &ErrDeniedURL{Err: err}
		}
		return Release{}, "", false, &ErrOffline{Err: err}
	}
	defer resp.Body.Close()
	newETag := resp.Header.Get("ETag")
	switch resp.StatusCode {
	case http.StatusNotModified:
		return Release{}, etagOr(newETag, etag), true, nil
	case http.StatusForbidden, http.StatusTooManyRequests:
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return Release{}, etagOr(newETag, etag), false, ErrRateLimited
	case http.StatusOK:
		// continue
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return Release{}, "", false, fmt.Errorf("github releases: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var raw ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Release{}, "", false, fmt.Errorf("decode release: %w", err)
	}
	if raw.Draft || raw.Prerelease {
		return Release{}, "", false, fmt.Errorf("latest release %q is draft/prerelease; ignored", raw.TagName)
	}
	ver, err := ParseVersion(raw.TagName)
	if err != nil {
		return Release{}, "", false, fmt.Errorf("release tag %q: %w", raw.TagName, err)
	}
	if ver.IsPrerelease() {
		return Release{}, "", false, fmt.Errorf("latest release %q has prerelease tag; ignored", raw.TagName)
	}
	assets := make([]Asset, 0, len(raw.Assets))
	for _, a := range raw.Assets {
		if err := ValidateAssetName(a.Name); err != nil {
			return Release{}, "", false, fmt.Errorf("release asset: %w", err)
		}
		assets = append(assets, Asset{Name: a.Name, URL: a.BrowserDownloadURL, Size: a.Size})
	}
	rel := Release{
		Tag:         raw.TagName,
		Version:     ver.String(),
		Notes:       raw.Body,
		PublishedAt: raw.PublishedAt,
		Prerelease:  raw.Prerelease,
		Draft:       raw.Draft,
		Assets:      assets,
		HTMLURL:     raw.HTMLURL,
	}
	return rel, etagOr(newETag, etag), false, nil
}

func isDeniedRedirect(err error) bool {
	return errors.Is(err, ErrHostNotAllowed)
}

func etagOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// AttachChecksums fetches SHA256SUMS.txt from the release assets (by name) and
// fills Asset.SHA256 via the download allowlisted Transport (initial URL and
// every redirect hop). Fail-closed: missing SUMS file, non-allowlisted URL
// (no request is made), non-200 / offline fetch, or unparseable body returns
// an error. Call RequireChecksums for the asset being installed before install.
func AttachChecksums(ctx context.Context, tr *Transport, rel Release) (Release, error) {
	if tr == nil {
		tr = NewDownloadTransport()
	}
	var sumsURL string
	for _, a := range rel.Assets {
		if a.Name == "SHA256SUMS.txt" {
			sumsURL = a.URL
			break
		}
	}
	if sumsURL == "" {
		return rel, fmt.Errorf("SHA256SUMS.txt missing from release assets")
	}
	resp, err := tr.Get(ctx, sumsURL)
	if err != nil {
		var denied *ErrDeniedURL
		if errors.As(err, &denied) || errors.Is(err, ErrHostNotAllowed) {
			return rel, err
		}
		return rel, &ErrOffline{Err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return rel, fmt.Errorf("SHA256SUMS.txt: HTTP %d", resp.StatusCode)
	}
	sums, err := ParseSHA256SUMS(resp.Body)
	if err != nil {
		return rel, err
	}
	rel.Assets = ApplyChecksums(rel.Assets, sums)
	return rel, nil
}
