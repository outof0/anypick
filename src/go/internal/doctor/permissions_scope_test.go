package doctor

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestRepairPermissionsTouchesOnlyTheFlaggedPaths pins the scope contract:
// the plan carries the exact paths the diagnosis flagged, and the repair
// touches only those. The earlier walk-anything-not-0700/0600 shape silently
// widened the reported scope — one 0644 file made every 0755 directory under
// the root get rewritten too, so the user was told a scope that was not the
// scope applied.
func TestRepairPermissionsTouchesOnlyTheFlaggedPaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACLs are not represented by POSIX mode bits")
	}
	root := t.TempDir()
	// One flagged file (0644), one flagged dir (0755), and one CLEAN dir with
	// its own file. The 0640 file IS flagged — group read is group access, the
	// same rule the old diagnosis used — but the repair tightens it, so the
	// path that must survive untouched is the 0640 INSIDE the untouched scope:
	// none exists here. The untouched case is covered by the root exclusion:
	// the root itself is never walked, so a deliberately-loose file placed
	// OUTSIDE the flag set by the caller cannot appear. What the test pins is
	// the count: repair must chmod exactly the flagged list, nothing else.
	// Chmod AFTER create: os.MkdirAll/WriteFile pass the mode through the
	// process umask, and a sandboxed umask (007) would silently turn the
	// 0755 fixture into 0750 and make the assertions umask-dependent.
	writeMode := func(rel string, mode os.FileMode, isDir bool) string {
		full := filepath.Join(root, rel)
		if isDir {
			if err := os.MkdirAll(full, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(full, mode); err != nil {
				// A sandbox that refuses chmod makes every assertion below a
				// lie about the repair; skip rather than report fake results.
				t.Skipf("chmod unavailable in this environment: %v", err)
			}
		} else {
			if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(full, mode); err != nil {
				t.Fatal(err)
			}
		}
		return full
	}
	flaggedFile := writeMode("credentials.json", 0o644, false)
	flaggedDir := writeMode("loose", 0o755, true)
	cleanDir := writeMode("tight", 0o700, true)
	untouchedFile := writeMode(filepath.Join("tight", "keep-me-0640"), 0o640, false)

	// A 0755 script inside the flagged dir is created BEFORE planning so the
	// repair sees it: its owner +x must survive, and group/other must go.
	exe := writeMode(filepath.Join("loose", "run.sh"), 0o755, false)

	planPaths := permissivePaths(root)
	// 4 flagged: the 0644 file, the 0755 dir, the 0755 script, and the 0640
	// file (group read counts as group access, the diagnosis's rule).
	if len(planPaths) != 4 {
		t.Fatalf("diagnosis flagged %d paths (%v), want 4", len(planPaths), planPaths)
	}
	joined := strings.Join(planPaths, ",")
	if !strings.Contains(joined, filepath.Base(flaggedFile)) || !strings.Contains(joined, filepath.Base(flaggedDir)) {
		t.Fatalf("the flagged set does not name the permissive paths: %v", planPaths)
	}
	for _, p := range planPaths {
		if strings.HasPrefix(p, cleanDir) && p != untouchedFile {
			t.Fatalf("the clean DIRECTORY itself was flagged: %v", planPaths)
		}
	}

	action := FixAction{ID: "repair_permissions:" + root, Kind: FixRepairPermissions, Target: root, Paths: planPaths}
	deps := FixDeps{Root: root}
	msg, err := fixRepairPermissions(action, deps)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(msg, "4") {
		t.Fatalf("repair message %q does not name the flagged count", msg)
	}

	// The repair tightens GROUP/OTHER bits only: owner bits (including +x)
	// are the user's, so nothing needs a saved mode to undo.
	if info, err := os.Stat(flaggedFile); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("flagged file = %v %v, want 0600", info, err)
	}
	if info, err := os.Stat(flaggedDir); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("flagged dir = %v %v, want group/other cleared; planPaths=%v", info, err, planPaths)
	}
	// The 0640 file inside the tight dir was flagged too (group read); it
	// keeps its owner read, drops group read.
	if info, err := os.Stat(untouchedFile); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("flagged 0640 file = %v %v, want 0600", info, err)
	}
	// The clean dir was never in the plan and keeps its exact mode.
	if info, err := os.Stat(cleanDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("clean dir was touched: %v %v", info, err)
	}
	// A 0755 script keeps its owner +x: stripping an executable bit was the
	// defect (301 scripts on the reviewer's machine). The script was created
	// before planning, so the repair saw it.
	if info, err := os.Stat(exe); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("executable = %v %v, owner +x must survive the tightening", info, err)
	}
	if info, err := os.Stat(exe); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("executable = %v %v, want group/other cleared", info, err)
	}
}

// TestPermissivePathsFlagsDirectoriesOnAnyGroupAccess pins the diagnosis
// side: a 0755 directory IS flagged (a credential store must not be
// world-readable), which is what makes the reported set and the fixed set the
// same list.
func TestPermissivePathsFlagsDirectoriesOnAnyGroupAccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACLs are not represented by POSIX mode bits")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "tight"), 0o700); err != nil {
		t.Fatal(err)
	}
	got := permissivePaths(root)
	if len(got) != 1 || !strings.HasSuffix(got[0], "d") {
		t.Fatalf("permissivePaths = %v, want only the 0755 dir", got)
	}
}
