package update

import (
	"fmt"
	"runtime"
	"strings"
)

// PickAsset selects the release asset for the given OS/arch/channel, matching
// the real v1.1.0 naming conventions.
//
//	macOS direct/brew desktop: AnyPick-macos-universal.zip
//	Windows NSIS:              AnyPick_<ver>_x64-setup.exe
//	Windows MSI:               AnyPick_<ver>_x64_en-US.msi
//	Windows winget:            AnyPick-<ver>-windows-x64.msi
//	Linux AppImage:            AnyPick_<ver>_amd64.AppImage
//	Linux deb:                 AnyPick_<ver>_amd64.deb
//	Linux rpm:                 AnyPick-<ver>-1.x86_64.rpm
//	CLI archives:              anypick-<ver>-{darwin,linux,windows}-{amd64,arm64}.{tar.gz,zip}
//
// arm64 desktop GUI bundles do not exist for linux/windows → returns error so
// the caller can fall back to a manual download link.
func PickAsset(rel Release, goos, goarch string, ch InstallChannel) (Asset, error) {
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	ver := rel.Version
	if ver == "" {
		v, err := ParseVersion(rel.Tag)
		if err != nil {
			return Asset{}, err
		}
		ver = v.String()
	}
	want, err := assetName(ver, goos, goarch, ch)
	if err != nil {
		return Asset{}, err
	}
	for _, a := range rel.Assets {
		if a.Name == want {
			return a, nil
		}
	}
	return Asset{}, fmt.Errorf("no asset %q in release %s", want, rel.Tag)
}

func assetName(ver, goos, goarch string, ch InstallChannel) (string, error) {
	switch ch {
	case ChannelBrew, ChannelDirect:
		if goos == "darwin" {
			return "AnyPick-macos-universal.zip", nil
		}
		if goos == "linux" {
			// direct on linux without APPIMAGE is unusual; prefer AppImage name
			// when arch is amd64, else manual.
			if goarch == "amd64" {
				return fmt.Sprintf("AnyPick_%s_amd64.AppImage", ver), nil
			}
			return "", fmt.Errorf("no desktop asset for linux/%s (manual download)", goarch)
		}
		if goos == "windows" {
			if goarch != "amd64" {
				return "", fmt.Errorf("no desktop asset for windows/%s (manual download)", goarch)
			}
			return fmt.Sprintf("AnyPick_%s_x64-setup.exe", ver), nil
		}
	case ChannelNSIS:
		if goarch != "amd64" {
			return "", fmt.Errorf("no NSIS asset for windows/%s", goarch)
		}
		return fmt.Sprintf("AnyPick_%s_x64-setup.exe", ver), nil
	case ChannelMSI:
		if goarch != "amd64" {
			return "", fmt.Errorf("no MSI asset for windows/%s", goarch)
		}
		return fmt.Sprintf("AnyPick_%s_x64_en-US.msi", ver), nil
	case ChannelWinget:
		if goarch != "amd64" {
			return "", fmt.Errorf("no winget asset for windows/%s", goarch)
		}
		return fmt.Sprintf("AnyPick-%s-windows-x64.msi", ver), nil
	case ChannelAppImage:
		if goarch != "amd64" {
			return "", fmt.Errorf("no AppImage for linux/%s (manual download)", goarch)
		}
		return fmt.Sprintf("AnyPick_%s_amd64.AppImage", ver), nil
	case ChannelDeb:
		return fmt.Sprintf("AnyPick_%s_amd64.deb", ver), nil
	case ChannelRPM:
		return fmt.Sprintf("AnyPick-%s-1.x86_64.rpm", ver), nil
	case ChannelScoop, ChannelNPM, ChannelUnknown:
		return cliArchiveName(ver, goos, goarch)
	}
	return cliArchiveName(ver, goos, goarch)
}

func cliArchiveName(ver, goos, goarch string) (string, error) {
	osPart := goos
	switch goos {
	case "darwin":
		osPart = "darwin"
	case "linux":
		osPart = "linux"
	case "windows":
		osPart = "windows"
	default:
		return "", fmt.Errorf("unsupported GOOS %q", goos)
	}
	arch := goarch
	switch goarch {
	case "amd64", "arm64":
	default:
		return "", fmt.Errorf("unsupported GOARCH %q", goarch)
	}
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("anypick-%s-%s-%s.%s", ver, osPart, arch, ext), nil
}

// ManualDownloadURL returns the browser download URL for an asset, or the
// release HTML page when no asset matches.
func ManualDownloadURL(rel Release, asset Asset) string {
	if asset.URL != "" {
		return asset.URL
	}
	if rel.HTMLURL != "" {
		return rel.HTMLURL
	}
	return "https://github.com/outof0/anypick/releases/latest"
}

// FindAsset returns the asset with the given name, if any.
func FindAsset(rel Release, name string) (Asset, bool) {
	for _, a := range rel.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return Asset{}, false
}

// NormalizeArch maps GOARCH aliases.
func NormalizeArch(arch string) string {
	switch strings.ToLower(arch) {
	case "x86_64", "x64":
		return "amd64"
	case "aarch64":
		return "arm64"
	default:
		return arch
	}
}
