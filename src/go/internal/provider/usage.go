package provider

import "context"

type UsageWindow struct {
	Label            string   `json:"label"`
	RemainingPercent int      `json:"remainingPercent"`
	ResetsAtMs       *float64 `json:"resetsAtMs,omitempty"`
	// LimitWindowSeconds is the vendor's window cadence (e.g. 18000 for a
	// 5-hour Codex window). It answers "which limit" without inferring
	// anything the payload does not state.
	LimitWindowSeconds *int `json:"limitWindowSeconds,omitempty"`
	// Group is an optional vendor section title (Antigravity
	// retrieveUserQuotaSummary displayName, e.g. "Gemini Models"). Empty
	// when the payload has no groups.
	Group string `json:"group,omitempty"`
}

type LiveUsage struct {
	Windows []UsageWindow `json:"windows"`
}

// LiveUsageProvider is implemented by providers that can read quota/rate-limit
// from their upstream API using the current live login (no snapshot needed).
type LiveUsageProvider interface {
	LiveUsage(ctx context.Context) (*LiveUsage, error)
}

// SnapshotUsageProvider reads a saved account's quota windows from its
// snapshot, so routing can compare accounts that are not the live login. It
// only reads: an expired token yields an error, never a refresh, because a
// refresh would rewrite the snapshot outside the account's own lock.
type SnapshotUsageProvider interface {
	SnapshotUsage(ctx context.Context, snapshotDir string) (*LiveUsage, error)
}
