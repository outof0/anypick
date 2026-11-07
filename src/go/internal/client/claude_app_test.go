package client

import (
	"os"
	"path/filepath"
	"testing"
)

// A profiles path that exists but cannot be listed must be an error on every
// platform. A dangling symlink makes ReadDir report "not found" here exactly
// as Windows does for a regular file, so this pins the Lstat confirmation
// without a Windows runner.
func TestProfilesFolderThatExistsButCannotBeListedIsAnError(t *testing.T) {
	root := t.TempDir()
	dir := claudeAppProfilesDir(root)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "gone"), dir); err != nil {
		t.Skipf("cannot create a symlink here: %v", err)
	}
	if _, err := FindClaudeAppProfile(root, "work"); err == nil {
		t.Fatal("FindClaudeAppProfile read a dangling profiles folder as empty")
	}
	if _, err := ListClaudeAppProfiles(root); err == nil {
		t.Fatal("ListClaudeAppProfiles read a dangling profiles folder as empty")
	}
}

func TestMissingProfilesFolderIsNoProfiles(t *testing.T) {
	root := t.TempDir()
	match, err := FindClaudeAppProfile(root, "work")
	if err != nil || match.Exists {
		t.Fatalf("FindClaudeAppProfile = %+v, %v; want no match, nil", match, err)
	}
	profiles, err := ListClaudeAppProfiles(root)
	if err != nil || len(profiles) != 0 {
		t.Fatalf("ListClaudeAppProfiles = %v, %v; want none, nil", profiles, err)
	}
}
