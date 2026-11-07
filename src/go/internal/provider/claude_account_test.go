package provider

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// claudeConfig is ~/.claude.json the way Claude Code writes it.
func claudeConfig(account string) string {
	fields := []string{
		`  "numStartups": 3`,
		`  "tipsHistory": {
    "Smith & Sons <Ltd>": 1,
    "emoji": "  ✓"
  }`,
	}
	if account != "" {
		fields = append(fields, `  "oauthAccount": `+account)
	}
	fields = append(fields, `  "projects": {}`)
	return "{\n" + strings.Join(fields, ",\n") + "\n}"
}

const claudeRecord = `{
    "emailAddress": "me@example.com",
    "profileFetchedAt": 1798000000000,
    "organizationUuid": "org-me"
  }`

// claudeStaleRecord is claudeRecord as a switch leaves it: Claude Code fetches
// a record with no fetch time again at its next start.
const claudeStaleRecord = `{
    "emailAddress": "me@example.com",
    "organizationUuid": "org-me"
  }`

func claudeCredentialFor(email string) string {
	return `{"claudeAiOauth":{"accessToken":"at-` + email + `","email":"` + email + `"}}`
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// backupClaude saves the live credential as a snapshot.
func backupClaude(t *testing.T, pv Provider) string {
	t.Helper()
	snap := t.TempDir()
	if _, err := pv.Backup(snap); err != nil {
		t.Fatal(err)
	}
	return snap
}

// Claude Code trusts its account record for a day after the fetch time it
// holds, so a switch to another login must drop that time, keep the record
// (a running Claude Code reads a missing one as damage), and leave the rest of
// the file as it was.
func TestClaudeSwitchMarksThePreviousAccountRecordStale(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	config := env.mustPath(".claude.json")

	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)
	env.write(t, creds, claudeCredentialFor("me@example.com"))
	env.write(t, config, claudeConfig(claudeRecord))

	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, config); got != claudeConfig(claudeStaleRecord) {
		t.Fatalf("~/.claude.json after the switch:\n%s\nwant:\n%s", got, claudeConfig(claudeStaleRecord))
	}
	if _, err := os.Stat(config + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("Claude Code's config lock was left behind: %v", err)
	}
	if snapshot := readFile(t, filepath.Join(work, claudeSnapshotFile)); strings.Contains(snapshot, claudeAccountKey) {
		t.Fatal("a snapshot carries an account record, which nothing ties to its credential")
	}
}

// Restoring the credential that is already live, token for token, keeps the
// record's fetch time: Claude Code would only fetch the same record again. A
// rotated access token reads as another credential.
func TestClaudeRestoreOfTheSameLoginKeepsTheRecord(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	config := env.mustPath(".claude.json")
	env.write(t, env.mustPath(".claude/.credentials.json"), claudeCredentialFor("me@example.com"))
	env.write(t, config, claudeConfig(claudeRecord))
	if err := pv.Restore(backupClaude(t, pv)); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, config); got != claudeConfig(claudeRecord) {
		t.Fatalf("the same login lost its record:\n%s", got)
	}
}

// The record is best effort: a file AnyPick cannot read or does not have is
// never created, replaced, or a reason to fail the switch.
func TestClaudeSwitchLeavesAConfigItCannotUse(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	config := env.mustPath(".claude.json")
	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)

	for _, tc := range []struct {
		name, content string
		mode          os.FileMode
	}{
		{"damaged", `{"oauthAccount": {}, `, 0o600},
		{"not an object", `[{"oauthAccount": {}}]`, 0o600},
		{"unreadable", claudeConfig(claudeRecord), 0o000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.mode == 0 && (runtime.GOOS == "windows" || os.Geteuid() == 0) {
				t.Skip("file modes do not deny reads here")
			}
			env.write(t, creds, claudeCredentialFor("me@example.com"))
			env.write(t, config, tc.content)
			if err := os.Chmod(config, tc.mode); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(config, 0o600) })
			if err := pv.Restore(work); err != nil {
				t.Fatalf("the switch failed on a config it cannot use: %v", err)
			}
			if err := os.Chmod(config, 0o600); err != nil {
				t.Fatal(err)
			}
			if got := readFile(t, config); got != tc.content {
				t.Fatalf("the config was rewritten: %s", got)
			}
		})
	}

	if err := os.Remove(config); err != nil {
		t.Fatal(err)
	}
	env.write(t, creds, claudeCredentialFor("me@example.com"))
	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config); !os.IsNotExist(err) {
		t.Fatalf("restore created ~/.claude.json: %v", err)
	}
}

