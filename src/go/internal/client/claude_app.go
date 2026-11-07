package client

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// claudeAppBundleID names the Claude desktop app, which AnyPick starts only by
// bundle id so an install outside /Applications still works.
const claudeAppBundleID = "com.anthropic.claudefordesktop"

// ErrClaudeAppUnsupported reports a platform without the Claude app launch
// path. Passing --user-data-dir to a new instance relies on macOS's open(1).
var ErrClaudeAppUnsupported = fmt.Errorf("opening a Claude app profile is supported only on macOS")

// ClaudeAppProfile is one separate Claude app data folder. It holds no route
// and no AnyPick account: the login belongs to the app instance (ADR 0038).
type ClaudeAppProfile struct {
	Name     string
	SignedIn bool
	Running  bool
}

// ClaudeAppProfileSupported reports whether this machine can open a Claude app
// profile.
func ClaudeAppProfileSupported() bool { return codexAppGOOS == "darwin" }

// ValidateClaudeAppProfileName applies the Codex profile name rules: the name
// becomes a single path element below the AnyPick root.
func ValidateClaudeAppProfileName(name string) error {
	if ValidateCodexProfileName(name) != nil {
		return fmt.Errorf("invalid Claude app profile name %q (use 1-64 letters, digits, hyphens, or underscores)", name)
	}
	return nil
}

func claudeAppProfilesDir(root string) string {
	if root == "" {
		root = anyPickRootFallback()
	}
	return filepath.Join(root, "clients", "claude", "app-profiles")
}

// ClaudeAppProfilePath is everything a profile owns; removal deletes it.
func ClaudeAppProfilePath(root, name string) string {
	return filepath.Join(claudeAppProfilesDir(root), name)
}

// ClaudeAppProfileUserDataPath is the app instance's Electron user data.
func ClaudeAppProfileUserDataPath(root, name string) string {
	return filepath.Join(ClaudeAppProfilePath(root, name), "user-data")
}

