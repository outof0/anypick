package repocheck

import (
	"strings"
	"testing"
)

// The quarantine instruction is a command the reader pastes verbatim, so the
// gate is exercised in both directions: a bare `xattr` must fail, and the
// absolute path must pass. Without the clean direction a pattern that stopped
// matching would report success while the docs shipped the broken command again.

func TestCheckQuarantineInstructionsAcceptsTheSystemBinary(t *testing.T) {
	fixture := newFixtureRepo(t)
	fixture.write("README.md",
		"# AnyPick\n\n```bash\n/usr/bin/xattr -dr com.apple.quarantine /Applications/AnyPick.app\n```\n")
	fixture.git("add", "-A")

	section := checkQuarantineInstructions(fixture.root)
	if len(section.Findings) > 0 {
		t.Fatalf("the absolute path must pass, findings: %v", section.Findings)
	}
	if len(section.Checked) == 0 {
		t.Fatal("the check inspected nothing")
	}
}

func TestCheckQuarantineInstructionsRejectsABareXattr(t *testing.T) {
	fixture := newFixtureRepo(t)
	fixture.write("README.md",
		"# AnyPick\n\n```bash\nxattr -dr com.apple.quarantine /Applications/AnyPick.app\n```\n")
	fixture.git("add", "-A")

	found := checkQuarantineInstructions(fixture.root).Findings
	if len(found) != 1 {
		t.Fatalf("a bare xattr must produce exactly one finding, got %v", found)
	}
	if !strings.Contains(found[0].Detail, "README.md:4") {
		t.Fatalf("the finding must name the line, got %q", found[0].Detail)
	}
	if advice := strings.Join(found[0].Advice, " "); !strings.Contains(advice, "/usr/bin/xattr") {
		t.Fatalf("the finding must carry the fix, got %q", advice)
	}
}

// TestCheckQuarantineInstructionsRejectsEveryTranslation guards the shape that
// actually shipped: the same command translated into eight locales plus the
// shared partials. One translated page left on the old wording is a user in
// that language following a command that exits 64.
func TestCheckQuarantineInstructionsRejectsEveryTranslation(t *testing.T) {
	for _, rel := range []string{
		"docs/src/content/vi/docs/guides/tray.mdx",
		"docs/src/content/partials/install.mdx",
		"packaging/homebrew/render-cask.sh",
		"packaging/macos/INSTALL.txt",
	} {
		t.Run(rel, func(t *testing.T) {
			fixture := newFixtureRepo(t)
			fixture.write(rel, "Run `xattr -dr com.apple.quarantine /Applications/AnyPick.app`.\n")
			fixture.git("add", "-A")

			found := checkQuarantineInstructions(fixture.root).Findings
			if len(found) == 0 {
				t.Fatalf("%s was not scanned", rel)
			}
			if !strings.Contains(found[0].Detail, rel) {
				t.Fatalf("the finding must name %s, got %q", rel, found[0].Detail)
			}
		})
	}
}

// TestCheckQuarantineInstructionsReportsAnEmptyExtraction covers the failure
// mode the rest of this package exists to prevent: an extraction that matches
// nothing must not look like a clean tree.
func TestCheckQuarantineInstructionsReportsAnEmptyExtraction(t *testing.T) {
	fixture := newFixtureRepo(t)
	fixture.write("README.md", "# AnyPick\n\nNo quarantine instructions here.\n")
	fixture.git("add", "-A")

	found := checkQuarantineInstructions(fixture.root).Findings
	var joined strings.Builder
	for _, finding := range found {
		joined.WriteString(finding.Detail)
		joined.WriteString("\n")
	}
	if !strings.Contains(joined.String(), "found nothing in") {
		t.Fatalf("an empty extraction must fail loudly, findings:\n%s", joined.String())
	}
}
