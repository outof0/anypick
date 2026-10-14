package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/transport"
)

// kiroTestEnv isolates every tier: no keychain, private sqlite db, private
// SSO cache dir.
type kiroTestEnv struct {
	t       *testing.T
	Home    string
	Secrets string // sqlite db path
	Cache   string
	pv      *kiro
}

func newKiroTestEnv(t *testing.T) *kiroTestEnv {
	t.Helper()
	home := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "data.sqlite3")
	cache := t.TempDir()
	t.Setenv("ANYPICK_KIRO_NO_KEYCHAIN", "1")
	t.Setenv("ANYPICK_KIRO_SECRET_DB", dbPath)
	t.Setenv("KIRO_SSO_CACHE_DIR", cache)
	os.Unsetenv("KIROLINK_BIN")
	os.Unsetenv("KIROLINK_JS")

	reg := NewRegistry()
	if err := reg.Register(newKiro(home)); err != nil {
		t.Fatal(err)
	}
	pv, err := reg.Get("kiro")
	if err != nil {
		t.Fatal(err)
	}
	return &kiroTestEnv{t: t, Home: home, Secrets: dbPath, Cache: cache, pv: pv.(*kiro)}
}

func (e *kiroTestEnv) seedAuthKv(key, value string) {
	e.t.Helper()
	d, err := sql.Open("sqlite", "file:"+e.Secrets)
	if err != nil {
		t := e.t
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS auth_kv (
	   key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`); err != nil {
		e.t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)`,
		key, value); err != nil {
		e.t.Fatal(err)
	}
}

func tokenJSON(profileArn, provider string) string {
	data, _ := json.Marshal(map[string]string{
		"accessToken":  "at",
		"profileArn":   profileArn,
		"provider":     provider,
		"refreshToken": "rt",
	})
	return string(data)
}

func TestKiroDetectLiveFromSecretStore(t *testing.T) {
	env := newKiroTestEnv(t)

	live, err := env.pv.DetectLive()
	if err != nil || live.Present {
		t.Fatalf("empty store must be absent: %+v %v", live, err)
	}

	env.seedAuthKv("kirocli:social:token",
		tokenJSON("arn:aws:sso::123:profile/9X7K2M", "BuilderId"))

	live, err = env.pv.DetectLive()
	if err != nil || !live.Present {
		t.Fatalf("detect = %+v err=%v", live, err)
	}
	if live.Identity != "BuilderId:9X7K2M" {
		t.Errorf("identity = %q, want BuilderId:9X7K2M", live.Identity)
	}
	if live.Details != "kiro-cli secret store" {
		t.Errorf("details = %q", live.Details)
	}
}

func TestKiroBackupRestoreRoundTripWithCachePruning(t *testing.T) {
	env := newKiroTestEnv(t)
	env.seedAuthKv("kirocli:social:token",
		tokenJSON("arn:aws:sso::123:profile/A1B2C3", "BuilderId"))

	snapDir := t.TempDir()
	snap, err := env.pv.Backup(snapDir)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Identity != "BuilderId:A1B2C3" {
		t.Fatalf("backup identity = %q", snap.Identity)
	}

	// A cache file from ANOTHER account appearing AFTER the backup must not
	// survive the switch — the proxy picks by expiry, not by name.
	stale := filepath.Join(env.Cache, "stale.json")
	if err := os.WriteFile(stale, []byte(tokenJSON("arn:x:y/z-old", "Other")), 0o600); err != nil {
		t.Fatal(err)
	}

	// Wipe everything, then restore the snapshot.
	if err := env.pv.ClearLive(); err != nil {
		t.Fatal(err)
	}
	live, _ := env.pv.DetectLive()
	if live.Present {
		t.Fatal("clear failed")
	}

	if err := env.pv.Restore(snapDir); err != nil {
		t.Fatal(err)
	}
	live, err = env.pv.DetectLive()
	if err != nil || !live.Present || live.Identity != "BuilderId:A1B2C3" {
		t.Fatalf("restored live = %+v err=%v", live, err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale other-account cache file survived restore")
	}
}

func TestKiroRestoreEmptySnapshotFails(t *testing.T) {
	env := newKiroTestEnv(t)
	err := env.pv.Restore(t.TempDir())
	var ae *anyerr.Error
	if !errorsAsAnyProvider(err, &ae) || ae.Code != "EMPTY_SNAPSHOT" {
		t.Fatalf("err = %v, want EMPTY_SNAPSHOT", err)
	}
}

func TestKiroAdapterPairingMatrix(t *testing.T) {
	env := newKiroTestEnv(t)
	adapter := env.pv.AccountAdapter("work", false)

	if got := adapter.TransportFor("kiro"); got != transport.Direct {
		t.Errorf("own client = %s", got)
	}
	if got := adapter.TransportFor("gemini"); got != transport.Unsupported {
		t.Errorf("gemini = %s, want unsupported (invariant #1)", got)
	}
	// No kirolink on PATH in the test environment → manual external proxy.
	for _, client := range []string{"claude", "codex", "opencode"} {
		got := adapter.TransportFor(client)
		if got != transport.ExternalManualProxy && got != transport.ManagedExternalProxy {
			t.Errorf("%s = %s, want external proxy capability", client, got)
		}
	}
}

func TestKiroProxyCommandDiscoverySeam(t *testing.T) {
	binDir := t.TempDir()
	name := "kirolink"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	fake := filepath.Join(binDir, name)
	if err := os.WriteFile(fake, []byte("fake executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	env := newKiroTestEnv(t)
	env.pv.findExecutable = discoverKiroProxyCommand
	if got := env.pv.proxyCommand(); got != fake {
		t.Fatalf("discovered %q, want %q", got, fake)
	}

	adapter := env.pv.AccountAdapter("w", false)
	if got := adapter.TransportFor("codex"); got != transport.ManagedExternalProxy {
		t.Errorf("with kirolink present, codex = %s, want managed_external_proxy", got)
	}
}

func TestKiroSnapshotMatchesLive(t *testing.T) {
	env := newKiroTestEnv(t)
	env.seedAuthKv("kirocli:social:token",
		tokenJSON("arn:aws:sso::1:p/p1", "BuilderId"))

	snapDir := t.TempDir()
	if _, err := env.pv.Backup(snapDir); err != nil {
		t.Fatal(err)
	}
	match, known, err := env.pv.SnapshotMatchesLive(snapDir)
	if err != nil || !known || !match {
		t.Fatalf("match=%v known=%v err=%v", match, known, err)
	}

	// Change the login → mismatch.
	env.seedAuthKv("kirocli:social:token",
		tokenJSON("arn:aws:sso::1:p/p2", "BuilderId"))
	match, known, err = env.pv.SnapshotMatchesLive(snapDir)
	if err != nil || !known || match {
		t.Fatalf("after switch match=%v known=%v err=%v", match, known, err)
	}
}

var _ = context.Background
