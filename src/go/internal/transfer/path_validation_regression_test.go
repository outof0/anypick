package transfer

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

func TestPathValidationTransferImportKey(t *testing.T) {
	root := t.TempDir()
	if err := ValidateImportFileKey(pvAccept); err != nil {
		t.Fatalf("ValidateImportFileKey rejected %q: %v", pvAccept, err)
	}
	if _, err := StagedFilePath(root, pvAccept); err != nil {
		t.Fatalf("StagedFilePath rejected %q: %v", pvAccept, err)
	}
	for _, in := range pvReject {
		t.Run(in, func(t *testing.T) {
			if err := ValidateImportFileKey(in); err == nil {
				t.Errorf("ValidateImportFileKey accepted %q", in)
			}
			if got, err := StagedFilePath(root, in); err == nil {
				t.Errorf("StagedFilePath accepted %q -> %q", in, got)
			}
		})
	}
}
