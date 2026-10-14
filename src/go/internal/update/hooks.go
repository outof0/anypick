package update

import (
	"strings"
	"time"
)

// Testing gate and hook env names. Every hook is ignored unless
// ANYPICK_UPDATE_TESTING=1, including in release builds.
const (
	EnvTesting        = "ANYPICK_UPDATE_TESTING"
	EnvFeedURL        = "ANYPICK_UPDATE_FEED_URL"
	EnvChannel        = "ANYPICK_UPDATE_CHANNEL"
	EnvClock          = "ANYPICK_UPDATE_CLOCK"
	EnvClockOffset    = "ANYPICK_UPDATE_CLOCK_OFFSET"
	EnvFault          = "ANYPICK_UPDATE_FAULT"
	EnvCurrentVersion = "ANYPICK_UPDATE_CURRENT_VERSION"
)

// TestingEnabled reports whether update testing hooks may be read.
func TestingEnabled(env Env) bool {
	if env == nil {
		env = OSEnv{}
	}
	return env.Getenv(EnvTesting) == "1"
}

// HookValue returns the value of a testing hook only when the gate is open.
// Without ANYPICK_UPDATE_TESTING=1 it always returns "".
func HookValue(env Env, key string) string {
	if !TestingEnabled(env) {
		return ""
	}
	if env == nil {
		env = OSEnv{}
	}
	return strings.TrimSpace(env.Getenv(key))
}

// HookClock returns a Clock overridden by testing hooks, or fallback.
func HookClock(env Env, fallback Clock) Clock {
	if fallback == nil {
		fallback = RealClock{}
	}
	if fixed := HookValue(env, EnvClock); fixed != "" {
		t, err := time.Parse(time.RFC3339, fixed)
		if err == nil {
			return FixedClock{T: t}
		}
	}
	if off := HookValue(env, EnvClockOffset); off != "" {
		d, err := time.ParseDuration(off)
		if err == nil {
			return OffsetClock{Base: fallback, Offset: d}
		}
	}
	return fallback
}

// HookChannel returns an InstallChannel override when the testing gate is open.
func HookChannel(env Env) (InstallChannel, bool) {
	v := HookValue(env, EnvChannel)
	if v == "" {
		return "", false
	}
	switch InstallChannel(v) {
	case ChannelDirect, ChannelBrew, ChannelNSIS, ChannelMSI, ChannelWinget,
		ChannelScoop, ChannelNPM, ChannelDeb, ChannelRPM, ChannelAppImage, ChannelUnknown:
		return InstallChannel(v), true
	default:
		return "", false
	}
}

// HookCurrentVersion returns a faked running version when the gate is open.
func HookCurrentVersion(env Env) string {
	return HookValue(env, EnvCurrentVersion)
}

// HookFeedURL returns a feed base URL override when the gate is open.
func HookFeedURL(env Env) string {
	return strings.TrimRight(HookValue(env, EnvFeedURL), "/")
}

// HookFault returns a fault injection name when the gate is open.
func HookFault(env Env) string {
	return HookValue(env, EnvFault)
}
