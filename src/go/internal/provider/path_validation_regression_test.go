package provider

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

// singlePasteFile only allows a bare file name, so "a/b.txt" must be rejected
// too; the plain accept case is "b.txt".
func TestPathValidationSinglePasteFile(t *testing.T) {
	if !singlePasteFile("b.txt") {
		t.Fatal("singlePasteFile rejected b.txt")
	}
	if singlePasteFile(pvAccept) {
		t.Errorf("singlePasteFile accepted nested %q", pvAccept)
	}
	for _, in := range pvReject {
		t.Run(in, func(t *testing.T) {
			if singlePasteFile(in) {
				t.Errorf("singlePasteFile accepted %q", in)
			}
		})
	}
}
