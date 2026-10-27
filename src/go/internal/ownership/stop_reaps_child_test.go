package ownership

import (
	"path/filepath"
	"testing"
	"time"
)

// Regression: Stop must actually reap the child it owns. Ownership
// verification used to depend on shelling out to /bin/ps; wherever that binary
// is blocked — sandboxed CI, a hardened runtime, a minimal container — every
// verification failed closed, Stop refused to signal the child, and detached
// services leaked for the lifetime of the machine. Identity now comes from
// sysctl on darwin and /proc on Linux, neither of which needs an executable.
func TestStopReapsOwnedChildWithoutExternalBinary(t *testing.T) {
	dir := t.TempDir()
	pidPath := filepath.Join(dir, "service.pid")
	rec := spawnHelper(t, pidPath)
	t.Cleanup(func() { _ = Stop(pidPath, StopOptions{}) })

	waitFor(t, rec.Alive)

	if rec.ProcessStart == 0 {
		t.Fatal("spawn recorded no process start stamp: identity was not captured after exec")
	}
	if rec.Executable == "" {
		t.Fatal("spawn recorded no executable path: identity was not captured after exec")
	}

	if !Stop(pidPath, StopOptions{Timeout: 5e9}) {
		t.Fatal("Stop refused to stop a child it owns")
	}
	waitFor(t, func() bool { return !rec.Alive() })

	if Load(pidPath) != nil {
		t.Fatal("ownership record survived a successful stop")
	}
}

// A recycled pid that happens to run the same command must not be signalled:
// the start stamp is what separates it from the child we spawned.
func TestStopRefusesRecycledPidWithMatchingArgv(t *testing.T) {
	dir := t.TempDir()
	pidPath := filepath.Join(dir, "service.pid")
	rec := spawnHelper(t, pidPath)
	t.Cleanup(func() {
		// The test replaces the trusted start stamp with a forged one so Stop
		// must refuse it. Restore the real record for cleanup or the helper is
		// intentionally un-stoppable and keeps its executable open on Windows.
		if err := writeAtomic(pidPath, rec); err != nil {
			t.Errorf("restore helper ownership record: %v", err)
			return
		}
		// A refusal here is a different failure from a slow teardown: name it,
		// so the next CI failure says which one it was.
		if !Stop(pidPath, StopOptions{}) {
			t.Error("Stop refused the restored, owned record")
		}
		// On Windows, Stop decides "gone" from the job object's active-process
		// count, while Alive asks whether the process handle is signalled. On
		// a loaded runner the two briefly disagree, so asking Alive once, at
		// once, failed for a helper that was already terminated.
		deadline := time.Now().Add(5 * time.Second)
		for rec.Alive() && time.Now().Before(deadline) {
			time.Sleep(25 * time.Millisecond)
		}
		if rec.Alive() {
			t.Error("could not stop the owned helper after restoring its record")
		}
	})

	waitFor(t, rec.Alive)

	recycled := *rec
	recycled.ProcessStart = rec.ProcessStart + 1
	if recycled.VerifyLive() {
		t.Fatal("a process with a different start stamp verified as the owned child")
	}

	if err := writeAtomic(pidPath, &recycled); err != nil {
		t.Fatal(err)
	}
	if Stop(pidPath, StopOptions{Timeout: 100e6}) {
		t.Fatal("Stop signalled a process it could not prove ownership of")
	}
	if !rec.Alive() {
		t.Fatal("the real child was killed by an unverified stop")
	}
}
