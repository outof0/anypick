// Package quotacache keeps each saved account's quota windows on disk so the
// proxy can route by when quota comes back (ADR-0035). The proxy and hub
// children read it; they never fetch on the request path. Whoever refreshes it
// (the desktop service, a pool or hub child's background loop) writes it.
//
// It imports nothing that imports the proxy, so the proxy can read it.
package quotacache

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/paths"
)

// fileVersion guards the on-disk shape; an unknown version is read as empty.
const fileVersion = 1

// MaxAgeMs is how old an entry may be and still steer routing. Reset times
// move as quota is spent, so a stale entry is worse than none: none falls back
// to failover order, a stale one confidently picks the wrong account.
const MaxAgeMs = 30 * 60 * 1000

// Window is the part of a vendor quota window routing needs.
type Window struct {
	RemainingPercent int      `json:"remainingPercent"`
	ResetsAtMs       *float64 `json:"resetsAtMs,omitempty"`
}

// Entry is one account's last reading.
type Entry struct {
	FetchedAtMs int64    `json:"fetchedAtMs"`
	Windows     []Window `json:"windows"`
}

// File is one provider's cache.
type File struct {
	Version  int              `json:"version"`
	Accounts map[string]Entry `json:"accounts"`
}

// Path is the provider's cache file, next to its pool runtime state.
func Path(root, providerID string) string {
	return filepath.Join(paths.PoolRuntimeDir(root, providerID), "quota-windows.json")
}

// Load reads the cache. A missing or unreadable file is an empty cache: the
// strategy then falls back to failover order rather than failing a request.
func Load(root, providerID string) File {
	empty := File{Version: fileVersion, Accounts: map[string]Entry{}}
	raw, err := os.ReadFile(Path(root, providerID))
	if err != nil {
		return empty
	}
	var f File
	if json.Unmarshal(raw, &f) != nil || f.Version != fileVersion || f.Accounts == nil {
		return empty
	}
	return f
}

// Put records one account's reading, keeping the others.
func Put(root, providerID, account string, entry Entry) error {
	f := Load(root, providerID)
	f.Accounts[account] = entry
	return save(root, providerID, f)
}

// Forget drops an account's reading, so a reading that failed this time does
// not keep steering by the one before it.
func Forget(root, providerID, account string) error {
	f := Load(root, providerID)
	if _, ok := f.Accounts[account]; !ok {
		return nil
	}
	delete(f.Accounts, account)
	return save(root, providerID, f)
}

func save(root, providerID string, f File) error {
	f.Version = fileVersion
	raw, err := json.Marshal(f)
	if err != nil {
		return err
	}
	path := Path(root, providerID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	return atomicfile.Write(path, raw, 0o600)
}

// NextReset is the account's sort key: the soonest reset among windows that
// still have quota left, in Unix ms. Zero means unknown, and an unknown
// account sorts after every known one. A window with nothing left is skipped:
// its reset is when the account becomes usable, which the quota guard already
// handles as a cooldown.
func NextReset(entry Entry, nowMs int64) int64 {
	if entry.FetchedAtMs <= 0 || nowMs-entry.FetchedAtMs > MaxAgeMs {
		return 0
	}
	var best int64
	for _, w := range entry.Windows {
		if w.ResetsAtMs == nil || w.RemainingPercent <= 0 {
			continue
		}
		at := int64(*w.ResetsAtMs)
		if at <= nowMs {
			continue
		}
		if best == 0 || at < best {
			best = at
		}
	}
	return best
}

// OrderBySoonestReset sorts names so the account whose unused quota resets
// soonest comes first: that quota is lost at the reset anyway, so spending it
// first wastes the least. Unknown accounts keep their relative order after the
// known ones, which is plain failover order when nothing is known.
func OrderBySoonestReset(names []string, f File, nowMs int64) []string {
	out := append([]string(nil), names...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := NextReset(f.Accounts[out[i]], nowMs), NextReset(f.Accounts[out[j]], nowMs)
		switch {
		case a == 0:
			return false
		case b == 0:
			return true
		default:
			return a < b
		}
	})
	return out
}
