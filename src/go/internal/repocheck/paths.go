package repocheck

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Layout constants. They name the directories the checks below assume; a
// directory move is what this gate is here to catch, so they live in one place
// instead of being spelled out per check.
const (
	GoDir       = "src/go"
	MacOSDir    = "src/macos"
	TauriDir    = "src/tauri"
	TauriCore   = "src/tauri/app"
	XcodeProj   = "src/macos/AnyPick.xcodeproj/project.pbxproj"
	HelperSh    = "src/macos/scripts/bundle-go-helper.sh"
	AuthorityMD = "AGENTS.md"
)

// CheckPaths verifies every reference the build scripts make to a file in the
// repository, plus the tracked-content invariants that only git can answer.
//
// Each check is a Section so a failure names what broke, what it inspected, and
// what to do — and so a test can assert that every check inspected something.
func CheckPaths(root string) []Section {
	return []Section{
		checkLayout(root),
		checkMacOSHelper(root),
		checkXcodeSRCROOT(root),
		checkXcodeAssets(root),
		checkTauriIcons(root),
		checkTauriBuildRS(root),
		checkWorkflowWorkingDirs(root),
		checkGoSourcesNotIgnored(root),
		checkGoSourcesTracked(root),
		checkNoTrackedArtifacts(root),
		checkReferenceDocsTracked(root),
		checkHooksTracked(root),
		checkHooksInstalled(root),
		checkRootEntries(root),
		checkMakefileTargets(root),
		checkMakeReferences(root),
		checkQuarantineInstructions(root),
		checkDocumentCitations(root),
		checkGoSourceCitations(root),
	}
}

// checkLayout asserts the directories the rest of the checks look inside.
// Without it, a moved directory turns every later check into a parse failure
// with a confusing message.
func checkLayout(root string) Section {
	section := Section{Name: "repository layout"}
	for _, dir := range []string{GoDir, MacOSDir, TauriDir} {
		if info, err := os.Stat(filepath.Join(root, dir)); err != nil || !info.IsDir() {
			section.Findings = append(section.Findings, fail(dir+" is missing",
				"the gates below parse files inside it; update the layout constants",
				"in internal/repocheck when the tree moves"))
			continue
		}
		section.Checked = append(section.Checked, dir)
	}
	return section
}

// helperRootPattern reads the `repo_root="$(cd "${script_dir}/REL" && pwd)"`
// line out of the macOS helper script. The script's whole job is to resolve the
// repository from its own location, so the depth it hard-codes is the thing
// that breaks when either the script or the tree moves.
var helperRootPattern = regexp.MustCompile(`repo_root="\$\(cd "\$\{script_dir\}/([^"]+)"`)

// helperGoRootPattern reads the Go module path the helper derives from that
// root. The pre-src/ layout appended /go straight onto the root and the suffix
// was never updated, which made every `make app-build` fail on every machine.
var helperGoRootPattern = regexp.MustCompile(`go_root="\$\{repo_root\}/([^"]+)"`)

// checkMacOSHelper verifies the helper script still resolves the repository
// root and the Go module inside it.
func checkMacOSHelper(root string) Section {
	section := Section{Name: "macOS helper script resolves the repository root"}
	content, missing := readFile(root, HelperSh)
	if missing != nil {
		section.Findings = append(section.Findings, *missing)
		return section
	}
	rel, ok := capture(helperRootPattern, content)
	if !ok {
		section.Findings = append(section.Findings,
			fail(HelperSh+" no longer declares repo_root as a relative cd",
				"this check exists to prove the script resolves the repository",
				"from its own location; if the shape changed, update the pattern"))
		return section
	}
	// The script lives at src/macos/scripts, so its relative path back to the
	// root must land exactly on the root.
	scriptDir := filepath.Dir(HelperSh)
	if resolved := filepath.Clean(filepath.Join(scriptDir, filepath.FromSlash(rel))); resolved != "." {
		section.Findings = append(section.Findings, fail(
			HelperSh+" resolves "+rel+" from "+scriptDir+", which is "+resolved+" rather than the repository root",
			"fix the relative depth in the script, or move the script back"))
	} else {
		section.Checked = append(section.Checked, HelperSh+" → "+rel)
	}

	goRel, ok := capture(helperGoRootPattern, content)
	if !ok {
		section.Findings = append(section.Findings,
			fail(HelperSh+" no longer declares go_root from repo_root",
				"the Go module path is what the script builds; without it the",
				"bundle phase has no module to build"))
		return section
	}
	if !exists(root, "", filepath.Join(goRel, "go.mod")) {
		section.Findings = append(section.Findings, fail(
			HelperSh+" builds from "+goRel+"/go.mod, which does not exist",
			"the helper's module path has drifted from the layout (this is the",
			"exact drift that broke `make app-build` once)"))
		return section
	}
	section.Checked = append(section.Checked, goRel+"/go.mod")
	return section
}

