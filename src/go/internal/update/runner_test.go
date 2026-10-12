package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// releaseServer serves /releases/latest, SHA256SUMS.txt, and the macOS zip.
func releaseServer(t *testing.T, payload []byte, sum string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases/latest":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v1.2.0", "body": "## Notes\n- fix", "html_url": "https://github.com/outof0/anypick/releases/tag/v1.2.0",
				"published_at": time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
				"assets": []map[string]any{
					{"name": "AnyPick-macos-universal.zip", "browser_download_url": srv.URL + "/dl/zip", "size": len(payload)},
					{"name": "SHA256SUMS.txt", "browser_download_url": srv.URL + "/dl/sums", "size": 100},
				},
			})
		case "/dl/sums":
			fmt.Fprintf(w, "%s  AnyPick-macos-universal.zip\n", sum)
		case "/dl/zip":
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testRunner(t *testing.T, srv *httptest.Server, env MapEnv) (*Runner, *[]StatusDTO) {
	t.Helper()
	var seen []StatusDTO
	host := strings.Split(strings.TrimPrefix(srv.URL, "https://"), ":")[0]
	return &Runner{
		Checker: &Checker{
			Fetcher: testAPIFetcher(t, srv, env),
			Clock:   FixedClock{T: time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)},
			Env:     env, GOOS: "darwin", GOARCH: "arm64",
		},
		Transport: &Transport{Kind: KindDownload, allowedHosts: []string{host}, HTTP: srv.Client()},
		Env:       env,
		CacheDir:  t.TempDir(),
		Emit:      func(d StatusDTO) { seen = append(seen, d) },
	}, &seen
}

func kinds(ds []StatusDTO) []string {
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = d.Kind
	}
	return out
}

func TestRunnerCheckAvailableDirect(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), HashBytes([]byte("zip")))
	r, seen := testRunner(t, srv, MapEnv{})
	d := r.Check(context.Background(), "1.1.0", ChannelDirect)
	if d.Kind != "availableDirect" || d.Latest != "1.2.0" || d.ActionKind != "selfUpdate" || !strings.Contains(d.Notes, "fix") {
		t.Fatalf("got %+v", d)
	}
	if d.Command != "" {
		t.Fatalf("direct install must not carry a command: %q", d.Command)
	}
	if got := kinds(*seen); strings.Join(got, ",") != "checking,availableDirect" {
		t.Fatalf("emitted %v", got)
	}
}

func TestRunnerCheckBrewShowsCommandNotUpdateNow(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), HashBytes([]byte("zip")))
	r, _ := testRunner(t, srv, MapEnv{})
	d := r.Check(context.Background(), "1.1.0", ChannelBrew)
	if d.Kind != "availablePackageManager" || d.ActionKind != "command" || d.Command != "brew upgrade --cask anypick" {
		t.Fatalf("got %+v", d)
	}
}

func TestRunnerCheckUpToDate(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), HashBytes([]byte("zip")))
	r, _ := testRunner(t, srv, MapEnv{})
	d := r.Check(context.Background(), "1.2.0", ChannelDirect)
	if d.Kind != "upToDate" || d.Message != "AnyPick 1.2.0 is the latest version." {
		t.Fatalf("got %+v", d)
	}
}

func TestRunnerDownloadReady(t *testing.T) {
	payload := []byte(strings.Repeat("a", 300_000))
	srv := releaseServer(t, payload, HashBytes(payload))
	r, seen := testRunner(t, srv, MapEnv{})
	d := r.Download(context.Background(), "1.1.0", ChannelDirect)
	if d.Kind != "ready" || d.Message != ReadyAuthenticityLine || d.Footnote != MacOSReadyFootnote {
		t.Fatalf("got %+v", d)
	}
	if want := filepath.Join(r.CacheDir, "1.2.0", "AnyPick-macos-universal.zip"); d.FilePath != want {
		t.Fatalf("file %q want %q", d.FilePath, want)
	}
	if b, _ := os.ReadFile(d.FilePath); len(b) != len(payload) {
		t.Fatalf("file has %d bytes", len(b))
	}
	got := strings.Join(kinds(*seen), ",")
	if !strings.HasPrefix(got, "checking,downloading") || !strings.HasSuffix(got, "verifying,ready") {
		t.Fatalf("emitted %s", got)
	}
	if strings.Contains(strings.ToLower(d.Message), "verified") {
		t.Fatal("ready copy must not say verified")
	}
}

