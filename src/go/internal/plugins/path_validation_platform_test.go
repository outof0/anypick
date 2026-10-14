package plugins

import (
	"testing"
)

// Path normalization cases that must be refused the same way on every OS.
var pvAllPlatforms = []string{
	`\x`, `C:\x`, "C:/x", "C:x", `..\x`, `\\server\share\x`, `x\..\..\y`, "x/../..", "/x",
	"a\x00b", "a\x1fb", "a\x7fb",
}

func TestPathValidationResolveEntryAllPlatforms(t *testing.T) {
	root := t.TempDir()
	for _, in := range pvAllPlatforms {
		if got, err := ResolveEntry(root, in); err == nil {
			t.Errorf("ResolveEntry accepted %q -> %q", in, got)
		}
	}
}
