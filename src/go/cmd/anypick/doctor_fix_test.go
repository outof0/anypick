package main

// Regressions for `anypick doctor --fix`.
//
// The defect this file exists for: cmdDoctor parsed no flags at all. It used a
// substring scan for "--json", so `doctor --fix --dry-run` printed an ordinary
// report and exited 0, and `doctor --definitely-not-a-flag` did too. The golden
// tree advertised `--fix` the whole time. A command whose advertised flags are
// not registered is a documented promise with no implementation, so the gate
// below asserts the fixture and the handler agree.

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/doctor"
	"github.com/outof0/anypick/go/internal/modelcache"
)

// TestDoctorFlagsAreRegistered is the gate that let this defect ship. Every
// flag the golden tree advertises for `doctor` must be accepted by the handler
// the binary actually runs. The old check only proved the command *path*
// existed; it stopped at the first token starting with a dash.
func TestDoctorFlagsAreRegistered(t *testing.T) {
	fixture := loadCliTree(t)
	var doctorFlags []string
	for _, cmd := range fixture.Commands {
		if cmd.Path == "doctor" {
			doctorFlags = cmd.Flags
		}
	}
	if len(doctorFlags) == 0 {
		t.Fatal("the cli-tree fixture advertises no doctor flags; the gate would pass vacuously")
	}

	// Register through the handler's own function, so this gate cannot drift
	// from what cmdDoctor actually parses. A hand-kept copy here would recreate
	// the very gap the gate exists to close.
	fs := fsFor(nil)
	registerDoctorFlags(fs)
	registered := map[string]bool{}
	fs.VisitAll(func(f *flag.Flag) { registered[f.Name] = true })

	for _, advertised := range doctorFlags {
		name := strings.TrimLeft(advertised, "-")
		if !registered[name] {
			t.Errorf("cli-tree.json advertises %q for `doctor` but the handler registers no such flag", advertised)
		}
	}
}

// TestDoctorRejectsUnknownFlag is the reproduction, pinned. Before the fix this
// exited 0 after printing a report.
func TestDoctorRejectsUnknownFlag(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	exit := -1
	out, errOut := captureBoth(t, func() {
		exit = run([]string{"doctor", "--definitely-not-a-flag"})
	})
	if exit != int(anyerr.InvalidUsage) {
		t.Fatalf("unknown flag exited %d, want %d\nstdout=%q stderr=%q",
			exit, int(anyerr.InvalidUsage), out, errOut)
	}
	if !strings.Contains(errOut, "definitely-not-a-flag") {
		t.Fatalf("stderr did not name the unknown flag: %q", errOut)
	}
	if strings.Contains(out, "anypick doctor —") {
		t.Fatalf("unknown flag still printed a report: %q", out)
	}
}

// TestDoctorFixJSONWithoutYesRequiresConfirmation pins the non-TTY contract:
// exit 2 with CONFIRMATION_REQUIRED, and nothing mutated (invariant 7).
func TestDoctorFixJSONWithoutYesRequiresConfirmation(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	globals.JSON = true
	exit := -1
	_, errOut := captureBoth(t, func() {
		exit = run([]string{"doctor", "--fix"})
	})
	if exit != int(anyerr.InvalidUsage) {
		t.Fatalf("doctor --fix --json without --yes exited %d, want %d (stderr=%q)",
			exit, int(anyerr.InvalidUsage), errOut)
	}
	if !strings.Contains(errOut, "CONFIRMATION_REQUIRED") {
		t.Fatalf("refusal did not carry CONFIRMATION_REQUIRED: %q", errOut)
	}
}

