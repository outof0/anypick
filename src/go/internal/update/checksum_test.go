package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSHA256SUMS(t *testing.T) {
	const sample = `
# comment
d3ba775502491fd4a490ad323a1979953a2bc6eba15684c97e305d412578c3e2  AnyPick-macos-universal.zip
04a411890364b135eddc3ba7671e394cb939d3110c0901a1205227c5df51b36a  AnyPick_1.1.0_x64-setup.exe
`
	sums, err := ParseSHA256SUMS(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	if sums["AnyPick-macos-universal.zip"] != "d3ba775502491fd4a490ad323a1979953a2bc6eba15684c97e305d412578c3e2" {
		t.Fatalf("zip hash: %q", sums["AnyPick-macos-universal.zip"])
	}
	if len(sums) != 2 {
		t.Fatalf("len=%d", len(sums))
	}
}

func TestParseSHA256SUMSDuplicateFailsClosed(t *testing.T) {
	const sample = `
d3ba775502491fd4a490ad323a1979953a2bc6eba15684c97e305d412578c3e2  AnyPick-macos-universal.zip
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  AnyPick-macos-universal.zip
`
	if _, err := ParseSHA256SUMS(strings.NewReader(sample)); err == nil {
		t.Fatal("duplicate entry must fail closed")
	}
}

func TestParseSHA256SUMSRejectsPathLikeNames(t *testing.T) {
	hex := strings.Repeat("ab", 32)
	for _, name := range []string{"../evil.zip", "dir/file.zip", `dir\file.zip`} {
		body := hex + "  " + name + "\n"
		if _, err := ParseSHA256SUMS(strings.NewReader(body)); err == nil {
			t.Fatalf("expected reject for %q", name)
		}
	}
}

func TestParseSHA256SUMSQuirks(t *testing.T) {
	hexUpper := strings.ToUpper(strings.Repeat("ab", 32))
	hexLower := strings.ToLower(hexUpper)
	t.Run("binary marker", func(t *testing.T) {
		body := hexLower + " *file.bin\n"
		sums, err := ParseSHA256SUMS(strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if sums["file.bin"] != hexLower {
			t.Fatalf("%q", sums["file.bin"])
		}
	})
	t.Run("CRLF", func(t *testing.T) {
		body := hexLower + "  file.bin\r\n"
		sums, err := ParseSHA256SUMS(strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if sums["file.bin"] != hexLower {
			t.Fatalf("%q", sums["file.bin"])
		}
	})
	t.Run("uppercase hex", func(t *testing.T) {
		body := hexUpper + "  file.bin\n"
		sums, err := ParseSHA256SUMS(strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if sums["file.bin"] != hexLower {
			t.Fatalf("want lowercase stored, got %q", sums["file.bin"])
		}
	})
}

func TestVerifyFileSHA256MatchAndMismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob")
	content := []byte("any-pick-test-bytes")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	// Sibling "install" marker that must remain untouched on mismatch.
	install := filepath.Join(dir, "install-untouched")
	if err := os.WriteFile(install, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	want := HashBytes(content)
	if err := VerifyFileSHA256(path, want); err != nil {
		t.Fatalf("match: %v", err)
	}
	if err := VerifyFileSHA256(path, strings.Repeat("ab", 32)); err == nil {
		t.Fatal("mismatch should fail")
	} else if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("want mismatch wording, got %v", err)
	}
	got, err := os.ReadFile(install)
	if err != nil || string(got) != "original" {
		t.Fatalf("mismatch must leave install untouched: %q err=%v", got, err)
	}
	if err := VerifyFileSHA256(path, ""); err == nil {
		t.Fatal("empty hash must fail")
	}
}

func TestApplyChecksums(t *testing.T) {
	assets := []Asset{{Name: "a.zip"}, {Name: "b.zip"}}
	sums := map[string]string{"a.zip": "aa"}
	out := ApplyChecksums(assets, sums)
	if out[0].SHA256 != "aa" || out[1].SHA256 != "" {
		t.Fatalf("%+v", out)
	}
}

func TestRequireChecksumsOnlyInstallAsset(t *testing.T) {
	assets := []Asset{
		{Name: "a.zip", SHA256: "aa"},
		{Name: "b.zip"}, // missing — must not block when installing a.zip
		{Name: "SHA256SUMS.txt"},
	}
	if err := RequireChecksums(assets, "a.zip"); err != nil {
		t.Fatalf("unrelated missing entry must not block: %v", err)
	}
	if err := RequireChecksums(assets, "b.zip"); err == nil {
		t.Fatal("missing hash for install asset must fail")
	}
	assets[1].SHA256 = "   "
	if err := RequireChecksums(assets, "b.zip"); err == nil {
		t.Fatal("empty hash must fail")
	}
	assets[1].SHA256 = "bb"
	if err := RequireChecksums(assets, "b.zip"); err != nil {
		t.Fatal(err)
	}
	if err := RequireChecksums(assets, "missing.zip"); err == nil {
		t.Fatal("unknown install asset must fail")
	}
	if err := RequireChecksums(assets, "SHA256SUMS.txt"); err == nil {
		t.Fatal("SUMS file is not installable")
	}
}