// A login from nothing has no previous account to compare, so its record, left
// by whoever signed in last, is marked stale too.
func TestClaudeLoginFromNothingMarksTheRecordStale(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	config := env.mustPath(".claude.json")
	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)
	if err := os.Remove(creds); err != nil {
		t.Fatal(err)
	}
	env.write(t, config, claudeConfig(claudeRecord))
	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, config); got != claudeConfig(claudeStaleRecord) {
		t.Fatalf("~/.claude.json after a login from nothing:\n%s", got)
	}
}

// Claude Code saves under ~/.claude.json.lock. While it holds the lock the
// record is left alone, and the lock is not broken.
func TestClaudeSwitchWaitsForClaudeCodesLock(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	config := env.mustPath(".claude.json")
	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)
	env.write(t, creds, claudeCredentialFor("me@example.com"))
	env.write(t, config, claudeConfig(claudeRecord))
	if err := os.Mkdir(config+".lock", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := pv.Restore(work); err != nil {
		t.Fatalf("a held lock failed the switch: %v", err)
	}
	if got := readFile(t, config); got != claudeConfig(claudeRecord) {
		t.Fatalf("the config was written while Claude Code held its lock:\n%s", got)
	}
	if _, err := os.Stat(config + ".lock"); err != nil {
		t.Fatalf("Claude Code's lock was broken: %v", err)
	}
}

// A lock Claude Code releases within the wait is taken, and the record marked.
func TestClaudeSwitchTakesTheLockOnceClaudeCodeReleasesIt(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	config := env.mustPath(".claude.json")
	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)
	env.write(t, creds, claudeCredentialFor("me@example.com"))
	env.write(t, config, claudeConfig(claudeRecord))
	if err := os.Mkdir(config+".lock", 0o700); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(200 * time.Millisecond)
		_ = os.Remove(config + ".lock")
	}()
	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	<-released
	if got := readFile(t, config); got != claudeConfig(claudeStaleRecord) {
		t.Fatalf("the record was not marked after the lock was released:\n%s", got)
	}
}

// A write Claude Code makes while AnyPick rewrites the file must survive.
func TestClaudeSwitchDoesNotDiscardAConcurrentWrite(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	config := env.mustPath(".claude.json")
	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)
	env.write(t, creds, claudeCredentialFor("me@example.com"))
	env.write(t, config, claudeConfig(claudeRecord))

	concurrent := strings.Replace(claudeConfig(claudeRecord), `"numStartups": 3`, `"numStartups": 40`, 1)
	writes := 0
	beforeWriteHook = func() {
		writes++
		if writes == 1 {
			env.write(t, config, concurrent)
		}
	}
	t.Cleanup(func() { beforeWriteHook = nil })
	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(claudeConfig(claudeStaleRecord), `"numStartups": 3`, `"numStartups": 40`, 1)
	if got := readFile(t, config); got != want {
		t.Fatalf("a concurrent write was lost:\n%s\nwant:\n%s", got, want)
	}
}

// A dotfile manager's symlink must stay a symlink, and the file keeps its mode.
func TestClaudeSwitchKeepsTheConfigLinkAndMode(t *testing.T) {
	env := newProviderEnv(t, nil)
	pv := mustProvider(t, env.Registry, "claude")
	creds := env.mustPath(".claude/.credentials.json")
	env.write(t, creds, claudeCredentialFor("work@example.com"))
	work := backupClaude(t, pv)
	env.write(t, creds, claudeCredentialFor("me@example.com"))
	target := filepath.Join(t.TempDir(), "claude.json")
	env.write(t, target, claudeConfig(claudeRecord))
	if err := os.Chmod(target, 0o640); err != nil {
		t.Fatal(err)
	}
	link := env.mustPath(".claude.json")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	// Claude Code locks the path it was given, not the link's target.
	if err := os.Mkdir(link+".lock", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, target); got != claudeConfig(claudeRecord) {
		t.Fatalf("the target was written while Claude Code held the link's lock:\n%s", got)
	}
	if _, err := os.Stat(target + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("the lock was taken on the target's path: %v", err)
	}
	if err := os.Remove(link + ".lock"); err != nil {
		t.Fatal(err)
	}

	env.write(t, creds, claudeCredentialFor("me@example.com"))
	if err := pv.Restore(work); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("~/.claude.json is no longer a symlink: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	if got := readFile(t, target); got != claudeConfig(claudeStaleRecord) {
		t.Fatalf("the record was not marked stale through the link: %s", got)
	}
}
