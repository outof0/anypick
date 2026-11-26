package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

// ErrQuotaLoginRequired means the saved or live login needs a new session
// before the provider will return quota.
var ErrQuotaLoginRequired = errors.New("quota requires a fresh login")

// ErrSavedQuotaUnavailable means this saved credential has no supported
// quota source.
var ErrSavedQuotaUnavailable = errors.New("no quota for this saved credential")

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

// SavedQuotaProvider is the on-demand account quota reader. Implementing it
// does not opt the provider in to background routing refreshes.
type SavedQuotaProvider interface {
	ReadSavedQuota(ctx context.Context, file SnapshotFileReader) (*LiveUsage, error)
}

// LiveAccountQuotaProvider verifies and queries the same live credential when
// publishing a reading under a saved account.
type LiveAccountQuotaProvider interface {
	LiveQuotaForSnapshot(ctx context.Context, file SnapshotFileReader) (*LiveUsage, error)
}

// SnapshotFileReader reads a named file from a single saved account.
type SnapshotFileReader func(name string) ([]byte, error)

func snapshotFilesAt(dir string) SnapshotFileReader {
	return func(name string) ([]byte, error) { return os.ReadFile(filepath.Join(dir, name)) }
}

// SnapshotFileMatcher lets display readers compare a committed snapshot
// without creating another on-disk copy of the credential.
type SnapshotFileMatcher interface {
	SnapshotFilesMatchLive(file SnapshotFileReader) (match bool, known bool, err error)
}
