// Package update implements in-app update decision logic for the Go core:
// channel detection, GitHub release fetch, semver compare, asset selection,
// SHA-256 checksum verify, throttle, and testing hooks.
//
// Slice 1 is pure decision logic — no desktop protocol wiring and no UI.
// See docs/design/in-app-update.md.
package update

import (
	"time"
)

// InstallChannel is how the running binary was installed.
type InstallChannel string

const (
	ChannelDirect   InstallChannel = "direct"
	ChannelBrew     InstallChannel = "brew"
	ChannelNSIS     InstallChannel = "nsis"
	ChannelMSI      InstallChannel = "msi"
	ChannelWinget   InstallChannel = "winget"
	ChannelScoop    InstallChannel = "scoop"
	ChannelNPM      InstallChannel = "npm"
	ChannelDeb      InstallChannel = "deb"
	ChannelRPM      InstallChannel = "rpm"
	ChannelAppImage InstallChannel = "appimage"
	ChannelUnknown  InstallChannel = "unknown"
)

// StateKind is one value of the update state machine.
type StateKind string

const (
	StateIdle                    StateKind = "idle"
	StateChecking                StateKind = "checking"
	StateUpToDate                StateKind = "upToDate"
	StateAvailableDirect         StateKind = "availableDirect"
	StateAvailablePackageManager StateKind = "availablePackageManager"
	StateNotWritable             StateKind = "notWritable"
	StateDownloading             StateKind = "downloading"
	StateVerifying               StateKind = "verifying"
	StateReady                   StateKind = "ready"
	StateOffline                 StateKind = "offline"
	StateRateLimited             StateKind = "rateLimited"
	StateGitHubDown              StateKind = "githubDown"
	StateHostBlocked             StateKind = "hostBlocked"
	StateBadChecksum             StateKind = "badChecksum"
	StateInstallFailed           StateKind = "installFailed"
)

// Asset is one downloadable file on a GitHub release.
type Asset struct {
	Name   string
	URL    string
	Size   int64
	SHA256 string // filled from SHA256SUMS.txt when available
}

// Release is a published GitHub release (drafts/prereleases are filtered out).
type Release struct {
	Tag         string
	Version     string // semver without leading "v"
	Notes       string
	PublishedAt time.Time
	Prerelease  bool
	Draft       bool
	Assets      []Asset
	HTMLURL     string
}

// UpdateSettings persists check preferences and feed cache metadata.
//
// AutoDownload defaults false and is forced false whenever AutoCheck is false.
// It means: download+verify in the background, install on next quit — never
// relaunch when idle. The UI label is "Download updates automatically".
type UpdateSettings struct {
	AutoCheck      bool
	AutoDownload   bool
	SkippedVersion string
	LastChecked    time.Time
	ETag           string
	HighestSeen    string
}

// DefaultSettings returns the documented defaults.
func DefaultSettings() UpdateSettings {
	return UpdateSettings{AutoCheck: true, AutoDownload: false}
}

// Normalize enforces the AutoCheck/AutoDownload invariant.
func (s UpdateSettings) Normalize() UpdateSettings {
	if !s.AutoCheck {
		s.AutoDownload = false
	}
	return s
}

// UpdateState is the value the UI / CLI renders.
type UpdateState struct {
	Kind        StateKind
	Current     string
	Latest      string
	Notes       string
	Command     string       // pasteable command from Action, when set
	Action      UpdateAction // typed channel guidance (selfUpdate/command/downloadAsset/manual)
	Channel     InstallChannel
	Asset       *Asset
	Progress    float64
	Err         error
	LastChecked time.Time
	SkippedHint string // set when a manual check surfaces a skipped version
	Message     string // UI status-row copy for error-like states (e.g. hostBlocked)
	Retry       bool   // UI Retry control; false for hostBlocked
}
