//go:build !windows

package i18n

import "os"

func systemLanguageCandidates() []string {
	var candidates []string
	if preferred := os.Getenv("ANYPICK_SYSTEM_LANG"); preferred != "" {
		candidates = append(candidates, preferred)
	}
	return append(candidates, localeCandidatesFromEnvironment()...)
}
