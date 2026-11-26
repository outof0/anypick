package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The .env in ~/.gemini is layered: AnyPick writes a source marker into it,
// and the gemini client adapter adds proxy keys while a managed binding is
// active. Restore must treat it as an overlay — replacing the live file with a
// source-scoped snapshot would destroy the user's own keys, and deleting it
// when the snapshot has none would destroy the whole environment.

const geminiTestOAuthJSON = `{"access_token":"live","refresh_token":"live-refresh","token_type":"Bearer"}`

func geminiRestoreFixture(t *testing.T) (*gemini, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_CONFIG_DIR", "")
	return newGemini(home), filepath.Join(home, ".gemini")
}

func TestGeminiRestoreKeepsUnmanagedUserKeys(t *testing.T) {
	p, dir := geminiRestoreFixture(t)
	writeTestFile(t, filepath.Join(dir, ".env"),
		"GEMINI_API_KEY=user-own-key\nGEMINI_OAUTH_SOURCE=antigravity\n")
	writeTestFile(t, filepath.Join(dir, "settings.json"), `{"theme":"dark"}`)

	snapshot := t.TempDir()
	writeTestFile(t, filepath.Join(snapshot, ".env"), "GEMINI_OAUTH_SOURCE=gemini-cli\n")
	writeTestFile(t, filepath.Join(snapshot, "oauth_creds.json"), geminiTestOAuthJSON)

	if err := p.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	env := readGeminiFixtureFile(t, filepath.Join(dir, ".env"))
	if !strings.Contains(env, "GEMINI_API_KEY=user-own-key") {
		t.Fatalf("user's own GEMINI_API_KEY was destroyed:\n%s", env)
	}
	if !strings.Contains(env, "GEMINI_OAUTH_SOURCE=gemini-cli") {
		t.Fatalf("source marker not applied:\n%s", env)
	}
}

func TestGeminiRestoreDropsProxyManagedKeys(t *testing.T) {
	p, dir := geminiRestoreFixture(t)
	writeTestFile(t, filepath.Join(dir, ".env"),
		"GEMINI_API_KEY=proxy-token\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9\nCUSTOM=keep\n")
	writeTestFile(t, filepath.Join(dir, "settings.json"),
		`{"theme":"dark","_anypickManaged":{"keys":["GEMINI_API_KEY","GOOGLE_GEMINI_BASE_URL"]}}`)

	snapshot := t.TempDir()
	writeTestFile(t, filepath.Join(snapshot, ".env"), "GEMINI_OAUTH_SOURCE=antigravity\n")
	writeTestFile(t, filepath.Join(snapshot, "oauth_creds.json"), geminiTestOAuthJSON)

	if err := p.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	env := readGeminiFixtureFile(t, filepath.Join(dir, ".env"))
	if strings.Contains(env, "GEMINI_API_KEY") || strings.Contains(env, "GOOGLE_GEMINI_BASE_URL") {
		t.Fatalf("proxy keys survived the restore:\n%s", env)
	}
	if !strings.Contains(env, "CUSTOM=keep") {
		t.Fatalf("unrelated live key was dropped:\n%s", env)
	}
	settings := readGeminiFixtureFile(t, filepath.Join(dir, "settings.json"))
	if strings.Contains(settings, "_anypickManaged") {
		t.Fatalf("client marker survived the restore:\n%s", settings)
	}
	if !strings.Contains(settings, `"dark"`) {
		t.Fatalf("settings.json lost unrelated content:\n%s", settings)
	}
}

func TestGeminiRestorePrefersSnapshotCredentialOverLive(t *testing.T) {
	p, dir := geminiRestoreFixture(t)
	writeTestFile(t, filepath.Join(dir, ".env"), "GEMINI_API_KEY=proxy-token\nKEEP=1\n")
	writeTestFile(t, filepath.Join(dir, "settings.json"),
		`{"_anypickManaged":{"keys":["GEMINI_API_KEY"]}}`)

	snapshot := t.TempDir()
	writeTestFile(t, filepath.Join(snapshot, ".env"), "GEMINI_API_KEY=real-key\n")
	writeTestFile(t, filepath.Join(snapshot, "oauth_creds.json"), geminiTestOAuthJSON)

	if err := p.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	env := readGeminiFixtureFile(t, filepath.Join(dir, ".env"))
	if !strings.Contains(env, "GEMINI_API_KEY=real-key") {
		t.Fatalf("snapshot credential did not win:\n%s", env)
	}
	if strings.Contains(env, "proxy-token") || !strings.Contains(env, "KEEP=1") {
		t.Fatalf("restore mixed credentials:\n%s", env)
	}
}

