package update

import (
	"testing"
	"time"
)

func TestHookGateIgnoresWithoutFlag(t *testing.T) {
	env := MapEnv{
		EnvFeedURL:        "http://127.0.0.1:9",
		EnvChannel:        "brew",
		EnvClock:          "2026-10-12T00:00:00Z",
		EnvClockOffset:    "25h",
		EnvFault:          "checksum-mismatch",
		EnvCurrentVersion: "9.9.9",
		// EnvTesting deliberately unset
	}
	if TestingEnabled(env) {
		t.Fatal("testing should be disabled")
	}
	if HookValue(env, EnvFeedURL) != "" {
		t.Fatal("FEED_URL leaked without gate")
	}
	if HookValue(env, EnvChannel) != "" {
		t.Fatal("CHANNEL leaked without gate")
	}
	if HookValue(env, EnvClock) != "" {
		t.Fatal("CLOCK leaked without gate")
	}
	if HookValue(env, EnvClockOffset) != "" {
		t.Fatal("CLOCK_OFFSET leaked without gate")
	}
	if HookValue(env, EnvFault) != "" {
		t.Fatal("FAULT leaked without gate")
	}
	if HookValue(env, EnvCurrentVersion) != "" {
		t.Fatal("CURRENT_VERSION leaked without gate")
	}
	if _, ok := HookChannel(env); ok {
		t.Fatal("HookChannel ok without gate")
	}
	if HookCurrentVersion(env) != "" {
		t.Fatal("HookCurrentVersion without gate")
	}
	if HookFeedURL(env) != "" {
		t.Fatal("HookFeedURL without gate")
	}
	if HookFault(env) != "" {
		t.Fatal("HookFault without gate")
	}
	// CLOCK / CLOCK_OFFSET must not alter the fallback clock when gate closed.
	fixed := FixedClock{T: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	got := HookClock(env, fixed)
	if got.Now() != fixed.T {
		t.Fatalf("HookClock altered time with gate closed: %v", got.Now())
	}
}

func TestHookGateClosedForTrueAndZero(t *testing.T) {
	for _, v := range []string{"true", "0", "yes", "TRUE", "on"} {
		env := MapEnv{
			EnvTesting:        v,
			EnvFeedURL:        "http://127.0.0.1:9",
			EnvChannel:        "brew",
			EnvClock:          "2026-10-12T00:00:00Z",
			EnvClockOffset:    "25h",
			EnvFault:          "relaunch-fail",
			EnvCurrentVersion: "9.9.9",
		}
		if TestingEnabled(env) {
			t.Fatalf("TESTING=%q must stay closed (only exactly 1 opens)", v)
		}
		if HookFeedURL(env) != "" || HookFault(env) != "" || HookCurrentVersion(env) != "" {
			t.Fatalf("hooks leaked with TESTING=%q", v)
		}
		if _, ok := HookChannel(env); ok {
			t.Fatalf("channel leaked with TESTING=%q", v)
		}
	}
}

func TestHookGateEachHookClosed(t *testing.T) {
	// Each hook individually present, gate closed.
	hooks := []struct {
		key, val string
		check    func(MapEnv) bool // true if leaked
	}{
		{EnvClock, "2026-10-12T00:00:00Z", func(e MapEnv) bool { return HookValue(e, EnvClock) != "" }},
		{EnvClockOffset, "25h", func(e MapEnv) bool { return HookValue(e, EnvClockOffset) != "" }},
		{EnvFeedURL, "http://127.0.0.1:9", func(e MapEnv) bool { return HookFeedURL(e) != "" }},
		{EnvCurrentVersion, "9.9.9", func(e MapEnv) bool { return HookCurrentVersion(e) != "" }},
		{EnvChannel, "deb", func(e MapEnv) bool { _, ok := HookChannel(e); return ok }},
		{EnvFault, "relaunch-fail", func(e MapEnv) bool { return HookFault(e) != "" }},
		{EnvFault, "swap-fail", func(e MapEnv) bool { return HookFault(e) != "" }},
		{EnvFault, "checksum-mismatch", func(e MapEnv) bool { return HookFault(e) != "" }},
		{EnvFault, "download-stall", func(e MapEnv) bool { return HookFault(e) != "" }},
	}
	for _, h := range hooks {
		t.Run(h.key+"="+h.val, func(t *testing.T) {
			env := MapEnv{h.key: h.val} // no TESTING
			if h.check(env) {
				t.Fatalf("hook %s leaked with gate closed", h.key)
			}
		})
	}
}

func TestHookGateOpen(t *testing.T) {
	env := MapEnv{
		EnvTesting:        "1",
		EnvFeedURL:        "http://127.0.0.1:9/",
		EnvChannel:        "brew",
		EnvCurrentVersion: "1.2.3",
		EnvFault:          "swap-fail",
		EnvClock:          "2026-10-12T00:00:00Z",
	}
	if !TestingEnabled(env) {
		t.Fatal("want enabled")
	}
	if got := HookFeedURL(env); got != "http://127.0.0.1:9" {
		t.Fatalf("feed %q", got)
	}
	ch, ok := HookChannel(env)
	if !ok || ch != ChannelBrew {
		t.Fatalf("channel %q ok=%v", ch, ok)
	}
	if HookCurrentVersion(env) != "1.2.3" {
		t.Fatal("version")
	}
	if HookFault(env) != "swap-fail" {
		t.Fatal("fault")
	}
	clk := HookClock(env, RealClock{})
	want := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	if !clk.Now().Equal(want) {
		t.Fatalf("clock %v", clk.Now())
	}
}

func TestHookFaultValuesOpen(t *testing.T) {
	for _, fault := range []string{"relaunch-fail", "swap-fail", "checksum-mismatch", "download-stall"} {
		env := MapEnv{EnvTesting: "1", EnvFault: fault}
		if HookFault(env) != fault {
			t.Fatalf("fault %q", fault)
		}
	}
}
