package desktop

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Display metadata is user-facing, not a credential channel. Providers are
// allowed to return best-effort identities, so the desktop boundary must still
// reject opaque token-shaped values before they become snapshot fields or
// operation messages.
const (
	maxDisplayIdentityRunes = 160
	maxDisplayMessageRunes  = 512
)

// unsafeDisplayFallback is what a rejected message renders as. It is a named
// value because callers that compose text (Result.Fail's suggestions) must be
// able to tell "this text was replaced" from "this is the user's text".
const unsafeDisplayFallback = "The operation returned a message that cannot be displayed safely. Try again."

// displaySafeIdentity returns only a short, printable identity suitable for a
// native label. An empty result means "login is present but not identified";
// callers must keep that state instead of falling back to the raw value.
// DisplaySafeIdentity is the exported form of displaySafeIdentity for the TUI.
func DisplaySafeIdentity(raw string) string { return displaySafeIdentity(raw) }

func displaySafeIdentity(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || utf8.RuneCountInString(value) > maxDisplayIdentityRunes {
		return ""
	}
	if strings.IndexFunc(value, func(r rune) bool {
		return unicode.IsControl(r) || unicode.IsSpace(r) && r != ' '
	}) >= 0 {
		return ""
	}
	if looksLikeOpaqueCredential(value) {
		return ""
	}
	return value
}

// displaySafeMessage keeps provider diagnostics useful while refusing to
// render a long token copied into an error or detection message. The fallback
// intentionally does not mention the offending value.
// DisplaySafeMessage is displaySafeMessage for other output surfaces (the
// management API), so every surface refuses the same opaque values.
func DisplaySafeMessage(raw string) string { return displaySafeMessage(raw) }

func displaySafeMessage(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if utf8.RuneCountInString(value) > maxDisplayMessageRunes || containsOpaqueCredential(value) {
		return unsafeDisplayFallback
	}
	return value
}

// displaySafeMessageWithNotice keeps a fixed notice attached to a sanitized
// message. FrameResult sanitizes the composed string once more, so the notice
// must not push the message past the display cap — the head is trimmed and the
// notice survives.
func displaySafeMessageWithNotice(raw, notice string) string {
	base := displaySafeMessage(raw)
	if notice == "" {
		return base
	}
	if base == "" {
		return strings.TrimSpace(notice)
	}
	limit := maxDisplayMessageRunes - utf8.RuneCountInString(notice)
	if limit > 0 {
		runes := []rune(base)
		if len(runes) > limit {
			base = string(runes[:limit])
		}
	}
	return base + notice
}

func containsOpaqueCredential(value string) bool {
	var run strings.Builder
	flush := func() bool {
		candidate := run.String()
		run.Reset()
		return looksLikeOpaqueCredential(candidate)
	}
	for _, r := range value {
		if isOpaqueCredentialRune(r) {
			run.WriteRune(r)
			continue
		}
		if flush() {
			return true
		}
	}
	return flush()
}

func looksLikeOpaqueCredential(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if strings.HasPrefix(strings.ToLower(value), "bearer ") {
		return true
	}
	parts := strings.Split(value, ".")
	if len(parts) == 3 && len(parts[0]) >= 8 && len(parts[1]) >= 8 && len(parts[2]) >= 8 {
		if allOpaqueCredentialRunes(parts[0]) && allOpaqueCredentialRunes(parts[1]) &&
			allOpaqueCredentialRunes(parts[2]) {
			return true
		}
	}
	if len([]rune(value)) < 48 || strings.ContainsAny(value, " @:/") {
		return false
	}
	return allOpaqueCredentialRunes(value)
}

func allOpaqueCredentialRunes(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !isOpaqueCredentialRune(r) {
			return false
		}
	}
	return true
}

func isOpaqueCredentialRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("-_.+=/", r)
}
