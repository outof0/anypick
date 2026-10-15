//go:build windows

package i18n

import (
	"os"

	"golang.org/x/sys/windows"
)

func systemLanguageCandidates() []string {
	var candidates []string
	if preferred := os.Getenv("ANYPICK_SYSTEM_LANG"); preferred != "" {
		candidates = append(candidates, preferred)
	}
	preferred, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil {
		return append(candidates, localeCandidatesFromEnvironment()...)
	}
	candidates = append(candidates, preferred...)
	return append(candidates, localeCandidatesFromEnvironment()...)
}
