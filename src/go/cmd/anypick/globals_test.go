package main

// Global-flag matrix regressions (M8): flags are recorded wherever they
// appear before the command, --dry-run plans without persisting, and secret
// redaction follows maskSecret unless --reveal.

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/bindings"
)

func resetGlobals() func() {
	old := globals
	return func() { globals = old; globalJSON = old.JSON }
}

// openAppBindingForTest reads the global binding for a client from the
// isolated ANYPICK_HOME.
func openAppBindingForTest(t *testing.T, clientID string) (*bindings.Global, error) {
	a, closeFn, err := appReadyForTest()
	if err != nil {
		return nil, err
	}
	defer closeFn()
	return a.BindingSvc.GetGlobalContext(context.Background(), clientID)
}

// captureStdout redirects os.Stdout for the duration of fn.
//
// The pipe is drained by a goroutine started before fn runs. Reading it only
// afterwards deadlocks once the command writes more than the pipe buffer holds.
// See captureBoth in help_parity_test.go for the full account.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(&buf, r)
	}()

	saved := os.Stdout
	os.Stdout = w
	fn()
	os.Stdout = saved
	_ = w.Close()
	<-done
	_ = r.Close()
	return buf.String()
}

func TestGlobalFlagMatrixRecorded(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	args := extractGlobals([]string{
		"--json", "--dry-run", "--no-input", "--yes", "--quiet",
		"--verbose", "--trace", "--reveal", "--tray", "providers",
	})
	if len(args) != 1 || args[0] != "providers" {
		t.Fatalf("command args lost: %v", args)
	}
	if !globals.JSON || !globals.DryRun || !globals.NoInput || !globals.Yes ||
		!globals.Quiet || !globals.Verbose || !globals.Trace || !globals.Reveal || !globals.Tray {
		t.Fatalf("flags not all recorded: %+v", globals)
	}
	if !globalJSON {
		t.Fatal("globalJSON alias not set")
	}
}

func TestMergedEnvironmentReplacesInheritedKeys(t *testing.T) {
	got := mergedEnvironment(
		[]string{"PATH=/bin", "CODEX_HOME=/live", "ANYPICK_PROXY_API_KEY=old", "MALFORMED"},
		map[string]string{
			"CODEX_HOME":            "/isolated/.codex",
			"ANYPICK_PROXY_API_KEY": "new",
			"HOME":                  "/isolated/home",
		},
	)
	joined := strings.Join(got, "\n")
	for _, want := range []string{
		"CODEX_HOME=/isolated/.codex",
		"ANYPICK_PROXY_API_KEY=new",
		"HOME=/isolated/home",
		"PATH=/bin",
		"MALFORMED",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("merged environment missing %q: %v", want, got)
		}
	}
	for _, key := range []string{"CODEX_HOME", "ANYPICK_PROXY_API_KEY", "HOME"} {
		count := 0
		for _, entry := range got {
			if strings.HasPrefix(entry, key+"=") {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s appears %d times: %v", key, count, got)
		}
	}
}

func TestUseDryRunPlansWithoutPersisting(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	globals.DryRun = true

	// Seed a gateway so the plan resolves a real source.
	t.Setenv("ANYPICK_SECRET", "sk-dry-run-secret-12345")
	if code := run([]string{"gateway", "add", "drygw", "--provider", "openrouter"}); code != 0 {
		t.Fatalf("gateway seed exited %d", code)
	}
	globals.DryRun = true // add may have consumed nothing; keep explicit

	if code := run([]string{"use", "claude", "--with", "gateway/drygw"}); code != 0 {
		t.Fatalf("use --dry-run exited %d", code)
	}

	// The global binding must NOT exist: dry runs write nothing.
	binding, gerr := openAppBindingForTest(t, "claude")
	if gerr != nil {
		t.Fatal(gerr)
	}
	if binding != nil {
		t.Fatalf("dry run persisted a binding: %+v", binding)
	}
}

