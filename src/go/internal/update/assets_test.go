package update

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func v110Assets() Release {
	names := []string{
		"AnyPick-macos-universal.zip",
		"AnyPick-macos-universal.dmg",
		"AnyPick_1.1.0_x64-setup.exe",
		"AnyPick_1.1.0_x64_en-US.msi",
		"AnyPick-1.1.0-windows-x64.msi",
		"AnyPick_1.1.0_amd64.AppImage",
		"AnyPick_1.1.0_amd64.deb",
		"AnyPick-1.1.0-1.x86_64.rpm",
		"anypick-1.1.0-darwin-amd64.tar.gz",
		"anypick-1.1.0-darwin-arm64.tar.gz",
		"anypick-1.1.0-linux-amd64.tar.gz",
		"anypick-1.1.0-linux-arm64.tar.gz",
		"anypick-1.1.0-windows-amd64.zip",
		"anypick-1.1.0-windows-arm64.zip",
		"SHA256SUMS.txt",
	}
	var assets []Asset
	for _, n := range names {
		assets = append(assets, Asset{Name: n, URL: "https://github.com/outof0/anypick/releases/download/v1.1.0/" + n})
	}
	return Release{Tag: "v1.1.0", Version: "1.1.0", Assets: assets, HTMLURL: "https://github.com/outof0/anypick/releases/tag/v1.1.0"}
}

func TestPickAssetV110Names(t *testing.T) {
	rel := v110Assets()
	cases := []struct {
		goos, goarch string
		ch           InstallChannel
		want         string
	}{
		{"darwin", "arm64", ChannelDirect, "AnyPick-macos-universal.zip"},
		{"darwin", "amd64", ChannelBrew, "AnyPick-macos-universal.zip"},
		{"windows", "amd64", ChannelNSIS, "AnyPick_1.1.0_x64-setup.exe"},
		{"windows", "amd64", ChannelMSI, "AnyPick_1.1.0_x64_en-US.msi"},
		{"windows", "amd64", ChannelWinget, "AnyPick-1.1.0-windows-x64.msi"},
		{"linux", "amd64", ChannelAppImage, "AnyPick_1.1.0_amd64.AppImage"},
		{"linux", "amd64", ChannelDeb, "AnyPick_1.1.0_amd64.deb"},
		{"linux", "amd64", ChannelRPM, "AnyPick-1.1.0-1.x86_64.rpm"},
		{"linux", "amd64", ChannelNPM, "anypick-1.1.0-linux-amd64.tar.gz"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			a, err := PickAsset(rel, tc.goos, tc.goarch, tc.ch)
			if err != nil {
				t.Fatal(err)
			}
			if a.Name != tc.want {
				t.Fatalf("got %q", a.Name)
			}
		})
	}
}

func TestPickAssetArm64DesktopFallback(t *testing.T) {
	rel := v110Assets()
	_, err := PickAsset(rel, "linux", "arm64", ChannelDirect)
	if err == nil {
		t.Fatal("expected manual-download error for linux/arm64 desktop")
	}
	_, err = PickAsset(rel, "windows", "arm64", ChannelNSIS)
	if err == nil {
		t.Fatal("expected error for windows/arm64 NSIS")
	}
}

func TestPackageManagerCommands(t *testing.T) {
	if got := PackageManagerCommand(ChannelDeb, "1.2.0"); got != "sudo apt install ./AnyPick_1.2.0_amd64.deb" {
		t.Fatalf("deb: %q", got)
	}
	if got := PackageManagerCommand(ChannelRPM, "1.2.0"); got != "sudo dnf install ./AnyPick-1.2.0-1.x86_64.rpm" {
		t.Fatalf("rpm: %q", got)
	}
	if got := PackageManagerCommand(ChannelWinget, "1.2.0"); got != "winget upgrade AnyPick" {
		t.Fatalf("winget: %q", got)
	}
	for _, ch := range []InstallChannel{ChannelDeb, ChannelRPM} {
		cmd := PackageManagerCommand(ch, "1.0.0")
		if containsFold(cmd, "repo") {
			t.Fatalf("%s command must not say repo: %q", ch, cmd)
		}
	}
}