// TestDoctorFixDryRunPrintsPlanAndMutatesNothing covers the "You see" contract:
// one [dry-run] line per planned action, and the target survives.
func TestDoctorFixDryRunPrintsPlanAndMutatesNothing(t *testing.T) {
	base := isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	// Plant a stale overlay in the system temp dir the process will scan.
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TMP", tmp)
	t.Setenv("TEMP", tmp)
	overlay := filepath.Join(tmp, "anypick-claude-doctor-test")
	if err := os.MkdirAll(overlay, 0o700); err != nil {
		t.Fatal(err)
	}
	old := timeHoursAgo(2)
	if err := os.Chtimes(overlay, old, old); err != nil {
		t.Fatal(err)
	}

	exit := -1
	out, errOut := captureBoth(t, func() {
		exit = run([]string{"doctor", "--fix", "--dry-run"})
	})
	if exit != int(anyerr.Success) {
		t.Fatalf("dry run exited %d (stderr=%q)", exit, errOut)
	}
	if !strings.Contains(out, "[dry-run]") {
		t.Fatalf("dry run printed no plan: %q", out)
	}
	if !strings.Contains(out, overlay) {
		t.Fatalf("dry run did not name the planted overlay %s: %q", overlay, out)
	}
	if _, err := os.Stat(overlay); err != nil {
		t.Fatalf("dry run deleted the overlay: %v", err)
	}
	_ = base
}

// TestDoctorFixYesDeletesStaleOverlay is the live contract for one kind, driven
// through the real command path with an isolated root.
func TestDoctorFixYesDeletesStaleOverlay(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TMP", tmp)
	t.Setenv("TEMP", tmp)
	overlay := filepath.Join(tmp, "anypick-live-checkpoint-doctor-test")
	if err := os.MkdirAll(overlay, 0o700); err != nil {
		t.Fatal(err)
	}
	old := timeHoursAgo(2)
	if err := os.Chtimes(overlay, old, old); err != nil {
		t.Fatal(err)
	}

	out, errOut := captureBoth(t, func() {
		_ = run([]string{"doctor", "--fix", "--yes"})
	})
	// The exit code is not asserted here: the plan also includes temp overlays
	// under the SHARED system temp directory, where leftovers from other test
	// runs are correctly refused (too young to delete), and any refusal now
	// exits HealthFailure. This test owns the rebuild and the overlay deletion,
	// both asserted directly below; the exit-code contract lives in
	// doctor_exit_test.go with its own forced refusal.
	if !strings.Contains(out, "rebuilt derived caches") {
		t.Fatalf("--fix did not rebuild caches (stdout=%q stderr=%q)", out, errOut)
	}
	if _, err := os.Stat(overlay); !os.IsNotExist(err) {
		t.Fatalf("stale overlay survived --fix --yes: %v (stdout=%q)", err, out)
	}
	if !strings.Contains(out, "deleted temp overlay") {
		t.Fatalf("--fix did not report the deletion: %q", out)
	}
}

// TestDoctorPlainReportUnchanged guards against --fix changing the read-only
// report: `doctor` and `doctor --json` must be exactly what they were, and
// `--fix` must not add, drop or reorder a finding.
//
// It pins the finding SET rather than asserting a non-empty status, which is
// what it used to do: `report.Status != ""` passes for any report, so it could
// not have caught a finding appearing or disappearing. The permission check is
// in the expected set because the diagnosis gained it deliberately; a new
// finding that nobody meant to add fails here.
func TestDoctorPlainReportUnchanged(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	findingsOf := func(args ...string) []string {
		t.Helper()
		globals.JSON = true
		exit := -1
		out, errOut := captureBoth(t, func() { exit = run(args) })
		if exit != int(anyerr.Success) {
			t.Fatalf("%v exited %d (stderr=%q)", args, exit, errOut)
		}
		var report doctor.InstallationReport
		if err := json.Unmarshal([]byte(out), &report); err != nil {
			t.Fatalf("%v is not one JSON value: %v (%.200q)", args, err, out)
		}
		if report.Status == "" {
			t.Fatalf("%v carries no status: %.200q", args, out)
		}
		got := make([]string, 0, len(report.Findings))
		for _, f := range report.Findings {
			got = append(got, f.Check)
		}
		return got
	}

	wantFindings := []string{"proxy-environment", "database"}
	if runtime.GOOS != "windows" {
		wantFindings = append(wantFindings, "permissions")
	}
	want := strings.Join(wantFindings, ",")
	if got := strings.Join(findingsOf("doctor"), ","); got != want {
		t.Fatalf("doctor findings = %q, want %q: the read-only report changed", got, want)
	}

	// A dry run prints the PLAN, not the report, so its JSON is the dry-run
	// envelope. Pin that shape: `--json` must stay one machine-readable value
	// on this path too (AGENTS.md invariant 7), and the plan must name actions
	// without claiming any were applied.
	globals.JSON = true
	exit := -1
	out, errOut := captureBoth(t, func() { exit = run([]string{"doctor", "--fix", "--dry-run"}) })
	if exit != int(anyerr.Success) {
		t.Fatalf("doctor --fix --dry-run exited %d (stderr=%q)", exit, errOut)
	}
	var dry struct {
		DryRun  bool `json:"dryRun"`
		Planned []struct {
			Kind string `json:"kind"`
		} `json:"planned"`
	}
	if err := json.Unmarshal([]byte(out), &dry); err != nil {
		t.Fatalf("doctor --fix --dry-run is not one JSON value: %v (%.200q)", err, out)
	}
	if !dry.DryRun {
		t.Fatalf("dry run did not report dryRun=true: %.200q", out)
	}
	for _, p := range dry.Planned {
		if p.Kind == "" {
			t.Fatalf("a planned action carries no kind: %.200q", out)
		}
	}
}

