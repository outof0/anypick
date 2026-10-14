package update

import "testing"

func TestParseAndCompare(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want int
	}{
		{"equal", "1.2.0", "1.2.0", 0},
		{"v prefix", "v1.2.0", "1.2.0", 0},
		{"patch newer", "1.2.1", "1.2.0", 1},
		{"minor newer", "1.3.0", "1.2.9", 1},
		{"major newer", "2.0.0", "1.9.9", 1},
		{"minor 1.10 > 1.9", "1.10.0", "1.9.0", 1},
		{"older", "1.1.0", "1.2.0", -1},
		{"stable > prerelease", "1.2.0", "1.2.0-rc.1", 1},
		{"prerelease < stable", "1.2.0-rc.1", "1.2.0", -1},
		{"prerelease order", "1.2.0-rc.2", "1.2.0-rc.1", 1},
		{"V prefix", "V1.0.0", "1.0.0", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			va, err := ParseVersion(tc.a)
			if err != nil {
				t.Fatalf("parse a: %v", err)
			}
			vb, err := ParseVersion(tc.b)
			if err != nil {
				t.Fatalf("parse b: %v", err)
			}
			if got := Compare(va, vb); got != tc.want {
				t.Fatalf("Compare(%q,%q)=%d want %d", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestParseRejects(t *testing.T) {
	for _, s := range []string{"", "1.2", "abc", "1.2.x", "v"} {
		if _, err := ParseVersion(s); err == nil {
			t.Fatalf("ParseVersion(%q) succeeded", s)
		}
	}
}

func TestIsNewerRefuseDowngrade(t *testing.T) {
	cases := []struct {
		cand, cur string
		want      bool
	}{
		{"1.2.0", "1.1.0", true},
		{"1.1.0", "1.1.0", false},
		{"1.0.0", "1.1.0", false},
		{"1.2.0-rc.1", "1.1.0", true},
		{"1.1.0-rc.1", "1.1.0", false},
	}
	for _, tc := range cases {
		got, err := IsNewer(tc.cand, tc.cur)
		if err != nil {
			t.Fatalf("%s vs %s: %v", tc.cand, tc.cur, err)
		}
		if got != tc.want {
			t.Fatalf("IsNewer(%q,%q)=%v want %v", tc.cand, tc.cur, got, tc.want)
		}
	}
}

func TestMaxVersion(t *testing.T) {
	if got := MaxVersion("1.1.0", "1.2.0"); got != "1.2.0" {
		t.Fatalf("got %q", got)
	}
	if got := MaxVersion("", "1.0.0"); got != "1.0.0" {
		t.Fatalf("got %q", got)
	}
}

func TestParseIgnoresBuildMetadata(t *testing.T) {
	va, err := ParseVersion("1.2.0+build.1")
	if err != nil {
		t.Fatal(err)
	}
	vb, err := ParseVersion("1.2.0")
	if err != nil {
		t.Fatal(err)
	}
	if Compare(va, vb) != 0 {
		t.Fatalf("build metadata must be ignored in compare: %q vs %q", va, vb)
	}
	newer, err := IsNewer("1.2.0+meta", "1.1.0")
	if err != nil || !newer {
		t.Fatalf("IsNewer with build meta: %v %v", newer, err)
	}
}
