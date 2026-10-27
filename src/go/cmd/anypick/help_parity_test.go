package main

// NATIVE-M1 CLI parity part 1: structural command-tree golden gate against
// go/testdata/parity/cli-tree.json, stdout purity under --json,
// verbosity-flag consumers, and dynamic positional completion. The fixture
// is maintained by hand now, and the enforced part is the path set
// (descriptions and flags are documentation kept in step with the Go
// dispatch).

import (
	"bytes"
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
)

type cliTreeFixture struct {
	Commands []struct {
		Path        string   `json:"path"`
		Description string   `json:"description"`
		Flags       []string `json:"flags"`
		Subcommands []string `json:"subcommands"`
		Hidden      bool     `json:"hidden"`
	} `json:"commands"`
	Omitted []struct {
		Path   string `json:"path"`
		Reason string `json:"reason"`
	} `json:"omitted"`
}

func loadCliTree(t *testing.T) cliTreeFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "parity", "cli-tree.json"))
	if err != nil {
		t.Fatalf("read the CLI tree fixture: %v", err)
	}
	var f cliTreeFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f cliTreeFixture) omittedSet() map[string]bool {
	out := map[string]bool{}
	for _, o := range f.Omitted {
		out[o.Path] = true
	}
	return out
}

// dispatchedTopLevel extracts the string case literals of the switch inside
// run() in main.go straight from the AST, so the test compares the fixture
// against the real dispatch tree instead of a drift-prone copy.
func dispatchedTopLevel(t *testing.T) map[string]bool {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "run" {
			return true
		}
		ast.Inspect(fn, func(m ast.Node) bool {
			sw, ok := m.(*ast.SwitchStmt)
			if !ok {
				return true
			}
			for _, stmt := range sw.Body.List {
				cc, ok := stmt.(*ast.CaseClause)
				if !ok || len(cc.List) != 1 {
					continue
				}
				lit, ok := cc.List[0].(*ast.BasicLit)
				if ok && lit.Kind == token.STRING {
					cases[strings.Trim(lit.Value, "`\"")] = true
				}
			}
			return true
		})
		return false
	})
	return cases
}

// clearGlobalsForParity zeroes recorded global flags — resetGlobals() only
// snapshots for a deferred restore, it never clears leaked state.
func clearGlobalsForParity() {
	globals.JSON, globals.DryRun, globals.NoInput, globals.Yes = false, false, false, false
	globals.Quiet, globals.Verbose, globals.Trace, globals.Reveal, globals.Tray = false, false, false, false, false
	globalJSON = false
}

// globalsClean asserts no global flag survived a probe — the "tray start"
// --dry-run probe used to leak DryRun=true into every later probe.
func globalsClean() bool {
	return !globals.JSON && !globals.DryRun && !globals.NoInput && !globals.Yes &&
		!globals.Quiet && !globals.Verbose && !globals.Trace && !globals.Reveal &&
		!globals.Tray && !globalJSON
}

// captureBoth redirects stdout and stderr for the duration of fn, returning
// (stdout, stderr) and mirroring them into lastStdout/lastStderr.
//
// Both pipes are drained by a goroutine started before fn runs. Reading only
// afterwards deadlocks once the command writes more than the pipe buffer holds
// (64KB on Linux, 16KB on Darwin): the write blocks on a full pipe while the
// reader has not started, so the test hangs until the package timeout rather
// than failing. `doctor --fix --dry-run --json` reached 82KB once stale
// temp overlays piled up in TMPDIR, which is how this was found.
var lastStdout, lastStderr string

func captureBoth(t *testing.T, fn func()) (string, string) {
	t.Helper()
	soutR, soutW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	serrR, serrW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var outBuf, errBuf bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(&outBuf, soutR)
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(&errBuf, serrR)
	}()

	savedOut, savedErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = soutW, serrW
	fn()
	os.Stdout, os.Stderr = savedOut, savedErr
	_ = soutW.Close()
	_ = serrW.Close()
	wg.Wait()
	_ = soutR.Close()
	_ = serrR.Close()
	lastStdout, lastStderr = outBuf.String(), errBuf.String()
	return lastStdout, lastStderr
}

