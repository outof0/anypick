package i18n

import (
	"encoding/json"
	"io/fs"
	"testing"
)

func TestStableKeysUseSelectedCatalog(t *testing.T) {
	t.Setenv(LanguageEnv, "zh-CN")
	if got := T("tui.board.apps"); got != "应用" {
		t.Fatalf("T(tui.board.apps) = %q, want Chinese translation", got)
	}
	if got := T("tui.apps.source"); got != "%s 使用 %s" {
		t.Fatalf("T(tui.apps.source) = %q, want translated format string", got)
	}
	if got := F("tui.apps.source", "Claude", "my-account"); got != "Claude 使用 my-account" {
		t.Fatalf("F(tui.apps.source) = %q, want interpolated Chinese text", got)
	}
}

func TestLocaleFallbackAndSourceCompatibility(t *testing.T) {
	t.Setenv(LanguageEnv, "vi-VN")
	if got := T("tui.board.apps"); got != "ứng dụng" {
		t.Fatalf("T(tui.board.apps) = %q, want Vietnamese translation", got)
	}
	if got := Text("apps"); got != "ứng dụng" {
		t.Fatalf("Text(apps) = %q, want Vietnamese translation", got)
	}

	t.Setenv(LanguageEnv, "zh-CN")
	if got := Text("apps\nready\r\n"); got != "应用\n就绪\r\n" {
		t.Fatalf("Text(multiline) = %q, want translated lines with preserved line endings", got)
	}
}

func TestUnsupportedAndTraditionalChineseFallBackToEnglish(t *testing.T) {
	for _, locale := range []string{"it-IT", "zh-TW", "zh-Hant"} {
		t.Run(locale, func(t *testing.T) {
			t.Setenv(LanguageEnv, locale)
			if got := T("tui.board.apps"); got != "apps" {
				t.Fatalf("T(tui.board.apps) = %q, want English fallback", got)
			}
		})
	}
}

func TestAllEnglishMessageKeysResolve(t *testing.T) {
	data, err := fs.ReadFile(messageFiles, "messages.en.json")
	if err != nil {
		t.Fatal(err)
	}
	var messages map[string]struct {
		Other string `json:"other"`
	}
	if err := json.Unmarshal(data, &messages); err != nil {
		t.Fatal(err)
	}
	t.Setenv(LanguageEnv, "en")
	for key, message := range messages {
		if got := T(key); got != message.Other {
			t.Errorf("T(%q) = %q, want %q", key, got, message.Other)
		}
	}
}

func TestEveryCatalogCoversEnglishKeys(t *testing.T) {
	readCatalog := func(name string) map[string]struct {
		Other string `json:"other"`
	} {
		t.Helper()
		data, err := fs.ReadFile(messageFiles, name)
		if err != nil {
			t.Fatal(err)
		}
		var messages map[string]struct {
			Other string `json:"other"`
		}
		if err := json.Unmarshal(data, &messages); err != nil {
			t.Fatal(err)
		}
		return messages
	}
	en := readCatalog("messages.en.json")
	catalogs, err := fs.Glob(messageFiles, "messages.*.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, catalogName := range catalogs {
		if catalogName == "messages.en.json" {
			continue
		}
		catalog := readCatalog(catalogName)
		for key := range en {
			if message, ok := catalog[key]; !ok || message.Other == "" {
				t.Errorf("%s is missing a message for %q", catalogName, key)
			}
		}
		for key := range catalog {
			if _, ok := en[key]; !ok {
				t.Errorf("%s has a key absent from English: %q", catalogName, key)
			}
		}
	}
}

