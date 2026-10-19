//go:build windows

package browserlogin

import (
	"context"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExecutableNamesAddsWindowsExtensions(t *testing.T) {
	t.Setenv("PATHEXT", ".EXE;.CMD")
	names := executableNames("codex")
	if len(names) < 2 || names[0] != "codex.exe" {
		t.Fatalf("executableNames = %#v", names)
	}
}

func TestRunNpmBatchLauncherWithSpacesAndNativeHome(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(t.TempDir(), "npm cli & launchers")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(dir, "test-launcher.cmd")
	body := "@echo off\r\nif not \"%~1\"==\"login\" exit /b 11\r\nif not \"%~2\"==\"argument with & spaces\" exit /b 12\r\nif not \"%USERPROFILE%\"==\"%ANYPICK_EXPECTED_PROFILE%\" exit /b 13\r\n> \"%USERPROFILE%\\completed\" echo ok\r\nexit /b 0\r\n"
	if err := os.WriteFile(launcher, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PATHEXT", ".EXE;.CMD")
	if got := ResolveBinary([]string{"test-launcher"}, nil); got != launcher {
		t.Fatalf("launcher=%q, want %q", got, launcher)
	}
	if err := Run(context.Background(), Command{Names: []string{"test-launcher"}, Args: []string{"login", "argument with & spaces"}, Env: map[string]string{"ANYPICK_EXPECTED_PROFILE": home}}, home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "completed")); err != nil {
		t.Fatal("batch launcher did not finish in the isolated USERPROFILE:", err)
	}
}

func TestBatchLauncherRefusesExpansionInArguments(t *testing.T) {
	child := exec.Command(filepath.Join(t.TempDir(), "launcher.cmd"), "%SECRET_VALUE%")
	child.SysProcAttr = &windows.SysProcAttr{}
	if err := prepareWindowsLauncher(child); err == nil {
		t.Fatal("batch launcher accepted an expanding argument")
	}
}

func TestBatchLoginCancellationStopsTheCommandTree(t *testing.T) {
	home := t.TempDir()
	launcher := filepath.Join(home, "launcher.cmd")
	if err := os.WriteFile(launcher, []byte("@echo off\r\nping -n 30 127.0.0.1 >nul\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	timer := time.AfterFunc(200*time.Millisecond, cancel)
	defer timer.Stop()
	defer cancel()
	started := time.Now()
	err := Run(ctx, Command{Names: []string{launcher}}, home)
	if err == nil || time.Since(started) > 5*time.Second {
		t.Fatalf("batch cancellation = %v after %v", err, time.Since(started))
	}
}
