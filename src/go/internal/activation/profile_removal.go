package activation

import (
	"context"
	"fmt"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
)

// Removing a named native profile has four callers. Explicit removal and the
// unattended orphan sweep leave the private credential home on disk. The
// account-deletion cascade is the one that purges it, because the user deleted
// the account. Opening the app must not delete sessions and history that live
// in a home whose account row is merely missing.

// ProfileRemoval describes one named profile to remove and whether the
// credential material inside its private home must go with it.
type ProfileRemoval struct {
	Client string
	Name   string
	// PurgeCredentials removes the profile's private credential home in
	// addition to the generated route files. Only the account-deletion
	// cascade sets it. The orphan sweep does not. It runs when the app
	// opens, and the home still holds sessions and history.
	PurgeCredentials bool
	// HubName is the Proxy Hub behind the route, when there is one. It is
	// needed because the route row lives under the hub's mutation scope; a
	// removal that does not hold it races hub mutations (ADR 0009). Callers
	// that build removals from a stored profile fill it in via
	// ProfileRemovalFor; the callers that pass a literal can leave it empty
	// only when they already hold that scope.
	HubName string
}

// ProfileRemovalFor builds the removal for one stored profile, filling in the
// hub scope the route row needs. purge is true when the profile's credential
// home must go with it.
func ProfileRemovalFor(named *client.NamedProfile, purge bool) ProfileRemoval {
	if named == nil {
		return ProfileRemoval{}
	}
	removal := ProfileRemoval{
		Client: named.Client, Name: named.Name, PurgeCredentials: purge,
	}
	if named.Spec.Source.Kind == refs.KindProxyHub {
		removal.HubName = named.Spec.Source.Name
	}
	return removal
}

