package main

// End-to-end regressions for the P1 fixes: global flags before the command,
// supervisor lifecycle commands, pool enable/disable semantics, and
// project-scoped link/unlink.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/ownership"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/transfer"
)

func appReadyForTest() (*app.App, func(), error) {
	return app.Ready(context.Background(), app.Options{SkipMigrate: true})
}

func TestAccountBackupCLIExportImportRoundTrip(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	seedRootForParity(t)

	source, closeSource, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	sourceAccount, err := source.Accounts.Get(context.Background(), "deepseek", "ds")
	if err != nil {
		closeSource()
		t.Fatal(err)
	}
	if sourceAccount == nil {
		closeSource()
		t.Fatal("seed account is missing")
	}
	expectedFiles := transfer.CollectSnapshotFiles(sourceAccount.SnapshotDir)
	closeSource()
	if len(expectedFiles) == 0 {
		t.Fatal("seed account has no snapshot files to round-trip")
	}

	backupPath := filepath.Join(t.TempDir(), "roundtrip.json")
	clearGlobalsForParity()
	code := -1
	captureBoth(t, func() {
		code = run([]string{"account", "export", "--all", "--out", backupPath})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("account export exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	if _, err := os.Stat(backupPath); err != nil {
		t.Fatalf("backup file was not created: %v", err)
	}

	destRoot := t.TempDir()
	destHome := filepath.Join(destRoot, "home")
	if err := os.MkdirAll(destHome, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", destHome)
	t.Setenv("USERPROFILE", destHome)
	t.Setenv("APPDATA", filepath.Join(destHome, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(destHome, "AppData", "Local"))
	t.Setenv("ANYPICK_HOME", filepath.Join(destRoot, "data"))
	t.Setenv("CODEX_HOME", "")
	clearGlobalsForParity()
	captureBoth(t, func() { code = run([]string{"account", "import", backupPath}) })
	if code != int(anyerr.Success) {
		t.Fatalf("account import exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}

	dest, closeDest, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeDest()
	imported, err := dest.Accounts.Get(context.Background(), "deepseek", "ds")
	if err != nil {
		t.Fatal(err)
	}
	if imported == nil {
		t.Fatal("account is missing after CLI backup import")
	}
	if got := transfer.CollectSnapshotFiles(imported.SnapshotDir); !reflect.DeepEqual(got, expectedFiles) {
		t.Fatalf("imported snapshot differs from exported snapshot: got %d file(s), want %d", len(got), len(expectedFiles))
	}
}

func TestAccountBackupCannotUseSingleAccountImportForm(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	seedRootForParity(t)

	backupPath := filepath.Join(t.TempDir(), "accounts.json")
	code := -1
	captureBoth(t, func() {
		code = run([]string{"account", "export", "--all", "--out", backupPath})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("could not prepare backup: exit=%d stderr=%q", code, lastStderr)
	}
	clearGlobalsForParity()
	home, data := os.Getenv("HOME"), os.Getenv("ANYPICK_HOME")
	before := treeDigest(t, home, data)
	captureBoth(t, func() {
		code = run([]string{"account", "import", "deepseek", "renamed", backupPath, "--force"})
	})
	if code != int(anyerr.InvalidUsage) {
		t.Fatalf("single-account backup import exited %d, want invalid usage (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}
	if after := treeDigest(t, home, data); after != before {
		t.Fatal("rejected single-account backup import mutated local state")
	}
}

func TestAccountExportDefaultPathCanonicalizesAccountName(t *testing.T) {
	base := isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	seedRootForParity(t)

	code := -1
	captureBoth(t, func() {
		code = run([]string{"account", "export", "deepseek", "../../../../ds"})
	})
	if code != int(anyerr.Success) {
		t.Fatalf("account export exited %d (stdout=%q stderr=%q)", code, lastStdout, lastStderr)
	}

	exportsDir := filepath.Join(os.Getenv("ANYPICK_HOME"), "exports")
	want := filepath.Join(exportsDir, "anypick-deepseek-ds.json")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("canonical export was not written inside exports: %v", err)
	}
	if rel, err := filepath.Rel(exportsDir, want); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		t.Fatalf("default export path escaped exports: %q (rel %q, err %v)", want, rel, err)
	}
	if _, err := os.Stat(filepath.Join(base, "ds.json")); err == nil {
		t.Fatal("traversal alias wrote an export outside the data root")
	}
}

// leakedChildren reports detached children whose ownership records live under
// this test's isolated AnyPick data root. It works on Windows too, where pgrep
// is unavailable, and verifies each recorded process identity before calling
// it a leak.
func leakedChildren(t *testing.T) []string {
	t.Helper()
	return liveOwnedRecords(t, "detached child scan")
}

// liveOwnedRecords lists detached-child ownership records under ANYPICK_HOME
// that still verify against a live process. Record-based, so it needs no
// external binary and names the exact child that outlived its stop (ADR 0003).
func liveOwnedRecords(t *testing.T, phase string) []string {
	t.Helper()
	root := os.Getenv("ANYPICK_HOME")
	if root == "" {
		return nil
	}
	found, err := scanLiveOwnedRecords(filepath.Join(root, "runtime"))
	if err != nil {
		t.Fatalf("%s: inspect detached child ownership records: %v", phase, err)
	}
	if len(found) > 0 {
		t.Logf("%s: %d live ownership record(s) remain: %v", phase, len(found), found)
	}
	return found
}

func scanLiveOwnedRecords(runtimeRoot string) ([]string, error) {
	info, err := os.Lstat(runtimeRoot)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("stat runtime directory %s: %w", runtimeRoot, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("runtime path %s is not a directory", runtimeRoot)
	}
	var found []string
	err = filepath.WalkDir(runtimeRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return fmt.Errorf("walk %s: %w", path, walkErr)
		}
		if d.IsDir() || d.Name() != "service.pid" {
			return nil
		}
		rec, inspectErr := ownership.Inspect(path)
		if os.IsNotExist(inspectErr) {
			return nil
		}
		if inspectErr != nil {
			return fmt.Errorf("inspect ownership record %s: %w", path, inspectErr)
		}
		if rec != nil && rec.VerifyLive() {
			found = append(found, path+" pid="+strconv.Itoa(rec.PID))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return found, nil
}

func TestScanLiveOwnedRecordsReportsMalformedRecord(t *testing.T) {
	runtimeRoot := filepath.Join(t.TempDir(), "runtime")
	recordPath := filepath.Join(runtimeRoot, "proxy", "service.pid")
	if err := os.MkdirAll(filepath.Dir(recordPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(recordPath, []byte("not a record"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := scanLiveOwnedRecords(runtimeRoot); err == nil || !strings.Contains(err.Error(), recordPath) {
		t.Fatalf("scanLiveOwnedRecords error = %v, want malformed record path %q", err, recordPath)
	}
}

// waitBudget is the single upper bound for every "wait for it to happen" and
// "prove it did not block" poll in this package.
//
// These tests spawn real detached children and shells out to `go build`, then
// wait for a /health endpoint or for a process to exit. On a loaded machine —
// `make test` runs ~36 packages in parallel, and this package builds the CLI
// inside the test — the old 3-8 second deadlines were not wrong, just tight:
// a slow child looked exactly like a dead one, and the failure named the test
// rather than the timing.
//
// 30s does not weaken the assertions that matter. In dryrun_gate_test the lock
// holder is released by a defer AFTER the assertions, so an operation that
// really does block waits for that release; it cannot pass inside any budget
// the test would still be waiting on.
const waitBudget = 30 * time.Second

// assertNoLeakedChildren waits briefly for a verified stop to take effect, then
// fails with the pids that survived — so a leak always names its own test.
func assertNoLeakedChildren(t *testing.T, phase string) {
	t.Helper()
	deadline := time.Now().Add(waitBudget)
	for {
		pids := leakedChildren(t)
		if len(pids) == 0 {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("leaked %d detached child(ren) after %s: pids %v under temp root %s; live records: %v",
				len(pids), phase, pids, t.TempDir(), liveOwnedRecords(t, phase))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// isolateEnv points home, app-data and AnyPick paths at a sandbox for one test.
func isolateEnv(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	home := filepath.Join(base, "home")
	t.Setenv("HOME", home)
	// On Windows, os.UserHomeDir and app-data lookups ignore HOME.
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("ANYPICK_HOME", filepath.Join(base, "data"))
	// codexHomePath follows CODEX_HOME and ignores the sandboxed HOME.
	t.Setenv("CODEX_HOME", "")
	if err := os.MkdirAll(filepath.Join(base, "home"), 0o700); err != nil {
		t.Fatal(err)
	}
	return base
}

func TestRootGlobalFlagsBeforeCommand(t *testing.T) {
	isolateEnv(t)
	globalJSON = false
	defer func() { globalJSON = false }()
	if code := run([]string{"--json", "providers"}); code != 0 {
		t.Fatalf("--json providers exited %d", code)
	}
}

// TestTuiWithoutTTYRefusesBeforeTouchingServices is the regression for the
// TTY guard's position.
//
// app.Ready's startup maintenance runs RecoverIncompleteOperations — which
// compensates half-applied activation steps, i.e. it rewrites real credential
// files — and reaps detached proxy leases. Under cron or CI,
// `anypick tui < /dev/null` must be refused before any of that, not after
// (AGENTS.md: "The TTY guard runs before any service is touched"). Placing the
// guard inside tui.Run left a scheduled job able to destroy backups and kill
// the proxies the desktop app was using.
func TestTuiWithoutTTYRefusesBeforeTouchingServices(t *testing.T) {
	base := isolateEnv(t)
	// isolateEnv creates only "home", so ANYPICK_HOME must not exist yet.
	dataRoot := filepath.Join(base, "data")

	// Redirect stdin away from a terminal, the way cron and CI invoke it.
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	origStdin := os.Stdin
	os.Stdin = devNull
	defer func() { os.Stdin = origStdin }()

	code := -1
	captureBoth(t, func() { code = run([]string{"tui"}) })

	if code != int(anyerr.InvalidUsage) {
		t.Fatalf("exit = %d, want InvalidUsage (%d)", code, anyerr.InvalidUsage)
	}
	// The regression: refusing must precede app.Ready. Move the guard back
	// after app.Ready and the data root gets created, so this fails.
	if _, err := os.Stat(dataRoot); err == nil {
		t.Fatalf("data root %s exists — services were touched before the TTY guard", dataRoot)
	}
}

func TestVersionFlag(t *testing.T) {
	base := isolateEnv(t)
	if code := run([]string{"--version"}); code != 0 {
		t.Fatalf("--version exited %d", code)
	}
	if code := run([]string{"--help"}); code != 0 {
		t.Fatalf("--help exited %d", code)
	}
	if code := run([]string{"--quiet", "help"}); code != 0 {
		t.Fatalf("--quiet help exited %d", code)
	}
	if _, err := os.Stat(filepath.Join(base, "data")); !os.IsNotExist(err) {
		t.Fatalf("identity/help path created the data root: %v", err)
	}
}

func TestSupervisorStatusStop(t *testing.T) {
	isolateEnv(t)
	if code := run([]string{"status"}); code != 0 {
		t.Fatalf("status exited %d", code)
	}
	if code := run([]string{"stop"}); code != 0 {
		t.Fatalf("stop exited %d", code)
	}
}

// TestTrayStatusRoutesToSupervisorStatus pins the fix: `tray status` must
// print the supervisor status line and never fall through into cmdAppRun's
// desktop snapshot protocol on stdout.
func TestTrayStatusRoutesToSupervisorStatus(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()
	var out string
	exit := -1
	out, _ = captureBoth(t, func() { exit = run([]string{"tray", "status"}) })
	if exit != int(anyerr.Success) {
		t.Fatalf("tray status exited %d, want success", exit)
	}
	if strings.TrimSpace(out) != "not running" {
		t.Fatalf("tray status must print the supervisor status line, got %q", out)
	}
}

func TestPoolDisableActuallyDisables(t *testing.T) {
	isolateEnv(t)
	if code := run([]string{"proxy", "pool", "enable", "deepseek", "--strategy", "round-robin"}); code != 0 {
		t.Fatalf("pool enable exited %d", code)
	}
	pool, err := openPoolForTest(t)
	if err != nil || pool == nil || !pool.Enabled {
		t.Fatalf("pool should be enabled: %+v err=%v", pool, err)
	}
	if pool.Strategy != "round-robin" {
		t.Fatalf("strategy was dropped: %q", pool.Strategy)
	}
	if code := run([]string{"proxy", "pool", "disable", "deepseek"}); code != 0 {
		t.Fatalf("pool disable exited %d", code)
	}
	pool, err = openPoolForTest(t)
	if err != nil {
		t.Fatal(err)
	}
	if pool != nil && pool.Enabled {
		t.Fatalf("pool disable left the pool enabled: %+v", pool)
	}
}

func TestLinkUnlinkAreProjectScoped(t *testing.T) {
	isolateEnv(t)
	// A gateway gives link a resolvable non-account source.
	t.Setenv("ANYPICK_SECRET", "sk-test")
	if code := run([]string{"gateway", "add", "or", "--provider", "openrouter"}); code != 0 {
		t.Fatalf("gateway add exited %d", code)
	}
	if code := run([]string{"link", "claude", "--with", "or"}); code != 0 {
		t.Fatalf("link exited %d", code)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	global, gerr := a.BindingSvc.GetGlobalContext(context.Background(), "claude")
	if gerr != nil {
		t.Fatal(gerr)
	}
	if global != nil {
		t.Fatalf("link must not write a global binding: %+v", global)
	}
	cwd, _ := os.Getwd()
	project, perr := a.BindingSvc.GetProjectContext(context.Background(), cwd, "claude")
	if perr != nil || project == nil {
		t.Fatalf("project binding missing: %+v err=%v", project, perr)
	}

	// Unlink removes the PROJECT binding only.
	if code := run([]string{"unlink", "claude"}); code != 0 {
		t.Fatalf("unlink exited %d", code)
	}
	project, _ = a.BindingSvc.GetProjectContext(context.Background(), cwd, "claude")
	if project != nil {
		t.Fatalf("unlink left the project binding: %+v", project)
	}
}

var _ = pools.Pool{}

func openPoolForTest(t *testing.T) (*pools.Pool, error) {
	t.Helper()
	a, closeFn, err := appReadyForTest()
	if err != nil {
		return nil, err
	}
	defer closeFn()
	return a.PoolSvc.GetContext(context.Background(), "deepseek")
}

func TestHubActivationEndToEnd(t *testing.T) {
	isolateEnv(t)
	// Detached children must be a real CLI binary, not the test binary.
	requireBuiltCLI(t)
	t.Setenv("ANYPICK_SECRET", "sk-test")
	if code := run([]string{"proxy", "hub", "enable", "test"}); code != 0 {
		t.Fatalf("hub enable exited %d", code)
	}
	if code := run([]string{"add", "deepseek", "--name", "ds", "--kind", "api-key", "--secret", "sk-ds"}); code != 0 {
		t.Fatalf("add exited %d", code)
	}
	if code := run([]string{"proxy", "hub", "source", "test", "deepseek", "ds"}); code != 0 {
		t.Fatalf("hub source exited %d", code)
	}
	if code := run([]string{"use", "claude", "--with", "hub:test"}); code != 0 {
		t.Fatalf("hub activation exited %d — planner/executor must accept enabled hubs", code)
	}
	// The hub child must be serving the planned endpoint.
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	cfg, gerr := a.Hub.GetConfig("test")
	if gerr != nil || cfg == nil || cfg.Port == 0 {
		t.Fatalf("hub config missing port: %+v err=%v", cfg, gerr)
	}
	closeFn()
	if !waitHTTP(t, fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port)) {
		t.Fatal("hub child never became healthy")
	}
	stopDetached(hubPIDPath(os.Getenv("ANYPICK_HOME"), "test"))
}

// Pool activation e2e (NATIVE-M1): fixture accounts → pool enable →
// `use claude --with pool:<p>` through the shared port → stop leaves zero
// leaked `_serve-pool` children.
func TestPoolActivationEndToEnd(t *testing.T) {
	isolateEnv(t)
	requireBuiltCLI(t)
	t.Setenv("ANYPICK_SECRET", "sk-test")

	for _, name := range []string{"dsa", "dsb"} {
		if code := run([]string{"add", "deepseek", "--name", name,
			"--kind", "api-key", "--secret", "sk-" + name}); code != 0 {
			t.Fatalf("add %s exited %d", name, code)
		}
	}
	// Deterministic port semantics bind exactly this port (pool.port ??
	// provider default ?? 8080), so pick a free one for hermeticity — a busy
	// planned port must fail loudly, not relocate.
	ln, lerr := net.Listen("tcp", "127.0.0.1:0")
	if lerr != nil {
		t.Fatal(lerr)
	}
	poolPort := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	if code := run([]string{"proxy", "pool", "enable", "deepseek", "dsa", "dsb",
		"--port", strconv.Itoa(poolPort)}); code != 0 {
		t.Fatalf("pool enable exited %d", code)
	}
	if code := run([]string{"use", "claude", "--with", "pool:deepseek"}); code != 0 {
		t.Fatalf("pool activation exited %d — executor must start the shared pool transport", code)
	}

	// The detached child must be serving the planned endpoint under the
	// primary member's proxy_state record.
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	state, serr := a.Store.ReadProxyState(context.Background(), "deepseek", "dsa")
	closeFn()
	if serr != nil || state == nil || state.Endpoint == "" || state.Token == "" {
		t.Fatalf("primary pool state missing: %+v err=%v", state, serr)
	}
	if !waitHTTP(t, state.Endpoint+"/health") {
		t.Fatal("pool child never became healthy")
	}

	// Plan/actual port parity: the client config the activation wrote must
	// point at exactly the served endpoint (no plan-vs-bind divergence).
	rawSettings, rerr := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".claude", "settings.json"))
	if rerr != nil {
		t.Fatalf("claude settings.json missing: %v", rerr)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(rawSettings, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Env["ANTHROPIC_BASE_URL"] != state.Endpoint {
		t.Fatalf("client config endpoint = %q, want served endpoint %q",
			settings.Env["ANTHROPIC_BASE_URL"], state.Endpoint)
	}
	// Credentialed routes are gated even without any reachable upstream:
	// a missing bearer must be rejected by the pool itself, never forwarded.
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Post(state.Endpoint+"/v1/chat/completions",
		"application/json", strings.NewReader(`{"model":"m"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated pool request = %d, want 401", resp.StatusCode)
	}

	// Stop via the CLI: the Service verifies ownership via the /health instance
	// echo before signalling; nothing may leak.
	if code := run([]string{"proxy", "pool", "stop", "deepseek"}); code != 0 {
		t.Fatalf("pool stop exited %d", code)
	}
	deadline := time.Now().Add(waitBudget)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, state.Endpoint+"/health", nil)
		resp, err := client.Do(req)
		if err != nil {
			break
		}
		_ = resp.Body.Close()
		time.Sleep(100 * time.Millisecond)
	}
	assertNoLeakedChildren(t, "pool stop")

	// A verified stop releases the (provider, "") pool lease — the lease
	// store must be empty.
	a2, closeFn2, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	leases, lerr := a2.Proxy.ListPoolLeasesContext(context.Background(), "deepseek")
	closeFn2()
	if lerr != nil || len(leases) != 0 {
		t.Fatalf("pool leases survived verified stop: %+v err=%v", leases, lerr)
	}
}

// Stopping a pool that was never configured must report failure (nonzero),
// never print a false success — the old stopDetached-discard path did.
func TestPoolStopReportsFailureForUnknownPool(t *testing.T) {
	isolateEnv(t)
	requireBuiltCLI(t)
	if code := run([]string{"proxy", "pool", "stop", "nosuch"}); code == 0 {
		t.Fatal("stopping a nonexistent pool must exit nonzero")
	}
}

// thisFileDir returns this test file's package directory without needing a
// *testing.T, so the build helper below can run once outside any single test.
func thisFileDir() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return ""
	}
	return filepath.Dir(file)
}

func waitHTTP(t *testing.T, url string) bool {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(waitBudget)
	start := time.Now()
	var lastErr error
	var lastStatus int
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			lastStatus = resp.StatusCode
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return true
			}
		} else {
			lastErr = err
			lastStatus = 0
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Name the timing, not just the test: a healthy child that was simply slow
	// must not be reported the same way as one that never listened.
	t.Logf("%s never became healthy in %s (last error: %v, last status: %d)",
		url, time.Since(start).Round(time.Millisecond), lastErr, lastStatus)
	return false
}

// The helper binary is built once per test binary, not once per test.
//
// `go build` relinks even when every package is already cached (measured 5s
// per call inside this suite, 11s standalone), and ten call sites paid that
// separately.
// Under `make test` — ~44 packages compiling at once — that made this the
// package that hit the 900s timeout, and it did so at a *different* test each
// run, which reads like a product bug rather than a build-cost one.
var (
	builtCLIOnce sync.Once
	builtCLIPath string
	builtCLIDir  string
	builtCLIErr  error
)

func buildCLI() {
	dir, err := os.MkdirTemp("", "anypick-cli")
	if err != nil {
		builtCLIErr = err
		return
	}
	builtCLIDir = dir
	bin := filepath.Join(dir, "anypick-cli")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/anypick")
	cmd.Dir = filepath.Join(thisFileDir(), "..", "..")
	// Tests replace HOME with a TempDir. The child Go command then places its
	// module cache below that TempDir; writable module directories let cleanup
	// remove the cache when the test finishes.
	goFlags := strings.TrimSpace(os.Getenv("GOFLAGS") + " -modcacherw")
	cmd.Env = os.Environ()
	flagsFound := false
	for i, variable := range cmd.Env {
		if strings.HasPrefix(variable, "GOFLAGS=") {
			cmd.Env[i] = "GOFLAGS=" + goFlags
			flagsFound = true
		}
	}
	if !flagsFound {
		cmd.Env = append(cmd.Env, "GOFLAGS="+goFlags)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		builtCLIErr = fmt.Errorf("build helper binary: %v\n%s", err, out)
		return
	}
	builtCLIPath = bin
}

// requireBuiltCLI returns a real built CLI binary for detached-child spawns.
func requireBuiltCLI(t *testing.T) string {
	t.Helper()
	builtCLIOnce.Do(buildCLI)
	if builtCLIErr != nil {
		t.Fatal(builtCLIErr)
	}
	t.Setenv("ANYPICK_SELF_EXE", builtCLIPath)
	return builtCLIPath
}

// The ten call sites have to keep sharing one binary; a per-test relink is what
// pushed this package past the suite's timeout budget.
func TestRequireBuiltCLIBuildsOnce(t *testing.T) {
	first := requireBuiltCLI(t)
	second := requireBuiltCLI(t)
	if first != second {
		t.Fatalf("CLI rebuilt per call: %q then %q", first, second)
	}
	if _, err := os.Stat(first); err != nil {
		t.Fatalf("helper binary missing at %q: %v", first, err)
	}
}

// TestMain exists only to remove the shared helper binary; without it the
// os.MkdirTemp above would outlive the test run.
func TestMain(m *testing.M) {
	code := m.Run()
	if builtCLIDir != "" {
		_ = os.RemoveAll(builtCLIDir)
	}
	os.Exit(code)
}

func TestSupervisorStartStaysAlive(t *testing.T) {
	isolateEnv(t)
	requireBuiltCLI(t)

	if code := run([]string{"start"}); code != 0 {
		t.Fatalf("start exited %d", code)
	}
	// The bug this regression pins: the detached supervisor used to exit as
	// soon as its stdin hit EOF, so status flipped to "not running".
	time.Sleep(2 * time.Second)
	globalJSON = true
	defer func() { globalJSON = false }()
	if code := run([]string{"status"}); code != 0 {
		t.Fatal("status failed")
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(supervisorRuntimeDir(a.Root), "service.pid")
	pid := readPID(pidFile)
	closeFn()
	if pid == 0 || !processAlive(pid) {
		t.Fatalf("supervisor died after start (pid=%d)", pid)
	}
	if code := run([]string{"stop"}); code != 0 {
		t.Fatal("stop failed")
	}
	deadline := time.Now().Add(waitBudget)
	for time.Now().Before(deadline) && processAlive(pid) {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(pid) {
		t.Fatalf("supervisor survived stop (pid=%d)", pid)
	}
}

func TestLinkWithoutWithPreservesGlobalSpec(t *testing.T) {
	isolateEnv(t)
	requireBuiltCLI(t)
	t.Setenv("ANYPICK_SECRET", "sk-test")
	if code := run([]string{"add", "deepseek", "--name", "ds", "--kind", "api-key", "--secret", "sk-ds"}); code != 0 {
		t.Fatalf("add exited %d", code)
	}
	// Global binding with an explicit model + transport policy.
	if code := run([]string{"use", "claude", "--with", "deepseek/ds", "--model", "preserved-model", "--transport", "proxy"}); code != 0 {
		t.Fatalf("global use exited %d", code)
	}
	// This activation spawns a persistent detached proxy; register cleanup
	// immediately so neither the normal nor the race suite leaks _serve-proxy
	// children (review finding: orphaned processes across runs).
	//
	// proxy stop waits until the child pid has exited, not only until /health
	// stops. The leak assertion checks verified ownership records under this
	// test's isolated AnyPick data root.
	t.Cleanup(func() {
		if code := run([]string{"proxy", "stop", "deepseek", "ds"}); code != 0 {
			t.Errorf("cleanup proxy stop exited %d", code)
		}
		assertNoLeakedChildren(t, "link-without-with proxy teardown")
	})
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	global, gerr := a.BindingSvc.GetGlobalContext(context.Background(), "claude")
	if gerr != nil || global == nil {
		t.Fatalf("global binding missing: %+v %v", global, gerr)
	}
	wantSpec := global.Spec
	wantGlobalUpdatedAt := global.UpdatedAt
	closeFn()

	// Project link WITHOUT --with must reapply the whole spec.
	if code := run([]string{"link", "claude"}); code != 0 {
		t.Fatalf("project link exited %d", code)
	}
	a, closeFn, err = appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()
	cwd, _ := os.Getwd()
	project, perr := a.BindingSvc.GetProjectContext(context.Background(), cwd, "claude")
	if perr != nil || project == nil {
		t.Fatalf("project binding missing: %v", perr)
	}
	if project.Spec.Model.Mode != wantSpec.Model.Mode ||
		project.Spec.Model.ID != wantSpec.Model.ID ||
		project.Spec.TransportPolicy != wantSpec.TransportPolicy ||
		project.Spec.Client != "claude" ||
		fmt.Sprint(project.Spec.Source) != fmt.Sprint(wantSpec.Source) {
		t.Fatalf("spec drifted:\nwant %+v\ngot  %+v", wantSpec, project.Spec)
	}
	// Deep equality: ClientOptions (model roles) and every provenance field
	// must travel with the re-applied spec, not just the model/transport bits.
	if fmt.Sprint(project.Spec.ClientOptions) != fmt.Sprint(wantSpec.ClientOptions) {
		t.Fatalf("clientOptions drifted:\nwant %+v\ngot  %+v", wantSpec.ClientOptions, project.Spec.ClientOptions)
	}
	wantJSON, _ := json.Marshal(wantSpec)
	gotJSON, _ := json.Marshal(project.Spec)
	if string(wantJSON) != string(gotJSON) {
		t.Fatalf("full spec JSON drifted:\nwant %s\ngot  %s", wantJSON, gotJSON)
	}
	if project.Provenance.Kind != "global_binding_snapshot" {
		t.Fatalf("provenance = %q, want global_binding_snapshot", project.Provenance.Kind)
	}
	if project.Provenance.GlobalBindingUpdatedAt == "" {
		t.Fatal("provenance lost globalBindingUpdatedAt")
	}
	if project.Provenance.GlobalBindingUpdatedAt != wantGlobalUpdatedAt {
		t.Fatalf("globalBindingUpdatedAt = %q, want source updatedAt %q",
			project.Provenance.GlobalBindingUpdatedAt, wantGlobalUpdatedAt)
	}
}

func TestHubActivationAdoptsAndStopsChild(t *testing.T) {
	isolateEnv(t)
	bin := requireBuiltCLI(t)
	t.Setenv("ANYPICK_SECRET", "sk-test")
	if code := run([]string{"proxy", "hub", "enable", "test"}); code != 0 {
		t.Fatalf("hub enable exited %d", code)
	}
	if code := run([]string{"add", "deepseek", "--name", "ds", "--kind", "api-key", "--secret", "sk-ds"}); code != 0 {
		t.Fatalf("add exited %d", code)
	}
	if code := run([]string{"proxy", "hub", "source", "test", "deepseek", "ds"}); code != 0 {
		t.Fatalf("hub source exited %d", code)
	}
	if code := run([]string{"use", "claude", "--with", "hub:test"}); code != 0 {
		t.Fatalf("hub activation exited %d", code)
	}
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	cfg, gerr := a.Hub.GetConfig("test")
	if gerr != nil || cfg == nil || cfg.Port == 0 {
		t.Fatalf("hub config missing port: %+v %v", cfg, gerr)
	}
	closeFn()
	if !waitHTTP(t, fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port)) {
		t.Fatal("hub child never became healthy")
	}

	// Pid-file ownership: `proxy hub stop` must stop the child that
	// activation spawned.
	pidFile := hubPIDPath(os.Getenv("ANYPICK_HOME"), "test")
	pid := readPID(pidFile)
	if pid == 0 {
		t.Fatal("activation did not record a hub service.pid")
	}
	if code := run([]string{"proxy", "hub", "stop", "test"}); code != 0 {
		t.Fatalf("hub stop exited %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && processAlive(pid) {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(pid) {
		_ = signalPID(pid)
		t.Fatal("hub child survived proxy hub stop — leaked process")
	}
	_ = bin
}

// homeFilesWithToken walks root and returns every file whose bytes contain the
// given secret (best-effort: unreadable files are skipped).
func homeFilesWithToken(root, token string) []string {
	var hits []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil || info.Size() > 8<<20 {
			return nil
		}
		raw, rerr := os.ReadFile(path)
		if rerr == nil && strings.Contains(string(raw), token) {
			hits = append(hits, path)
		}
		return nil
	})
	return hits
}

// Route lifecycle e2e (NATIVE-M1): enable hub → fixture accounts → `use claude
// --with hub:route` → fresh per-client route token → model-pinned requests hit
// the right source; wrong token 401; detach under the hub scope kills the
// credential; verified stop leaves zero leaked children and clean route rows.
func TestHubRouteLifecycleEndToEnd(t *testing.T) {
	isolateEnv(t)
	requireBuiltCLI(t)
	t.Setenv("ANYPICK_SECRET", "sk-test")
	// Every detached child this test spawns must be gone by the time it ends,
	// not just at the stop assertion below.
	t.Cleanup(func() { assertNoLeakedChildren(t, "hub route lifecycle end") })

	const hubName = "route"
	if code := run([]string{"proxy", "hub", "enable", hubName}); code != 0 {
		t.Fatalf("hub enable exited %d", code)
	}
	for _, name := range []string{"dsa", "dsb"} {
		if code := run([]string{"add", "deepseek", "--name", name,
			"--kind", "api-key", "--secret", "sk-" + name}); code != 0 {
			t.Fatalf("add %s exited %d", name, code)
		}
	}
	if code := run([]string{"proxy", "hub", "source", hubName, "deepseek", "dsa"}); code != 0 {
		t.Fatalf("hub source dsa exited %d", code)
	}
	if code := run([]string{"proxy", "hub", "source", hubName, "deepseek", "dsb"}); code != 0 {
		t.Fatalf("hub source dsb exited %d", code)
	}
	if code := run([]string{"use", "claude", "--with", "hub:" + hubName}); code != 0 {
		t.Fatalf("hub activation exited %d", code)
	}

	readClientEnv := func() (baseURL, token string) {
		raw, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".claude", "settings.json"))
		if err != nil {
			t.Fatalf("claude settings.json missing: %v", err)
		}
		var settings struct {
			Env map[string]string `json:"env"`
		}
		if err := json.Unmarshal(raw, &settings); err != nil {
			t.Fatal(err)
		}
		return settings.Env["ANTHROPIC_BASE_URL"], settings.Env["ANTHROPIC_AUTH_TOKEN"]
	}

	endpoint, token1 := readClientEnv()
	if endpoint == "" || token1 == "" {
		t.Fatalf("activation wrote no hub endpoint/token: %q / %q", endpoint, token1)
	}
	if !waitHTTP(t, endpoint+"/health") {
		t.Fatal("hub child never became healthy")
	}

	// Re-attach rotates the per-client credential.
	if code := run([]string{"use", "claude", "--with", "hub:" + hubName}); code != 0 {
		t.Fatalf("second activation exited %d", code)
	}
	endpoint, token2 := readClientEnv()
	if token2 == "" || token2 == token1 {
		t.Fatalf("re-attach did not rotate the route token: %q vs %q", token1, token2)
	}

	// Secret redaction: the plaintext token may exist ONLY in client config
	// (~/.claude/settings.json and the clients/<id>/env.sh mirror — the same
	// boundary class as any proxy credential). Never anywhere else under
	// ANYPICK_HOME (the DB stores only the HMAC), never CLI output.
	statusOut := captureStdout(t, func() {
		if code := run([]string{"proxy", "hub", "status", hubName, "--json"}); code != 0 {
			t.Fatalf("hub status --json exited %d", code)
		}
	})
	if strings.Contains(statusOut, token2) {
		t.Fatal("hub status --json leaked the route token")
	}
	home := os.Getenv("ANYPICK_HOME")
	for _, hit := range homeFilesWithToken(home, token2) {
		if rel, err := filepath.Rel(home, hit); err == nil &&
			strings.HasPrefix(rel, "clients"+string(filepath.Separator)) {
			continue
		}
		t.Fatalf("route token leaked into %s", hit)
	}

	// Make routed requests deterministic + offline: the DB is the authority
	// for snapshots (ADR 0004 — MaterializeSnapshot rebuilds the on-disk cache
	// on every read), so poison each account's stored credential with a
	// DISTINCT unknown endpoint profile. Resolution then fails fast per request
	// with an error naming its account — no network, deterministic source id.
	ctx := context.Background()
	a, closeFn, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"dsa", "dsb"} {
		cred, _ := json.Marshal(map[string]interface{}{
			"version": 1, "kind": "api-key",
			"profile": "stub-endpoint-" + name, "secret": "sk-" + name,
		})
		res, uerr := a.Store.DB.Exec(
			`UPDATE account_snapshot_files SET content = ?
			   WHERE provider = 'deepseek' AND account = ?
			     AND path = 'compatible-credential.json'`, string(cred), name)
		if uerr != nil {
			t.Fatal(uerr)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			t.Fatalf("no stored credential row for deepseek/%s", name)
		}
	}
	closeFn()

	postModelAt := func(model, token string) (*http.Response, string) {
		body, _ := json.Marshal(map[string]string{"model": model})
		req, err := http.NewRequest(http.MethodPost, endpoint+"/v1/chat/completions",
			strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(raw)
	}

	// Model pin "#N" selects the source; each 502 names the endpoint profile
	// the child actually resolved — proving per-model routing through the real
	// binary without touching the network.
	resp, body := postModelAt("#0", token2)
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(body, "stub-endpoint-dsa") {
		t.Fatalf("#0 request = %d %s, want 502 naming stub-endpoint-dsa", resp.StatusCode, body)
	}
	resp, body = postModelAt("#1", token2)
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(body, "stub-endpoint-dsb") {
		t.Fatalf("#1 request = %d %s, want 502 naming stub-endpoint-dsb", resp.StatusCode, body)
	}

	// Wrong token is rejected by the hub before any routing.
	if resp, _ := postModelAt("#0", "not-the-token"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", resp.StatusCode)
	}

	// Detach runs under the `hub/<name>` mutation scope — never serializeRef —
	// mirroring the executor's critical section.
	a2, closeFn2, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	detachErr := lock.WithMutationLock(ctx, a2.Root, refs.MutationScopeForRef(refs.ProxyHubRef(hubName)), func(c context.Context) error {
		return a2.Hub.DetachRouteContext(c, DefaultHubRouteIDForTest(hubName, "claude"))
	})
	closeFn2()
	if detachErr != nil {
		t.Fatal(detachErr)
	}
	if resp, _ := postModelAt("#0", token2); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token after detach = %d, want 401", resp.StatusCode)
	}

	// Stop the detached child through the health-echo-vetoed CLI stop.
	if code := run([]string{"proxy", "hub", "stop", hubName}); code != 0 {
		t.Fatalf("hub stop exited %d", code)
	}
	assertNoLeakedChildren(t, "hub stop")

	// Clean route-row state: the detached row is gone; config remains.
	a3, closeFn3, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	row, serr := a3.Hub.SnapshotRouteContext(ctx, DefaultHubRouteIDForTest(hubName, "claude"))
	cfg, cerr := a3.Hub.GetConfig(hubName)
	byToken, terr := a3.Hub.RouteByToken(token2)
	closeFn3()
	if serr != nil || row != nil {
		t.Fatalf("detached route row survived: %+v err=%v", row, serr)
	}
	if cerr != nil || cfg == nil {
		t.Fatalf("hub config vanished with the route: %+v err=%v", cfg, cerr)
	}
	if terr != nil || byToken != nil {
		t.Fatalf("detached token still resolves: %+v err=%v", byToken, terr)
	}
}

// DefaultHubRouteIDForTest mirrors the executor's per-client route id shape.
func DefaultHubRouteIDForTest(hubName, client string) string {
	return hubName + "/route-" + client
}

// TestCurrentReportsTheEffectiveBinding pins the gateway fallback. The
// troubleshooting page sends users to `current <provider>` to see "what is
// actually in effect"; a gateway binding leaves the native account pointer
// empty, and the command used to answer "no active account" with exit 0 — a
// false negative indistinguishable from success, on a page about diagnosing
// exactly that confusion.
func TestCurrentReportsTheEffectiveBinding(t *testing.T) {
	isolateEnv(t)
	clearGlobalsForParity()
	defer resetGlobals()()

	if code := run([]string{"add", "gateway", "gw", "--provider", "openrouter",
		"--endpoint", "https://openrouter.ai/api/v1", "--api-key", "sk-x"}); code != 0 {
		t.Fatalf("add gateway exited %d", code)
	}
	if code := run([]string{"use", "claude", "--with", "gw"}); code != 0 {
		t.Fatalf("use exited %d", code)
	}

	var stdout, stderr string
	exit := 0
	stdout, stderr = captureBoth(t, func() { exit = run([]string{"current", "claude"}) })
	if exit != 0 {
		t.Fatalf("current exited %d: %s", exit, stderr)
	}
	if !strings.Contains(stdout, "gw") {
		t.Fatalf("current did not name the bound gateway: %q", stdout)
	}
	if strings.Contains(stdout, "no active account") {
		t.Fatalf("current still reports no active account with a gateway bound: %q", stdout)
	}
}