func TestRunnerDownloadBadChecksumDeletesFile(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), strings.Repeat("1", 64))
	r, _ := testRunner(t, srv, MapEnv{})
	d := r.Download(context.Background(), "1.1.0", ChannelDirect)
	if d.Kind != "badChecksum" || !d.Retry || !strings.Contains(d.Message, "You're still on 1.1.0.") {
		t.Fatalf("got %+v", d)
	}
	if _, err := os.Stat(filepath.Join(r.CacheDir, "1.2.0", "AnyPick-macos-universal.zip")); !os.IsNotExist(err) {
		t.Fatalf("mismatched download left on disk: %v", err)
	}
}

func TestRunnerDownloadFaultHookChecksumMismatch(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), HashBytes([]byte("zip")))
	r, _ := testRunner(t, srv, MapEnv{EnvTesting: "1", EnvFault: "checksum-mismatch"})
	if d := r.Download(context.Background(), "1.1.0", ChannelDirect); d.Kind != "badChecksum" {
		t.Fatalf("got %+v", d)
	}
}

func TestRunnerDownloadHostBlocked(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), HashBytes([]byte("zip")))
	r, _ := testRunner(t, srv, MapEnv{})
	r.Transport = &Transport{Kind: KindDownload, allowedHosts: []string{"github.com"}, HTTP: srv.Client()}
	d := r.Download(context.Background(), "1.1.0", ChannelDirect)
	if d.Kind != "hostBlocked" || d.Retry || d.Message != HostBlockedCopy("1.1.0") || d.Lead != "View on GitHub" {
		t.Fatalf("got %+v", d)
	}
}

func TestRunnerDownloadSkipsPackageManager(t *testing.T) {
	srv := releaseServer(t, []byte("zip"), HashBytes([]byte("zip")))
	r, _ := testRunner(t, srv, MapEnv{})
	d := r.Download(context.Background(), "1.1.0", ChannelBrew)
	if d.Kind != "availablePackageManager" {
		t.Fatalf("brew install must never self-download: %+v", d)
	}
	if entries, _ := os.ReadDir(r.CacheDir); len(entries) != 0 {
		t.Fatalf("cache dir written for brew: %v", entries)
	}
}

func TestRunnerOversizedDownloadRefused(t *testing.T) {
	payload := []byte("zip")
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases/latest":
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.2.0", "assets": []map[string]any{
				{"name": "AnyPick-macos-universal.zip", "browser_download_url": srv.URL + "/z", "size": 2},
				{"name": "SHA256SUMS.txt", "browser_download_url": srv.URL + "/s", "size": 1},
			}})
		case "/s":
			fmt.Fprintf(w, "%s  AnyPick-macos-universal.zip\n", HashBytes(payload))
		case "/z":
			_, _ = w.Write(payload)
		}
	}))
	defer srv.Close()
	r, _ := testRunner(t, srv, MapEnv{})
	if d := r.Download(context.Background(), "1.1.0", ChannelDirect); d.Kind == "ready" {
		t.Fatalf("oversized download accepted: %+v", d)
	}
}

