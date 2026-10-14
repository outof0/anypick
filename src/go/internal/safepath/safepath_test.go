package safepath

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPathValidationKeyRejects(t *testing.T) {
	for _, in := range []string{
		"/x", `\x`, `C:\x`, "C:/x", "C:x", "c:", "a:b", `\\server\share\x`, "//server/share/x",
		"..", "../x", `..\x`, "x/..", `x\..`, `x\..\..\y`, "x/../..", "a/../b",
	} {
		if err := ValidateKey(in); !errors.Is(err, ErrNotLocal) {
			t.Errorf("ValidateKey(%q) = %v, want ErrNotLocal", in, err)
		}
	}
}

func TestPathValidationKeyEmpty(t *testing.T) {
	if err := ValidateKey(""); !errors.Is(err, ErrEmpty) {
		t.Errorf("ValidateKey(\"\") = %v, want ErrEmpty", err)
	}
}

func TestPathValidationKeyBadNames(t *testing.T) {
	in := []string{
		"a\x00b", "a\x01b", "a\x1fb", "a\x7fb", "a\tb", "dir/a\nb",
	}
	for _, s := range in {
		if err := ValidateKey(s); !errors.Is(err, ErrBadName) {
			t.Errorf("ValidateKey(%q) = %v, want ErrBadName", s, err)
		}
	}
}

func TestPathValidationKeyAccepts(t *testing.T) {
	for _, in := range []string{
		"a", "a/b.txt", `a\b.txt`, "..foo.mjs", "dist/..foo.mjs", "a..b", ".hidden",
		"console.txt", "nullable.json", "COM10", "COM0", "LPT", "auxiliary", "con-fig", "a/./b",
	} {
		if err := ValidateKey(in); err != nil {
			t.Errorf("ValidateKey(%q) rejected: %v", in, err)
		}
	}
}

func TestPathValidationName(t *testing.T) {
	for _, in := range []string{"a/b", `a\b`, ".", "..", "", "C:x", "a\x00b"} {
		if ValidateName(in) == nil {
			t.Errorf("ValidateName(%q) accepted", in)
		}
	}
	for _, in := range []string{"auth.json", "..foo.json", ".credentials.json"} {
		if err := ValidateName(in); err != nil {
			t.Errorf("ValidateName(%q) rejected: %v", in, err)
		}
	}
}

// isWindowsReserved is OS-independent so a Linux revert of the list is caught.
func TestPathValidationIsWindowsReserved(t *testing.T) {
	for _, in := range []string{
		"CON", "con", "Prn.txt", "aux.tar.gz", "NUL.json", "com1", "LPT9.txt",
		"CON .txt", "prn ", "COM\u00b9", "com\u00b2.dat", "LPT\u00b3.txt",
		"COM\u00b9 ", "lpt\u00b2 .log",
	} {
		if !isWindowsReserved(in) {
			t.Errorf("isWindowsReserved(%q) = false, want true", in)
		}
	}
	for _, in := range []string{
		"console.txt", "nullable.json", "COM10", "COM0", "LPT", "auxiliary", "con-fig",
		"..foo.mjs", "a..b", ".hidden", "COM¹0", "LPT10",
	} {
		if isWindowsReserved(in) {
			t.Errorf("isWindowsReserved(%q) = true, want false", in)
		}
	}
}

// Reserved device names are refused only on Windows.
func TestPathValidationReservedNames(t *testing.T) {
	for _, in := range []string{
		"CON", "con", "Prn.txt", "aux.tar.gz", "dir/NUL.json", `dir\com1`, "LPT9.txt",
		"CON .txt", "COM\u00b9", "LPT\u00b2.tar.gz",
	} {
		err := ValidateKey(in)
		if runtime.GOOS == "windows" && !errors.Is(err, ErrReserved) {
			t.Errorf("ValidateKey(%q) = %v, want ErrReserved", in, err)
		}
		if runtime.GOOS != "windows" && err != nil {
			t.Errorf("ValidateKey(%q) rejected off Windows: %v", in, err)
		}
	}
}

// On Windows, filepath.IsLocal accepts some reserved names with extensions.
// Dropping the explicit isWindowsReserved call would let those through.
func TestPathValidationReservedNamesBeyondIsLocal(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("explicit reserved-name check is wired only on Windows")
	}
	for _, in := range []string{"Prn.txt", "aux.tar.gz", "dir/NUL.json", "LPT9.txt", "CON .txt"} {
		slash := strings.ReplaceAll(in, `\`, "/")
		if !filepath.IsLocal(in) && !filepath.IsLocal(slash) {
			t.Fatalf("%q: IsLocal already rejects; case does not prove the explicit check", in)
		}
		if err := ValidateKey(in); !errors.Is(err, ErrReserved) {
			t.Errorf("ValidateKey(%q) = %v, want ErrReserved (IsLocal alone is not enough)", in, err)
		}
	}
}

func TestPathValidationImportRefusalMessage(t *testing.T) {
	const noName = "Can't use this file. It contains an entry with no usable name, so nothing was imported."
	for _, in := range []string{"", "a\x00b", "a\x1fb", "a\x7fb"} {
		if got := ImportRefusalMessage(in, ValidateKey(in)); got != noName {
			t.Errorf("ImportRefusalMessage(%q) = %q", in, got)
		}
	}
	const outside = "Can't use \"../x\". It points outside AnyPick's folder, so nothing was imported."
	if got := ImportRefusalMessage("../x", ValidateKey("../x")); got != outside {
		t.Errorf("ImportRefusalMessage(../x) = %q", got)
	}
	const reserved = `Can't use "Prn.txt". Windows reserves that name, so nothing was imported.`
	if got := ImportRefusalMessage("Prn.txt", ErrReserved); got != reserved {
		t.Errorf("ImportRefusalMessage(Prn.txt) = %q, want %q", got, reserved)
	}
	const reservedSpace = `Can't use "CON .txt". Windows reserves that name, so nothing was imported.`
	if got := ImportRefusalMessage("CON .txt", ErrReserved); got != reservedSpace {
		t.Errorf("ImportRefusalMessage(CON .txt) = %q, want %q", got, reservedSpace)
	}
}
