package repocheck

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// First-launch instructions are the only thing standing between a user and a
// Gatekeeper block, and a command that fails is worse than no command: the
// reader concludes the app is broken rather than the instruction. The wording
// that shipped was `xattr -dr com.apple.quarantine …`, which resolves through
// PATH. On any machine with a Python `xattr` package installed (pyenv shims are
// the common case) that is a different program with no `-r` flag, so the
// documented fix exits 64 and clears nothing. /usr/bin/xattr is the one macOS
// ships, so every instruction names it in full.

// bareXattrPattern matches an `xattr` invocation that does not name the system
// binary. The leading group rejects `/usr/bin/xattr` and any other absolute
// path, because those already say which program runs.
var bareXattrPattern = regexp.MustCompile(`(^|[^/\w.-])xattr\s+-[a-zA-Z]*r`)

// xattrInvocation matches any quarantine-clearing xattr command, correct or
// not. It exists so the gate can tell "every instruction is correct" apart from
// "the extraction stopped finding instructions": only the first is a pass.
var xattrInvocation = regexp.MustCompile(`xattr\s+-[a-zA-Z]*r\s+com\.apple\.quarantine`)

// quarantineSources are the live files whose instructions a user follows
// verbatim: release documentation, the Homebrew cask that renders caveats, and
// the DMG note that ships inside the download. ADR-0033 is included because it
// is the decision the other four quote. docs/history is excluded because it is
// provenance, and rewriting a superseded record would falsify it.
var quarantineSources = []string{
	"README.md",
	"packaging/README.md",
	"packaging/homebrew/README.md",
	"packaging/homebrew/render-cask.sh",
	"packaging/macos/INSTALL.txt",
	"adr/0033-macos-release-without-notarization.md",
}

// quarantineGlobs are directories scanned for the same instruction.
var quarantineGlobs = []string{
	"docs/src/content",
}

// checkQuarantineInstructions reports a documented quarantine fix that names a
// program the reader may not have on PATH.
func checkQuarantineInstructions(root string) Section {
	section := Section{Name: "documented quarantine commands name the system xattr"}

	files, err := quarantineFiles(root)
	if err != nil {
		section.Findings = append(section.Findings, fail("cannot list instruction sources: "+errText(err)))
		return section
	}
	if len(files) == 0 {
		section.Findings = append(section.Findings, emptyInput("instruction source", strings.Join(quarantineGlobs, ", ")))
		return section
	}

	instructions := 0
	for _, rel := range files {
		content, unreadable := readFile(root, rel)
		if unreadable != nil {
			section.Findings = append(section.Findings, *unreadable)
			continue
		}
		for lineNo, line := range strings.Split(content, "\n") {
			if !xattrInvocation.MatchString(line) {
				continue
			}
			instructions++
			if !bareXattrPattern.MatchString(line) {
				continue
			}
			section.Findings = append(section.Findings, fail(
				rel+":"+strconv.Itoa(lineNo+1)+" tells the reader to run `xattr`, which may not be macOS's xattr",
				"write `/usr/bin/xattr -dr com.apple.quarantine <app>` instead: a",
				"Python `xattr` package or a pyenv shim shadows the system binary on",
				"some machines and has no `-r` flag, so the documented fix exits 64"))
		}
	}
	if instructions == 0 {
		// Not "zero findings": a scan that reached no quarantine command at all
		// means either every instruction lost the wording this gate exists to
		// check, or the extraction broke. Both are findings, and silence here is
		// how a gate goes dead while still reporting success.
		section.Findings = append(section.Findings, emptyInput("quarantine instruction", strings.Join(files, ", ")))
		return section
	}
	section.Checked = append(section.Checked,
		strconv.Itoa(instructions)+" quarantine commands across "+strconv.Itoa(len(files))+" files")
	return section
}

// quarantineFiles returns the instruction sources that exist, relative to root.
// A listed file may legitimately be absent on a fixture, but the scan must
// still reach at least one file or the gate proves nothing.
func quarantineFiles(root string) ([]string, error) {
	var out []string
	for _, rel := range quarantineSources {
		if _, err := os.Stat(filepath.Join(root, rel)); err == nil {
			out = append(out, rel)
		}
	}
	for _, glob := range quarantineGlobs {
		base := filepath.Join(root, glob)
		if _, statErr := os.Stat(base); statErr != nil {
			// A glob that vanished is a finding, not a silent skip: the
			// instructions inside it stop being checked, and a check that
			// quietly covers less is the failure this package exists to prevent.
			return nil, fmt.Errorf("%s cannot be read: %w", glob, statErr)
		}
		err := filepath.WalkDir(base, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				switch entry.Name() {
				case "node_modules", "dist", "history":
					return filepath.SkipDir
				}
				return nil
			}
			switch filepath.Ext(entry.Name()) {
			case ".md", ".mdx", ".txt":
			default:
				return nil
			}
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			out = append(out, filepath.ToSlash(rel))
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return uniqueSorted(out), nil
}
