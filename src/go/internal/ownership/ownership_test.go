package ownership

// Regression coverage for ADR-0003 structured detached-child ownership:
// legacy numeric PID files fail closed, records verify live argv identity,
// stop signals only verified children, and an optional health proof can veto.

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// TestOwnershipHelperChild blocks until signalled — spawned by the tests below
// as a stand-in detached service. Direct runs skip immediately.
func TestOwnershipHelperChild(t *testing.T) {
	if os.Getenv("OWNERSHIP_HELPER") != "1" {
		t.Skip("helper only")
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	os.Exit(0)
}

func TestOwnershipForeignHelperChild(t *testing.T) {
	if os.Getenv("OWNERSHIP_FOREIGN_HELPER") != "1" {
		t.Skip("helper only")
	}
	for {
		time.Sleep(time.Hour)
	}
}

func spawnHelper(t *testing.T, pidPath string) *Record {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OWNERSHIP_HELPER", "1")
	rec, err := Spawn(self, []string{"-test.run=TestOwnershipHelperChild", "-test.v"},
		pidPath, "", "OWNERSHIP_HELPER=1")
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}

func TestSpawnRecordsInstanceAndVerifiesIdentity(t *testing.T) {
	dir := t.TempDir()
	pidPath := filepath.Join(dir, "service.pid")
	rec := spawnHelper(t, pidPath)
	t.Cleanup(func() { _ = Stop(pidPath, StopOptions{}) })

	if rec.PID <= 0 || len(rec.InstanceID) != 36 || rec.RecordVersion != RecordVersion {
		t.Fatalf("bad record: %+v", rec)
	}
	waitFor(t, rec.Alive)

	loaded := Load(pidPath)
	if loaded == nil || loaded.InstanceID != rec.InstanceID || loaded.PID != rec.PID {
		t.Fatalf("round-trip mismatch: %+v vs %+v", loaded, rec)
	}
	if !loaded.VerifyLive() {
		t.Fatal("freshly spawned child failed live verification")
	}

	// Tampering with recorded command tokens must break identity proof.
	forged := *loaded
	if runtime.GOOS == "windows" {
		// Windows verifies executable + process start and job membership; the
		// command line is not part of its native process identity query.
		forged.ProcessStart++
	} else {
		forged.Command = []string{"totally", "different", "argv"}
	}
	if forged.VerifyLive() {
		t.Fatal("forged command tokens passed identity verification")
	}
}

func TestLoadFailsClosedOnLegacyAndCorruptFiles(t *testing.T) {
	dir := t.TempDir()

	legacy := filepath.Join(dir, "legacy.pid")
	if err := os.WriteFile(legacy, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := Load(legacy); rec != nil {
		t.Fatal("legacy numeric PID file was trusted")
	}
	if _, err := os.Stat(legacy); err == nil {
		t.Fatal("legacy numeric file was not removed")
	}

	corrupt := filepath.Join(dir, "corrupt.pid")
	if err := os.WriteFile(corrupt, []byte(`{"recordVersion":1,"pid":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := Load(corrupt); rec != nil {
		t.Fatal("corrupt record was trusted")
	}

	wrongVersion := filepath.Join(dir, "wrongversion.pid")
	if err := os.WriteFile(wrongVersion, []byte(`{"recordVersion":99,"instanceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","pid":123,"command":["x"],"createdAt":"t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := Load(wrongVersion); rec != nil {
		t.Fatal("wrong-version record was trusted")
	}

	if rec := Load(filepath.Join(dir, "missing.pid")); rec != nil {
		t.Fatal("absent record returned non-nil")
	}
}

func TestStopFailsClosedWithoutTrustedRecord(t *testing.T) {
	dir := t.TempDir()
	victim := exec.Command(os.Args[0], "-test.run=^TestOwnershipForeignHelperChild$")
	victim.Env = append(os.Environ(), "OWNERSHIP_FOREIGN_HELPER=1")
	if err := victim.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = victim.Process.Kill()
		_ = victim.Wait()
	})

	// Numeric-only file naming a LIVE foreign process: stop must not signal it.
	foreign := filepath.Join(dir, "foreign.pid")
	if err := os.WriteFile(foreign, []byte(strconv.Itoa(victim.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	if Stop(foreign, StopOptions{}) {
		t.Fatal("stop signalled a process with no trusted ownership record")
	}
	waitFor(t, func() bool { return processAlive(victim.Process.Pid) })
}

func TestStopHealthVetoIsFailClosed(t *testing.T) {
	dir := t.TempDir()
	pidPath := filepath.Join(dir, "service.pid")
	spawnHelper(t, pidPath)

	if Stop(pidPath, StopOptions{Health: func(Record) bool { return false }}) {
		t.Fatal("health veto did not abort the stop")
	}
	// The vetoed child must still be running and its record intact.
	rec := Load(pidPath)
	if rec == nil || !rec.VerifyLive() {
		t.Fatal("vetoed stop removed the record or the child")
	}
	// Without the veto the same child stops cleanly.
	if !Stop(pidPath, StopOptions{}) {
		t.Fatal("verified stop returned false")
	}
	waitFor(t, func() bool { return Load(pidPath) == nil })
}
