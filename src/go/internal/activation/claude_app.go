package activation

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/lock"
)

// claudeAppProfileScope folds case because "work" and "Work" are one folder on
// the default macOS filesystem and must not lock as two.
func claudeAppProfileScope(name string) []string {
	return []string{"client-profile/claude-app/" + strings.ToLower(name)}
}

func claudeAppProfileOpenError(name string) error {
	return anyerr.Newf("Claude app profile "+name+" is open.",
		"CLAUDE_APP_RUNNING", anyerr.WithExitCode(anyerr.CapabilityConflict),
		anyerr.WithSuggestions("Quit that Claude instance with Command-Q in its window, then try again. A window opened in the last 30 seconds counts as open while it starts."))
}

func findClaudeAppProfile(root, name string) (client.ClaudeAppProfileMatch, error) {
	match, err := client.FindClaudeAppProfile(root, name)
	if err != nil {
		return match, anyerr.Wrapf(err, "read the Claude app profiles", "OPERATIONAL",
			anyerr.WithExitCode(anyerr.Operational))
	}
	return match, nil
}

// checkClaudeAppProfileClosed refuses unless the profile is known to be closed.
func checkClaudeAppProfileClosed(root, name string) error {
	running, err := client.ClaudeAppProfileInUse(root, name)
	if err != nil {
		return anyerr.Wrapf(err, "check whether Claude app profile "+name+" is open",
			"CLAUDE_APP_STATE_UNKNOWN", anyerr.WithExitCode(anyerr.Operational))
	}
	if running {
		return claudeAppProfileOpenError(name)
	}
	return nil
}

// claudeAppLaunch is what a failed launch has to undo.
type claudeAppLaunch struct {
	created   bool
	startedAt time.Time
}

// prepareClaudeAppProfile refuses a second instance on one folder, then marks
// the profile as starting. `open -n` always starts a new process, and the
// Claude app has no Singleton files to hand it over to the first, so nothing
// else stops two writers.
func prepareClaudeAppProfile(ctx context.Context, root, name string) (claudeAppLaunch, error) {
	var launch claudeAppLaunch
	err := lock.WithMutationLocks(ctx, root, claudeAppProfileScope(name),
		func(context.Context) error {
			match, err := findClaudeAppProfile(root, name)
			if err != nil {
				return err
			}
			if match.CaseConflict != "" {
				return anyerr.Newf("Claude app profile "+match.CaseConflict+" already exists; names differing only by case are the same folder.",
					"CLAUDE_APP_PROFILE_NAME_CONFLICT", anyerr.WithExitCode(anyerr.CapabilityConflict),
					anyerr.WithSuggestions("anypick claude-app profile open "+match.CaseConflict))
			}
			if match.Exists {
				if err := checkClaudeAppProfileClosed(root, name); err != nil {
					return err
				}
			}
			launch.created = !match.Exists
			launch.startedAt, err = client.MarkClaudeAppProfileStarting(root, name)
			return err
		}, 0)
	return launch, err
}

// abandonClaudeAppLaunch undoes what a failed launch prepared. A folder it
// created goes too, so it does not list as a profile nobody made, unless another
// open took the folder over: open(1) has no timeout, so the failure can arrive
// after the grace period let that open through. It is best effort: what the user
// needs to see is the launch failure, and the folder stays removable.
func abandonClaudeAppLaunch(ctx context.Context, root, name string, launch claudeAppLaunch) {
	_ = lock.WithMutationLocks(ctx, root, claudeAppProfileScope(name),
		func(context.Context) error {
			client.ClearClaudeAppProfileStarting(root, name, launch.startedAt)
			if !launch.created {
				return nil
			}
			if err := checkClaudeAppProfileClosed(root, name); err != nil {
				return err
			}
			return client.RemoveClaudeAppProfileData(root, name)
		}, 0)
}

func invalidClaudeAppProfileName(err error) error {
	return anyerr.Newf(err.Error(), "INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
}

// OpenClaudeAppProfile starts a Claude app instance on one profile, creating
// the profile on first use. The CLI and the desktop protocol both call it.
func OpenClaudeAppProfile(ctx context.Context, root, name string) error {
	if err := client.ValidateClaudeAppProfileName(name); err != nil {
		return invalidClaudeAppProfileName(err)
	}
	// Checked before the write: a platform that cannot launch the app must
	// not collect empty profiles.
	if !client.ClaudeAppProfileSupported() {
		return anyerr.Newf(client.ErrClaudeAppUnsupported.Error(), "UNSUPPORTED_PLATFORM",
			anyerr.WithExitCode(anyerr.CapabilityConflict))
	}
	launch, err := prepareClaudeAppProfile(ctx, root, name)
	if err != nil {
		return err
	}
	if err := client.LaunchClaudeAppProfile(root, name); err != nil {
		abandonClaudeAppLaunch(ctx, root, name, launch)
		if errors.Is(err, client.ErrClaudeAppUnsupported) {
			return anyerr.Newf(err.Error(), "UNSUPPORTED_PLATFORM",
				anyerr.WithExitCode(anyerr.CapabilityConflict))
		}
		return anyerr.Wrapf(err, "open the Claude app", "OPERATIONAL",
			anyerr.WithExitCode(anyerr.Operational),
			anyerr.WithSuggestions("Install the Claude desktop app and try again."))
	}
	return nil
}

// RemoveClaudeAppProfile deletes a profile's local data. An open instance
// would keep writing into the folder and recreate it with nothing tracking
// it, so removal is refused until that window is quit.
func RemoveClaudeAppProfile(ctx context.Context, root, name string) error {
	if err := client.ValidateClaudeAppProfileName(name); err != nil {
		return invalidClaudeAppProfileName(err)
	}
	return lock.WithMutationLocks(ctx, root, claudeAppProfileScope(name),
		func(context.Context) error {
			match, err := findClaudeAppProfile(root, name)
			if err != nil {
				return err
			}
			if !match.Exists {
				return anyerr.Newf("Claude app profile "+name+" does not exist.",
					"CLAUDE_APP_PROFILE_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound),
					anyerr.WithSuggestions("anypick claude-app profile list"))
			}
			if err := checkClaudeAppProfileClosed(root, name); err != nil {
				return err
			}
			return client.RemoveClaudeAppProfileData(root, name)
		}, 0)
}