func loadV110AssetNames(t *testing.T) map[string]bool {
	t.Helper()
	path := filepath.Join("testdata", "v1.1.0-assets.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Assets []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(b, &payload); err != nil {
		t.Fatal(err)
	}
	out := make(map[string]bool, len(payload.Assets))
	for _, a := range payload.Assets {
		out[a.Name] = true
	}
	if !out["AnyPick-macos-universal.dmg"] {
		t.Fatal("fixture missing dmg (expected in real v1.1.0)")
	}
	return out
}

func TestCommandsFromRealV110Assets(t *testing.T) {
	names := loadV110AssetNames(t)
	ver := "1.1.0"
	channels := []struct {
		ch   InstallChannel
		goos string
		arch string
	}{
		{ChannelBrew, "darwin", "arm64"},
		{ChannelScoop, "windows", "amd64"},
		{ChannelNPM, "linux", "amd64"},
		{ChannelWinget, "windows", "amd64"},
		{ChannelDeb, "linux", "amd64"},
		{ChannelRPM, "linux", "amd64"},
		{ChannelMSI, "windows", "amd64"},
	}
	for _, tc := range channels {
		t.Run(string(tc.ch), func(t *testing.T) {
			action := ChannelUpdateAction(tc.ch, ver)
			rel := Release{Tag: "v" + ver, Version: ver}
			for n := range names {
				rel.Assets = append(rel.Assets, Asset{Name: n})
			}
			if action.DownloadAsset != "" {
				if !names[action.DownloadAsset] {
					t.Fatalf("DownloadAsset %q not in real v1.1.0 assets", action.DownloadAsset)
				}
			}
			if action.Command != "" {
				for _, tok := range strings.Fields(action.Command) {
					tok = strings.TrimPrefix(tok, "./")
					// Only treat tokens that look like release asset filenames.
					if strings.Contains(tok, ".") && (strings.HasPrefix(tok, "AnyPick") || strings.HasPrefix(tok, "anypick-")) {
						if !names[tok] {
							t.Fatalf("command references %q which is not in real assets; cmd=%q", tok, action.Command)
						}
					}
				}
			}
			if asset, err := PickAsset(rel, tc.goos, tc.arch, tc.ch); err == nil {
				if !names[asset.Name] {
					t.Fatalf("PickAsset %q not in real assets", asset.Name)
				}
			}
		})
	}

	// A renamed asset must fail: alter the RPM command pattern expectation.
	bad := ChannelUpdateAction(ChannelRPM, ver)
	bad.DownloadAsset = "AnyPick-1.1.0.x86_64.rpm" // missing -1. release epoch
	if names[bad.DownloadAsset] {
		t.Fatal("bad name unexpectedly present")
	}
	if names["AnyPick-1.1.0-1.x86_64.rpm"] != true {
		t.Fatal("expected real rpm name in fixture")
	}
}

func TestValidateAssetNameRejectsPathLike(t *testing.T) {
	for _, name := range []string{"../evil", "foo/bar", `foo\bar`, "a/../b", ""} {
		if err := ValidateAssetName(name); err == nil {
			t.Fatalf("expected reject for %q", name)
		}
	}
	if err := ValidateAssetName("AnyPick_1.1.0_amd64.deb"); err != nil {
		t.Fatal(err)
	}
}

func containsFold(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(len(s) > 0 && (stringFind(s, sub) >= 0)))
}

func stringFind(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		ok := true
		for j := 0; j < len(sub); j++ {
			a, b := s[i+j], sub[j]
			if a >= 'A' && a <= 'Z' {
				a += 32
			}
			if b >= 'A' && b <= 'Z' {
				b += 32
			}
			if a != b {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}
