package update

import (
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// StatusSchema is the version of the JSON line contract that
// `anypick update check|download --json` writes and the macOS Settings >
// Updates pane decodes (UpdateStatusDTO in src/macos/UpdatesPane.swift).
// Bump it on any breaking field change.
const StatusSchema = 1

// ReleasesPageURL is where "View on GitHub" and manual fallbacks point.
const ReleasesPageURL = "https://github.com/outof0/anypick/releases"

// StatusDTO is the stable, JSON-tagged projection of UpdateState for shells.
// Every user-facing string the pane shows comes from here, so copy lives in
// one place (Go) instead of being duplicated in Swift/Tauri.
type StatusDTO struct {
	Schema        int     `json:"schema"`
	Kind          string  `json:"kind"`
	Current       string  `json:"current"`
	Latest        string  `json:"latest,omitempty"`
	Notes         string  `json:"notes,omitempty"`
	Channel       string  `json:"channel"`
	ActionKind    string  `json:"actionKind,omitempty"`
	Command       string  `json:"command,omitempty"`
	Lead          string  `json:"lead,omitempty"`
	DownloadAsset string  `json:"downloadAsset,omitempty"`
	ReleaseURL    string  `json:"releaseURL,omitempty"`
	Progress      float64 `json:"progress"`
	Message       string  `json:"message,omitempty"`
	Footnote      string  `json:"footnote,omitempty"`
	SkippedHint   string  `json:"skippedHint,omitempty"`
	Retry         bool    `json:"retry"`
	FilePath      string  `json:"filePath,omitempty"`
	LastChecked   string  `json:"lastChecked,omitempty"`
}

// Status-row copy for states Design has not locked yet. hostBlocked, ready,
// and the macOS footnote use the locked constants in commands.go.
const (
	copyChecking    = "Checking for updates…"
	copyOffline     = "Couldn't reach GitHub. Check your connection and try again."
	copyRateLimited = "GitHub is limiting update checks right now. Try again in a little while."
	copyGitHubDown  = "GitHub didn't return a usable release. Try again later."
	copyNotWritable = "AnyPick can't save the download to its cache folder. Download the update in your browser instead."
	copyStateStore  = "AnyPick couldn't read or save the update safety state. No update was downloaded. Check folder permissions, then retry."
	copyInstallFail = "Update didn't finish, so nothing was changed."
	copyDownloading = "Downloading the update…"
	copyVerifying   = "Checking the download against the release checksum…"
)

// BadChecksumCopy is the status-row copy when the download did not match.
func BadChecksumCopy(current string) string {
	return fmt.Sprintf("Update didn't finish. The download didn't match the release checksum, so it was deleted and nothing was changed. You're still on %s.", current)
}

// UpToDateCopy is the status-row copy after a check finds nothing newer.
func UpToDateCopy(current string) string {
	return fmt.Sprintf("AnyPick %s is the latest version.", current)
}

// NewStatusDTO projects st into the shell contract. goos decides whether the
// macOS-only Ready footnote applies.
func NewStatusDTO(st UpdateState, goos string) StatusDTO {
	d := StatusDTO{
		Schema:        StatusSchema,
		Kind:          string(st.Kind),
		Current:       st.Current,
		Latest:        st.Latest,
		Notes:         st.Notes,
		Channel:       string(st.Channel),
		ActionKind:    string(st.Action.Kind),
		Command:       st.Command,
		Lead:          st.Action.Lead,
		DownloadAsset: st.Action.DownloadAsset,
		Progress:      st.Progress,
		Message:       st.Message,
		SkippedHint:   st.SkippedHint,
		Retry:         st.Retry,
		ReleaseURL:    ReleasesPageURL,
	}
	if d.Command == "" {
		d.Command = st.Action.Command
	}
	if !st.LastChecked.IsZero() {
		d.LastChecked = st.LastChecked.UTC().Format(time.RFC3339)
	}
	if st.Latest != "" && st.Kind != StateUpToDate {
		d.ReleaseURL = ReleasesPageURL + "/tag/v" + st.Latest
	}
	if d.Message == "" {
		switch st.Kind {
		case StateChecking:
			d.Message = copyChecking
		case StateUpToDate:
			d.Message = UpToDateCopy(st.Current)
		case StateOffline:
			d.Message = copyOffline
		case StateRateLimited:
			d.Message = copyRateLimited
		case StateGitHubDown:
			d.Message = copyGitHubDown
		case StateNotWritable:
			d.Message = copyNotWritable
		case StateStorageUnavailable:
			d.Message = copyStateStore
		case StateInstallFailed:
			d.Message = copyInstallFail
		case StateDownloading:
			d.Message = copyDownloading
		case StateVerifying:
			d.Message = copyVerifying
		case StateBadChecksum:
			d.Message = BadChecksumCopy(st.Current)
		case StateReady:
			d.Message = ReadyAuthenticityLine
		}
	}
	if st.Kind == StateHostBlocked {
		// Locked: no Retry, View on GitHub only.
		d.Retry = false
		d.ActionKind = string(ActionManual)
		d.Command = ""
		d.Lead = "View on GitHub"
	}
	if st.Kind == StateBadChecksum {
		d.Retry = true
	}
	if st.Kind == StateStorageUnavailable {
		d.Retry = true
	}
	if st.Kind == StateReady && goos == "darwin" && st.Channel == ChannelDirect {
		d.Footnote = MacOSReadyFootnote
	}
	return d
}

// WriteStatusLine writes d as one compact JSON line (NDJSON). Shells read the
// stream line by line; the last line is the final state.
func WriteStatusLine(w io.Writer, d StatusDTO) error {
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	_, err = w.Write(append(raw, '\n'))
	return err
}
