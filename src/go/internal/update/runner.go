package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// maxDownloadBytes is the hard ceiling on an update asset download. Declared
// sizes above this are refused up front. When Asset.Size is 0 or unknown the
// same ceiling still bounds the body so a missing size cannot fill the disk.
var maxDownloadBytes int64 = 512 << 20 // 512 MiB

// Runner drives one check or one download for a shell and reports every
// intermediate state through Emit. It is the bridge behind
// `anypick update check --json` and `anypick update download --json`.
type Runner struct {
	Checker   *Checker
	Transport *Transport // download allowlisted transport; nil → NewDownloadTransport
	Env       Env
	CacheDir  string // e.g. ~/Library/Caches/AnyPick/update
	Emit      func(StatusDTO)
}

func (r *Runner) env() Env {
	if r.Env != nil {
		return r.Env
	}
	return OSEnv{}
}

func (r *Runner) goos() string {
	if r.Checker != nil {
		return r.Checker.GOOS
	}
	return ""
}

func (r *Runner) emit(st UpdateState) StatusDTO {
	d := NewStatusDTO(st, r.goos())
	if r.Emit != nil {
		r.Emit(d)
	}
	return d
}

// Check runs a manual check (throttle bypassed) and returns the final state.
func (r *Runner) Check(ctx context.Context, current string, ch InstallChannel) StatusDTO {
	if name := HookFixture(r.env()); name != "" {
		return r.fixture(name, current, ch, false)
	}
	res := r.check(ctx, current, ch)
	return r.emit(res.State)
}

func (r *Runner) check(ctx context.Context, current string, ch InstallChannel) CheckResult {
	if hook := HookCurrentVersion(r.env()); hook != "" {
		current = hook
	}
	r.emit(UpdateState{Kind: StateChecking, Current: current, Channel: ch})
	return r.Checker.Check(ctx, CheckInput{
		Current:  current,
		Settings: DefaultSettings(),
		Channel:  ch,
		Manual:   true,
	})
}

// Download checks, then (only for availableDirect) downloads the asset into
// CacheDir/<version>/, enforcing the size cap, and verifies its SHA-256
// against SHA256SUMS.txt from the same release. A mismatch deletes the file
// and ends in badChecksum. Nothing outside CacheDir is touched: staging,
// bundle swap, and relaunch are slice 4.
func (r *Runner) Download(ctx context.Context, current string, ch InstallChannel) StatusDTO {
	if name := HookFixture(r.env()); name != "" {
		return r.fixture(name, current, ch, true)
	}
	res := r.check(ctx, current, ch)
	st := res.State
	if st.Kind != StateAvailableDirect || res.Release == nil || st.Asset == nil {
		return r.emit(st)
	}
	tr := r.Transport
	if tr == nil {
		tr = NewDownloadTransport()
	}
	fail := func(err error) StatusDTO {
		applyFetchError(&st, err)
		st.Progress = 0
		return r.emit(st)
	}

	rel, err := AttachChecksums(ctx, tr, *res.Release)
	if err != nil {
		return fail(err)
	}
	asset := *st.Asset
	if err := ValidateAssetName(asset.Name); err != nil {
		return fail(err)
	}
	if err := RequireChecksums(rel.Assets, asset.Name); err != nil {
		st.Kind = StateBadChecksum
		st.Err = err
		return r.emit(st)
	}
	if a, ok := FindAsset(rel, asset.Name); ok {
		asset = a
	}
	if HookFault(r.env()) == "checksum-mismatch" {
		asset.SHA256 = strings.Repeat("0", 64)
	}

	if r.CacheDir == "" {
		return fail(errors.New("no update cache directory"))
	}
	dir := filepath.Join(r.CacheDir, rel.Version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		st.Kind = StateNotWritable
		st.Err = err
		return r.emit(st)
	}
	dest := filepath.Join(dir, asset.Name)

	st.Kind = StateDownloading
	st.Progress = 0
	r.emit(st)
	if err := r.fetchTo(ctx, tr, asset, dest, &st); err != nil {
		_ = os.Remove(dest)
		st.Kind = StateDownloading
		return fail(err)
	}

	st.Kind = StateVerifying
	st.Progress = 1
	r.emit(st)
	if err := VerifyFileSHA256(dest, asset.SHA256); err != nil {
		_ = os.Remove(dest)
		st.Kind = StateBadChecksum
		st.Err = err
		return r.emit(st)
	}
	st.Kind = StateReady
	d := NewStatusDTO(st, r.goos())
	d.FilePath = dest
	if r.Emit != nil {
		r.Emit(d)
	}
	return d
}

