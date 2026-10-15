package ownership

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// TestStopWaitsForTheWholeProcessGroup is the regression for a stop that
// returned too early.
//
// The leader here spawns a grandchild that ignores SIGTERM. Signalling the
// group kills the leader immediately and leaves the grandchild running, so the
// old implementation — which waited for the recorded pid only — returned in
// milliseconds while the tree was still up. Every caller treats Stop's return
// as "the proxy is gone", and a grandchild still flushing logs into the data
// directory is what made teardown race a write.
func TestStopWaitsForTheWholeProcessGroup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the SIGTERM grandchild behavior is POSIX-specific")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no POSIX shell available")
	}
	dir := t.TempDir()
	pidPath := filepath.Join(dir, "service.pid")
	self, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	// The background subshell inherits the ignored TERM disposition, and `sleep`
	// inherits it across exec, so only the leader dies from the group signal.
	// The grandchild announces itself with a file: waiting for the leader to
	// exist is not enough, because the shell forks the grandchild after that,
	// and a stop that ran first would have nothing to wait for.
	ready := filepath.Join(dir, "grandchild-ready")
	// The leader keeps its own argv (it must, or Stop's identity check would
	// refuse to signal it): it stays a shell and waits on a foreground child,
	// while the TERM-ignoring subshell it backgrounded outlives it.
	script := "sh -c 'trap \"\" TERM; : > " + ready + "; sleep 30' & sleep 30"
	rec, err := Spawn(self, []string{"-c", script}, pidPath, "", "ANYPICK_OWNERSHIP_TEST=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Stop(pidPath, StopOptions{Timeout: time.Second}) })
	waitFor(t, func() bool {
		_, statErr := os.Stat(ready)
		return statErr == nil
	})

	// A short graceful timeout forces the escalation path, which is the only
	// thing that can kill a process ignoring SIGTERM.
	const graceful = 1500 * time.Millisecond
	start := time.Now()
	if !Stop(pidPath, StopOptions{Timeout: graceful}) {
		t.Fatal("Stop refused to stop a child it owns")
	}
	elapsed := time.Since(start)

	if groupAlive(rec) {
		t.Fatal("Stop returned while a grandchild of the child was still running")
	}
	// The leader dies at once and the grandchild ignores TERM, so a stop that
	// did not wait for the group would return long before the graceful timeout.
	if elapsed < graceful {
		t.Fatalf("Stop returned in %s: it did not wait for the group", elapsed)
	}
}
