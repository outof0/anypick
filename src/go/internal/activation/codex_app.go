package activation

import (
	"context"
	"errors"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/lock"
)

// OpenCodexProfileApp starts a Codex desktop app instance on one named
// profile. The CLI and the desktop protocol both call it, so the app always
// receives the route the profile's CLI file holds. The app reads its config
// only at startup, so a route changed later reaches it the next time the
// profile is opened.
func OpenCodexProfileApp(ctx context.Context, name string, deps *Deps) error {
	if deps == nil || deps.ClientProfiles == nil {
		return anyerr.Newf("Codex profiles are not available.", "OPERATIONAL",
			anyerr.WithExitCode(anyerr.Operational))
	}
	if err := client.ValidateCodexProfileName(name); err != nil {
		return anyerr.Newf(err.Error(), "INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	// Checked before the write: config.toml in CODEX_HOME carries the route's
	// bearer token and is also the base config the CLI reads there, so a
	// platform that cannot launch the app must not get one.
	if !client.CodexProfileAppSupported() {
		return anyerr.Newf(client.ErrCodexAppUnsupported.Error(), "UNSUPPORTED_PLATFORM",
			anyerr.WithExitCode(anyerr.CapabilityConflict))
	}
	err := lock.WithMutationLocks(ctx, deps.Root,
		[]string{"client/codex", "client-profile/codex/" + name},
		func(c context.Context) error {
			named, err := deps.ClientProfiles.GetContext(c, "codex", name)
			if err != nil {
				return err
			}
			if named == nil {
				return NamedProfileNotFound(name)
			}
			return client.WriteCodexProfileAppConfig(deps.Root, name)
		}, 0)
	if err != nil {
		return err
	}
	if err := client.LaunchCodexProfileApp(deps.Root, name); err != nil {
		if errors.Is(err, client.ErrCodexAppUnsupported) {
			return anyerr.Newf(err.Error(), "UNSUPPORTED_PLATFORM",
				anyerr.WithExitCode(anyerr.CapabilityConflict))
		}
		return anyerr.Wrapf(err, "open the Codex app", "OPERATIONAL",
			anyerr.WithExitCode(anyerr.Operational),
			anyerr.WithSuggestions("Install the Codex app (ChatGPT for macOS) and try again."))
	}
	return nil
}
