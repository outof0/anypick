// Package i18n provides keyed translations for human-facing CLI and TUI copy.
// JSON output is a stable machine interface and must not use this package.
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	goi18n "github.com/nicksnyder/go-i18n/v2/i18n"
	"golang.org/x/text/language"
)

const LanguageEnv = "ANYPICK_LANG"

const LanguageAuto = "auto"

// LanguageOption is one selectable locale and its self-named display label.
type LanguageOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// ResolvedLanguage reports the catalog i18n.T will use for a preference.
// It lets desktop clients render the same locale even when the preference is
// auto-detect and the host exposes a regional locale such as es-MX.
func ResolvedLanguage(preference string) string {
	return resolvedLanguageCandidates(languageCandidatesFor(preference))
}

func resolvedLanguageForCandidates(preference string, systemCandidates []string) string {
	return resolvedLanguageCandidates(languageCandidatesForCandidates(preference, systemCandidates))
}

func resolvedLanguageCandidates(candidates []string) string {
	for _, candidate := range candidates {
		if catalog := catalogForLocale(candidate); catalog != "" {
			return catalog
		}
	}
	return "en"
}

func catalogForLocale(value string) string {
	value = normalizeLocale(value)
	for _, option := range languageOptions {
		if option.Value == value {
			return value
		}
	}
	tag, err := language.Parse(value)
	if err != nil {
		return ""
	}
	base, _ := tag.Base()
	// These catalogs intentionally use regional identifiers instead of a
	// generic language code. Keep the resolved value aligned with go-i18n's
	// catalog match for regional system locales.
	switch base.String() {
	case "pt":
		return "pt-BR"
	case "zh":
		return "zh-CN"
	}
	for _, option := range languageOptions {
		if option.Value == base.String() {
			return base.String()
		}
	}
	return ""
}

var languageOptions = [...]LanguageOption{
	{Value: LanguageAuto, Label: "Auto Detect"},
	{Value: "en", Label: "English"},
	{Value: "zh-CN", Label: "简体中文"},
	{Value: "es", Label: "Español"},
	{Value: "fr", Label: "Français"},
	{Value: "de", Label: "Deutsch"},
	{Value: "ja", Label: "日本語"},
	{Value: "ko", Label: "한국어"},
	{Value: "pt-BR", Label: "Português (Brasil)"},
	{Value: "vi", Label: "Tiếng Việt"},
}

//go:embed messages.*.json
var messageFiles embed.FS

var (
	bundleOnce sync.Once
	appBundle  *goi18n.Bundle
	bundleErr  error

	localizers       sync.Map
	sourceOnce       sync.Once
	sourceKeys       map[string]string
	selectedLanguage atomic.Value
)

// LanguageOptions returns a copy of the language menu options in display order.
func LanguageOptions() []LanguageOption {
	return append([]LanguageOption(nil), languageOptions[:]...)
}

// SupportedLanguages returns catalog identifiers, in display order.
func SupportedLanguages() []string {
	values := make([]string, 0, len(languageOptions)-1)
	for _, option := range languageOptions {
		if option.Value != LanguageAuto {
			values = append(values, option.Value)
		}
	}
	return values
}

// NormalizePreference validates a persisted language preference and returns
// its canonical identifier. An empty value means auto-detect.
func NormalizePreference(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, LanguageAuto) {
		return LanguageAuto, true
	}
	for _, option := range languageOptions {
		if option.Value == LanguageAuto {
			continue
		}
		if strings.EqualFold(value, option.Value) {
			return option.Value, true
		}
	}
	return "", false
}

// SetLanguage selects a catalog. The auto preference follows the operating
// system locale; ANYPICK_LANG remains an explicit per-process override.
func SetLanguage(value string) bool {
	canonical, ok := NormalizePreference(value)
	if !ok {
		return false
	}
	selectedLanguage.Store(canonical)
	return true
}

// Language returns the persisted-style preference, defaulting to auto.
func Language() string {
	if value := selectedLanguage.Load(); value != nil {
		return value.(string)
	}
	return LanguageAuto
}

// T translates a stable message key, such as "tui.board.apps".
func T(key string) string {
	message, err := localizer().Localize(&goi18n.LocalizeConfig{MessageID: key})
	if err != nil {
		return key
	}
	return message
}

// F translates a printf-style message key before formatting its arguments.
func F(key string, args ...any) string {
	return fmt.Sprintf(T(key), args...)
}