// xcodeSRCROOTPattern matches `$(SRCROOT)/path`, stopping at the first quote or
// backslash. Those characters end the path in every pbxproj reference, and
// running past them would invent paths that do not exist.
var xcodeSRCROOTPattern = regexp.MustCompile(`SRCROOT\)/([^"\\]*)`)

// checkXcodeSRCROOT verifies every file the Xcode project references through
// $(SRCROOT) exists. SRCROOT is the src/macos directory, and the project file
// is generated by hand-editing, so a rename there fails the build with an
// error that does not name the reference.
func checkXcodeSRCROOT(root string) Section {
	section := Section{Name: "Xcode SRCROOT references"}
	content, missing := readFile(root, XcodeProj)
	if missing != nil {
		section.Findings = append(section.Findings, *missing)
		return section
	}
	references := uniqueSorted(captures(xcodeSRCROOTPattern, content))
	if len(references) == 0 {
		section.Findings = append(section.Findings, emptyInput("SRCROOT reference", XcodeProj))
		return section
	}
	for _, rel := range references {
		if exists(root, MacOSDir, rel) {
			section.Checked = append(section.Checked, "SRCROOT/"+rel)
			continue
		}
		section.Findings = append(section.Findings,
			fail("SRCROOT/"+rel+" does not exist",
				"the Xcode project references it by path; fix the reference or restore the file"))
	}
	return section
}

// xcodeAssetPattern matches `path = ../…;` entries verbatim, quoted or bare.
// Xcode writes asset references relative to the group's directory, so the check
// resolves them from src/macos — the same base the build uses. Only references
// that escape the project directory are collected: a bare sibling path in a
// pbxproj group is resolved by Xcode against the group, not against the file,
// and guessing that base would invent failures.
var xcodeAssetPattern = regexp.MustCompile(`path = "?(\.\.[^;]*);`)

// checkXcodeAssets verifies the project's relative asset references resolve.
func checkXcodeAssets(root string) Section {
	section := Section{Name: "Xcode asset references"}
	content, missing := readFile(root, XcodeProj)
	if missing != nil {
		section.Findings = append(section.Findings, *missing)
		return section
	}
	references := uniqueSorted(captures(xcodeAssetPattern, content))
	if len(references) == 0 {
		section.Findings = append(section.Findings, emptyInput("asset reference", XcodeProj))
		return section
	}
	for _, raw := range references {
		// A quoted path is still a reference; skipping those is how a renamed
		// asset kept the shell version of this check green.
		rel := strings.Trim(raw, `"`)
		if exists(root, MacOSDir, rel) {
			section.Checked = append(section.Checked, rel)
			continue
		}
		section.Findings = append(section.Findings, fail(rel+" does not exist",
			"the Xcode project references it; fix the reference or restore the file"))
	}
	return section
}

// tauriIconPattern matches the icon paths the Tauri config points at. They live
// outside the Tauri tree (../../..), which is exactly why a move of assets/ has
// to fail here instead of inside a bundler.
var tauriIconPattern = regexp.MustCompile(`"(\.\./\.\./\.\./assets/[^"]*)"`)

// checkTauriIcons verifies the bundled icon files exist.
func checkTauriIcons(root string) Section {
	section := Section{Name: "Tauri icon references"}
	rel := filepath.Join(TauriCore, "tauri.conf.json")
	content, missing := readFile(root, rel)
	if missing != nil {
		section.Findings = append(section.Findings, *missing)
		return section
	}
	icons := uniqueSorted(captures(tauriIconPattern, content))
	if len(icons) == 0 {
		section.Findings = append(section.Findings, emptyInput("icon reference", rel))
		return section
	}
	for _, icon := range icons {
		if exists(root, TauriCore, icon) {
			section.Checked = append(section.Checked, icon)
			continue
		}
		section.Findings = append(section.Findings, fail(icon+" does not exist",
			"tauri.conf.json names it for the bundle step; restore the file or fix the path"))
	}
	return section
}

// tauriRerunPattern matches the directory build.rs watches. A wrong path there
// means the sidecar is not rebuilt when the Go engine changes — a stale binary
// in the app, with no build error.
var tauriRerunPattern = regexp.MustCompile(`rerun-if-changed=([^"]*)`)

// checkTauriBuildRS verifies build.rs watches a directory that exists.
func checkTauriBuildRS(root string) Section {
	section := Section{Name: "Tauri sidecar path in build.rs"}
	rel := filepath.Join(TauriCore, "build.rs")
	content, missing := readFile(root, rel)
	if missing != nil {
		section.Findings = append(section.Findings, *missing)
		return section
	}
	watched, ok := capture(tauriRerunPattern, content)
	if !ok {
		section.Findings = append(section.Findings,
			fail(rel+" no longer declares rerun-if-changed",
				"without it the sidecar is not rebuilt when the engine changes"))
		return section
	}
	if !exists(root, TauriCore, watched) {
		section.Findings = append(section.Findings, fail(
			rel+" watches "+watched+", which does not exist",
			"the sidecar build watches this path; a typo here ships a stale engine"))
		return section
	}
	section.Checked = append(section.Checked, watched)
	return section
}

