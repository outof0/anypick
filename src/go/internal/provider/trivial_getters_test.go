package provider

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestProviderTrivialGetters(t *testing.T) {
	env := newProviderEnv(t, nil)
	for _, id := range env.Registry.IDs() {
		pv, err := env.Registry.Get(id)
		if err != nil {
			t.Fatalf("Get %q: %v", id, err)
		}
		if pv.Name() == "" {
			t.Errorf("%q Name empty", id)
		}
		if pv.Description() == "" {
			t.Errorf("%q Description empty", id)
		}
		_ = pv.CanProxy()
		_ = ShortNameOf(pv)
		if sn, ok := pv.(ShortNamer); ok {
			_ = sn.ShortName()
		}
		ad := pv.AccountAdapter("work", false)
		_ = ad.TransportFor("claude")
		_ = ad.TransportFor("codex")
		_ = ad.TransportFor("gemini")

		if _, err := pv.DetectLive(); err != nil {
			// DetectLive is best-effort; only hard failure is unexpected
			t.Logf("%q DetectLive err: %v", id, err)
		}
		empty := t.TempDir()
		if _, err := pv.DescribeSnapshot(empty); err != nil {
			t.Logf("%q DescribeSnapshot empty err: %v", id, err)
		}
		// Restore writes the user's live credential files. From an empty
		// snapshot it must refuse, or write nothing: a "successful" restore of
		// nothing is how a saved account would blank a real login.
		before := homeTree(t, env.Home)
		if err := pv.Restore(empty); err == nil {
			if after := homeTree(t, env.Home); after != before {
				t.Errorf("%q Restore from an empty snapshot succeeded and changed the home:\n before %s\n after  %s", id, before, after)
			}
		}

		// Backup on empty dest: compatible vendors return NO_LIVE_AUTH, file
		// providers may also error when no live auth. Just ensure no panic.
		if _, err := pv.Backup(empty); err != nil {
			// expected for many providers when no live auth
			_ = err
		}
		if pr, ok := pv.(PreflightRestorer); ok {
			if err := pr.PreflightRestore(empty); err != nil {
				t.Logf("%q PreflightRestore err: %v", id, err)
			}
		}
	}
}

func TestCompatibleExtras(t *testing.T) {
	// Definition / ShortName / DetectLive / Restore / DescribeSnapshot
	def := BuiltinDefinitions()[0] // openrouter
	pv, err := NewCompatible(def)
	if err != nil {
		t.Fatal(err)
	}
	if pv.Definition() == nil || pv.Definition().ID != "openrouter" {
		t.Fatalf("Definition = %+v", pv.Definition())
	}
	if pv.ShortName() == "" {
		t.Fatalf("ShortName empty")
	}
	if got := ShortNameOf(pv); got == "" {
		t.Fatalf("ShortNameOf empty")
	}
	if live, err := pv.DetectLive(); err != nil || live.Present {
		t.Fatalf("DetectLive compatible should be absent: %+v %v", live, err)
	}
	if err := pv.Restore(t.TempDir()); err != nil {
		t.Fatalf("Restore compatible should be no-op: %v", err)
	}
	// DescribeSnapshot on empty -> empty info, no error
	if info, err := pv.DescribeSnapshot(t.TempDir()); err != nil {
		t.Fatalf("DescribeSnapshot empty: %v", err)
	} else if info.CredentialKind != "" && info.CredentialKind != "proxy-only" {
		t.Fatalf("DescribeSnapshot empty kind = %q", info.CredentialKind)
	}
	// After BackupInput, DescribeSnapshot returns proxy-only with class
	snap := t.TempDir()
	if _, err := pv.BackupInput("api-key", "sk-test-123", "global", snap); err != nil {
		t.Fatal(err)
	}
	info, err := pv.DescribeSnapshot(snap)
	if err != nil {
		t.Fatal(err)
	}
	if info.CredentialKind != "proxy-only" {
		t.Fatalf("DescribeSnapshot after BackupInput kind = %q", info.CredentialKind)
	}
	if info.CredentialClass == "" {
		t.Fatalf("CredentialClass empty")
	}
	// credentialClassOf fallback (incompatible class defaults to provider_api_key)
	// Exercise via groq which has empty CredentialClass in definition
	groqDef := BuiltinDefinitions()[5] // groq has no credentialClass
	groqPv, _ := NewCompatible(groqDef)
	groqSnap := t.TempDir()
	if _, err := groqPv.BackupInput("api-key", "sk-groq", "global", groqSnap); err != nil {
		t.Fatal(err)
	}
	if info, _ := groqPv.DescribeSnapshot(groqSnap); info.CredentialClass != "provider_api_key" {
		t.Fatalf("groq fallback class = %q", info.CredentialClass)
	}

	// RegisterBuiltinCompatibles on fresh registry
	reg := NewRegistry()
	if err := RegisterBuiltinCompatibles(reg, t.TempDir()); err != nil {
		t.Fatalf("RegisterBuiltinCompatibles: %v", err)
	}
	if !reg.Has("openrouter") || !reg.Has("deepseek") {
		t.Fatalf("compatibles not registered")
	}
}

func TestProcessUnixHelpers(t *testing.T) {
	if got := quoteSecurity("simple"); got != "simple" {
		t.Errorf("quoteSecurity simple = %q", got)
	}
	// contains single quote or backslash triggers quoting
	if got := quoteSecurity("a'b"); got != "'a'\\''b'" {
		t.Errorf("quoteSecurity single quote = %q", got)
	}
	if got := quoteSecurity(`a\b`); !strings.Contains(got, "'") {
		t.Errorf("quoteSecurity backslash = %q", got)
	}
	// keychainAvailable is false on linux (GOOS != darwin)
	if keychainAvailable() {
		t.Logf("keychainAvailable true on this platform (darwin)")
	}
	if got := currentUsername(); got == "" {
		t.Errorf("currentUsername empty")
	}
	if err := errSnapshotMissing("auth.json"); err == nil || !strings.Contains(err.Error(), "auth.json") {
		t.Fatalf("errSnapshotMissing = %v", err)
	}
	// exercise codex specific getters directly
	env := newProviderEnv(t, nil)
	if pv, _ := env.Registry.Get("codex"); pv != nil {
		if pv.Name() == "" || pv.Description() == "" {
			t.Errorf("codex Name/Description empty")
		}
		if !pv.CanProxy() {
			t.Errorf("codex CanProxy should be true")
		}
		if sn, ok := pv.(ShortNamer); ok && sn.ShortName() == "" {
			t.Errorf("codex ShortName empty")
		}
	}
	// exercise compatible helper: readStoredCredential via invalid snapshot
	if _, err := readStoredCredential(t.TempDir()); err == nil {
		t.Fatalf("readStoredCredential empty should error")
	}
	// invalid compatible-credential.json
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "compatible-credential.json"), []byte(`{not json`), 0o600)
	if _, err := readStoredCredential(dir); err == nil {
		t.Fatalf("readStoredCredential invalid should error")
	}
	// claude AccountAdapter explicitly
	if pv, _ := env.Registry.Get("claude"); pv != nil {
		ad := pv.AccountAdapter("work", false)
		if ad.SourceRef.Provider != "claude" {
			t.Errorf("claude AccountAdapter provider = %q", ad.SourceRef.Provider)
		}
	}
}

// homeTree is every file under root with its size and content hash, so a write
// that keeps a file's length still shows.
func homeTree(t *testing.T, root string) string {
	t.Helper()
	var entries []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		entries = append(entries, fmt.Sprintf("%s:%x", rel, sha256.Sum256(data)))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(entries)
	return strings.Join(entries, ",")
}