// claudeAppInstancePath is the user data path passed to, and looked for on, an
// instance. The root is resolved because the app does not share AnyPick's
// working directory, and because the process list holds exactly the spelling
// given at launch, so two spellings of one root must not read as two folders.
func claudeAppInstancePath(root, name string) string {
	if root == "" {
		root = anyPickRootFallback()
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	return ClaudeAppProfileUserDataPath(root, name)
}

// ClaudeAppProfileInstancePath is the folder an instance of the profile runs
// on, as the CLI reports it.
func ClaudeAppProfileInstancePath(root, name string) string {
	return claudeAppInstancePath(root, name)
}

// ClaudeAppProfileMatch is what a name finds among the profile folders.
type ClaudeAppProfileMatch struct {
	// Exists says a folder has exactly this name. A stat would not do: the
	// default macOS filesystem finds "work" for "Work", while the process list
	// does not, so a removal of "Work" would pass the open check and delete the
	// folder a "work" window is running on.
	Exists bool
	// CaseConflict names a profile differing from this name only by case. Such
	// a pair would be one folder on the default macOS filesystem.
	CaseConflict string
}

// readClaudeAppProfilesDir lists the profiles folder; a missing folder is no
// profiles. A missing folder is confirmed with Lstat rather than read off the
// ReadDir error, because Windows reports ReadDir on a regular file as "path
// not found", which os.IsNotExist accepts, and that would read an unreadable
// folder as an empty one.
func readClaudeAppProfilesDir(root string) ([]os.DirEntry, error) {
	dir := claudeAppProfilesDir(root)
	entries, err := os.ReadDir(dir)
	if err == nil {
		return entries, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	if _, statErr := os.Lstat(dir); statErr == nil {
		return nil, fmt.Errorf("read Claude app profiles: %s is not a directory", dir)
	} else if !os.IsNotExist(statErr) {
		return nil, statErr
	}
	return nil, nil
}

// FindClaudeAppProfile looks a name up. An unreadable folder is an error, not
// an empty one: reading it as empty would skip the checks that guard a profile.
func FindClaudeAppProfile(root, name string) (ClaudeAppProfileMatch, error) {
	var match ClaudeAppProfileMatch
	entries, err := readClaudeAppProfilesDir(root)
	if err != nil {
		return match, err
	}
	for _, entry := range entries {
		switch {
		case !entry.IsDir():
		case entry.Name() == name:
			match.Exists = true
		case strings.EqualFold(entry.Name(), name):
			match.CaseConflict = entry.Name()
		}
	}
	return match, nil
}

// ListClaudeAppProfiles reads the profiles from disk. The folder is the
// record: the app owns everything in it, so a table row could only disagree.
func ListClaudeAppProfiles(root string) ([]ClaudeAppProfile, error) {
	entries, err := readClaudeAppProfilesDir(root)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && ValidateClaudeAppProfileName(entry.Name()) == nil {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return nil, nil
	}
	// One listing per read: this runs on every desktop snapshot.
	processes := listClaudeAppProcesses()
	profiles := make([]ClaudeAppProfile, 0, len(names))
	for _, name := range names {
		profiles = append(profiles, ClaudeAppProfile{
			Name:     name,
			SignedIn: claudeAppSignedIn(ClaudeAppProfileUserDataPath(root, name)),
			Running:  claudeAppRunningOrUnknown(root, name, processes),
		})
	}
	return profiles, nil
}

// claudeAppSignedIn decodes the one non-secret field that says the instance has
// seen an account. The app's token cache in the same file is not decoded.
func claudeAppSignedIn(userData string) bool {
	raw, err := os.ReadFile(filepath.Join(userData, "config.json"))
	if err != nil {
		return false
	}
	var config struct {
		Account string `json:"lastKnownAccountUuid"`
	}
	return json.Unmarshal(raw, &config) == nil && config.Account != ""
}

// MarkClaudeAppProfileStarting creates the profile if needed and makes it
// count as open for the launch grace period, so a removal queued behind the
// open cannot delete the folder the instance is about to run on. The returned
// time identifies this mark for ClearClaudeAppProfileStarting.
func MarkClaudeAppProfileStarting(root, name string) (time.Time, error) {
	if err := ValidateClaudeAppProfileName(name); err != nil {
		return time.Time{}, err
	}
	userData := ClaudeAppProfileUserDataPath(root, name)
	if err := markElectronAppStarting(userData); err != nil {
		return time.Time{}, err
	}
	info, err := os.Stat(filepath.Join(userData, codexAppLaunchMarker))
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

// ClearClaudeAppProfileStarting ends the grace period of a launch that failed,
// so it does not block a removal. A later open may have marked the profile
// since, and that mark is not this launch's to clear. The caller holds the
// profile's lock, which is what makes the check and the removal one step.
func ClearClaudeAppProfileStarting(root, name string, startedAt time.Time) {
	marker := filepath.Join(ClaudeAppProfileUserDataPath(root, name), codexAppLaunchMarker)
	if info, err := os.Stat(marker); err == nil && info.ModTime().Equal(startedAt) {
		_ = os.Remove(marker)
	}
}

// LaunchClaudeAppProfile starts a separate Claude app instance on the
// profile's user data. --user-data-dir is the only supported input: signed
// builds ignore CLAUDE_USER_DATA_DIR. CLAUDE_CONFIG_DIR stays unset so the
// instance's Code tab keeps the ~/.claude settings and transcripts the user
// already has (ADR 0038).
func LaunchClaudeAppProfile(root, name string) error {
	if err := ValidateClaudeAppProfileName(name); err != nil {
		return err
	}
	if !ClaudeAppProfileSupported() {
		return ErrClaudeAppUnsupported
	}
	return codexAppOpen([]string{
		"-n", "-b", claudeAppBundleID,
		"--args", "--user-data-dir=" + claudeAppInstancePath(root, name),
	})
}

// RemoveClaudeAppProfileData deletes the profile's local data. The login is
// not signed out on the server, because that needs the app the user quit.
func RemoveClaudeAppProfileData(root, name string) error {
	if err := ValidateClaudeAppProfileName(name); err != nil {
		return err
	}
	return os.RemoveAll(ClaudeAppProfilePath(root, name))
}

// claudeAppProcessListTimeout bounds a hung ps, which would otherwise stall the
// desktop snapshot that runs it.
const claudeAppProcessListTimeout = 5 * time.Second

// claudeAppProcessList returns every process's command line; tests replace it.
var claudeAppProcessList = func() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), claudeAppProcessListTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-axww", "-o", "command=").Output()
	return string(out), err
}

type claudeAppProcesses struct {
	commands string
	err      error
}

// listClaudeAppProcesses is empty off macOS, where no instance can exist and
// there is no /bin/ps to fail closed on.
func listClaudeAppProcesses() claudeAppProcesses {
	if !ClaudeAppProfileSupported() {
		return claudeAppProcesses{}
	}
	commands, err := claudeAppProcessList()
	return claudeAppProcesses{commands: commands, err: err}
}

// SetClaudeAppProcessListForTest replaces the process listing and returns a
// restore function.
func SetClaudeAppProcessListForTest(fn func() (string, error)) func() {
	old := claudeAppProcessList
	claudeAppProcessList = fn
	return func() { claudeAppProcessList = old }
}

// ClaudeAppProfileInUse reports whether an instance runs, or is starting, on
// the profile. A failed listing is an error, because nobody can tell the
// profile is closed.
func ClaudeAppProfileInUse(root, name string) (bool, error) {
	return claudeAppInstanceRunning(root, name, listClaudeAppProcesses())
}

// claudeAppRunningOrUnknown is for display, where a listing that fails counts
// as running: a live profile must not read as closed.
func claudeAppRunningOrUnknown(root, name string, processes claudeAppProcesses) bool {
	running, err := claudeAppInstanceRunning(root, name, processes)
	return running || err != nil
}

// claudeAppInstanceRunning finds an instance. The Claude app leaves no
// Singleton files in its user data, so the check electronAppRunning makes
// covers only the launch marker, and a running instance is found by the flag on
// its command line.
func claudeAppInstanceRunning(root, name string, processes claudeAppProcesses) (bool, error) {
	if electronAppRunning(ClaudeAppProfileUserDataPath(root, name)) {
		return true, nil
	}
	if processes.err != nil {
		return false, processes.err
	}
	flag := "--user-data-dir=" + claudeAppInstancePath(root, name)
	for _, line := range strings.Split(processes.commands, "\n") {
		// The boundary keeps profile "work" from matching "work-2".
		if i := strings.Index(line, flag); i >= 0 {
			rest := line[i+len(flag):]
			if rest == "" || rest[0] == ' ' {
				return true, nil
			}
		}
	}
	return false, nil
}
