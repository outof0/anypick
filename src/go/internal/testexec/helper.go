// Package testexec builds a tiny, configurable executable for cross-platform
// process tests. Shell scripts are not portable launchers on Windows.
package testexec

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// Build returns a small helper executable in the test's temporary directory.
// The helper uses ANYPICK_TESTEXEC_* environment variables to write a file,
// create a marker, wait, and select its exit status.
func Build(t testing.TB) string {
	t.Helper()
	dir := t.TempDir()
	source := filepath.Join(dir, "main.go")
	binary := filepath.Join(dir, "testexec")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if err := os.WriteFile(source, []byte(helperSource), 0o600); err != nil {
		t.Fatalf("write process helper: %v", err)
	}
	goTool := os.Getenv("GO")
	if goTool == "" {
		goTool = "go"
	}
	cmd := exec.Command(goTool, "build", "-o", binary, source)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build process helper: %v\n%s", err, output)
	}
	return binary
}

const helperSource = `package main

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func main() {
	if marker := os.Getenv("ANYPICK_TESTEXEC_MARKER"); marker != "" {
		_ = os.MkdirAll(filepath.Dir(marker), 0700)
		_ = os.WriteFile(marker, []byte("started"), 0600)
	}
	if target := os.Getenv("ANYPICK_TESTEXEC_WRITE_PATH"); target != "" {
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil { os.Exit(90) }
		if err := os.WriteFile(target, []byte(os.Getenv("ANYPICK_TESTEXEC_CONTENT")), 0600); err != nil { os.Exit(91) }
	}
	if envName := os.Getenv("ANYPICK_TESTEXEC_WRITE_UNDER_ENV"); envName != "" {
		target := filepath.Join(os.Getenv(envName), os.Getenv("ANYPICK_TESTEXEC_WRITE_BASENAME"))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil { os.Exit(94) }
		if err := os.WriteFile(target, []byte(os.Getenv("ANYPICK_TESTEXEC_CONTENT")), 0600); err != nil { os.Exit(95) }
	}
	if target := os.Getenv("ANYPICK_TESTEXEC_FAIL_IF_PRESENT"); target != "" {
		_, err := os.Stat(target)
		if marker := os.Getenv("ANYPICK_TESTEXEC_PRESENCE_MARKER"); marker != "" {
			state := "absent"
			if err == nil { state = "present" }
			if writeErr := os.WriteFile(marker, []byte(state), 0600); writeErr != nil { os.Exit(96) }
		}
		if err == nil { os.Exit(9) }
		os.Exit(7)
	}
	if wait := os.Getenv("ANYPICK_TESTEXEC_WAIT_MS"); wait != "" {
		ms, err := strconv.Atoi(wait)
		if err != nil { os.Exit(92) }
		time.Sleep(time.Duration(ms) * time.Millisecond)
	}
	if code := os.Getenv("ANYPICK_TESTEXEC_EXIT_CODE"); code != "" {
		status, err := strconv.Atoi(code)
		if err != nil { os.Exit(93) }
		os.Exit(status)
	}
}
`

// SetWrite configures the helper to create or replace a file with data.
func SetWrite(t testing.TB, path, content string) {
	t.Helper()
	t.Setenv("ANYPICK_TESTEXEC_WRITE_PATH", path)
	t.Setenv("ANYPICK_TESTEXEC_CONTENT", content)
}

// SetWriteInEnvDir writes a file under the directory named by envName.
func SetWriteInEnvDir(t testing.TB, envName, basename, content string) {
	t.Helper()
	t.Setenv("ANYPICK_TESTEXEC_WRITE_UNDER_ENV", envName)
	t.Setenv("ANYPICK_TESTEXEC_WRITE_BASENAME", basename)
	t.Setenv("ANYPICK_TESTEXEC_CONTENT", content)
}

// SetExit configures a specific helper exit status.
func SetExit(t testing.TB, code int) {
	t.Helper()
	t.Setenv("ANYPICK_TESTEXEC_EXIT_CODE", fmt.Sprint(code))
}