// Text translates legacy CLI output by matching the English source against the
// keyed English catalog. New TUI copy should use T/F with a message key.
func Text(source string) string {
	if key := keyForSource(source); key != "" {
		return T(key)
	}
	if !strings.ContainsAny(source, "\r\n") {
		return source
	}
	var out strings.Builder
	for len(source) > 0 {
		end := strings.IndexAny(source, "\r\n")
		if end < 0 {
			out.WriteString(textLine(source))
			break
		}
		out.WriteString(textLine(source[:end]))
		termEnd := end + 1
		if source[end] == '\r' && termEnd < len(source) && source[termEnd] == '\n' {
			termEnd++
		}
		out.WriteString(source[end:termEnd])
		source = source[termEnd:]
	}
	return out.String()
}

func textLine(source string) string {
	if key := keyForSource(source); key != "" {
		return T(key)
	}
	return source
}

func keyForSource(source string) string {
	sourceOnce.Do(loadSourceKeys)
	return sourceKeys[source]
}

func loadSourceKeys() {
	sourceKeys = make(map[string]string)
	var messages map[string]struct {
		Other string `json:"other"`
	}
	data, err := fs.ReadFile(messageFiles, "messages.en.json")
	if err != nil || json.Unmarshal(data, &messages) != nil {
		return
	}
	for key, message := range messages {
		if message.Other == "" {
			continue
		}
		if _, exists := sourceKeys[message.Other]; !exists {
			sourceKeys[message.Other] = key
		}
	}
}

func localizer() *goi18n.Localizer {
	candidates := languageCandidates()
	cacheKey := strings.Join(candidates, "|")
	if value, ok := localizers.Load(cacheKey); ok {
		return value.(*goi18n.Localizer)
	}
	bundle := getBundle()
	preferences := append(append([]string(nil), candidates...), "en")
	value, _ := localizers.LoadOrStore(cacheKey, goi18n.NewLocalizer(bundle, preferences...))
	return value.(*goi18n.Localizer)
}

func getBundle() *goi18n.Bundle {
	bundleOnce.Do(func() {
		appBundle = goi18n.NewBundle(language.English)
		files, err := fs.Glob(messageFiles, "messages.*.json")
		if err != nil {
			bundleErr = err
			return
		}
		for _, name := range files {
			if _, err := appBundle.LoadMessageFileFS(messageFiles, name); err != nil {
				bundleErr = fmt.Errorf("load i18n catalog %s: %w", name, err)
				return
			}
		}
	})
	if bundleErr != nil || appBundle == nil {
		// Embedded catalogs are validated by tests; keep runtime output useful
		// if a packaging or filesystem regression ever bypasses those checks.
		fallback := goi18n.NewBundle(language.English)
		_, _ = fallback.LoadMessageFileFS(messageFiles, "messages.en.json")
		return fallback
	}
	return appBundle
}

func languageCandidates() []string {
	return languageCandidatesFor(Language())
}

func languageCandidatesFor(preference string) []string {
	return languageCandidatesForCandidates(preference, systemLanguageCandidates())
}

func languageCandidatesForCandidates(preference string, systemCandidates []string) []string {
	if forced := strings.TrimSpace(os.Getenv(LanguageEnv)); forced != "" {
		if normalized := normalizeLocale(forced); normalized != "" {
			return []string{normalized}
		}
		return []string{"en"}
	}
	if selected, ok := NormalizePreference(preference); ok && selected != LanguageAuto {
		return []string{selected}
	}
	var candidates []string
	for _, candidate := range systemCandidates {
		if normalized := normalizeLocale(candidate); normalized != "" {
			candidates = append(candidates, normalized)
		}
	}
	return candidates
}

func normalizeLocale(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "C" || value == "POSIX" {
		return ""
	}
	value = strings.SplitN(value, ".", 2)[0]
	value = strings.SplitN(value, "@", 2)[0]
	value = strings.ReplaceAll(value, "_", "-")
	tag, err := language.Parse(value)
	if err != nil {
		return ""
	}
	base, _ := tag.Base()
	if base.String() == "zh" {
		// This release ships Simplified Chinese only. Do not silently show it
		// to a user whose locale explicitly requests Traditional Chinese.
		script, _ := tag.Script()
		region, _ := tag.Region()
		if script.String() == "Hant" || region.String() == "TW" ||
			region.String() == "HK" || region.String() == "MO" {
			return "en"
		}
	}
	return tag.String()
}

func localeCandidatesFromEnvironment() []string {
	var out []string
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" && value != "C" && value != "POSIX" {
			out = append(out, value)
		}
	}
	return out
}