func TestFixtureCoversEveryName(t *testing.T) {
	for _, name := range FixtureNames() {
		r := &Runner{Checker: &Checker{GOOS: "darwin"}, Env: MapEnv{EnvTesting: "1", EnvFixture: name}, CacheDir: "/tmp/c"}
		d := r.Check(context.Background(), "1.1.0", ChannelDirect)
		if d.Kind != name || d.Schema != StatusSchema {
			t.Errorf("fixture %s → %+v", name, d)
		}
	}
	r := &Runner{Checker: &Checker{GOOS: "darwin"}, Env: MapEnv{EnvTesting: "1", EnvFixture: "hostBlocked"}}
	d := r.Check(context.Background(), "1.1.0", ChannelDirect)
	if d.Retry || d.Message != HostBlockedCopy("1.1.0") || !strings.HasPrefix(d.Message, "Update didn't finish. The download came from an address AnyPick doesn't trust") {
		t.Fatalf("hostBlocked fixture %+v", d)
	}
	if pm := (&Runner{Checker: &Checker{}, Env: MapEnv{EnvTesting: "1", EnvFixture: "availablePackageManager"}}).Check(context.Background(), "1.1.0", ChannelDirect); pm.Command != "brew upgrade --cask anypick" {
		t.Fatalf("package-manager fixture %+v", pm)
	}
}

func TestFixtureIgnoredWithoutGate(t *testing.T) {
	r := &Runner{Checker: &Checker{}, Env: MapEnv{EnvFixture: "ready"}}
	if d := r.Check(context.Background(), "1.1.0", ChannelDirect); d.Kind == "ready" {
		t.Fatal("fixture honored without ANYPICK_UPDATE_TESTING=1")
	}
}

func TestStatusLineIsOneCompactJSONLine(t *testing.T) {
	var b strings.Builder
	if err := WriteStatusLine(&b, NewStatusDTO(UpdateState{Kind: StateUpToDate, Current: "1.1.0", Notes: "a\nb"}, "darwin")); err != nil {
		t.Fatal(err)
	}
	if strings.Count(b.String(), "\n") != 1 || !strings.HasSuffix(b.String(), "\n") {
		t.Fatalf("not one line: %q", b.String())
	}
}

func TestRunnerUnknownSizeHardCap(t *testing.T) {
	old := maxDownloadBytes
	maxDownloadBytes = 32
	t.Cleanup(func() { maxDownloadBytes = old })

	payload := []byte("0123456789abcdef0123456789abcdefXXXX") // 36 bytes > 32
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases/latest":
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v1.2.0", "assets": []map[string]any{
				// size 0 / omitted → hard maximum must still apply
				{"name": "AnyPick-macos-universal.zip", "browser_download_url": srv.URL + "/z", "size": 0},
				{"name": "SHA256SUMS.txt", "browser_download_url": srv.URL + "/s", "size": 1},
			}})
		case "/s":
			fmt.Fprintf(w, "%s  AnyPick-macos-universal.zip\n", HashBytes(payload))
		case "/z":
			_, _ = w.Write(payload)
		}
	}))
	defer srv.Close()
	r, _ := testRunner(t, srv, MapEnv{})
	d := r.Download(context.Background(), "1.1.0", ChannelDirect)
	if d.Kind == "ready" {
		t.Fatalf("unknown-size download above hard cap accepted: %+v", d)
	}
	if _, err := os.Stat(filepath.Join(r.CacheDir, "1.2.0", "AnyPick-macos-universal.zip")); !os.IsNotExist(err) {
		t.Fatalf("oversized unknown-size download must be deleted, err=%v", err)
	}
}

func TestNotWritableCopyIsDownloadOnly(t *testing.T) {
	d := NewStatusDTO(UpdateState{Kind: StateNotWritable, Current: "1.1.0", Latest: "1.1.1", Channel: ChannelDirect}, "darwin")
	if !strings.Contains(d.Message, "cache folder") {
		t.Fatalf("notWritable message still install-oriented: %q", d.Message)
	}
	if strings.Contains(d.Message, "replace itself") {
		t.Fatalf("notWritable message must not mention install replace: %q", d.Message)
	}
}
