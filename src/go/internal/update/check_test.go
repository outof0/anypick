package update

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

type stubFetcher struct {
	rel         Release
	etag        string
	notModified bool
	err         error
	calls       int
	lastETag    string
	// sequence: if non-nil, each Latest call pops the next response.
	seq []stubFetchResp
}

type stubFetchResp struct {
	rel         Release
	etag        string
	notModified bool
	err         error
}

func (s *stubFetcher) Latest(ctx context.Context, etag string) (Release, string, bool, error) {
	s.calls++
	s.lastETag = etag
	if len(s.seq) > 0 {
		r := s.seq[0]
		s.seq = s.seq[1:]
		if r.err != nil {
			return Release{}, r.etag, false, r.err
		}
		if r.notModified {
			return Release{}, etag, true, nil
		}
		return r.rel, r.etag, false, nil
	}
	if s.err != nil {
		return Release{}, s.etag, false, s.err
	}
	if s.notModified {
		return Release{}, etag, true, nil
	}
	return s.rel, s.etag, false, nil
}

func TestCheckUpgradeDirect(t *testing.T) {
	f := &stubFetcher{
		rel:  Release{Tag: "v1.2.0", Version: "1.2.0", Notes: "hi", Assets: []Asset{{Name: "AnyPick-macos-universal.zip", URL: "u"}}},
		etag: `"e1"`,
	}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Date(2026, 10, 11, 18, 0, 0, 0, time.UTC)}, GOOS: "darwin", GOARCH: "arm64"}
	res := c.Check(context.Background(), CheckInput{
		Current:  "1.1.0",
		Settings: DefaultSettings(),
		Channel:  ChannelDirect,
		Manual:   true,
	})
	if res.State.Kind != StateAvailableDirect {
		t.Fatalf("kind=%s err=%v", res.State.Kind, res.State.Err)
	}
	if res.Settings.ETag != `"e1"` || res.Settings.HighestSeen != "1.2.0" {
		t.Fatalf("settings %+v", res.Settings)
	}
	if res.State.Asset == nil || res.State.Asset.Name != "AnyPick-macos-universal.zip" {
		t.Fatalf("asset %+v", res.State.Asset)
	}
	if res.State.Action.Kind != ActionSelfUpdate {
		t.Fatalf("action %+v", res.State.Action)
	}
}

func TestCheckRefuseDowngrade(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.0.0", Version: "1.0.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateUpToDate {
		t.Fatalf("kind=%s", res.State.Kind)
	}
}

func TestCheckHighestSeenBlocksRollback(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.1.0", Version: "1.1.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.HighestSeen = "1.2.0"
	res := c.Check(context.Background(), CheckInput{
		Current: "1.0.0", Settings: s, Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateUpToDate {
		t.Fatalf("kind=%s want upToDate (rollback refused)", res.State.Kind)
	}
}

func TestCheckSkipVersion(t *testing.T) {
	rel := Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}
	f := &stubFetcher{rel: rel}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.SkippedVersion = "1.2.0"

	auto := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: false,
	})
	if auto.State.Kind != StateUpToDate {
		t.Fatalf("auto skip: kind=%s", auto.State.Kind)
	}
	if auto.State.SkippedHint == "" {
		t.Fatal("expected skip hint")
	}

	manual := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: true,
	})
	if manual.State.Kind != StateAvailableDirect {
		t.Fatalf("manual should still show update, got %s", manual.State.Kind)
	}
	if manual.State.SkippedHint == "" {
		t.Fatal("manual should mention skipped copy")
	}
}

func TestCheckSkipOnlyExactVersion(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.3.0", Version: "1.3.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.SkippedVersion = "1.2.0"
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: false,
	})
	if res.State.Kind != StateAvailableDirect {
		t.Fatalf("newer than skipped should show, got %s", res.State.Kind)
	}
}

func TestCheckThrottle(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}}
	start := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	c := &Checker{Fetcher: f, Clock: FixedClock{T: start.Add(1 * time.Hour)}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.LastChecked = start
	cached := &Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: false, Cached: cached,
	})
	if f.calls != 0 {
		t.Fatalf("throttled check must not hit network, calls=%d", f.calls)
	}
	if res.State.Kind != StateAvailableDirect {
		t.Fatalf("kind=%s", res.State.Kind)
	}

	res2 := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: true, Cached: cached,
	})
	if f.calls != 1 {
		t.Fatalf("manual should fetch, calls=%d", f.calls)
	}
	if res2.State.Kind != StateAvailableDirect {
		t.Fatalf("kind=%s", res2.State.Kind)
	}
}

