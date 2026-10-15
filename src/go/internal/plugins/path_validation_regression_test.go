package plugins

// Regression tests for Windows path validation (QA). Every case runs on
// every OS.

import (
	"testing"
)

var pvReject = []string{
	`\x`,
	`C:\x`,
	`C:x`,
	`..\x`,
	`\\server\share\x`,
	`x\..\..\y`,
	`x/../..`,
}

const pvAccept = "a/b.txt"

func TestPathValidationResolveEntry(t *testing.T) {
	root := t.TempDir()
	if _, err := ResolveEntry(root, pvAccept); err != nil {
		t.Fatalf("ResolveEntry rejected %q: %v", pvAccept, err)
	}
	for _, in := range pvReject {
		t.Run(in, func(t *testing.T) {
			if got, err := ResolveEntry(root, in); err == nil {
				t.Errorf("ResolveEntry accepted %q -> %q", in, got)
			}
		})
	}
}
