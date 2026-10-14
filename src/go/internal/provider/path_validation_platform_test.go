package provider

import (
	"testing"
)

// Path normalization cases that must be refused the same way on every OS.
var pvAllPlatforms = []string{
	`\x`, `C:\x`, "C:/x", "C:x", `..\x`, `\\server\share\x`, `x\..\..\y`, "x/../..", "/x",
	"a\x00b", "a\x1fb", "a\x7fb",
}

func TestPathValidationSinglePasteFileAllPlatforms(t *testing.T) {
	const want = "This login data includes a file name AnyPick can't use, so nothing was saved. Copy it again from the provider."
	for _, in := range pvAllPlatforms {
		if singlePasteFile(in) {
			t.Errorf("singlePasteFile accepted %q", in)
		}
		err := PastedSnapshot{files: map[string][]byte{in: []byte("{}")}}.WriteTo(t.TempDir())
		if err == nil || err.Error() != want {
			t.Errorf("WriteTo(%q) error = %v, want %q", in, err, want)
		}
	}
}
