package accounts

import (
	"context"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
)

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// useLocked runs preflight → checkpoint → stop the
// previous account proxy → refresh previous → restore target → set active →
// start the target proxy when enabled. The proxy lifecycle is optional so the
// account service remains usable in import/tests that do not compose a proxy.
func useLocked(s *Service, ctx context.Context, providerID, name string, opts UseOptions) (SwitchResult, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return SwitchResult{}, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	accountName, err := slug.AccountName(name)
	if err != nil {
		return SwitchResult{}, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	var result SwitchResult
	err = lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID),
		func(c context.Context) error {
			r, runErr := s.useUnlocked(c, pv, accountName, opts)
			if runErr == nil {
				result = r
			}
			return runErr
		})
	if err != nil {
		return SwitchResult{}, err
	}
	return result, nil
}

func (s *Service) useUnlocked(ctx context.Context, pv provider.Provider, accountName string, opts UseOptions) (SwitchResult, error) {
	target, err := s.Store.Require(ctx, pv.ID(), accountName)
	if err != nil {
		return SwitchResult{}, err
	}

	previous, err := s.Store.GetActive(ctx, pv.ID())
	if err != nil {
		return SwitchResult{}, err
	}

	if pr, ok := pv.(provider.PreflightRestorer); ok && target.Meta.CredentialKind != "proxy-only" {
		if err := pr.PreflightRestore(target.SnapshotDir); err != nil {
			return SwitchResult{}, err
		}
	}

	checkpoint, err := s.CheckpointLiveAuth(ctx, pv.ID(), false)
	if err != nil {
		return SwitchResult{}, err
	}
	defer func() { _ = s.DiscardLiveAuthCheckpoint(checkpoint) }()

	proxySwitch, err := s.prepareProxySwitch(ctx, pv, previous, accountName, opts)
	if err != nil {
		return SwitchResult{}, err
	}

	refreshedAccount := ""
	if !opts.NoRefresh && previous != "" && previous != accountName {
		refreshedAccount = s.refreshPreviousSnapshot(ctx, pv, previous)
	}
	refreshedPrevious := refreshedAccount == previous && refreshedAccount != ""

	// A proxy-only snapshot holds no native login — restoring it would at best
	// write nothing and at worst delete the real login.
	if target.Meta.CredentialKind != "proxy-only" {
		if err := pv.Restore(target.SnapshotDir); err != nil {
			return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), err)
		}
	}
	if err := s.Store.SetActiveContext(ctx, pv.ID(), accountName); err != nil {
		return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), err)
	}
	if s.AfterSwitch != nil {
		if err := s.AfterSwitch(ctx, pv.ID(), accountName); err != nil {
			return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), err)
		}
	}
	if proxySwitch.enabled {
		before, runningErr := proxySwitch.switcher.ProxyRunning(ctx, pv.ID(), accountName)
		if runningErr != nil {
			return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), runningErr)
		}
		proxySwitch.target = accountName
		if err := proxySwitch.switcher.StartProxyIfEnabled(ctx, pv.ID(), accountName); err != nil {
			return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), err)
		}
		after, runningErr := proxySwitch.switcher.ProxyRunning(ctx, pv.ID(), accountName)
		if runningErr != nil {
			// Start returned. If it was down before, roll the listener back
			// rather than leave a proxy the caller will be told was undone.
			proxySwitch.targetStarted = !before
			return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), runningErr)
		}
		// Only a proxy this switch started is stopped on rollback. One that
		// was already running belongs to the target account and stays up.
		proxySwitch.targetStarted = after && !before
	}
	// PostSwitch is part of the switch, not an afterthought: client configs
	// (proxy endpoint, token, models) must follow the account or the user is
	// left with a switched pointer and a client still talking to the previous
	// proxy. A failure restores the checkpoint — native auth AND the active
	// pointer — plus the binding realignment and the previous proxy.
	if err := runPostSwitch(ctx, opts, pv.ID(), accountName); err != nil {
		return s.rollbackSwitch(ctx, checkpoint, proxySwitch, pv.ID(), err)
	}

	return SwitchResult{
		Provider:          pv.ID(),
		ProviderName:      pv.Name(),
		From:              previous,
		To:                accountName,
		RefreshedPrevious: refreshedPrevious,
		RefreshedAccount:  refreshedAccount,
	}, nil
}