func TestGeminiRestoreWithoutSnapshotEnvKeepsLiveFile(t *testing.T) {
	p, dir := geminiRestoreFixture(t)
	writeTestFile(t, filepath.Join(dir, ".env"),
		"GEMINI_API_KEY=user-own-key\nGEMINI_OAUTH_SOURCE=antigravity\n")

	snapshot := t.TempDir()
	writeTestFile(t, filepath.Join(snapshot, "oauth_creds.json"), geminiTestOAuthJSON)

	if err := p.Restore(snapshot); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".env")); err != nil {
		t.Fatalf(".env must survive a snapshot without one: %v", err)
	}
	env := readGeminiFixtureFile(t, filepath.Join(dir, ".env"))
	if !strings.Contains(env, "GEMINI_API_KEY=user-own-key") {
		t.Fatalf("live key was destroyed:\n%s", env)
	}
	if strings.Contains(env, "GEMINI_OAUTH_SOURCE") {
		t.Fatalf("stale source marker survived:\n%s", env)
	}
}

func readGeminiFixtureFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestGeminiBroadSnapshotDoesNotMatchLiveOnOneOfTwoIdentities: a broad
// (unscoped) snapshot can hold an Antigravity login while the live ~/.gemini
// also carries a different account's API key. The Antigravity refresh token
// alone must not make the snapshot read as current.
func TestGeminiBroadSnapshotDoesNotMatchLiveOnOneOfTwoIdentities(t *testing.T) {
	home := t.TempDir()
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_OAUTH_SOURCE", "")
	t.Setenv("GEMINI_API_KEY", "")
	p := newGemini(home)
	liveDir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(liveDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeAntigravityState(t, home, antigravityTokenSentinel,
		antigravityTokenInfo("ya29.access", "Bearer", "1//refresh", time.Now().Add(time.Hour)))
	writeTestFile(t, filepath.Join(liveDir, ".env"), "GEMINI_API_KEY=other-identity\n")

	snapshot := t.TempDir()
	antigravityTokenFile(t, snapshot, "antigravity_oauth.json", "saved@example.com")

	match, known, err := p.SnapshotMatchesLive(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !known {
		t.Fatal("SnapshotsMatchesLive reported unknown")
	}
	if match {
		t.Fatal("snapshot missing the live API key must not read as live")
	}
}

func TestGeminiCLISnapshotDoesNotMatchLiveAntigravityLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_CONFIG_DIR", "")
	liveDir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(liveDir, 0o700); err != nil {
		t.Fatal(err)
	}
	snapshot := t.TempDir()
	writeTestFile(t, filepath.Join(snapshot, "oauth_creds.json"), geminiTestOAuthJSON)
	writeTestFile(t, filepath.Join(liveDir, "oauth_creds.json"), geminiTestOAuthJSON)
	writeAntigravityState(t, home, antigravityTokenSentinel,
		antigravityTokenInfo("ya29.access", "Bearer", "1//other-grant", time.Now().Add(time.Hour)))

	match, known, err := newGemini(home).SnapshotMatchesLive(snapshot)
	if err != nil || !known || match {
		t.Fatalf("CLI match with live Antigravity login = %v, known = %v, err = %v", match, known, err)
	}
}

func TestGeminiScopedCLISnapshotMatchesWithAnIndependentLiveAPIKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_CONFIG_DIR", "")
	live := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(live, 0o700); err != nil {
		t.Fatal(err)
	}
	saved := t.TempDir()
	writeTestFile(t, filepath.Join(live, "oauth_creds.json"), geminiTestOAuthJSON)
	writeTestFile(t, filepath.Join(live, ".env"), "GEMINI_API_KEY=independent-key\n")
	writeTestFile(t, filepath.Join(saved, "oauth_creds.json"), geminiTestOAuthJSON)
	writeTestFile(t, filepath.Join(saved, ".env"), "GEMINI_OAUTH_SOURCE=gemini-cli\n")

	match, known, err := newGemini(home).SnapshotMatchesLive(saved)
	if err != nil || !known || !match {
		t.Fatalf("scoped CLI match = %v, known = %v, err = %v", match, known, err)
	}
}

func TestGeminiLegacyPortableSnapshotMatchesItsLiveSource(t *testing.T) {
	home, saved := t.TempDir(), t.TempDir()
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", filepath.Join(home, "antigravity-state"))
	live := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(live, 0o700); err != nil {
		t.Fatal(err)
	}
	name := "jetski-standalone-oauth-token"
	writeAntigravityMirror(t, live, name, "same-google-grant", "grace@example.test", "")
	writeAntigravityMirror(t, saved, name, "same-google-grant", "grace@example.test", "")
	match, known, err := newGemini(home).SnapshotMatchesLive(saved)
	if err != nil || !known || !match {
		t.Fatalf("portable Antigravity match = %v, known = %v, err = %v", match, known, err)
	}
}
