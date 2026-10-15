package update

import (
	"fmt"
	"strconv"
	"strings"
)

// Version is a parsed semver (major.minor.patch with optional prerelease).
type Version struct {
	Major, Minor, Patch int
	Pre                 string // empty for a stable release
	Raw                 string // canonical without leading "v"
}

// ParseVersion parses a semver string, accepting an optional leading "v".
// Prerelease after '-' is kept (e.g. "1.2.0-rc.1"). Build metadata (+...) is
// stripped. Returns an error for empty or non-numeric core versions.
func ParseVersion(s string) (Version, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	s = strings.TrimPrefix(s, "V")
	if s == "" {
		return Version{}, fmt.Errorf("empty version")
	}
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	pre := ""
	core := s
	if i := strings.IndexByte(s, '-'); i >= 0 {
		core = s[:i]
		pre = s[i+1:]
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("%q is not major.minor.patch", s)
	}
	nums := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return Version{}, fmt.Errorf("%q has non-numeric component %q", s, p)
		}
		nums[i] = n
	}
	return Version{Major: nums[0], Minor: nums[1], Patch: nums[2], Pre: pre, Raw: s}, nil
}

// String returns the canonical form without a leading "v".
func (v Version) String() string {
	if v.Pre != "" {
		return fmt.Sprintf("%d.%d.%d-%s", v.Major, v.Minor, v.Patch, v.Pre)
	}
	return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
}

// IsPrerelease reports whether the version carries a prerelease tag.
func (v Version) IsPrerelease() bool { return v.Pre != "" }

// Compare returns -1 if v < other, 0 if equal, 1 if v > other.
// A stable release is greater than the same core with a prerelease tag
// (1.2.0 > 1.2.0-rc.1), matching semver precedence.
func Compare(v, other Version) int {
	if c := cmpInt(v.Major, other.Major); c != 0 {
		return c
	}
	if c := cmpInt(v.Minor, other.Minor); c != 0 {
		return c
	}
	if c := cmpInt(v.Patch, other.Patch); c != 0 {
		return c
	}
	// Both stable.
	if v.Pre == "" && other.Pre == "" {
		return 0
	}
	// Stable > prerelease.
	if v.Pre == "" {
		return 1
	}
	if other.Pre == "" {
		return -1
	}
	return strings.Compare(v.Pre, other.Pre)
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// IsNewer reports whether candidate is a strict upgrade over current.
func IsNewer(candidate, current string) (bool, error) {
	c, err := ParseVersion(candidate)
	if err != nil {
		return false, err
	}
	cur, err := ParseVersion(current)
	if err != nil {
		return false, err
	}
	return Compare(c, cur) > 0, nil
}

// MaxVersion returns the higher of a and b (semver). Empty strings are ignored.
func MaxVersion(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	va, errA := ParseVersion(a)
	vb, errB := ParseVersion(b)
	if errA != nil {
		return b
	}
	if errB != nil {
		return a
	}
	if Compare(va, vb) >= 0 {
		return va.String()
	}
	return vb.String()
}
