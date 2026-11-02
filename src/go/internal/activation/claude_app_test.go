package activation

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
)

// onMacWithProcesses stands in for macOS and its process list, so these tests
// mean the same on the Linux and Windows CI runners.
func onMacWithProcesses(t *testing.T, listing *string) {
	t.Helper()
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return *listing, nil }))
}

func profileExists(t *testing.T, root, name string) bool {
	t.Helper()
	match, err := client.FindClaudeAppProfile(root, name)
	if err != nil {
		t.Fatal(err)
	}
	return match.Exists
}

func profileInUse(t *testing.T, root, name string) bool {
	t.Helper()
	running, err := client.ClaudeAppProfileInUse(root, name)
	if err != nil {
		t.Fatal(err)
	}
	return running
}

func TestOpenClaudeAppProfileCreatesItAndLaunchesOnItsOwnUserData(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	var opened [][]string
	t.Cleanup(client.SetCodexAppOpenForTest(func(args []string) error {
		opened = append(opened, args)
		return nil
	}))
	root := t.TempDir()
	if err := OpenClaudeAppProfile(context.Background(), root, "work"); err != nil {
		t.Fatal(err)
	}
	if len(opened) != 1 {
		t.Fatalf("open calls = %v", opened)
	}
	userData := client.ClaudeAppProfileInstancePath(root, "work")
	want := []string{"-n", "-b", "com.anthropic.claudefordesktop", "--args", "--user-data-dir=" + userData}
	if len(opened[0]) != len(want) {
		t.Fatalf("open args = %v", opened[0])
	}
	for i := range want {
		if opened[0][i] != want[i] {
			t.Fatalf("open args = %v, want %v", opened[0], want)
		}
	}
	profiles, err := client.ListClaudeAppProfiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].Name != "work" || profiles[0].SignedIn || !profiles[0].Running {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestOpenClaudeAppProfileWritesNothingOnAnUnsupportedPlatform(t *testing.T) {
	t.Cleanup(client.SetCodexAppPlatformForTest("linux"))
	root := t.TempDir()
	err := OpenClaudeAppProfile(context.Background(), root, "work")
	var ae *anyerr.Error
	if !errorsAsAny(err, &ae) || ae.Code != "UNSUPPORTED_PLATFORM" {
		t.Fatalf("err = %v", err)
	}
	if profileExists(t, root, "work") {
		t.Fatal("a platform that cannot launch the app created a profile")
	}
}

// A failed launch must not leave the grace period blocking a removal.
func TestFailedClaudeAppLaunchDoesNotCountAsOpen(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error { return errors.New("no app") }))
	root := t.TempDir()
	if err := OpenClaudeAppProfile(context.Background(), root, "work"); err == nil {
		t.Fatal("expected a launch failure")
	}
	if profileInUse(t, root, "work") {
		t.Fatal("a failed launch counts as open")
	}
}

func TestClaudeAppProfilePathTraversalIsRefused(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	root := t.TempDir()
	victim := filepath.Join(root, "keep")
	if err := os.Mkdir(victim, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../../../keep", "..", "a/b", ""} {
		if err := RemoveClaudeAppProfile(context.Background(), root, name); err == nil {
			t.Errorf("remove %q succeeded", name)
		}
		if err := OpenClaudeAppProfile(context.Background(), root, name); err == nil {
			t.Errorf("open %q succeeded", name)
		}
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatal("traversal reached outside the profiles folder")
	}
}

func TestRemoveClaudeAppProfile(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error { return nil }))
	root := t.TempDir()
	ctx := context.Background()

	var ae *anyerr.Error
	err := RemoveClaudeAppProfile(ctx, root, "work")
	if !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_PROFILE_NOT_FOUND" {
		t.Fatalf("missing profile: err = %v", err)
	}

	if err := OpenClaudeAppProfile(ctx, root, "work"); err != nil {
		t.Fatal(err)
	}
	err = RemoveClaudeAppProfile(ctx, root, "work")
	if !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_RUNNING" {
		t.Fatalf("starting profile: err = %v", err)
	}
	if !profileExists(t, root, "work") {
		t.Fatal("a refused removal deleted the profile")
	}

	// Past the grace period, with no live socket, the instance is gone.
	userData := client.ClaudeAppProfileUserDataPath(root, "work")
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(userData, "anypick-launch"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := RemoveClaudeAppProfile(ctx, root, "work"); err != nil {
		t.Fatal(err)
	}
	if profileExists(t, root, "work") {
		t.Fatal("profile still exists")
	}
}

