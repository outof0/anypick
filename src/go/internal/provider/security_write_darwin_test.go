//go:build darwin

package provider

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// withTempKeychain runs fn against a throwaway keychain. It passes that
// file as the final argument of security, and it restores the user search
// list and default keychain afterwards. create-keychain adds its file to
// the search list, so the saved paths are restored as separate arguments.
func withTempKeychain(t *testing.T, fn func(kc string)) {
	t.Helper()
	search, def := userKeychainState(t)
	kc := filepath.Join(t.TempDir(), "anypick-test.keychain-db")
	const password = "anypick-temp-keychain"
	t.Cleanup(func() {
		restoreUserKeychainState(t, search, def)
	})
	out, err := exec.Command("security", "create-keychain", "-p", password, kc).CombinedOutput()
	if err != nil {
		t.Fatalf("create-keychain: %v\n%s", err, out)
	}
	t.Cleanup(func() {
		if kc == def {
			t.Errorf("temp keychain became the default; not deleting %s", kc)
			return
		}
		if out, err := exec.Command("security", "delete-keychain", kc).CombinedOutput(); err != nil {
			t.Errorf("delete-keychain: %v\n%s", err, out)
		}
	})
	if out, err := exec.Command("security", "unlock-keychain", "-p", password, kc).CombinedOutput(); err != nil {
		t.Fatalf("unlock-keychain: %v\n%s", err, out)
	}
	// Same-user access without a prompt. A prompt would hang the test.
	_, _ = exec.Command("security", "set-key-partition-list", "-S", "apple-tool:,apple:,unsigned:", "-k", password, kc).CombinedOutput()
	fn(kc)
}

func userKeychainState(t *testing.T) (search []string, def string) {
	t.Helper()
	out, err := exec.Command("security", "list-keychains", "-d", "user").CombinedOutput()
	if err != nil {
		t.Fatalf("list-keychains: %v\n%s", err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		line = strings.Trim(line, `"`)
		if line != "" {
			search = append(search, line)
		}
	}
	dout, err := exec.Command("security", "default-keychain", "-d", "user").CombinedOutput()
	if err != nil {
		t.Fatalf("default-keychain: %v\n%s", err, dout)
	}
	def = strings.Trim(strings.TrimSpace(string(dout)), `"`)
	return search, def
}

func restoreUserKeychainState(t *testing.T, search []string, def string) {
	t.Helper()
	if def != "" {
		out, err := exec.Command("security", "default-keychain", "-d", "user", "-s", def).CombinedOutput()
		if err != nil {
			t.Errorf("restore default-keychain: %v\n%s", err, out)
		}
	}
	if len(search) == 0 {
		return
	}
	args := append([]string{"list-keychains", "-d", "user", "-s"}, search...)
	out, err := exec.Command("security", args...).CombinedOutput()
	if err != nil {
		t.Errorf("restore list-keychains: %v\n%s", err, out)
	}
}

func TestDarwinApostrophePasswordReplacesTheTempKeychainItem(t *testing.T) {
	withTempKeychain(t, func(kc string) {
		// Seed through argv so the keychain path can be the final argument.
		// The plain password's production choice is stdin, and stdin writes
		// the default keychain.
		seed := append(darwinAddGenericArgv("Claude Code-credentials", "anypick-roundtrip", "plain-secret\n"), kc)
		if err := runSecurityArgs(seed); err != nil {
			t.Fatal(err)
		}
		_, args := darwinAddGenericInvocation("Claude Code-credentials", "anypick-roundtrip", "o'brien\n")
		if args == nil {
			t.Fatal("apostrophe stayed on stdin")
		}
		if err := runSecurityArgs(append(append([]string{}, args...), kc)); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command("/usr/bin/security", "find-generic-password",
			"-s", "Claude Code-credentials", "-a", "anypick-roundtrip", "-w", kc).Output()
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimRight(string(out), "\n"); got != "o'brien" {
			t.Fatalf("stored password = %q, want o'brien", got)
		}
	})
}

func TestDarwinClaudeKeychainPasswordReadsAsJSON(t *testing.T) {
	withTempKeychain(t, func(kc string) {
		const service = "Claude Code-credentials"
		const account = "anypick-roundtrip"
		for _, tc := range []struct {
			name string
			size int
		}{
			{"interactive", 0},
			{"oversized", securityStdinLimit},
		} {
			t.Run(tc.name, func(t *testing.T) {
				padding := strings.Repeat("x", tc.size)
				raw := `{
  "fixture": "é 😀 \"quotes\" ` + padding + "\"\n}\n"
				want := `{"fixture":"\u00e9 \ud83d\ude00 \"quotes\" ` + padding + `"}`
				stdin, args, err := claudeKeychainWriteInvocation(account, raw, raw)
				if err != nil {
					t.Fatal(err)
				}
				if stdin != "" {
					err = runSecurityStdin(strings.TrimSuffix(stdin, "\n") + " " + quoteSecurityCommand(kc) + "\n")
				} else {
					err = runSecurityArgs(append(args, kc))
				}
				if err != nil {
					t.Fatal(err)
				}
				out, err := exec.Command("/usr/bin/security", "find-generic-password",
					"-s", service, "-a", account, "-w", kc).Output()
				if err != nil {
					t.Fatal(err)
				}
				if strings.TrimSuffix(string(out), "\n") != want {
					t.Fatal("security did not return the complete credential JSON")
				}
				if claudeFingerprint(string(out)) != claudeFingerprint(raw) {
					t.Fatal("the live credential no longer matches the saved JSON")
				}
			})
		}
	})
}

func TestClaudeBackupRefusesAnUnrestorableKeychainCheckpoint(t *testing.T) {
	t.Setenv("ANYPICK_CLAUDE_NO_KEYCHAIN", "")
	p := newClaude(t.TempDir())
	credential := `{"claudeAiOauth":{"accessToken":"fixture"},"fixture":"` +
		strings.Repeat(`\\`, 1400) + `"}`
	p.keychainRead = func(string) (string, error) { return credential, nil }
	dest := t.TempDir()
	if _, err := p.Backup(dest); err == nil {
		t.Fatal("backup accepted a live credential that rollback would refuse")
	}
	entries, err := os.ReadDir(dest)
	if err != nil || len(entries) != 0 {
		t.Fatalf("invalid checkpoint was written: %v", err)
	}
}
