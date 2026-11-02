package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
)

func stubClaudeAppLaunch(t *testing.T) *[][]string {
	t.Helper()
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", nil }))
	opened := &[][]string{}
	t.Cleanup(client.SetCodexAppOpenForTest(func(args []string) error {
		*opened = append(*opened, args)
		return nil
	}))
	return opened
}

func TestClaudeAppProfileCLIOpenListAndRefuseRemoval(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	opened := stubClaudeAppLaunch(t)

	var code int
	out, errOut := captureBoth(t, func() {
		code = run([]string{"--json", "claude-app", "profile", "open", "work"})
	})
	if code != int(anyerr.Success) || len(*opened) != 1 {
		t.Fatalf("open exited %d, launches %d (stdout=%q stderr=%q)", code, len(*opened), out, errOut)
	}
	var result struct {
		OK       bool   `json:"ok"`
		Profile  string `json:"profile"`
		UserData string `json:"userData"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("open --json is not JSON: %q: %v", out, err)
	}
	if !result.OK || result.Profile != "work" || filepath.Base(result.UserData) != "user-data" {
		t.Fatalf("open result = %+v", result)
	}

	out, errOut = captureBoth(t, func() {
		code = run([]string{"--json", "claude-app", "profile", "list"})
	})
	var profiles []struct {
		Name     string `json:"name"`
		SignedIn bool   `json:"signedIn"`
		Running  bool   `json:"running"`
	}
	if err := json.Unmarshal([]byte(out), &profiles); err != nil || code != int(anyerr.Success) {
		t.Fatalf("list exited %d, %q %q: %v", code, out, errOut, err)
	}
	if len(profiles) != 1 || profiles[0].Name != "work" || profiles[0].SignedIn || !profiles[0].Running {
		t.Fatalf("list = %+v", profiles)
	}

	out, errOut = captureBoth(t, func() {
		code = run([]string{"--json", "--yes", "claude-app", "profile", "remove", "work"})
	})
	if code != int(anyerr.CapabilityConflict) || !strings.Contains(out+errOut, "CLAUDE_APP_RUNNING") {
		t.Fatalf("remove exited %d (stdout=%q stderr=%q)", code, out, errOut)
	}
}

func TestClaudeAppProfileCLIErrorPaths(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	opened := stubClaudeAppLaunch(t)

	for _, tc := range []struct {
		name string
		args []string
		exit anyerr.ExitCode
		want string
	}{
		{"empty list", []string{"--json", "claude-app", "profile", "list"}, anyerr.Success, "[]"},
		{"missing", []string{"--json", "--yes", "claude-app", "profile", "remove", "nope"}, anyerr.NotFound, "CLAUDE_APP_PROFILE_NOT_FOUND"},
		{"traversal", []string{"--json", "claude-app", "profile", "open", "../work"}, anyerr.InvalidUsage, "INVALID_USAGE"},
		{"no confirmation", []string{"--json", "claude-app", "profile", "remove", "nope"}, anyerr.InvalidUsage, "CONFIRMATION_REQUIRED"},
		{"dry run", []string{"--json", "--dry-run", "claude-app", "profile", "open", "work"}, anyerr.Success, "claude-app.profile.open"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer resetGlobals()()
			var code int
			out, errOut := captureBoth(t, func() { code = run(tc.args) })
			if code != int(tc.exit) || !strings.Contains(out+errOut, tc.want) {
				t.Fatalf("exited %d, want %d with %q (stdout=%q stderr=%q)", code, tc.exit, tc.want, out, errOut)
			}
		})
	}
	if len(*opened) != 0 {
		t.Fatalf("a dry run or a refusal launched the app: %v", *opened)
	}
}

func TestClaudeAppProfileCLIRefusesWhenTheProcessListFails(t *testing.T) {
	isolateEnv(t)
	defer resetGlobals()()
	opened := stubClaudeAppLaunch(t)
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", errors.New("no ps") }))
	userData := client.ClaudeAppProfileUserDataPath(os.Getenv("ANYPICK_HOME"), "work")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"--json", "claude-app", "profile", "open", "work"},
		{"--json", "--yes", "claude-app", "profile", "remove", "work"},
	} {
		t.Run(args[len(args)-2], func(t *testing.T) {
			defer resetGlobals()()
			var code int
			out, errOut := captureBoth(t, func() { code = run(args) })
			if code != int(anyerr.Operational) || !strings.Contains(out+errOut, "CLAUDE_APP_STATE_UNKNOWN") {
				t.Fatalf("exited %d (stdout=%q stderr=%q)", code, out, errOut)
			}
		})
	}
	if len(*opened) != 0 {
		t.Fatalf("a refused open launched the app: %v", *opened)
	}
	if _, err := os.Stat(userData); err != nil {
		t.Fatal("a refused removal deleted the profile")
	}
}
