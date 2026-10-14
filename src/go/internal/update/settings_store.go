package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/lock"
)

const settingsLockTimeout = 10 * time.Second

func settingsPath(cacheDir string) string {
	return filepath.Join(cacheDir, "settings.json")
}

func readSettings(path string) (UpdateSettings, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return DefaultSettings(), nil
	}
	if err != nil {
		return UpdateSettings{}, err
	}
	var settings UpdateSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return UpdateSettings{}, err
	}
	return settings.Normalize(), nil
}

func loadSettings(path string) (UpdateSettings, error) {
	fl, err := lock.AcquireFileLock(path+".lock", settingsLockTimeout)
	if err != nil {
		return UpdateSettings{}, err
	}
	defer fl.Release()
	return readSettings(path)
}

// saveSettings keeps the rollback floor monotonic when update checks race.
// LastChecked and ETag move together because the validator belongs to the
// response whose check time was recorded.
func saveSettings(path string, next UpdateSettings) (UpdateSettings, error) {
	fl, err := lock.AcquireFileLock(path+".lock", settingsLockTimeout)
	if err != nil {
		return UpdateSettings{}, err
	}
	defer fl.Release()

	current, err := readSettings(path)
	if err != nil {
		return UpdateSettings{}, err
	}
	next.HighestSeen = MaxVersion(current.HighestSeen, next.HighestSeen)
	if !current.LastChecked.Before(next.LastChecked) {
		next.LastChecked = current.LastChecked
		next.ETag = current.ETag
	}
	// Preferences may be changed by another process while this check is on the
	// network. Keep the persisted values rather than writing stale defaults.
	next.AutoCheck = current.AutoCheck
	next.AutoDownload = current.AutoDownload
	next.SkippedVersion = current.SkippedVersion
	next = next.Normalize()

	data, err := json.Marshal(next)
	if err != nil {
		return UpdateSettings{}, err
	}
	if err := atomicfile.Write(path, append(data, '\n'), 0o600); err != nil {
		return UpdateSettings{}, err
	}
	return next, nil
}