// runPostSwitch wraps the caller's client reapply with the rollback notice, so
// a failed switch tells the user the previous account was restored instead of
// surfacing only the underlying activation error.
func runPostSwitch(ctx context.Context, opts UseOptions, providerID, accountName string) error {
	if opts.PostSwitch == nil {
		return nil
	}
	if err := opts.PostSwitch(ctx); err != nil {
		message := "Switch to " + providerID + "/" + accountName + " failed; the previous account and its clients were restored"
		if incomplete, ok := err.(interface{ ClientRestoreIncomplete() bool }); ok && incomplete.ClientRestoreIncomplete() {
			message = "Switch to " + providerID + "/" + accountName + " failed and the clients that were already updated could not be restored"
		}
		return anyerr.Wrapf(err,
			message,
			"SWITCH_ROLLED_BACK",
			anyerr.WithSuggestions(
				"Verify that your account credentials and login session are valid.",
				"Check Live Logs in the Activity pane for detailed errors."))
	}
	return nil
}

// IncompleteClientRestore marks a post-switch error whose successful client
// updates could not be undone. The switch notice must not claim they were.
type incompleteClientRestore struct{ err error }

// IncompleteClientRestore wraps err so a failed switch does not report a
// client rollback that did not happen.
func IncompleteClientRestore(err error) error {
	if err == nil {
		return incompleteClientRestore{}
	}
	return incompleteClientRestore{err: err}
}

func (e incompleteClientRestore) Error() string {
	if e.err == nil {
		return "client configuration could not be restored"
	}
	return e.err.Error()
}

func (e incompleteClientRestore) Unwrap() error { return e.err }

func (e incompleteClientRestore) ClientRestoreIncomplete() bool { return true }

type proxySwitchState struct {
	switcher           ProxySwitcher
	enabled            bool
	previous           string
	target             string
	previousWasRunning bool
	targetStarted      bool
}

func (s *Service) prepareProxySwitch(ctx context.Context, pv provider.Provider, previous, target string, opts UseOptions) (proxySwitchState, error) {
	switcher, ok := s.Proxy.(ProxySwitcher)
	state := proxySwitchState{switcher: switcher, enabled: !opts.NoProxy && ok && pv.CanProxy(), previous: previous}
	if !state.enabled || previous == "" || previous == target {
		return state, nil
	}
	running, err := switcher.ProxyRunning(ctx, pv.ID(), previous)
	if err != nil {
		return proxySwitchState{}, err
	}
	state.previousWasRunning = running
	if err := switcher.StopProxyForSwitch(ctx, pv.ID(), previous); err != nil {
		return proxySwitchState{}, err
	}
	return state, nil
}

// rollbackSwitch restores native auth and, when needed, the exact previous
// proxy route after a target restore/activation failure.
func (s *Service) rollbackSwitch(ctx context.Context, checkpoint *Checkpoint, state proxySwitchState, providerID string, cause error) (SwitchResult, error) {
	rbCtx := context.WithoutCancel(ctx)
	var rbErr error
	// Stop the proxy this switch started before bringing the previous one
	// back. Leaving it up keeps any client that already reapplied talking to
	// the account the caller was told had been rolled back.
	if state.targetStarted && state.switcher != nil && state.target != "" {
		rbErr = state.switcher.StopProxyForSwitch(rbCtx, providerID, state.target)
	}
	if err := s.restoreCheckpointQuiet(rbCtx, checkpoint); err != nil && rbErr == nil {
		rbErr = err
	}
	if rbErr == nil && s.AfterSwitch != nil && state.previous != "" {
		rbErr = s.AfterSwitch(rbCtx, providerID, state.previous)
	}
	if rbErr == nil && state.enabled && state.previousWasRunning {
		rbErr = state.switcher.StartProxyIfEnabled(rbCtx, providerID, state.previous)
	}
	if rbErr != nil {
		return SwitchResult{}, anyerr.Wrapf(rbErr,
			"Account switch failed and rollback could not complete", "SWITCH_ROLLBACK_FAILED")
	}
	return SwitchResult{}, cause
}