// The Claude app leaves no Singleton files, so an instance past the launch
// grace period is only visible on the process list. Found on a real instance:
// the socket check alone let a removal delete the folder it was running on.
func TestRemoveClaudeAppProfileRefusesARunningInstanceAfterTheGracePeriod(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	root := t.TempDir()
	ctx := context.Background()
	userData := client.ClaudeAppProfileInstancePath(root, "work")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	listing = "/Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=" + userData + " --flag\n"
	var ae *anyerr.Error
	if err := RemoveClaudeAppProfile(ctx, root, "work"); !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_RUNNING" {
		t.Fatalf("running instance: err = %v", err)
	}

	listing = "Claude --user-data-dir=" + userData + "-2\n"
	if profileInUse(t, root, "work") {
		t.Fatal("a profile matched a longer profile's folder")
	}

	// An unknown process list must not read as "nothing is running", and must
	// not claim the profile is open either.
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", errors.New("no ps") }))
	if err := RemoveClaudeAppProfile(ctx, root, "work"); !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_STATE_UNKNOWN" {
		t.Fatalf("failed listing: err = %v", err)
	}
	if err := OpenClaudeAppProfile(ctx, root, "work"); !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_STATE_UNKNOWN" {
		t.Fatalf("failed listing on open: err = %v", err)
	}
	if !profileExists(t, root, "work") {
		t.Fatal("a refused removal deleted the profile")
	}
}

// `open -n` always starts a process, and this app has no Singleton files to hand
// over to the first one, so a second open would be two writers on one folder.
func TestOpenRefusesAProfileThatIsAlreadyOpen(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	opened := 0
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		opened++
		return nil
	}))
	root := t.TempDir()
	userData := client.ClaudeAppProfileInstancePath(root, "work")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	listing = "Claude --user-data-dir=" + userData + "\n"
	var ae *anyerr.Error
	err := OpenClaudeAppProfile(context.Background(), root, "work")
	if !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_RUNNING" {
		t.Fatalf("err = %v", err)
	}
	if opened != 0 {
		t.Fatalf("open(1) ran %d times on an open profile", opened)
	}
}

// Whether the filesystem folds case must not matter: the default macOS one
// finds "work" for "Work", while the process list does not.
func TestAProfileNameDifferingOnlyByCaseIsNotThatProfile(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	opened := 0
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		opened++
		return nil
	}))
	root := t.TempDir()
	ctx := context.Background()
	if err := os.MkdirAll(client.ClaudeAppProfileUserDataPath(root, "work"), 0o700); err != nil {
		t.Fatal(err)
	}
	var ae *anyerr.Error
	err := RemoveClaudeAppProfile(ctx, root, "Work")
	if !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_PROFILE_NOT_FOUND" {
		t.Fatalf("remove: err = %v", err)
	}
	if !profileExists(t, root, "work") {
		t.Fatal("removing Work deleted work")
	}
	err = OpenClaudeAppProfile(ctx, root, "Work")
	if !errorsAsAny(err, &ae) || ae.Code != "CLAUDE_APP_PROFILE_NAME_CONFLICT" {
		t.Fatalf("open: err = %v", err)
	}
	if opened != 0 {
		t.Fatalf("open(1) ran %d times on a name collision", opened)
	}
}

func TestFailedFirstLaunchLeavesNoProfileAndKeepsAnExistingOne(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error { return errors.New("no app") }))
	root := t.TempDir()
	ctx := context.Background()
	if err := OpenClaudeAppProfile(ctx, root, "fresh"); err == nil {
		t.Fatal("expected a launch failure")
	}
	if profileExists(t, root, "fresh") {
		t.Fatal("a launch that never ran left a profile")
	}

	userData := client.ClaudeAppProfileUserDataPath(root, "work")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(userData, "config.json")
	if err := os.WriteFile(config, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := OpenClaudeAppProfile(ctx, root, "work"); err == nil {
		t.Fatal("expected a launch failure")
	}
	if _, err := os.Stat(config); err != nil {
		t.Fatal("a failed launch deleted a profile the user already had")
	}
	if profileInUse(t, root, "work") {
		t.Fatal("a failed launch left an existing profile counting as open")
	}
}

// The check in the cleanup is all that stops it deleting a folder an instance
// came up on while the failing open(1) was still running.
func TestFailedFirstLaunchKeepsAFolderAnInstanceRunsOn(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	root := t.TempDir()
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		listing = "Claude --user-data-dir=" + client.ClaudeAppProfileInstancePath(root, "work") + "\n"
		return errors.New("no app")
	}))
	if err := OpenClaudeAppProfile(context.Background(), root, "work"); err == nil {
		t.Fatal("expected a launch failure")
	}
	if !profileExists(t, root, "work") {
		t.Fatal("the cleanup deleted the folder of a running instance")
	}
}

