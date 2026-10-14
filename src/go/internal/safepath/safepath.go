// Package safepath validates relative path keys that arrive from imports,
// backups, pasted logins and plugin manifests.
//
// Rules applied on every OS: the key must be non-empty; contain no control
// characters (0x00-0x1F, 0x7F); not be absolute or start with '/' or '\';
// carry no volume name, drive-letter prefix ("C:\x", "C:x") or UNC prefix;
// and have no ".." segment, with both '/' and '\' treated as separators.
//
// Windows-only rules: reserved device names (CON, PRN, AUX, NUL, COM1-9,
// LPT1-9, and COM/LPT with superscript 1-3) are refused by an explicit
// per-segment check; trailing dots or spaces and ":" outside a drive-letter
// prefix are refused through filepath.IsLocal. Those are not rejected off
// Windows.
package safepath

import (
	"errors"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

var (
	// ErrEmpty is returned for an empty key.
	ErrEmpty = errors.New("path is empty")
	// ErrBadName is returned for a key containing a control character.
	ErrBadName = errors.New("path contains a control character")
	// ErrReserved is returned for a Windows reserved device name.
	ErrReserved = errors.New("path uses a Windows reserved device name")
	// ErrNotLocal is returned for a key that is not a plain relative path.
	ErrNotLocal = errors.New("path is not a local relative path")
)

// windowsReservedDeviceNames are compared case-insensitively to the base
// name of each path segment (text before the first '.', trailing spaces
// trimmed). Superscript forms match Windows device aliases.
var windowsReservedDeviceNames = []string{
	"CON", "PRN", "AUX", "NUL",
	"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
	"COM¹", "COM²", "COM³",
	"LPT¹", "LPT²", "LPT³",
}

// ValidateKey reports whether key is a non-empty relative path that stays
// inside the directory it is joined to. Both '/' and '\' count as
// separators. It rejects absolute paths, a leading separator, any volume
// name (including drive-relative "C:x" and UNC "\\server\share"), any ".."
// segment and control characters (0x00-0x1F, 0x7F) on every OS; Windows
// reserved names are refused only on Windows (see the package comment).
// Names that merely start with dots, such as "..foo.mjs", are allowed.
func ValidateKey(key string) error {
	if key == "" {
		return ErrEmpty
	}
	if strings.IndexFunc(key, isControl) >= 0 {
		return ErrBadName
	}
	if key[0] == '/' || key[0] == '\\' || filepath.IsAbs(key) || filepath.VolumeName(key) != "" {
		return ErrNotLocal
	}
	if len(key) >= 2 && key[1] == ':' {
		return ErrNotLocal
	}
	segs := strings.FieldsFunc(key, isSep)
	for _, seg := range segs {
		if seg == ".." {
			return ErrNotLocal
		}
		if runtime.GOOS == "windows" && isWindowsReserved(seg) {
			return ErrReserved
		}
	}
	if !filepath.IsLocal(key) || !filepath.IsLocal(strings.ReplaceAll(key, `\`, "/")) {
		return ErrNotLocal
	}
	return nil
}

// ValidateName is ValidateKey for a single file name: no separators at all.
func ValidateName(name string) error {
	if err := ValidateKey(name); err != nil {
		return err
	}
	if strings.ContainsAny(name, `/\`) || name == "." {
		return ErrNotLocal
	}
	return nil
}

func isSep(r rune) bool { return r == '/' || r == '\\' }

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

// isWindowsReserved reports whether seg is a Windows reserved device name,
// with or without an extension. The check itself is OS-independent so tests
// can exercise it on every platform; ValidateKey only calls it on Windows.
func isWindowsReserved(seg string) bool {
	base := seg
	if i := strings.IndexByte(seg, '.'); i >= 0 {
		base = seg[:i]
	}
	base = strings.TrimRight(base, " ")
	if base == "" {
		return false
	}
	for _, name := range windowsReservedDeviceNames {
		if strings.EqualFold(base, name) {
			return true
		}
	}
	return false
}

// ImportRefusalMessage is the user-facing copy for an import or restore key
// that ValidateKey refused with err. Empty and control-character keys get a
// message that does not echo the key. Reserved device names use plain quotes.
func ImportRefusalMessage(key string, err error) string {
	switch {
	case errors.Is(err, ErrEmpty) || errors.Is(err, ErrBadName) || key == "":
		// No raw value: the key may be empty or hold unprintable bytes.
		return "Can't use this file. It contains an entry with no usable name, so nothing was imported."
	case errors.Is(err, ErrReserved):
		return `Can't use "` + key + `". Windows reserves that name, so nothing was imported.`
	default:
		return "Can't use " + strconv.Quote(key) + ". It points outside AnyPick's folder, so nothing was imported."
	}
}