// workflowWorkingDirPattern matches a GitHub Actions working-directory. Values
// holding `${{ … }}` are expressions resolved at run time and cannot be checked
// here.
var workflowWorkingDirPattern = regexp.MustCompile(`working-directory:[ \t]*(\S+)`)

// checkWorkflowWorkingDirs verifies every literal working-directory in the CI
// workflows exists. A missing one fails in CI minutes later, on a runner,
// which is the slowest possible place to learn about a rename.
func checkWorkflowWorkingDirs(root string) Section {
	section := Section{Name: "GitHub Actions working-directories"}
	dir := filepath.Join(root, ".github", "workflows")
	entries, err := os.ReadDir(dir)
	if err != nil {
		section.Findings = append(section.Findings, fail(".github/workflows cannot be read: "+errText(err)))
		return section
	}
	var references []string
	files := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yml") {
			continue
		}
		files++
		content, missing := readFile(root, filepath.Join(".github", "workflows", entry.Name()))
		if missing != nil {
			section.Findings = append(section.Findings, *missing)
			continue
		}
		references = append(references, captures(workflowWorkingDirPattern, content)...)
	}
	if files == 0 {
		section.Findings = append(section.Findings, emptyInput("workflow file", ".github/workflows"))
		return section
	}
	references = uniqueSorted(references)
	if len(references) == 0 {
		section.Findings = append(section.Findings, emptyInput("working-directory", ".github/workflows/*.yml"))
		return section
	}
	for _, wd := range references {
		if strings.Contains(wd, "${{") {
			section.Checked = append(section.Checked, wd+" (expression)")
			continue
		}
		if exists(root, "", wd) {
			section.Checked = append(section.Checked, wd)
			continue
		}
		section.Findings = append(section.Findings, fail(
			"working-directory "+wd+" does not exist",
			"a workflow step runs there; rename it with the directory"))
	}
	return section
}

// makeTargetPattern matches a rule definition at the start of a line. The
// leading alphanumeric requirement excludes `.PHONY:` and pattern rules, which
// are declarations rather than targets a caller can ask for.
var makeTargetPattern = regexp.MustCompile(`(?m)^([A-Za-z0-9_][A-Za-z0-9_.-]*):`)

// makePhonyPattern captures the whole `.PHONY` declaration, including its
// backslash continuations, because the list is long enough to be wrapped.
var makePhonyPattern = regexp.MustCompile(`(?m)^\.PHONY:((?:.*\\\n)*.*)$`)

// checkMakefileTargets keeps the Makefile's own bookkeeping honest: every
// target declared in .PHONY must exist, and every target that exists must be
// declared.
//
// This is the rule the alias cleanup above was measured against. A target
// missing from .PHONY runs only when no file of that name exists, and a stale
// .PHONY entry is documentation rot that nothing else notices.
func checkMakefileTargets(root string) Section {
	section := Section{Name: "every Makefile target is declared .PHONY"}
	content, missing := readFile(root, "Makefile")
	if missing != nil {
		section.Findings = append(section.Findings, *missing)
		return section
	}
	targets := map[string]bool{}
	for _, match := range makeTargetPattern.FindAllStringSubmatch(content, -1) {
		targets[match[1]] = true
	}
	if len(targets) == 0 {
		section.Findings = append(section.Findings, emptyInput("Makefile target", "Makefile"))
		return section
	}
	declared := map[string]bool{}
	block, ok := capture(makePhonyPattern, content)
	if !ok {
		section.Findings = append(section.Findings, fail("Makefile has no .PHONY declaration",
			"every target here is a name, not a file; without .PHONY a target that",
			"matches a path on disk silently does nothing"))
		return section
	}
	for _, name := range strings.Fields(strings.ReplaceAll(block, "\\", " ")) {
		declared[name] = true
	}
	if len(declared) == 0 {
		section.Findings = append(section.Findings, emptyInput(".PHONY entry", "Makefile"))
		return section
	}

	var undeclared, stale []string
	for name := range targets {
		if !declared[name] {
			undeclared = append(undeclared, name)
		}
	}
	for name := range declared {
		if !targets[name] {
			stale = append(stale, name)
		}
	}
	for _, name := range uniqueSorted(undeclared) {
		section.Findings = append(section.Findings, fail("target "+name+" is not in .PHONY",
			"add it to the .PHONY list: a target that matches a file on disk runs",
			"only when that file is missing"))
	}
	for _, name := range uniqueSorted(stale) {
		section.Findings = append(section.Findings, fail(".PHONY lists "+name+", which is not a target",
			"remove it: a stale entry makes the list unreliable for everyone reading it"))
	}
	section.Checked = append(section.Checked,
		strconv.Itoa(len(targets))+" targets, "+strconv.Itoa(len(declared))+" .PHONY declarations")
	return section
}