var unknownSentinels = []string{
	"unknown command",
	"unknown gateway subcommand",
	"unknown account subcommand",
	"unknown preset subcommand",
	"unknown plugin subcommand",
	"unknown codex subcommand",
	"unknown codex profile subcommand",
}

func looksUnknown(out, errOut string) bool {
	joined := out + errOut
	for _, s := range unknownSentinels {
		if strings.Contains(joined, s) {
			return true
		}
	}
	return false
}

// probeExtra holds per-path benign arguments that keep probing side-effect
// free (the handlers validate arity before acting; these two would not).
var probeExtra = map[string][]string{
	"tray start": {"--dry-run"}, // plan only: never spawns the supervisor
	// Bare `serve` runs the management API until interrupted; --stop on an
	// isolated home finds nothing running and returns.
	"serve": {"--stop"},
}

func TestCliTreePathsResolveInGoDispatch(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	fixture := loadCliTree(t)
	omitted := fixture.omittedSet()
	dispatch := dispatchedTopLevel(t)

	// Sentinel: structural drift in main.go's switch must fail closed, so the
	// extraction is required to still see these key single-literal cases.
	for _, key := range []string{"use", "__complete", "tray"} {
		if !dispatch[key] {
			t.Errorf("dispatchedTopLevel lost case %q — AST extraction drifted", key)
		}
	}

	for _, cmd := range fixture.Commands {
		path := cmd.Path
		if path == "" || omitted[path] || omitted[strings.SplitN(path, " ", 2)[0]] {
			continue
		}
		if path == "update" {
			// cmdUpdate hits the GitHub releases API before any flag gate;
			// probe it structurally instead of over the network.
			if !dispatch["update"] {
				t.Errorf("fixture command %q missing from Go dispatch tree", path)
			}
			continue
		}
		args := strings.Split(path, " ")
		args = append(args, probeExtra[path]...)
		restore := resetGlobals()
		out, errOut := captureBoth(t, func() { run(args) })
		restore()
		if !globalsClean() {
			t.Errorf("probe %q leaked global-flag state into subsequent probes: %+v", path, globals)
		}
		if looksUnknown(out, errOut) {
			t.Errorf("fixture command %q does not resolve in the Go dispatch tree (stdout=%q stderr=%q)",
				path, out, errOut)
		}
	}
	resetGlobals()
}

// The fixture records the command tree the TypeScript engine shipped, kept as
// the parity baseline after 9702015 deleted that engine. A Go-only command is
// legitimate; it must be listed as omitted so this check can tell it apart
// from one that was never accounted for.
func TestGoDispatchTreeMatchesRecordedTopLevel(t *testing.T) {
	fixture := loadCliTree(t)
	omitted := fixture.omittedSet()
	tsTop := map[string]bool{}
	for _, cmd := range fixture.Commands {
		if cmd.Path == "" {
			continue
		}
		tsTop[strings.SplitN(cmd.Path, " ", 2)[0]] = true
	}
	for c := range dispatchedTopLevel(t) {
		if strings.HasPrefix(c, "-") || c == "help" || c == "--tui" || c == "tui" {
			continue // flags and the documented TUI alias
		}
		if tsTop[c] || omitted[c] {
			continue
		}
		t.Errorf("Go dispatches top-level command %q but the parity fixture neither "+
			"records it nor lists it as omitted", c)
	}
}

func TestUnknownCommandPrintsUsageAndInvalidUsage(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	exit := -1
	out, _ := captureBoth(t, func() { exit = run([]string{"definitely-not-a-command"}) })
	if !strings.Contains(out, "Usage:") {
		t.Fatalf("unknown command must print usage on stdout, got %.200q", out)
	}
	if exit != int(anyerr.InvalidUsage) {
		t.Fatalf("unknown command exited %d, want InvalidUsage (%d)", exit, int(anyerr.InvalidUsage))
	}
}

