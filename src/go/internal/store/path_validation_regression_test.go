package store

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

func TestPathValidationStoreImportKey(t *testing.T) {
	root := t.TempDir()
	if err := validateImportFileKey(pvAccept); err != nil {
		t.Fatalf("validateImportFileKey rejected %q: %v", pvAccept, err)
	}
	if _, err := stagedFilePath(root, pvAccept); err != nil {
		t.Fatalf("stagedFilePath rejected %q: %v", pvAccept, err)
	}
	for _, in := range pvReject {
		t.Run(in, func(t *testing.T) {
			if err := validateImportFileKey(in); err == nil {
				t.Errorf("validateImportFileKey accepted %q", in)
			}
			if got, err := stagedFilePath(root, in); err == nil {
				t.Errorf("stagedFilePath accepted %q -> %q", in, got)
			}
		})
	}
}