func TestGatewayShowRedactsUnlessRevealed(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	t.Setenv("ANYPICK_SECRET", "sk-live-key-abcdef1234567890")
	if code := run([]string{"gateway", "add", "redactgw", "--provider", "openrouter"}); code != 0 {
		t.Fatalf("gateway seed exited %d", code)
	}

	// Default: masked.
	out := captureStdout(t, func() {
		if code := run([]string{"gateway", "show", "redactgw"}); code != 0 {
			t.Fatalf("show exited %d", code)
		}
	})
	if strings.Contains(out, "sk-live-key") {
		t.Fatalf("secret leaked in default show: %s", out)
	}
	if !strings.Contains(out, "…") {
		t.Fatalf("expected masked key formatting: %s", out)
	}

	// --reveal shows the real value.
	globals.Reveal = true
	out = captureStdout(t, func() {
		if code := run([]string{"--reveal", "gateway", "show", "redactgw"}); code != 0 {
			t.Fatalf("revealed show exited %d", code)
		}
	})
	if !strings.Contains(out, "sk-live-key-abcdef1234567890") {
		t.Fatalf("--reveal did not reveal: %s", out)
	}
	globals.Reveal = false
}

func TestGatewayShowPreservesCatalogCollidingName(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	t.Setenv("ANYPICK_LANG", "vi")
	t.Setenv("ANYPICK_SECRET", "sk-test-gateway-secret")

	var code int
	captureBoth(t, func() {
		code = run([]string{"gateway", "add", "apps", "--provider", "openrouter", "--model", "apps"})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("gateway add exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}

	stdout, stderr := captureBoth(t, func() {
		code = run([]string{"gateway", "show", "apps"})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("gateway show exited %d (stdout=%q stderr=%q)", code, stdout, stderr)
	}
	if !strings.HasPrefix(stdout, "apps\n") {
		t.Fatalf("gateway name was translated or omitted: %q", stdout)
	}
	for _, args := range [][]string{
		{"__complete", "gateways"},
		{"models", "claude", "--with", "gateway/apps"},
	} {
		stdout, stderr := captureBoth(t, func() { code = run(args) })
		if code != int(anyerr.Success) || !strings.Contains("\n"+stdout, "\napps\n") || strings.Contains(stdout, "ứng dụng") {
			t.Fatalf("%v changed raw identifiers: exit=%d stdout=%q stderr=%q", args, code, stdout, stderr)
		}
	}
}

func TestFollowedLogsPreserveScreenedContentAcrossLocales(t *testing.T) {
	t.Setenv("ANYPICK_LANG", "vi")
	logPath := filepath.Join(t.TempDir(), "proxy.log")
	if err := os.WriteFile(logPath, []byte("apps\nfixture-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout := captureStdout(t, func() {
		followFile(logPath, func(chunk string) string {
			// End the follow loop after its first chunk without a timing race.
			if err := os.Remove(logPath); err != nil {
				t.Error(err)
			}
			return strings.ReplaceAll(chunk, "fixture-secret", "[redacted]")
		})
	})
	if stdout != "apps\n[redacted]\n" {
		t.Fatalf("follow changed screened log content: %q", stdout)
	}
}

func TestMaskSecretMasking(t *testing.T) {
	if got := maskSecret(""); got != "(empty)" {
		t.Fatalf("empty: %q", got)
	}
	if got := maskSecret("short"); got != "••••••••" {
		t.Fatalf("short: %q", got)
	}
	if got := maskSecret("12345678"); got != "••••••••" {
		t.Fatalf("8 chars: %q", got)
	}
	if got := maskSecret("123456789"); got != "1234…6789" {
		t.Fatalf("long: %q", got)
	}
}

func TestTrayDryRunDoesNotSpawn(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	globals.DryRun = true
	if code := run([]string{"start"}); code != 0 {
		t.Fatalf("start dry-run exited %d", code)
	}
	dir := supervisorRuntimeDir(os.Getenv("ANYPICK_HOME"))
	if _, err := os.Stat(filepath.Join(dir, "service.pid")); !os.IsNotExist(err) {
		t.Fatalf("dry run spawned a supervisor: %v", err)
	}
	if code := run([]string{"stop"}); code != 0 {
		t.Fatalf("stop dry-run exited %d", code)
	}
}

func TestGlobalFlagsAfterSubcommand(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()

	// Seed a gateway, then place the global flag AFTER the command — the
	// documented contract is "before or after the subcommand".
	t.Setenv("ANYPICK_SECRET", "sk-after-sub-12345678")
	if code := run([]string{"gateway", "add", "aftergw", "--provider", "openrouter"}); code != 0 {
		t.Fatalf("gateway seed exited %d", code)
	}
	if code := run([]string{"use", "claude", "--with", "gateway/aftergw", "--dry-run"}); code != 0 {
		t.Fatalf("use … --dry-run exited %d (flag must be recognized after the subcommand)", code)
	}
	if !globals.DryRun {
		t.Fatal("--dry-run not recorded from trailing position")
	}
	binding, gerr := openAppBindingForTest(t, "claude")
	if gerr != nil {
		t.Fatal(gerr)
	}
	if binding != nil {
		t.Fatalf("dry run persisted a binding: %+v", binding)
	}
}

func TestNormalizeGlobalFlagsPreservesPassThrough(t *testing.T) {
	defer resetGlobals()()
	got := normalizeGlobalFlags([]string{
		"run", "--with", "grok/work", "--dry-run", "--", "claude", "--dry-run", "--verbose",
	})
	want := []string{"run", "--with", "grok/work", "--", "claude", "--dry-run", "--verbose"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("token %d: got %q want %q\nall: %v", i, got[i], want[i], got)
		}
	}
	if !globals.DryRun {
		t.Fatalf("flags before -- must be recorded: %+v", globals)
	}
	if globals.Verbose {
		t.Fatal("--verbose after -- must stay pass-through, not be recorded")
	}
}

func TestBareInvocationHonoursConfiguredSurface(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()

	// Default (unconfigured): explicit CLI-help policy.
	out := captureStdout(t, func() {
		if code := run(nil); code != 0 {
			t.Fatalf("bare default exited %d", code)
		}
	})
	if !strings.Contains(out, "Usage:") {
		t.Fatalf("default bare invocation should print help, got: %.200q", out)
	}

	// Persisted tui surface: honour it by actually opening the Go TUI. Under a
	// test there is no TTY, so it must fail closed with the usage exit code
	// (invariant #6) rather than print help and exit 0. The exit code is the
	// assertion: 2 proves the configured surface reached runTuiSurface.
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	if _, serr := a.Config.SetLaunchSurface(context.Background(), "tui"); serr != nil {
		t.Fatal(serr)
	}
	// A legacy lease (no instance id, no endpoint) is reaped from the PID
	// alone. This pid is not alive. Bare `anypick` with the terminal surface
	// and no TTY must leave the row in place.
	if _, err := a.DB.ExecContext(context.Background(), `
		INSERT INTO proxy_leases (
			lease_id, provider, account, port, host, owner_pid,
			binding_refs_json, created_at, updated_at)
		VALUES ('lease-canary', 'deepseek', 'ds', 9, '127.0.0.1', 2147483646,
			'[]', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`); err != nil {
		t.Fatal(err)
	}
	closeFn()

	// Make the precondition explicit instead of relying on it. `go test`
	// inherits the caller's standard input, so running this suite from an
	// interactive terminal hands runTuiSurface a real TTY and bubbletea then
	// blocks waiting for keystrokes until the test binary times out.
	devNull, derr := os.Open(os.DevNull)
	if derr != nil {
		t.Fatal(derr)
	}
	defer devNull.Close()
	realStdin := os.Stdin
	os.Stdin = devNull
	defer func() { os.Stdin = realStdin }()

	var tuiCode int
	captureStdout(t, func() {
		tuiCode = run(nil)
	})
	if tuiCode != int(anyerr.InvalidUsage) {
		t.Fatalf("bare tui-surface exited %d, want %d (no TTY must fail closed)",
			tuiCode, anyerr.InvalidUsage)
	}
	// Probe with maintenance off. A normal Ready would reap the canary and
	// hide the fact that the bare invocation already did.
	probe, probeClose, err := app.Ready(context.Background(), app.Options{
		SkipMigrate: true, SkipMaintenance: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var leases int
	if err := probe.DB.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM proxy_leases WHERE lease_id = ?`, "lease-canary").Scan(&leases); err != nil {
		probeClose()
		t.Fatal(err)
	}
	probeClose()
	if leases != 1 {
		t.Fatalf("bare tui without a TTY reaped lease-canary, count %d", leases)
	}

	// Persisted tray surface resolves for dispatch (the app run itself needs
	// a native host; the policy under test is the config read).
	a2, close2, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	if _, serr := a2.Config.SetLaunchSurface(context.Background(), "tray"); serr != nil {
		t.Fatal(serr)
	}
	close2()
	a3, close3, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer close3()
	if got := configuredLaunchSurface(context.Background(), a3); got != "tray" {
		t.Fatalf("configured surface = %q, want tray", got)
	}
}