// TestRebuildCachesClearsSQLiteViaCLI exercises the Go-only shape: --fix must
// clear model_catalog_cache rows, never write a <root>/cache marker file.
func TestRebuildCachesClearsSQLiteViaCLI(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := &modelcache.Store{DB: a.DB}
	if werr := store.Write(ctx, &modelcache.Entry{
		Provider: "grok", Endpoint: "https://example.invalid",
		Models: []string{"m"}, FetchedAt: "2026-01-01T00:00:00.000Z",
	}); werr != nil {
		closeFn()
		t.Fatal(werr)
	}
	root := a.Root
	closeFn()

	stdout, stderr := captureBoth(t, func() {
		_ = run([]string{"doctor", "--fix", "--yes"})
	})
	if !strings.Contains(stdout, "rebuilt derived caches") {
		t.Fatalf("--fix did not rebuild caches (stdout=%q stderr=%q)", stdout, stderr)
	}
	// The exit code is deliberately not asserted: the plan also includes
	// delete_temp_overlay actions against the SHARED system temp directory,
	// where leftovers from other runs are correctly refused (too young), and
	// any refusal now exits HealthFailure. This test owns the rebuild outcome,
	// asserted below; the exit-code contract lives in doctor_exit_test.go.

	reopened, closeFn2, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn2()
	models, merr := (&modelcache.Store{DB: reopened.DB}).ModelsForProvider(ctx, "grok")
	if merr != nil {
		t.Fatal(merr)
	}
	if len(models) != 0 {
		t.Fatalf("--fix left cache rows behind: %v", models)
	}
	if _, serr := os.Stat(filepath.Join(root, "cache")); !os.IsNotExist(serr) {
		t.Fatalf("--fix wrote a cache directory; the Go cache is SQLite")
	}
}

// TestDoctorFixDepsWiresEveryCollaborator keeps the CLI wiring honest: a field
// left nil silently turns a repair into a refusal, which is a worse failure
// than a compile error because it looks like "nothing to fix".
func TestDoctorFixDepsWiresEveryCollaborator(t *testing.T) {
	isolateEnv(t)
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	deps := doctorFixDeps(context.Background(), a)
	if deps.Root == "" || deps.Store == nil || deps.Binding == nil || deps.Proxy == nil {
		t.Fatalf("doctor fix deps are incomplete: %+v", deps)
	}
	if deps.Journal == nil || deps.Recovery == nil || deps.Leases == nil {
		t.Fatalf("doctor fix deps are incomplete: %+v", deps)
	}
	if len(deps.Providers) == 0 {
		t.Fatal("doctor fix deps carry no providers to rebuild caches for")
	}
}

func timeHoursAgo(hours int) time.Time {
	return time.Now().Add(-time.Duration(hours) * time.Hour)
}