// seedRootForParity gives probes a live gateway and account.
func seedRootForParity(t *testing.T) {
	t.Helper()
	t.Setenv("ANYPICK_SECRET", "sk-parity-seed-12345678")
	seed := func(args []string) {
		out, errOut := "", ""
		code := -1
		func() {
			out, errOut = captureBoth(t, func() { code = run(args) })
		}()
		if code != 0 {
			t.Fatalf("seed %v exited %d (stdout=%q stderr=%q)", args, code, out, errOut)
		}
	}
	seed([]string{"gateway", "add", "or", "--provider", "openrouter"})
	seed([]string{"add", "deepseek", "--name", "ds", "--kind", "api-key"})
}

func TestDynamicCompletionKinds(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	seedRootForParity(t)

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	wantProviders := append([]string(nil), a.Providers.IDs()...)
	wantClients := append([]string(nil), a.Clients.IDs()...)
	closeFn()

	cases := []struct {
		name string
		args []string
		want []string
	}{
		{"providers", []string{"__complete", "providers"}, wantProviders},
		{"clients", []string{"__complete", "clients"}, wantClients},
		{"gateways", []string{"__complete", "gateways"}, []string{"or"}},
		{"accounts for provider", []string{"__complete", "accounts", "deepseek"}, []string{"ds"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer resetGlobals()()
			var out string
			captureBoth(t, func() { run(tc.args) })
			out = lastStdout
			got := nonEmptyLines(out)
			if len(got) != len(tc.want) {
				t.Fatalf("__complete %s = %v, want %v", strings.Join(tc.args[1:], " "), got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("__complete %s = %v, want %v", strings.Join(tc.args[1:], " "), got, tc.want)
				}
			}
		})
	}

	// Unknown kind fails without printing ids.
	var out string
	captureBoth(t, func() { run([]string{"__complete", "bogus"}) })
	out = lastStdout
	if len(nonEmptyLines(out)) != 0 {
		t.Fatalf("unknown kind printed %q", out)
	}
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func TestCompletionScriptsShellOutToCompleteHelper(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	for _, shell := range []string{"bash", "zsh", "fish"} {
		var out string
		captureBoth(t, func() { run([]string{"completion", shell}) })
		out = lastStdout
		for _, want := range []string{"__complete clients", "__complete providers", "__complete accounts"} {
			if !strings.Contains(out, want) {
				t.Errorf("%s completion script lacks positional %q call", shell, want)
			}
		}
	}
}

// TestJSONStdoutPurityMatrix asserts every machine-readable invocation prints
// exactly ONE JSON value on stdout with zero trailing bytes (plan M8:
// "JSON stdout is exactly one parseable result stream").
func TestJSONStdoutPurityMatrix(t *testing.T) {
	clearGlobalsForParity()
	exportFile := filepath.Join(t.TempDir(), "export.json")
	cases := []struct {
		name    string
		args    []string
		wantKey string
	}{
		{"providers", []string{"providers"}, ""},
		{"clients", []string{"clients"}, ""},
		{"doctor", []string{"doctor"}, ""},
		{"current", []string{"current", "deepseek"}, ""},
		{"proxy status", []string{"proxy", "status", "deepseek", "ds"}, ""},
		{"use dry-run", []string{"use", "claude", "--with", "or", "--dry-run"}, ""},
		{"models", []string{"models", "claude", "--with", "gateway/or"}, ""},
		{"supervisor status", []string{"status"}, ""},
		{"supervisor stop", []string{"stop"}, ""},
		{"preset list", []string{"preset", "list"}, ""},
		{"account export", []string{"account", "export", "deepseek", "ds", "--out", exportFile}, ""},
		{"gateway list", []string{"gateway", "list"}, "gateways"},
		{"gateway edit", []string{"gateway", "edit", "or", "--model", "m-json"}, "name"},
		{"proxy enable", []string{"proxy", "enable", "deepseek", "ds"}, "port"},
		{"proxy disable", []string{"proxy", "disable", "deepseek", "ds"}, "action"},
		{"proxy logs", []string{"proxy", "logs", "deepseek", "ds"}, "lines"},
		{"hub enable", []string{"proxy", "hub", "enable", "parity"}, "hub"},
		{"pool enable", []string{"proxy", "pool", "enable", "deepseek"}, "provider"},
		{"serve stop", []string{"serve", "--stop"}, "state"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer resetGlobals()()
			isolateEnv(t) // fresh root per case
			seedRootForParity(t)
			full := append([]string{"--json"}, tc.args...)
			var out string
			exit := -1
			captureBoth(t, func() { exit = run(full) })
			out = lastStdout
			if exit != int(anyerr.Success) {
				t.Fatalf("--json %s exited %d\nstdout=%s\nstderr=%s", tc.name, exit, out, lastStderr)
			}
			dec := json.NewDecoder(strings.NewReader(out))
			var v interface{}
			if err := dec.Decode(&v); err != nil {
				t.Fatalf("--json %s stdout is not JSON (%v): %.300q", tc.name, err, out)
			}
			if _, terr := dec.Token(); terr != io.EOF { // a second token means trailing bytes
				t.Fatalf("--json %s stdout carries trailing non-JSON bytes", tc.name)
			}
			if strings.Contains(out, "sk-parity-seed") {
				t.Fatalf("--json %s printed the seeded secret: %.300q", tc.name, out)
			}
			if tc.wantKey != "" {
				obj, _ := v.(map[string]interface{})
				if obj == nil || obj[tc.wantKey] == nil {
					t.Fatalf("--json %s missing %s: %.300q", tc.name, tc.wantKey, out)
				}
			}
		})
	}
}

