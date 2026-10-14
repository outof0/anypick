package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunnerPersistsHighestSeenAcrossInvocations(t *testing.T) {
	cacheDir := t.TempDir()
	clock := FixedClock{T: time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)}
	newRunner := func(fetcher Fetcher) *Runner {
		return &Runner{
			Checker:  &Checker{Fetcher: fetcher, Clock: clock, GOOS: "darwin", GOARCH: "arm64"},
			CacheDir: cacheDir,
		}
	}
	release := func(version string) Release {
		return Release{
			Tag:     "v" + version,
			Version: version,
			Assets:  []Asset{{Name: "AnyPick-macos-universal.zip", URL: "https://github.com/outof0/anypick/releases/download/v" + version + "/AnyPick-macos-universal.zip"}},
		}
	}

	higher := newRunner(&stubFetcher{rel: release("1.3.0"), etag: `"high"`})
	if status := higher.Check(context.Background(), "1.1.0", ChannelDirect); status.Kind != string(StateAvailableDirect) {
		t.Fatalf("first check kind=%s message=%q", status.Kind, status.Message)
	}

	rolledBackFeed := newRunner(&stubFetcher{rel: release("1.2.0"), etag: `"old"`})
	status := rolledBackFeed.Check(context.Background(), "1.1.0", ChannelDirect)
	if status.Kind != string(StateUpToDate) || status.Latest != "1.3.0" {
		t.Fatalf("rollback feed status=%+v, want upToDate at persisted 1.3.0", status)
	}

	persisted, err := loadSettings(settingsPath(cacheDir))
	if err != nil {
		t.Fatal(err)
	}
	if persisted.HighestSeen != "1.3.0" {
		t.Fatalf("HighestSeen=%q, want 1.3.0", persisted.HighestSeen)
	}
}

func TestRunnerFailsClosedWhenUpdateSettingsCannotBeRead(t *testing.T) {
	cacheDir := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(cacheDir, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &Runner{
		Checker:  &Checker{Fetcher: &stubFetcher{rel: Release{Version: "1.2.0"}}, GOOS: "darwin", GOARCH: "arm64"},
		CacheDir: cacheDir,
	}
	status := r.Check(context.Background(), "1.1.0", ChannelDirect)
	if status.Kind != string(StateStorageUnavailable) || !status.Retry || status.Message == "" {
		t.Fatalf("status=%+v, want a retryable storageUnavailable state", status)
	}
}