func (r *Runner) fetchTo(ctx context.Context, tr *Transport, asset Asset, dest string, st *UpdateState) error {
	resp, err := DownloadAsset(ctx, tr, asset.URL)
	if err != nil {
		var denied *ErrDeniedURL
		if errors.As(err, &denied) || errors.Is(err, ErrHostNotAllowed) {
			return err
		}
		return &ErrOffline{Err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", asset.Name, resp.StatusCode)
	}
	if asset.Size > maxDownloadBytes {
		return fmt.Errorf("download %s declared size %d exceeds the %d-byte limit",
			asset.Name, asset.Size, maxDownloadBytes)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	// Always bound the body: declared size when known, else the hard maximum.
	limit := maxDownloadBytes
	if asset.Size > 0 {
		limit = asset.Size
	}
	body := io.LimitReader(resp.Body, limit+1)
	buf := make([]byte, 64<<10)
	var written int64
	lastStep := -1
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			written += int64(n)
			if written > limit {
				if asset.Size > 0 {
					return fmt.Errorf("download %s exceeds its declared size", asset.Name)
				}
				return fmt.Errorf("download %s exceeds the %d-byte limit", asset.Name, maxDownloadBytes)
			}
			if asset.Size > 0 {
				st.Progress = float64(written) / float64(asset.Size)
				if step := int(st.Progress * 20); step != lastStep {
					lastStep = step
					r.emit(*st)
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return &ErrOffline{Err: rerr}
		}
	}
	if asset.Size > 0 && written != asset.Size {
		return &ErrOffline{Err: fmt.Errorf("download %s truncated", asset.Name)}
	}
	return f.Close()
}

// FixtureNames lists every state ANYPICK_UPDATE_FIXTURE accepts.
func FixtureNames() []string {
	return []string{
		"checking", "upToDate", "availableDirect", "availablePackageManager",
		"downloading", "verifying", "ready", "offline", "badChecksum", "hostBlocked",
		"rateLimited", "notWritable",
	}
}

const fixtureNotes = "## What's new\n- Settings > Updates checks GitHub Releases for you.\n- Fixed the Add App… button lining up with the cards.\n"

// FixtureState returns a canned state for QA. ch only matters for
// availablePackageManager (defaults to brew when ch is a self-update channel).
func FixtureState(name, current string, ch InstallChannel) (UpdateState, bool) {
	if current == "" {
		current = "1.1.0"
	}
	const latest = "1.1.1"
	st := UpdateState{Current: current, Latest: latest, Notes: fixtureNotes, Channel: ch}
	switch name {
	case "checking":
		st = UpdateState{Kind: StateChecking, Current: current, Channel: ch}
	case "upToDate":
		st = UpdateState{Kind: StateUpToDate, Current: current, Latest: current, Channel: ch}
	case "availableDirect", "available":
		st.Kind = StateAvailableDirect
		st.Channel = ChannelDirect
		st.Action = UpdateAction{Kind: ActionSelfUpdate}
	case "availablePackageManager", "brew":
		if ch == "" || IsSelfUpdate(ch) || ch == ChannelUnknown {
			ch = ChannelBrew
		}
		st.Kind = StateAvailablePackageManager
		st.Channel = ch
		st.Action = ChannelUpdateAction(ch, latest)
		st.Command = st.Action.Command
	case "downloading":
		st.Kind = StateDownloading
		st.Channel = ChannelDirect
		st.Progress = 0.42
	case "verifying":
		st.Kind = StateVerifying
		st.Channel = ChannelDirect
		st.Progress = 1
	case "ready":
		st.Kind = StateReady
		st.Channel = ChannelDirect
		st.Progress = 1
	case "offline":
		st = UpdateState{Current: current, Channel: ch}
		applyFetchError(&st, &ErrOffline{Err: errors.New("fixture")})
	case "rateLimited":
		st = UpdateState{Current: current, Channel: ch}
		applyFetchError(&st, ErrRateLimited)
	case "hostBlocked":
		st.Channel = ChannelDirect
		applyFetchError(&st, &ErrDeniedURL{Err: ErrHostNotAllowed})
	case "badChecksum":
		st.Kind = StateBadChecksum
		st.Channel = ChannelDirect
	case "notWritable":
		st.Kind = StateNotWritable
		st.Channel = ChannelDirect
	default:
		return UpdateState{}, false
	}
	return st, true
}

func (r *Runner) fixture(name, current string, ch InstallChannel, _ bool) StatusDTO {
	if hook := HookCurrentVersion(r.env()); hook != "" {
		current = hook
	}
	st, ok := FixtureState(name, current, ch)
	if !ok {
		st = UpdateState{Kind: StateGitHubDown, Current: current, Channel: ch, Retry: true,
			Message: fmt.Sprintf("Unknown %s %q. Use one of: %s.", EnvFixture, name, strings.Join(FixtureNames(), ", "))}
	}
	d := NewStatusDTO(st, r.goos())
	if st.Kind == StateReady {
		d.FilePath = filepath.Join(r.CacheDir, "1.1.1", "AnyPick-macos-universal.zip")
	}
	if r.Emit != nil {
		r.Emit(d)
	}
	return d
}
