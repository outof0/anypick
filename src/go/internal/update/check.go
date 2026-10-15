package update

import (
	"context"
	"errors"
	"time"
)

// CheckThrottle is how long AutoCheck waits between network fetches.
const CheckThrottle = 24 * time.Hour

// Checker runs an update check against a Fetcher.
type Checker struct {
	Fetcher Fetcher
	Clock   Clock
	Env     Env
	GOOS    string
	GOARCH  string
}

// CheckInput is everything Check needs besides the Checker deps.
type CheckInput struct {
	Current  string // running version (buildinfo.Version or hook)
	Settings UpdateSettings
	Channel  InstallChannel
	Manual   bool     // true → bypass throttle and SkippedVersion hide
	Cached   *Release // previous release kept across 304
}

// CheckResult is the outcome of one check.
type CheckResult struct {
	State    UpdateState
	Settings UpdateSettings // updated LastChecked / ETag / HighestSeen
	Release  *Release
}

// Check fetches (unless throttled), compares versions, and returns a state.
// Network/rate-limit failures never panic; they become offline/rateLimited/
// hostBlocked. Host-allowlist refusals are never classified as offline.
func (c *Checker) Check(ctx context.Context, in CheckInput) CheckResult {
	clock := HookClock(c.Env, c.Clock)
	now := clock.Now()
	settings := in.Settings.Normalize()
	current := in.Current
	if hook := HookCurrentVersion(c.Env); hook != "" {
		current = hook
	}

	st := UpdateState{
		Kind:        StateChecking,
		Current:     current,
		Channel:     in.Channel,
		LastChecked: settings.LastChecked,
	}

	// Throttle automatic checks. A LastChecked in the future (clock rollback)
	// counts as expired so we refetch rather than trusting a skewed clock.
	if !in.Manual && settings.AutoCheck && !settings.LastChecked.IsZero() {
		elapsed := now.Sub(settings.LastChecked)
		if elapsed >= 0 && elapsed < CheckThrottle {
			return c.concludeFromCached(in, settings, current, now)
		}
	}
	if !settings.AutoCheck && !in.Manual {
		st.Kind = StateIdle
		return CheckResult{State: st, Settings: settings, Release: in.Cached}
	}

	if c.Fetcher == nil {
		st.Kind = StateOffline
		st.Err = errors.New("no fetcher")
		return CheckResult{State: st, Settings: settings}
	}

	rel, newETag, notModified, err := c.Fetcher.Latest(ctx, settings.ETag)
	settings.LastChecked = now
	if newETag != "" {
		settings.ETag = newETag
	}

	if err != nil {
		st.LastChecked = now
		applyFetchError(&st, err)
		return CheckResult{State: st, Settings: settings, Release: in.Cached}
	}

	var release *Release
	if notModified {
		release = in.Cached
		if release == nil {
			// 304 with no cached release must NOT report upToDate. Refetch
			// without If-None-Match so we have a body to evaluate.
			rel2, newETag2, notMod2, err2 := c.Fetcher.Latest(ctx, "")
			if newETag2 != "" {
				settings.ETag = newETag2
			}
			if err2 != nil {
				st.LastChecked = now
				applyFetchError(&st, err2)
				return CheckResult{State: st, Settings: settings}
			}
			if notMod2 {
				st.Kind = StateGitHubDown
				st.Err = errors.New("304 with empty cache and empty body")
				st.LastChecked = now
				return CheckResult{State: st, Settings: settings}
			}
			release = &rel2
		}
	} else {
		release = &rel
	}

	return c.evaluate(settings, current, in.Channel, in.Manual, release, now)
}

func (c *Checker) concludeFromCached(in CheckInput, settings UpdateSettings, current string, now time.Time) CheckResult {
	if in.Cached == nil {
		st := UpdateState{Kind: StateIdle, Current: current, Channel: in.Channel, LastChecked: settings.LastChecked}
		return CheckResult{State: st, Settings: settings}
	}
	return c.evaluate(settings, current, in.Channel, false, in.Cached, now)
}

func (c *Checker) evaluate(settings UpdateSettings, current string, ch InstallChannel, manual bool, release *Release, now time.Time) CheckResult {
	st := UpdateState{
		Current:     current,
		Channel:     ch,
		LastChecked: now,
		Notes:       release.Notes,
		Latest:      release.Version,
	}
	settings.HighestSeen = MaxVersion(settings.HighestSeen, release.Version)
	if result, done := evaluateReleaseVersion(settings, current, release, st); done {
		return result
	}
	if skipRelease(settings, release, manual, &st) {
		return CheckResult{State: st, Settings: settings, Release: release}
	}
	return c.evaluateAvailable(settings, ch, release, st)
}