func TestQuietSuppressesChatterButNotMutation(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	seedRootForParity(t)

	globals.Quiet = true
	var out string
	exit := -1
	captureBoth(t, func() { exit = run([]string{"use", "claude", "--with", "or"}) })
	out = lastStdout
	if exit != 0 {
		t.Fatalf("quiet use exited %d", exit)
	}
	if strings.TrimSpace(out) != "" {
		t.Fatalf("--quiet must suppress chatter lines, got %q", out)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	binding, gerr := a.BindingSvc.GetGlobalContext(context.Background(), "claude")
	if gerr != nil || binding == nil {
		t.Fatalf("--quiet must still persist the binding: %+v err=%v", binding, gerr)
	}
}

func TestTraceStepsGoToStderrOnly(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	seedRootForParity(t)

	globals.Trace = true
	exit := -1
	stdout, stderr := captureBoth(t, func() { exit = run([]string{"use", "claude", "--with", "gateway/or"}) })
	if exit != 0 {
		t.Fatalf("trace use exited %d", exit)
	}
	if !strings.Contains(stderr, "[trace]") {
		t.Fatalf("--trace must print step lines to stderr, got %.200q", stderr)
	}
	if strings.Contains(stdout, "[trace]") {
		t.Fatalf("--trace leaked into stdout: %q", stdout)
	}
	if !strings.Contains(stdout, "activated") {
		t.Fatalf("human result line missing under --trace: %q", stdout)
	}
}

func TestDoctorDetailRequiresVerbose(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()

	// Plant a dangling active pointer so a finding carries non-empty detail.
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	if serr := a.Store.SetActiveContext(context.Background(), "grok", "ghost"); serr != nil {
		t.Fatal(serr)
	}
	closeFn()
	defer resetGlobals()()

	var out string
	captureBoth(t, func() { run([]string{"doctor"}) })
	out = lastStdout
	if strings.Contains(out, "points at missing account") {
		t.Fatalf("detail must stay hidden without --verbose: %q", out)
	}
	globals.Verbose = true
	captureBoth(t, func() { run([]string{"doctor"}) })
	out = lastStdout
	if !strings.Contains(out, "points at missing account") {
		t.Fatalf("--verbose should reveal check detail: %q", out)
	}
}

// TestCLIReferenceCommandsExist ties the prose surfaces to the command tree:
// every `anypick …` invocation in a bash code block must resolve to a known
// command path, and every flag it passes must resolve to a global flag or to
// one the owning command's handler registers. The page had drifted into
// documenting commands and flags the binary never had, and nothing caught it
// because the structural golden only probes the fixture, not the prose, and
// the old loop stopped at the first token starting with a dash.
func TestCLIReferenceCommandsExist(t *testing.T) {
	fixture := loadCliTree(t)
	known := map[string]bool{}
	for _, c := range fixture.Commands {
		known[c.Path] = true
	}
	// Paths deliberately omitted from the fixture (hidden helpers, Go-only
	// commands) are still commands the reference may document.
	for _, o := range fixture.Omitted {
		known[o.Path] = true
	}
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	probe := newCommandFlagProbe(t)

	var lines []string
	for _, file := range docGateFiles(t) {
		doc, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		lines = append(lines, cliDocCommandLines(string(doc))...)
	}
	if len(lines) == 0 {
		// A parser that matches nothing reads exactly like a passing gate.
		t.Fatal("no `anypick` invocations found in any documentation fence; the doc scan has drifted")
	}
	for _, f := range checkDocumentedFlags(lines, known, probe) {
		t.Errorf("docs document %q, which the tree does not have:\n  %s", f.Flag, f.Line)
	}
}

// TestUsageTextFlagsResolveInHandlers closes the gap the --project defect came
// through. The shipped usage() string is itself a documentation surface: it
// advertised `link|unlink … [--project]` while cmdLink registered no such
// flag, and the doc gate could not see it because it only scans files under
// docs/ and the golden fixture. The usage text is collected at runtime from
// the same function the binary prints, so a future help line cannot name a
// flag no handler registers without failing here.
func TestUsageTextFlagsResolveInHandlers(t *testing.T) {
	fixture := loadCliTree(t)
	known := map[string]bool{}
	for _, c := range fixture.Commands {
		known[c.Path] = true
	}
	for _, o := range fixture.Omitted {
		known[o.Path] = true
	}
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	probe := newCommandFlagProbe(t)

	var lines []string
	for _, l := range strings.Split(usageText, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "anypick ") {
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	if len(lines) == 0 {
		t.Fatal("usage() produced no anypick invocation lines; the usage scan has drifted")
	}
	for _, f := range checkDocumentedFlags(lines, known, probe) {
		t.Errorf("usage() documents %q, which the tree does not have:\n  %s", f.Flag, f.Line)
	}
}

// TestCliTreeFlagsResolveInHandlers checks the golden's own `flags` arrays.
// The fixture advertised `flags` for every command from the start and nothing
// compared them to a FlagSet, which is how nine documented flags shipped with
// no handler behind them. A flag the golden promises and the handler does not
// register is the same defect in a second place.
func TestCliTreeFlagsResolveInHandlers(t *testing.T) {
	fixture := loadCliTree(t)
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	probe := newCommandFlagProbe(t)

	for _, cmd := range fixture.Commands {
		for _, advertised := range cmd.Flags {
			name := strings.TrimLeft(advertised, "-")
			if knownGlobalFlags[name] {
				continue
			}
			if cmd.Path == "" {
				// The root's non-global flags are handled before dispatch
				// (--version/-V) or by the switch (--tui).
				if rootOnlyFlags[name] {
					continue
				}
				t.Errorf("cli-tree.json advertises %q at the root but no global flag handles it", advertised)
				continue
			}
			flags, ok := probe.flagsForTokens(strings.Split(cmd.Path, " "))
			if !ok {
				t.Errorf("cli-tree.json command %q does not resolve in the binary", cmd.Path)
				continue
			}
			if !flags[name] {
				t.Errorf("cli-tree.json advertises %q for %q but the handler registers no such flag",
					advertised, cmd.Path)
			}
		}
	}
}

// TestDocumentedFlagGateRejectsUnknownFlag proves the gate can fail. It drives
// the checker with synthetic invocations carrying a flag no handler registers,
// so the failure is demonstrated without editing the real docs (which would
// leave a broken tree behind if the restore were ever skipped).
func TestDocumentedFlagGateRejectsUnknownFlag(t *testing.T) {
	known := map[string]bool{"": true, "list": true, "gateway": true}
	resolver := stubFlagResolver{
		"gateway edit": {"endpoint": true, "model": true, "m": true},
		"list":         {"json": true},
	}

	bad := checkDocumentedFlags(
		[]string{"anypick gateway edit gw --definitely-not-a-flag"}, known, resolver)
	if len(bad) != 1 || bad[0].Flag != "definitely-not-a-flag" {
		t.Fatalf("gate accepted an unknown flag: findings=%+v", bad)
	}

	good := checkDocumentedFlags(
		[]string{
			"anypick gateway edit gw --model x -m y",
			"anypick list --json",
			"anypick -V",
		}, known, resolver)
	if len(good) != 0 {
		t.Fatalf("gate rejected documented flags: findings=%+v", good)
	}

	unknownCommand := checkDocumentedFlags(
		[]string{"anypick not-a-command --json"}, known, resolver)
	if len(unknownCommand) != 1 || unknownCommand[0].Flag != "(command)" {
		t.Fatalf("gate accepted an unknown command: findings=%+v", unknownCommand)
	}
}

// stubFlagResolver answers from a literal path→flags map for the failure proof.
// It matches the longest registered prefix, the way the real probe resolves an
// alias the fixture spells differently.
type stubFlagResolver map[string]map[string]bool

func (s stubFlagResolver) flagsForTokens(tokens []string) (map[string]bool, bool) {
	flags := map[string]bool{}
	found := false
	// Longest registered prefix wins, matching the real probe's resolution of
	// an alias the fixture spells differently.
	for k := len(tokens); k >= 1; k-- {
		if f, ok := s[strings.Join(tokens[:k], " ")]; ok {
			found = true
			for name := range f {
				flags[name] = true
			}
			break
		}
	}
	return flags, found
}

// flagGateFinding is one documented flag (or command path) with no handler.
type flagGateFinding struct {
	Line string
	Flag string
}

// checkDocumentedFlags is the gate itself, kept free of the real probe so the
// failure proof can drive it with a stub. Path existence is checked against the
// fixture (`known`); flags are checked against the handler that actually runs,
// resolved through `probe` so a Go-only alias like `gateway add` is judged by
// its real FlagSet rather than by whether the fixture happens to list it.
func checkDocumentedFlags(lines []string, known map[string]bool, probe flagResolver) []flagGateFinding {
	var out []flagGateFinding
	for _, line := range lines {
		tokens := documentedPathTokens(line)
		if !documentedPathExists(tokens, known) {
			out = append(out, flagGateFinding{Line: line, Flag: "(command)"})
			continue
		}
		rootInvocation := len(tokens) == 0
		var names []string
		for _, name := range documentedFlagNames(line) {
			if knownGlobalFlags[name] || (rootInvocation && rootOnlyFlags[name]) {
				continue
			}
			names = append(names, name)
		}
		if len(names) == 0 {
			continue
		}
		// Refused paths (supervisors and surfaces) cannot be probed by running
		// their handler, so their flags cannot be verified here; the path
		// itself was already checked above. Flagging their real flags would
		// make this gate cry wolf and get ignored.
		if refusedByProbe(tokens) {
			continue
		}
		flags, _ := probe.flagsForTokens(tokens)
		for _, name := range names {
			if !flags[name] {
				out = append(out, flagGateFinding{Line: line, Flag: name})
			}
		}
	}
	return out
}

// flagResolver answers "which flags does the handler for this command path
// register?" for the gate and its stub.
type flagResolver interface {
	flagsForTokens(tokens []string) (map[string]bool, bool)
}

// documentedPathExists reports whether the invocation's leading tokens name a
// command. Matching the longest known prefix keeps the old leniency for a
// documented alias the fixture spells differently (`gateway add` vs the
// fixture's `add gateway`); the flag check then uses the real handler.
func documentedPathExists(tokens []string, known map[string]bool) bool {
	if len(tokens) == 0 {
		return known[""]
	}
	for _, alt := range expandPathAlternatives(tokens) {
		prefix := ""
		for _, tok := range alt {
			cand := tok
			if prefix != "" {
				cand = prefix + " " + tok
			}
			if !known[cand] {
				break
			}
			prefix = cand
		}
		if prefix != "" {
			return true
		}
	}
	return false
}

// rootOnlyFlags are accepted at the root but are not in knownGlobalFlags:
// --version/-V are handled before dispatch, and --tui is a switch case.
var rootOnlyFlags = map[string]bool{"version": true, "V": true, "tui": true}

// probeRefusedPaths are root commands that must never be run for a probe even
// if a doc line carried a flag: they spawn supervisors or open surfaces. No
// current fence does, so this is a guard against a future one.
//
// `serve` is absent on purpose: it is a documented command with flags now
// (ADR-0034), and both its handlers parse flags before they bind a port or
// touch the token, so an unknown flag returns at the parse error.
var probeRefusedPaths = map[string]bool{
	"start": true, "stop": true, "tray": true, "app": true, "tui": true,
	"desktop-service": true,
}

// refusedByProbe reports whether the first path token is one the probe must
// never run.
func refusedByProbe(tokens []string) bool {
	return len(tokens) > 0 && probeRefusedPaths[tokens[0]]
}

// commandFlagProbe answers "which flags does this command's handler register?"
// by running the real handler with an unknown flag and reading the FlagSet's
// own usage dump. That dump is the handler's registrations, so the gate cannot
// drift from the code the way a hand-kept path→flags copy would — that copy is
// exactly what let the reference advertise flags nothing implemented.
//
// The probe is safe because a flag-parsing handler returns at the parse error,
// before any service call or mutation; only paths that actually carry a
// non-global flag are ever probed.
type commandFlagProbe struct {
	t     *testing.T
	cache map[string]map[string]bool
}

func newCommandFlagProbe(t *testing.T) *commandFlagProbe {
	return &commandFlagProbe{t: t, cache: map[string]map[string]bool{}}
}

const parityUnknownFlag = "--parity-unknown-flag"

// flagsForTokens merges the flags of every concrete spelling of a path. A path
// that yields no usage dump parses no flags at all (or does not exist), which
// the caller sees as an empty set and reports as an unresolvable flag.
func (p *commandFlagProbe) flagsForTokens(tokens []string) (map[string]bool, bool) {
	if len(tokens) == 0 {
		return nil, false
	}
	flags := map[string]bool{}
	found := false
	for _, path := range expandPathAlternatives(tokens) {
		key := strings.Join(path, " ")
		if probeRefusedPaths[path[0]] {
			p.t.Errorf("refusing to probe %q: it starts a surface or supervisor", key)
			continue
		}
		if _, ok := p.cache[key]; !ok {
			p.cache[key] = p.probe(key)
		}
		if p.cache[key] == nil {
			continue
		}
		found = true
		for name := range p.cache[key] {
			flags[name] = true
		}
	}
	return flags, found
}

func (p *commandFlagProbe) probe(path string) map[string]bool {
	args := append(strings.Split(path, " "), parityUnknownFlag)
	restore := resetGlobals()
	_, errOut := captureBoth(p.t, func() { run(args) })
	restore()
	if !strings.Contains(errOut, "flag provided but not defined") {
		return nil
	}
	return parseFlagDump(errOut)
}

// parseFlagDump reads the flag names out of the stdlib's usage output. Flag
// lines start with two spaces and a dash; the tab-indented lines under them are
// descriptions, which this skips.
func parseFlagDump(out string) map[string]bool {
	flags := map[string]bool{}
	inUsage := false
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "Usage:" {
			inUsage = true
			continue
		}
		if !inUsage || !strings.HasPrefix(line, "  -") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if name := strings.TrimLeft(fields[0], "-"); name != "" {
			flags[name] = true
		}
	}
	return flags
}

// documentedPathTokens returns the leading tokens of an invocation that name a
// command path: leading global flags are skipped (they may precede the
// command), and the first non-global flag, `--`, or positional placeholder
// (`<client>`, `[providers|accounts]`) ends the path. An inline `#` comment is
// prose, not argv.
func documentedPathTokens(line string) []string {
	var out []string
	for _, tok := range strings.Fields(stripDocComment(line))[1:] {
		if tok == "--" {
			break
		}
		if strings.HasPrefix(tok, "-") {
			if knownGlobalFlags[flagName(tok)] {
				continue
			}
			break
		}
		if strings.HasPrefix(tok, "<") || strings.HasPrefix(tok, "[") || strings.HasPrefix(tok, "(") {
			break
		}
		// An alternation bar ends the path: "doctor | update | completion"
		// offers three separate commands, not a subcommand "|". Without this
		// the bar itself joined the path and the line read as an unknown
		// command.
		if tok == "|" {
			break
		}
		out = append(out, tok)
	}
	return out
}

// stripDocComment removes an inline shell comment from a documented line.
// Parenthesised trailing prose is treated the same way: the usage text annotates
// lines with "(deprecated alias for add account --current)", and reading the
// --current inside that prose as a flag of the line's own command made the gate
// flag a real invocation.
func stripDocComment(line string) string {
	for i, tok := range strings.Fields(line) {
		if strings.HasPrefix(tok, "#") {
			return strings.Join(strings.Fields(line)[:i], " ")
		}
		if strings.HasPrefix(tok, "(") {
			return strings.Join(strings.Fields(line)[:i], " ")
		}
	}
	return line
}

// expandPathAlternatives expands `use|run` style alternatives into concrete
// token sequences, so both spellings are probed.
func expandPathAlternatives(tokens []string) [][]string {
	paths := [][]string{{}}
	for _, tok := range tokens {
		var next [][]string
		for _, prefix := range paths {
			for _, alt := range strings.Split(strings.Trim(tok, "[](),"), "|") {
				alt = strings.TrimSpace(alt)
				if alt == "" {
					continue
				}
				next = append(next, append(append([]string{}, prefix...), alt))
			}
		}
		if len(next) == 0 {
			return nil
		}
		paths = next
	}
	return paths
}

// documentedFlagNames extracts every flag spelling a line passes, expanding
// `[--current|--new]` style alternatives. Everything after `--` is a child's
// argv and is not the CLI's own flag surface, and an inline `#` comment is
// prose (its `|` would otherwise be read as an alternative).
func documentedFlagNames(line string) []string {
	var out []string
	for _, tok := range strings.Fields(stripDocComment(line)) {
		if tok == "--" {
			break
		}
		for _, alt := range strings.Split(tok, "|") {
			alt = strings.Trim(alt, "[](),")
			if !strings.HasPrefix(alt, "-") || strings.HasPrefix(alt, "--<") {
				continue
			}
			if name := flagName(alt); name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

func flagName(tok string) string {
	name := strings.TrimLeft(tok, "-")
	if eq := strings.Index(name, "="); eq >= 0 {
		name = name[:eq]
	}
	return strings.Trim(name, "[](),")
}

// docGateFiles lists the prose surfaces whose bash fences are user-facing
// instructions. The reference page is canonical, but a flag that only appears
// in a guide is just as broken for the reader who follows it.
func docGateFiles(t *testing.T) []string {
	t.Helper()
	root := filepath.Join("..", "..", "..", "..")
	files := []string{filepath.Join(root, "README.md")}
	docs := filepath.Join(root, "docs", "src", "content", "docs")
	err := filepath.Walk(docs, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && (strings.HasSuffix(path, ".mdx") || strings.HasSuffix(path, ".md")) {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", docs, err)
	}
	sort.Strings(files)
	return files
}

// cliDocCommandLines returns every `anypick …` line inside a ```bash fence.
func cliDocCommandLines(doc string) []string {
	var out []string
	blocks := strings.Split(doc, "```")
	for i := 1; i < len(blocks); i += 2 {
		block := blocks[i]
		if !strings.HasPrefix(block, "bash\n") {
			continue
		}
		for _, line := range strings.Split(strings.TrimPrefix(block, "bash\n"), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "anypick ") {
				out = append(out, line)
			}
		}
	}
	return out
}
