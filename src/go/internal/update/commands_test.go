package update

import (
	"strings"
	"testing"
	"unicode"
)

func TestRelaunchProxiesConfirm(t *testing.T) {
	if got := RelaunchProxiesConfirm(0); got != "" {
		t.Fatalf("n=0 want empty (no confirm), got %q", got)
	}
	want1 := "Restarting stops 1 running proxy. Connected apps reconnect when AnyPick starts again."
	if got := RelaunchProxiesConfirm(1); got != want1 {
		t.Fatalf("n=1: %q", got)
	}
	want2 := "Restarting stops 2 running proxies. Connected apps reconnect when AnyPick starts again."
	if got := RelaunchProxiesConfirm(2); got != want2 {
		t.Fatalf("n=2: %q", got)
	}
}

func TestChannelUpdateActionKinds(t *testing.T) {
	cases := []struct {
		ch   InstallChannel
		kind ActionKind
	}{
		{ChannelDirect, ActionSelfUpdate},
		{ChannelNSIS, ActionSelfUpdate},
		{ChannelAppImage, ActionSelfUpdate},
		{ChannelBrew, ActionCommand},
		{ChannelScoop, ActionCommand},
		{ChannelNPM, ActionCommand},
		{ChannelWinget, ActionCommand},
		{ChannelDeb, ActionDownloadAsset},
		{ChannelRPM, ActionDownloadAsset},
		{ChannelMSI, ActionDownloadAsset},
		{ChannelUnknown, ActionManual},
	}
	for _, tc := range cases {
		a := ChannelUpdateAction(tc.ch, "1.1.0")
		if a.Kind != tc.kind {
			t.Fatalf("%s: kind=%s want %s", tc.ch, a.Kind, tc.kind)
		}
	}
	deb := ChannelUpdateAction(ChannelDeb, "1.1.0")
	if deb.DownloadAsset != "AnyPick_1.1.0_amd64.deb" || deb.Command == "" || deb.Lead == "" {
		t.Fatalf("deb action %+v", deb)
	}
	msi := ChannelUpdateAction(ChannelMSI, "1.1.0")
	if msi.DownloadAsset != "AnyPick_1.1.0_x64_en-US.msi" || msi.Command != "" {
		t.Fatalf("msi should be downloadAsset without command: %+v", msi)
	}
	winget := ChannelUpdateAction(ChannelWinget, "1.1.0")
	if winget.Command != "winget upgrade AnyPick" || winget.Kind != ActionCommand {
		t.Fatalf("winget %+v", winget)
	}
}

func TestCommandKindContainsNoProse(t *testing.T) {
	commandTokens := map[string]bool{
		"brew": true, "scoop": true, "npm": true, "sudo": true, "winget": true, "dnf": true, "apt": true,
	}
	for _, ch := range []InstallChannel{
		ChannelBrew, ChannelScoop, ChannelNPM, ChannelWinget, ChannelDeb, ChannelRPM,
	} {
		a := ChannelUpdateAction(ch, "1.1.0")
		if a.Command == "" {
			t.Fatalf("%s: empty command", ch)
		}
		cmd := a.Command
		if strings.HasSuffix(cmd, ".") {
			t.Fatalf("%s command has trailing period: %q", ch, cmd)
		}
		if strings.Contains(cmd, ". ") || strings.Contains(cmd, "?") || strings.Contains(cmd, "!") {
			t.Fatalf("%s command looks like a sentence: %q", ch, cmd)
		}
		fields := strings.Fields(cmd)
		if len(fields) == 0 || !commandTokens[fields[0]] {
			t.Fatalf("%s command must start with a command token, got %q", ch, cmd)
		}
		// No capitalised English sentence start after first token (rough).
		for _, f := range fields[1:] {
			if len(f) > 3 && unicode.IsUpper(rune(f[0])) && !strings.Contains(f, "AnyPick") && f != "AnyPick" {
				// allow AnyPick product token
				if f != "AnyPick" && !strings.HasPrefix(f, "AnyPick") && !strings.HasPrefix(f, "./") {
					t.Fatalf("%s suspicious prose token %q in %q", ch, f, cmd)
				}
			}
		}
	}
}

func TestCopyLintNoBannedWords(t *testing.T) {
	banned := []string{"safe", "instant", "verified"}
	samples := []string{
		ReadyAuthenticityLine,
		MacOSReadyFootnote,
		SkipVersionCopy("1.2.0"),
		HostBlockedCopy("1.1.0"),
		RelaunchProxiesConfirm(1),
		RelaunchProxiesConfirm(2),
		ChannelUpdateAction(ChannelWinget, "1.1.0").Lead,
		ChannelUpdateAction(ChannelBrew, "1.1.0").Lead,
		ChannelUpdateAction(ChannelScoop, "1.1.0").Lead,
		ChannelUpdateAction(ChannelNPM, "1.1.0").Lead,
		ChannelUpdateAction(ChannelDeb, "1.1.0").Lead,
		ChannelUpdateAction(ChannelRPM, "1.1.0").Lead,
		ChannelUpdateAction(ChannelMSI, "1.1.0").Lead,
		ChannelUpdateAction(ChannelUnknown, "1.1.0").Lead,
	}
	for _, s := range samples {
		lower := strings.ToLower(s)
		for _, b := range banned {
			// bare "verified" only — "matches the release checksum" is fine
			if b == "verified" {
				if strings.Contains(lower, "verified") {
					t.Fatalf("banned bare %q in %q", b, s)
				}
				continue
			}
			if strings.Contains(lower, b) {
				t.Fatalf("banned %q in %q", b, s)
			}
		}
	}
}

func TestHostBlockedCopyExact(t *testing.T) {
	want := "Update didn't finish. The download came from an address AnyPick doesn't trust, so nothing was changed. You're still on 1.1.0."
	if got := HostBlockedCopy("1.1.0"); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