func TestCheckThrottleExpires(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}}
	start := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	c := &Checker{Fetcher: f, Clock: FixedClock{T: start.Add(25 * time.Hour)}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.LastChecked = start
	_ = c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: false,
	})
	if f.calls != 1 {
		t.Fatalf("calls=%d", f.calls)
	}
}

func TestCheckLastCheckedInFutureCountsAsExpired(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}}
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	c := &Checker{Fetcher: f, Clock: FixedClock{T: now}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.LastChecked = now.Add(2 * time.Hour) // clock rollback: LastChecked in the future
	_ = c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: false,
	})
	if f.calls != 1 {
		t.Fatalf("future LastChecked must count as expired, calls=%d", f.calls)
	}
}

func TestCheckRateLimitedAndOffline(t *testing.T) {
	c := &Checker{Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	c.Fetcher = &stubFetcher{err: ErrRateLimited}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateRateLimited {
		t.Fatalf("kind=%s", res.State.Kind)
	}

	c.Fetcher = &stubFetcher{err: &ErrOffline{Err: errors.New("dial")}}
	res = c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateOffline {
		t.Fatalf("kind=%s", res.State.Kind)
	}
}

func TestCheck5xxGitHubDown(t *testing.T) {
	f := &stubFetcher{err: errors.New("github releases: HTTP 502: bad gateway")}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateGitHubDown {
		t.Fatalf("kind=%s", res.State.Kind)
	}
}

func TestCheckUnparseableTagNeverAvailable(t *testing.T) {
	// Fetcher returns error for bad tag; check surfaces githubDown, never available*.
	f := &stubFetcher{err: errors.New(`release tag "nope": "nope" is not major.minor.patch`)}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind == StateAvailableDirect || res.State.Kind == StateAvailablePackageManager {
		t.Fatalf("unparseable must never be available, got %s", res.State.Kind)
	}
	if res.State.Kind != StateGitHubDown {
		t.Fatalf("kind=%s", res.State.Kind)
	}
}

func TestCheckPackageManager(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{
		{Name: "AnyPick_1.2.0_amd64.deb"},
	}}}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "linux", GOARCH: "amd64"}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDeb, Manual: true,
	})
	if res.State.Kind != StateAvailablePackageManager {
		t.Fatalf("kind=%s", res.State.Kind)
	}
	if res.State.Command != "sudo apt install ./AnyPick_1.2.0_amd64.deb" {
		t.Fatalf("cmd=%q", res.State.Command)
	}
	if res.State.Action.Kind != ActionDownloadAsset || res.State.Action.DownloadAsset != "AnyPick_1.2.0_amd64.deb" {
		t.Fatalf("action %+v", res.State.Action)
	}
}

func TestCheckETag304UsesCache(t *testing.T) {
	cached := &Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}
	f := &stubFetcher{notModified: true, etag: `"same"`}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.ETag = `"same"`
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: true, Cached: cached,
	})
	if res.State.Kind != StateAvailableDirect {
		t.Fatalf("kind=%s", res.State.Kind)
	}
	if f.lastETag != `"same"` {
		t.Fatalf("etag not re-sent: %q", f.lastETag)
	}
}

func TestCheckETagSavedAndResent(t *testing.T) {
	f := &stubFetcher{
		rel:  Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}},
		etag: `"new-etag"`,
	}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: true,
	})
	if res.Settings.ETag != `"new-etag"` {
		t.Fatalf("etag not saved: %q", res.Settings.ETag)
	}
	f.notModified = true
	s2 := res.Settings
	_ = c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s2, Channel: ChannelDirect, Manual: true,
		Cached: &f.rel,
	})
	if f.lastETag != `"new-etag"` {
		t.Fatalf("saved etag not re-sent: %q", f.lastETag)
	}
}

func TestCheck304WithoutCacheRefetches(t *testing.T) {
	f := &stubFetcher{
		seq: []stubFetchResp{
			{notModified: true, etag: `"e"`},
			{rel: Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{{Name: "AnyPick-macos-universal.zip"}}}, etag: `"e2"`},
		},
	}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	s := DefaultSettings()
	s.ETag = `"e"`
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: s, Channel: ChannelDirect, Manual: true, Cached: nil,
	})
	if res.State.Kind == StateUpToDate {
		t.Fatal("304 with no cache must NOT report upToDate")
	}
	if res.State.Kind != StateAvailableDirect {
		t.Fatalf("kind=%s err=%v", res.State.Kind, res.State.Err)
	}
	if f.calls != 2 {
		t.Fatalf("want refetch without etag, calls=%d", f.calls)
	}
	if f.lastETag != "" {
		t.Fatalf("refetch must omit If-None-Match, got %q", f.lastETag)
	}
}