// open(1) has no timeout. A first launch that fails after the grace period can
// lose the race to a second open, and must leave that open's mark and folder.
func TestSlowFailedFirstLaunchLeavesAnOpenThatFollowedIt(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	root := t.TempDir()
	ctx := context.Background()
	calls := 0
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		calls++
		if calls > 1 {
			return nil
		}
		marker := filepath.Join(client.ClaudeAppProfileUserDataPath(root, "work"), "anypick-launch")
		old := time.Now().Add(-time.Hour)
		if err := os.Chtimes(marker, old, old); err != nil {
			t.Fatal(err)
		}
		if err := OpenClaudeAppProfile(ctx, root, "work"); err != nil {
			t.Fatal(err)
		}
		return errors.New("no app")
	}))
	if err := OpenClaudeAppProfile(ctx, root, "work"); err == nil {
		t.Fatal("expected a launch failure")
	}
	if !profileExists(t, root, "work") {
		t.Fatal("the failed launch deleted the folder of the open that followed it")
	}
	if !profileInUse(t, root, "work") {
		t.Fatal("the failed launch cleared the mark of the open that followed it")
	}
}

// An unreadable folder must not read as "no such profile": on open that would
// skip the check for a running instance.
func TestUnreadableProfilesFolderIsAnError(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		t.Fatal("open(1) ran without reading the profiles")
		return nil
	}))
	root := t.TempDir()
	dir := filepath.Dir(client.ClaudeAppProfilePath(root, "work"))
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var ae *anyerr.Error
	if err := RemoveClaudeAppProfile(ctx, root, "work"); !errorsAsAny(err, &ae) || ae.Code != "OPERATIONAL" {
		t.Fatalf("remove: err = %v", err)
	}
	if err := OpenClaudeAppProfile(ctx, root, "work"); !errorsAsAny(err, &ae) || ae.Code != "OPERATIONAL" {
		t.Fatalf("open: err = %v", err)
	}
}

// The same folder must lock as one scope, whichever way its name is typed.
func TestClaudeAppProfileScopeFoldsCase(t *testing.T) {
	work, upper := claudeAppProfileScope("work"), claudeAppProfileScope("Work")
	if len(work) != 1 || len(upper) != 1 || work[0] != upper[0] {
		t.Fatalf("scopes = %v and %v", work, upper)
	}
}

func TestListingProfilesReadsTheProcessListOnce(t *testing.T) {
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	listed := 0
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) {
		listed++
		return "", nil
	}))
	root := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		if err := os.MkdirAll(client.ClaudeAppProfileUserDataPath(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	profiles, err := client.ListClaudeAppProfiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 3 || listed != 1 {
		t.Fatalf("profiles = %d, listings = %d", len(profiles), listed)
	}
}

// A symlinked or relative root must find the instance launched through another
// spelling of it, or a removal would delete a folder in use.
func TestAnInstanceIsFoundThroughAnotherSpellingOfTheRoot(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "root")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.MkdirAll(client.ClaudeAppProfileUserDataPath(real, "work"), 0o700); err != nil {
		t.Fatal(err)
	}
	listing = "Claude --user-data-dir=" + client.ClaudeAppProfileInstancePath(real, "work") + "\n"
	if !profileInUse(t, link, "work") {
		t.Fatal("the instance was not found through a symlinked root")
	}
}

// No instance can exist off macOS, and no /bin/ps does either: a profile folder
// that got there by a restore must not read as open forever.
func TestAProfileIsNotOpenOnAnUnsupportedPlatform(t *testing.T) {
	t.Cleanup(client.SetCodexAppPlatformForTest("linux"))
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", errors.New("no ps") }))
	root := t.TempDir()
	if err := os.MkdirAll(client.ClaudeAppProfileUserDataPath(root, "work"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := RemoveClaudeAppProfile(context.Background(), root, "work"); err != nil {
		t.Fatal(err)
	}
}

// A display that cannot tell must not show a live profile as closed.
func TestAFailedProcessListShowsTheProfileAsOpen(t *testing.T) {
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", errors.New("no ps") }))
	root := t.TempDir()
	if err := os.MkdirAll(client.ClaudeAppProfileUserDataPath(root, "work"), 0o700); err != nil {
		t.Fatal(err)
	}
	profiles, err := client.ListClaudeAppProfiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || !profiles[0].Running {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestClaudeAppProfileSignedInReadsOnlyTheAccountField(t *testing.T) {
	listing := ""
	onMacWithProcesses(t, &listing)
	root := t.TempDir()
	userData := client.ClaudeAppProfileUserDataPath(root, "work")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	config := []byte(`{"lastKnownAccountUuid":"00000000-0000-0000-0000-000000000000"}`)
	if err := os.WriteFile(filepath.Join(userData, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	profiles, err := client.ListClaudeAppProfiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || !profiles[0].SignedIn || profiles[0].Running {
		t.Fatalf("profiles = %+v", profiles)
	}
}
