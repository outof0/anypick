package plugins

import (
	"os"
	"path/filepath"
	"testing"
)

// A file name that only starts with dots is an ordinary plugin entry.
func TestPathValidationDotPrefixedEntryLoads(t *testing.T) {
	root := t.TempDir()
	raw := []byte(`{"name":"acme-plugin","version":"1.2.3","apiVersion":1,"main":"..foo.mjs"}`)
	manifest, err := ParseManifest(raw, "manifest")
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "..foo.mjs"), []byte("export {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	entry, err := ResolveEntry(root, manifest.Main)
	if err != nil {
		t.Fatalf("ResolveEntry(%q): %v", manifest.Main, err)
	}
	absRoot, _ := filepath.Abs(root)
	if want := filepath.Join(absRoot, "..foo.mjs"); entry != want {
		t.Fatalf("entry = %q, want %q", entry, want)
	}
	if _, err := os.Stat(entry); err != nil {
		t.Fatalf("entry not readable: %v", err)
	}
}