// PlanNamedProfileRemoval reads one named profile and returns both the row a
// caller should re-check before removal and the removal to run. It never
// mutates.
func PlanNamedProfileRemoval(ctx context.Context, clientID, name string, deps *Deps) (*client.NamedProfile, ProfileRemoval, error) {
	if deps == nil || deps.ClientProfiles == nil {
		return nil, ProfileRemoval{}, anyerr.Newf("client profile store is unavailable in this composition", "STATE_CONFLICT")
	}
	if err := client.ValidateCodexProfileName(name); err != nil {
		return nil, ProfileRemoval{}, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	named, err := deps.ClientProfiles.GetContext(ctx, clientID, name)
	if err != nil {
		return nil, ProfileRemoval{}, err
	}
	if named == nil {
		return nil, ProfileRemoval{}, NamedProfileNotFound(name)
	}
	// The explicit removal path keeps the credential home: the same name may
	// be signed in again immediately, and the caller asked to remove a route,
	// not a login.
	return named, ProfileRemovalFor(named, false), nil
}

// NamedProfileChanged reports that the row moved between planning and removal,
// which makes the earlier decision (a user confirming a name, an orphan list)
// stale. Callers refuse instead of removing something the user never saw.
func NamedProfileChanged(planned, current *client.NamedProfile) bool {
	if planned == nil || current == nil {
		return planned != current
	}
	return planned.UpdatedAt != current.UpdatedAt ||
		refs.SerializeRef(planned.Spec.Source) != refs.SerializeRef(current.Spec.Source)
}

// NamedProfileNotFound is the one not-found error for named profiles.
func NamedProfileNotFound(name string) error {
	return anyerr.Newf("Codex profile "+name+" does not exist.",
		"CODEX_PROFILE_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound),
		anyerr.WithSuggestions("anypick codex profile list"))
}

// RemoveNamedProfiles removes named profiles through one plan, in one
// coordinated mutation per profile: the native files first, then the durable
// route row. A failure before the row is deleted leaves the profile intact and
// retryable rather than orphaned on disk.
//
// stop, when non-nil, runs inside the lock before the first removal and is the
// caller's chance to stop an account proxy or Hub child (only
// accounts.Service knows how). Returning an error aborts the whole batch.
func RemoveNamedProfiles(ctx context.Context, removals []ProfileRemoval, deps *Deps, stop func(context.Context) error) error {
	if deps == nil || deps.ClientProfiles == nil {
		return anyerr.Newf("client profile store is unavailable in this composition", "STATE_CONFLICT")
	}
	if len(removals) == 0 {
		return nil
	}
	scopes := make([]string, 0, 3*len(removals))
	for _, r := range removals {
		scopes = append(scopes, "client/"+r.Client, "client-profile/"+r.Client+"/"+r.Name)
		// A hub-backed profile detaches its route row, which lives under the
		// hub's own scope. The removal used to hold it; taking the same locks
		// here keeps "remove a profile" serialized against hub mutations.
		if r.HubName != "" {
			scopes = append(scopes, refs.MutationScopeForRef(refs.ProxyHubRef(r.HubName)))
		}
	}
	return lock.WithMutationLocks(ctx, deps.Root, scopes, func(c context.Context) error {
		if err := checkProfilesNotInUse(removals, deps); err != nil {
			return err
		}
		if stop != nil {
			if err := stop(c); err != nil {
				return err
			}
		}
		for _, r := range removals {
			if err := removeNamedProfileLocked(c, r, deps); err != nil {
				return err
			}
		}
		return nil
	}, 0)
}

// checkProfilesNotInUse refuses the whole batch before anything is removed or
// stopped. Each removal is its own unit, so a refusal discovered on the second
// profile would otherwise leave the first one already gone.
func checkProfilesNotInUse(removals []ProfileRemoval, deps *Deps) error {
	for _, r := range removals {
		adapter, err := deps.Clients.Get(r.Client)
		if err != nil {
			return err
		}
		if checker, ok := adapter.(client.ProfileInUseChecker); ok {
			if err := checker.ProfileInUse(r.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

func removeNamedProfileLocked(ctx context.Context, r ProfileRemoval, deps *Deps) error {
	current, err := deps.ClientProfiles.GetContext(ctx, r.Client, r.Name)
	if err != nil {
		return err
	}
	if current == nil {
		// Already gone (a concurrent removal, or the startup sweep running
		// twice). The desired state holds, so this is success, not an error.
		return nil
	}
	adapter, err := deps.Clients.Get(r.Client)
	if err != nil {
		return err
	}
	if err := removeProfileFiles(adapter, r); err != nil {
		return err
	}
	if current.Spec.Source.Kind == refs.KindProxyHub && deps.Hub != nil {
		routeID := hub.ClientProfileRouteID(current.Spec.Source.Name, r.Client, r.Name)
		if err := deps.Hub.DetachRouteContext(ctx, routeID); err != nil {
			return err
		}
	}
	return deps.ClientProfiles.DeleteContext(ctx, r.Client, r.Name)
}

func removeProfileFiles(adapter client.Adapter, r ProfileRemoval) error {
	if r.PurgeCredentials {
		purger, ok := adapter.(client.ProfilePurger)
		if !ok {
			return anyerr.Newf(
				"Client "+r.Client+" cannot remove named profiles in this build.",
				"UNSUPPORTED_PROFILE", anyerr.WithExitCode(anyerr.CapabilityConflict))
		}
		return purger.RemoveProfileFiles(r.Name)
	}
	resetter, ok := adapter.(client.ProfileResetter)
	if !ok {
		return anyerr.Newf(
			"Client "+r.Client+" cannot remove named profiles in this build.",
			"UNSUPPORTED_PROFILE", anyerr.WithExitCode(anyerr.CapabilityConflict))
	}
	return resetter.ResetProfile(r.Name)
}

// OrphanedAccountProfiles lists named profiles whose account source no longer
// exists. It is the read half of the deletion cascade: anything it returns was
// left behind by a delete that predates the cascade, by a database restored
// without its account rows, or by a crash between the two writes.
//
// A read failure on one profile is reported, never skipped: a sweep that
// silently ignores what it cannot read looks exactly like a clean installation.
func OrphanedAccountProfiles(ctx context.Context, deps *Deps) ([]ProfileRemoval, error) {
	if deps == nil || deps.ClientProfiles == nil || deps.Accounts == nil {
		return nil, nil
	}
	all, err := deps.ClientProfiles.ListAllContext(ctx)
	if err != nil {
		return nil, err
	}
	var out []ProfileRemoval
	var failures []string
	for _, named := range all {
		src := named.Spec.Source
		if src.Kind != refs.KindAccount {
			continue
		}
		account, err := deps.Accounts.Get(ctx, src.Provider, src.Name)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s/%s: %v", src.Provider, src.Name, err))
			continue
		}
		if account != nil {
			continue
		}
		// Leave the credential home. This list feeds the unattended desktop
		// sweep. Purging here deleted sessions the moment a restored
		// database lacked the account row.
		out = append(out, ProfileRemovalFor(&named, false))
	}
	if len(failures) > 0 {
		return out, anyerr.Newf(
			"could not check every named profile for a missing account: "+strings.Join(failures, "; "),
			"STATE_CONFLICT")
	}
	return out, nil
}

// CleanOrphanedProfiles removes every named profile whose account is gone and
// reports the profiles it removed. It is the startup half of the cascade:
// account deletion cleans up while it runs, this catches what an older build,
// a crash, or a restored database left behind.
//
// A single failure does not abandon the rest: each profile is one transaction,
// and the joined error tells the caller which ones remain.
func CleanOrphanedProfiles(ctx context.Context, deps *Deps) ([]ProfileRemoval, error) {
	orphans, err := OrphanedAccountProfiles(ctx, deps)
	if err != nil && len(orphans) == 0 {
		return nil, err
	}
	var removed []ProfileRemoval
	var failures []string
	if err != nil {
		failures = append(failures, err.Error())
	}
	for _, orphan := range orphans {
		if rerr := RemoveNamedProfiles(ctx, []ProfileRemoval{orphan}, deps, nil); rerr != nil {
			failures = append(failures, orphan.Name+": "+rerr.Error())
			continue
		}
		removed = append(removed, orphan)
	}
	if len(failures) > 0 {
		return removed, anyerr.Newf("could not clean every orphaned profile: "+
			strings.Join(failures, "; "), "STATE_CONFLICT")
	}
	return removed, nil
}

// ProfileRemovalLabels renders removals as "client/name" for a user-facing
// message. It exists so the CLI, the desktop protocol and the startup sweep
// spell the same cleanup the same way.
func ProfileRemovalLabels(removals []ProfileRemoval) []string {
	labels := make([]string, 0, len(removals))
	for _, r := range removals {
		labels = append(labels, r.Client+"/"+r.Name)
	}
	return labels
}

// AccountProfileRemovals is the deletion cascade: every named profile whose
// route is the account being deleted, ready to be removed with the account.
// Profiles that point somewhere else (a gateway, a Hub, a pool) are not
// returned — deleting account A must not take down a profile that uses B.
func AccountProfileRemovals(ctx context.Context, deps *Deps, providerID, accountName string) ([]ProfileRemoval, error) {
	if deps == nil || deps.ClientProfiles == nil {
		return nil, nil
	}
	all, err := deps.ClientProfiles.ListAllContext(ctx)
	if err != nil {
		return nil, err
	}
	var out []ProfileRemoval
	for _, named := range all {
		src := named.Spec.Source
		if src.Kind != refs.KindAccount || src.Provider != providerID || src.Name != accountName {
			continue
		}
		out = append(out, ProfileRemovalFor(&named, true))
	}
	return out, nil
}