func TestCheckArm64AndUnknownManual(t *testing.T) {
	rel := Release{Tag: "v1.2.0", Version: "1.2.0", HTMLURL: "https://github.com/outof0/anypick/releases/tag/v1.2.0", Assets: []Asset{
		{Name: "anypick-1.2.0-linux-arm64.tar.gz"},
	}}
	f := &stubFetcher{rel: rel}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "linux", GOARCH: "arm64"}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateAvailablePackageManager {
		t.Fatalf("kind=%s", res.State.Kind)
	}
	if res.State.Action.Kind != ActionManual {
		t.Fatalf("action %+v", res.State.Action)
	}

	c2 := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "linux", GOARCH: "amd64"}
	res2 := c2.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelUnknown, Manual: true,
	})
	if res2.State.Kind != StateAvailablePackageManager || res2.State.Action.Kind != ActionManual {
		t.Fatalf("unknown: kind=%s action=%+v", res2.State.Kind, res2.State.Action)
	}
}

func TestCheckHostBlocked(t *testing.T) {
	c := &Checker{Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	c.Fetcher = &stubFetcher{err: &ErrDeniedURL{Err: fmt.Errorf("%w: download host %q", ErrHostNotAllowed, "evil.example")}}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateHostBlocked {
		t.Fatalf("kind=%s want hostBlocked", res.State.Kind)
	}
	if res.State.Kind == StateOffline {
		t.Fatal("host block must never be offline")
	}
	if res.State.Retry {
		t.Fatal("hostBlocked Retry must be false")
	}
	wantMsg := HostBlockedCopy("1.1.0")
	if res.State.Message != wantMsg {
		t.Fatalf("Message=%q want %q", res.State.Message, wantMsg)
	}
	if res.State.Action.Kind != ActionManual || res.State.Action.Lead != "View on GitHub" {
		t.Fatalf("Action=%+v want View on GitHub", res.State.Action)
	}
	if res.State.Command != "https://github.com/outof0/anypick/releases" {
		t.Fatalf("Command=%q", res.State.Command)
	}
}

func TestCheckHostBlockedRewordedStillMaps(t *testing.T) {
	// Mapping must use errors.Is, not error-text matching — a reworded message
	// that still wraps ErrHostNotAllowed must land on hostBlocked.
	c := &Checker{Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	c.Fetcher = &stubFetcher{err: fmt.Errorf("completely different wording about a shady CDN: %w", ErrHostNotAllowed)}
	res := c.Check(context.Background(), CheckInput{
		Current: "1.1.0", Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
	})
	if res.State.Kind != StateHostBlocked {
		t.Fatalf("reworded ErrHostNotAllowed must map to hostBlocked, got %s", res.State.Kind)
	}
	if res.State.Retry {
		t.Fatal("Retry must be false")
	}
	if res.State.Message != HostBlockedCopy("1.1.0") {
		t.Fatalf("Message=%q", res.State.Message)
	}
}

func TestCheckDevCurrentDoesNotOfferUpgrade(t *testing.T) {
	f := &stubFetcher{rel: Release{Tag: "v1.2.0", Version: "1.2.0", Assets: []Asset{
		{Name: "AnyPick-macos-universal.zip", URL: "https://github.com/x", Size: 10},
	}}}
	c := &Checker{Fetcher: f, Clock: FixedClock{T: time.Now()}, GOOS: "darwin", GOARCH: "arm64"}
	for _, current := range []string{"(devel)", "devel", "tip", "not.a.version"} {
		res := c.Check(context.Background(), CheckInput{
			Current: current, Settings: DefaultSettings(), Channel: ChannelDirect, Manual: true,
		})
		if res.State.Kind != StateUpToDate {
			t.Fatalf("current %q: kind=%s, want upToDate (no bogus upgrade)", current, res.State.Kind)
		}
		if res.State.Kind == StateAvailableDirect || res.State.Kind == StateAvailablePackageManager {
			t.Fatalf("current %q offered an update: %+v", current, res.State)
		}
		if res.State.Latest != current {
			t.Fatalf("current %q: latest=%q, want current (no release version as upgrade target)", current, res.State.Latest)
		}
	}
}
