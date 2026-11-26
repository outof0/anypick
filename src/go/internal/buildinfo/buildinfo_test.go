package buildinfo

import "testing"

func TestVersionDefaultsAreNotARelease(t *testing.T) {
	if Version != "(devel)" {
		t.Fatalf("Version = %q", Version)
	}
	if ProtocolVersion != 3 {
		t.Fatalf("ProtocolVersion = %d", ProtocolVersion)
	}
	if IsRelease() {
		t.Fatal("default version reported as a release")
	}
}

func TestIsRelease(t *testing.T) {
	prev := Version
	t.Cleanup(func() { Version = prev })
	Version = "1.2.3"
	if !IsRelease() {
		t.Fatal("semver version was not a release")
	}
	Version = ""
	if IsRelease() {
		t.Fatal("empty version was a release")
	}
	Version = "(devel)"
	if IsRelease() {
		t.Fatal("(devel) was a release")
	}
}