func evaluateReleaseVersion(settings UpdateSettings, current string, release *Release, st UpdateState) (CheckResult, bool) {
	newer, err := IsNewer(release.Version, current)
	if err != nil {
		// Non-semver current (e.g. "--current (devel)" / tip-of-tree) cannot be
		// compared. Treat it as a dev/unknown build: never crash and never
		// offer a bogus upgrade or downgrade against a release.
		if _, cerr := ParseVersion(current); cerr != nil {
			st.Kind = StateUpToDate
			st.Latest = current
			return CheckResult{State: st, Settings: settings, Release: release}, true
		}
		st.Kind = StateGitHubDown
		st.Err = err
		return CheckResult{State: st, Settings: settings, Release: release}, true
	}
	if !newer {
		// Refuse downgrades / equal — including when HighestSeen is ahead of feed.
		st.Kind = StateUpToDate
		st.Latest = current
		return CheckResult{State: st, Settings: settings, Release: release}, true
	}

	// HighestSeen resistance: if we previously saw something newer than this
	// feed's latest, do not offer a rollback as an update.
	if settings.HighestSeen != "" {
		if ahead, err := IsNewer(settings.HighestSeen, release.Version); err == nil && ahead {
			st.Kind = StateUpToDate
			st.Latest = settings.HighestSeen
			return CheckResult{State: st, Settings: settings, Release: release}, true
		}
	}
	return CheckResult{}, false
}

func skipRelease(settings UpdateSettings, release *Release, manual bool, st *UpdateState) bool {
	if settings.SkippedVersion == "" {
		return false
	}
	skipped, err := ParseVersion(settings.SkippedVersion)
	latest, err2 := ParseVersion(release.Version)
	if err != nil || err2 != nil || Compare(skipped, latest) != 0 {
		return false
	}
	st.SkippedHint = SkipVersionCopy(release.Version)
	if !manual {
		st.Kind = StateUpToDate
		return true
	}
	return false
}

func (c *Checker) evaluateAvailable(settings UpdateSettings, ch InstallChannel, release *Release, st UpdateState) CheckResult {
	action := ChannelUpdateAction(ch, release.Version)
	asset, assetErr := PickAsset(*release, c.GOOS, c.GOARCH, ch)
	if IsPackageManager(ch) || IsCLIOnly(ch) {
		st.Kind = StateAvailablePackageManager
		st.Action = action
		st.Command = action.Command
		if assetErr == nil {
			st.Asset = &asset
			if action.DownloadAsset == "" && action.Kind == ActionDownloadAsset {
				st.Action.DownloadAsset = asset.Name
			}
		}
		return CheckResult{State: st, Settings: settings, Release: release}
	}
	if assetErr != nil {
		// arm64 desktop / unknown: manual download fallback.
		st.Kind = StateAvailablePackageManager
		manualAction := UpdateAction{
			Kind: ActionManual,
			Lead: "Download the latest release from GitHub:",
		}
		st.Action = manualAction
		st.Command = ManualDownloadURL(*release, Asset{})
		return CheckResult{State: st, Settings: settings, Release: release}
	}
	st.Kind = StateAvailableDirect
	st.Action = UpdateAction{Kind: ActionSelfUpdate}
	st.Asset = &asset
	return CheckResult{State: st, Settings: settings, Release: release}
}

func isOffline(err error) bool {
	var off *ErrOffline
	return errors.As(err, &off)
}

// applyFetchError maps a fetcher error onto st. Host-allowlist refusals become
// StateHostBlocked (never offline), with Retry=false and a View on GitHub
// action. Matching uses errors.Is(ErrHostNotAllowed), not error text.
func applyFetchError(st *UpdateState, err error) {
	st.Err = err
	switch {
	case errors.Is(err, ErrRateLimited):
		st.Kind = StateRateLimited
		st.Retry = true
	case errors.Is(err, ErrHostNotAllowed):
		st.Kind = StateHostBlocked
		st.Retry = false
		st.Message = HostBlockedCopy(st.Current)
		st.Action = UpdateAction{Kind: ActionManual, Lead: "View on GitHub"}
		st.Command = "https://github.com/outof0/anypick/releases"
	case isOffline(err):
		st.Kind = StateOffline
		st.Retry = true
	default:
		st.Kind = StateGitHubDown
		st.Retry = true
	}
}