func (s *Service) restoreCheckpointQuiet(ctx context.Context, cp *Checkpoint) error {
	if err := s.RestoreLiveAuthCheckpoint(ctx, cp); err != nil {
		return err
	}
	return s.DiscardLiveAuthCheckpoint(cp)
}

// refreshPreviousSnapshot saves the current live login back into the account
// being switched away from. Proxy-only snapshots hold no native login, so
// writing the live login into one would overwrite the credential the user
// typed in; they are skipped. Returns the refreshed account name, or "" when
// nothing was refreshed (including save failures, which the switch tolerates).
func (s *Service) refreshPreviousSnapshot(ctx context.Context, pv provider.Provider, previous string) string {
	live, err := pv.DetectLive()
	if err != nil || !live.Present {
		return ""
	}
	previousMeta, getErr := s.Store.Get(ctx, pv.ID(), previous)
	if getErr != nil || previousMeta == nil || previousMeta.Meta.CredentialKind == "proxy-only" {
		return ""
	}
	// A known different login must not replace the snapshot we are leaving.
	// writeMeta deletes that account's previous files in the same commit
	// (ADR 0004). Token rotation of the same identity still refreshes.
	if !liveRefreshAllowed(pv, previousMeta.SnapshotDir, previousMeta.Meta.Identity, live) {
		return ""
	}
	refreshed, saveErr := s.saveLiveIntoExistingAccount(ctx, pv, previous)
	if saveErr != nil {
		return ""
	}
	return refreshed
}

// liveRefreshAllowed reports whether the live login may be written back into
// the account being left. Providers with no matcher keep the historical
// refresh. A matcher that knows this is a different identity refuses.
func liveRefreshAllowed(pv provider.Provider, snapshotDir, savedIdentity string, live provider.LiveAuthStatus) bool {
	matcher, ok := pv.(provider.LiveMatcher)
	if !ok {
		return true
	}
	match, known, err := matcher.SnapshotMatchesLive(snapshotDir)
	if err != nil {
		return false
	}
	if !known || match {
		return true
	}
	return provider.AccountScopedIdentity(live.Identity) && identitiesEqual(savedIdentity, live.Identity)
}

// saveLiveIntoExistingAccount persists the current live login into an already
// saved account snapshot (refresh before switching away from it).
func (s *Service) saveLiveIntoExistingAccount(ctx context.Context, pv provider.Provider, name string) (string, error) {
	existing, err := s.Store.Get(ctx, pv.ID(), name)
	if err != nil || existing == nil {
		if err != nil {
			return "", err
		}
		return "", anyerr.Newf("No account \""+name+"\" for provider \""+pv.ID()+".",
			"ACCOUNT_NOT_FOUND", anyerr.WithExitCode(anyerr.NotFound))
	}
	snapshotDir, _, err := s.Store.PrepareSnapshot(pv.ID(), name)
	if err != nil {
		return "", err
	}
	info, err := pv.Backup(snapshotDir)
	if err != nil {
		_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
		return "", err
	}
	meta := existing.Meta
	meta.UpdatedAt = nowISO()
	if info.Identity != "" {
		meta.Identity = info.Identity
	}
	if err := s.Store.WriteMetaContext(ctx, meta, snapshotDir); err != nil {
		_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
		return "", err
	}
	_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
	return name, nil
}