func TestPopularLocalesSelectTheirCatalog(t *testing.T) {
	want := map[string]struct {
		board     string
		cancelled string
	}{
		"es":    {board: "aplicaciones", cancelled: "Cancelado."},
		"fr":    {board: "applications", cancelled: "Annulé."},
		"de":    {board: "Apps", cancelled: "Abgebrochen."},
		"ja":    {board: "アプリ", cancelled: "キャンセルしました。"},
		"ko":    {board: "앱", cancelled: "취소되었습니다."},
		"pt-BR": {board: "aplicativos", cancelled: "Cancelado."},
		"vi":    {board: "ứng dụng", cancelled: "Đã hủy."},
	}
	for locale, expected := range want {
		t.Run(locale, func(t *testing.T) {
			t.Setenv(LanguageEnv, locale)
			if got := T("tui.board.apps"); got != expected.board {
				t.Fatalf("T(tui.board.apps) = %q, want %q", got, expected.board)
			}
			if got := T("cli.action.cancelled"); got != expected.cancelled {
				t.Fatalf("T(cli.action.cancelled) = %q, want %q", got, expected.cancelled)
			}
		})
	}
}

func TestSelectedPreferenceOverridesSystemLocaleAndAutoRestoresDetection(t *testing.T) {
	previous := Language()
	t.Cleanup(func() { SetLanguage(previous) })
	t.Setenv(LanguageEnv, "")
	t.Setenv("ANYPICK_SYSTEM_LANG", "en")
	t.Setenv("LC_ALL", "en_US.UTF-8")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "")

	if !SetLanguage("vi") {
		t.Fatal("SetLanguage rejected vi")
	}
	if got := T("tui.board.apps"); got != "ứng dụng" {
		t.Fatalf("selected locale = %q, want Vietnamese catalog", got)
	}
	if !SetLanguage(LanguageAuto) {
		t.Fatal("SetLanguage rejected auto")
	}
	if got := T("tui.board.apps"); got != "apps" {
		t.Fatalf("auto locale = %q, want system English catalog", got)
	}
}

func TestResolvedLanguageFollowsPreferenceOverrideAndProvidedSystemLocale(t *testing.T) {
	t.Setenv(LanguageEnv, "")
	system := []string{"es_MX.UTF-8"}
	if got := resolvedLanguageForCandidates(LanguageAuto, system); got != "es" {
		t.Fatalf("auto resolved language = %q, want es", got)
	}
	if got := resolvedLanguageForCandidates("vi", system); got != "vi" {
		t.Fatalf("selected resolved language = %q, want vi", got)
	}
	t.Setenv(LanguageEnv, "zh-CN")
	if got := resolvedLanguageForCandidates("vi", system); got != "zh-CN" {
		t.Fatalf("environment override = %q, want zh-CN", got)
	}
}

func TestResolvedLanguageMatchesRegionalCatalogSelection(t *testing.T) {
	t.Setenv(LanguageEnv, "")
	t.Setenv("ANYPICK_SYSTEM_LANG", "")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	for _, test := range []struct {
		locale string
		want   string
		board  string
	}{
		{locale: "pt-PT", want: "pt-BR", board: "aplicativos"},
		{locale: "zh-SG", want: "zh-CN", board: "应用"},
		{locale: "zh-Hans", want: "zh-CN", board: "应用"},
		{locale: "zh-TW", want: "en", board: "apps"},
		{locale: "zh-MO", want: "en", board: "apps"},
	} {
		t.Run(test.locale, func(t *testing.T) {
			t.Setenv(LanguageEnv, test.locale)
			if got := ResolvedLanguage(LanguageAuto); got != test.want {
				t.Fatalf("ResolvedLanguage(auto) = %q, want %q", got, test.want)
			}
			if got := T("tui.board.apps"); got != test.board {
				t.Fatalf("T(tui.board.apps) = %q, want %q", got, test.board)
			}
		})
	}
}

func TestResolvedLanguageUsesHostLanguageHintWhenLocaleEnvironmentIsEmpty(t *testing.T) {
	previous := Language()
	t.Cleanup(func() { SetLanguage(previous) })
	SetLanguage(LanguageAuto)
	t.Setenv(LanguageEnv, "")
	t.Setenv("ANYPICK_SYSTEM_LANG", "vi-VN")
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "")
	if got := ResolvedLanguage(LanguageAuto); got != "vi" {
		t.Fatalf("ResolvedLanguage(auto) = %q, want vi", got)
	}
	if got := T("tui.board.apps"); got != "ứng dụng" {
		t.Fatalf("T(tui.board.apps) = %q, want Vietnamese catalog", got)
	}
}
