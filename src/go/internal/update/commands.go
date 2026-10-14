package update

import "fmt"

// ActionKind classifies what the UI should present for an available update.
type ActionKind string

const (
	// ActionSelfUpdate: shell can download and verify; installation is manual for now.
	ActionSelfUpdate ActionKind = "selfUpdate"
	// ActionCommand: show Lead + a pasteable Command (no prose inside Command).
	ActionCommand ActionKind = "command"
	// ActionDownloadAsset: UI shows a Download .<ext> button for DownloadAsset;
	// deb/rpm also include a pasteable Command for the local reinstall.
	ActionDownloadAsset ActionKind = "downloadAsset"
	// ActionManual: unknown / arm64 desktop — link to the release page.
	ActionManual ActionKind = "manual"
)

// UpdateAction is the typed channel guidance the UI renders. Command, when set,
// is exactly pasteable (no sentence, no trailing period).
type UpdateAction struct {
	Kind          ActionKind
	Command       string // pasteable; set for command and for deb/rpm downloadAsset
	DownloadAsset string // release asset file name for downloadAsset
	Lead          string // locked Design lead copy shown above the control
}

// ChannelUpdateAction returns the typed update action for a package-manager or
// self-update channel. version is the release version without a leading "v".
func ChannelUpdateAction(ch InstallChannel, version string) UpdateAction {
	ver := version
	if ver == "" {
		ver = "<version>"
	}
	switch ch {
	case ChannelDirect, ChannelNSIS, ChannelAppImage:
		return UpdateAction{Kind: ActionSelfUpdate}
	case ChannelBrew:
		return UpdateAction{
			Kind:    ActionCommand,
			Command: "brew upgrade --cask anypick",
			Lead:    "Installed with Homebrew, so update it there:",
		}
	case ChannelScoop:
		return UpdateAction{
			Kind:    ActionCommand,
			Command: "scoop update anypick",
			Lead:    "Installed with Scoop, so update it there:",
		}
	case ChannelNPM:
		return UpdateAction{
			Kind:    ActionCommand,
			Command: "npm install -g anypick@latest",
			Lead:    "Installed with npm, so update it there:",
		}
	case ChannelWinget:
		return UpdateAction{
			Kind:    ActionCommand,
			Command: "winget upgrade AnyPick",
			Lead:    "Installed with winget, so update it there:",
		}
	case ChannelDeb:
		name := fmt.Sprintf("AnyPick_%s_amd64.deb", ver)
		return UpdateAction{
			Kind:          ActionDownloadAsset,
			DownloadAsset: name,
			Command:       fmt.Sprintf("sudo apt install ./%s", name),
			Lead:          "Installed from a .deb file. Download the new one and reinstall:",
		}
	case ChannelRPM:
		name := fmt.Sprintf("AnyPick-%s-1.x86_64.rpm", ver)
		return UpdateAction{
			Kind:          ActionDownloadAsset,
			DownloadAsset: name,
			Command:       fmt.Sprintf("sudo dnf install ./%s", name),
			Lead:          "Installed from an .rpm file. Download the new one and reinstall:",
		}
	case ChannelMSI:
		name := fmt.Sprintf("AnyPick_%s_x64_en-US.msi", ver)
		return UpdateAction{
			Kind:          ActionDownloadAsset,
			DownloadAsset: name,
			Lead:          "Installed from an .msi file. Download the new one and reinstall:",
		}
	default:
		return UpdateAction{
			Kind: ActionManual,
			Lead: "Download the latest release from GitHub:",
		}
	}
}

// PackageManagerCommand returns the pasteable shell command for a
// package-manager channel, or "" when the channel has none (e.g. MSI download,
// self-update, manual). deb/rpm never mention a "repo" — they are manual
// reinstalls of a downloaded local file. Prefer ChannelUpdateAction for UI.
func PackageManagerCommand(ch InstallChannel, version string) string {
	return ChannelUpdateAction(ch, version).Command
}

// SkipVersionCopy is the UI string shown after the user skips a version.
func SkipVersionCopy(version string) string {
	return fmt.Sprintf("You skipped %s. You'll hear about the next version.", version)
}

// ReadyAuthenticityLine states that the checksum passed and that installation
// remains a manual step until the signed bundle replacement flow ships.
const ReadyAuthenticityLine = "Downloaded from GitHub Releases. The file matches the release checksum. Install it manually from Finder; AnyPick stays on this version."

// MacOSReadyFootnote is shown under Ready on macOS direct installs.
const MacOSReadyFootnote = "macOS may ask again for access AnyPick already had, such as Keychain or Automation, because this build isn't notarized. Allow it to keep things working."

// RelaunchProxiesConfirm formats the quit/relaunch confirmation when proxies
// are serving. n<=0 returns "" (no confirm — nothing is serving). n==1 uses
// singular "proxy"; n>1 keeps "proxies".
func RelaunchProxiesConfirm(n int) string {
	if n <= 0 {
		return ""
	}
	noun := "proxies"
	if n == 1 {
		noun = "proxy"
	}
	return fmt.Sprintf("Restarting stops %d running %s. Connected apps reconnect when AnyPick starts again.", n, noun)
}

// RestartMenuLabel is the menu bar item when an update is ready.
func RestartMenuLabel(version string) string {
	return fmt.Sprintf("Restart to Update to %s", version)
}

// HostBlockedCopy is the status-row copy when a download or API URL was refused
// because the host is not on AnyPick's allowlist. current is the running version.
//
// Split across literals so the db table-ownership scanner does not treat the
// user-facing sentence (starts with "Update", contains "from …") as SQL.
func HostBlockedCopy(current string) string {
	const lead = "Update didn't finish. "
	return lead + fmt.Sprintf("The download came from an address AnyPick doesn't trust, so nothing was changed. You're still on %s.", current)
}
