package desktop

import (
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
)

func TestDisplaySafeIdentityKeepsHumanIdentifiers(t *testing.T) {
	for _, value := range []string{
		"person@example.com",
		"antigravity:abcdef123456",
		"Claude Max",
		"user-42",
	} {
		if got := displaySafeIdentity(value); got != value {
			t.Fatalf("displaySafeIdentity(%q) = %q", value, got)
		}
	}
}

func TestDisplaySafeIdentityRejectsOpaqueCredentials(t *testing.T) {
	opaque := strings.Repeat("A", 256)
	jwt := strings.Repeat("a", 24) + "." + strings.Repeat("b", 32) + "." + strings.Repeat("c", 24)
	for _, value := range []string{opaque, jwt, "identity\nwith a line break"} {
		if got := displaySafeIdentity(value); got != "" {
			t.Fatalf("opaque display identity was kept with length %d", len(value))
		}
	}
}

func TestDisplaySafeMessageDoesNotExposeOpaqueCredential(t *testing.T) {
	opaque := strings.Repeat("A", 256)
	raw := "Detected " + opaque + " in Gemini."
	got := displaySafeMessage(raw)
	if got == raw || strings.Contains(got, opaque) {
		t.Fatal("opaque credential crossed the display-message boundary")
	}
}

func TestForeignConfigIssueKeepsUsefulWarningForWindowsPaths(t *testing.T) {
	server := New(Deps{}, strings.NewReader(""), &strings.Builder{})
	err := anyerr.Newf(
		`CLIENT_CONFIG_FOREIGN: claude config contains settings not managed by AnyPick (C:\Users\RUNNER~1\AppData\Local\Temp\TestStartupRefusesToOverwriteAUserOwnedConfig1234567890\.claude\settings.json, env.ANTHROPIC_API_KEY). Nothing was changed; confirm the takeover to replace them.`,
		"CLIENT_CONFIG_FOREIGN",
	)
	server.recordClientConfigIssue("claude", err)
	conditions := server.clientConfigConditions()
	if len(conditions) != 1 {
		t.Fatalf("conditions = %+v, want one safe warning", conditions)
	}
	detail := conditions[0].Detail
	if strings.Contains(detail, unsafeDisplayFallback) || !strings.Contains(detail, "AnyPick did not change it") {
		t.Fatalf("Windows path hid the useful foreign-config warning: %q", detail)
	}
	if strings.Contains(detail, "RUNNER") {
		t.Fatalf("desktop warning exposed the local path: %q", detail)
	}
}
