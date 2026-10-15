// Process-local backup inspection manager: a visible preview is bound to a
// privately staged copy of the backup bytes; restore re-verifies the digest
// and the plan before committing.
package desktop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	accountsvc "github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/transfer"
)

const (
	maxInspections  = 8
	inspectionTTL   = 10 * time.Minute
	stagedFileLimit = int64(transfer.MaxBackupEncodedBytes)
)

type inspectionRecord struct {
	stagedPath string
	stagedRoot string
	digest     string
	expiresAt  time.Time
	createdAt  string
	entries    []transfer.PreviewEntry
}

// InspectionManager owns staged backups for this supervisor process. Import
// validation and writes stay behind the shared accounts service API.
type InspectionManager struct {
	accounts *accountsvc.Service
	mu       sync.Mutex
	now      func() time.Time
	records  map[string]*inspectionRecord
}

func NewInspectionManager(accounts *accountsvc.Service) *InspectionManager {
	return &InspectionManager{accounts: accounts, now: time.Now, records: map[string]*inspectionRecord{}}
}

// Inspect stages path, inspects it, and binds a fresh inspection id. The
// result echoes requestID — the native app ignores previews whose requestId
// does not match the in-flight request.
func (m *InspectionManager) Inspect(requestID, path string) (*BackupPreviewResult, error) {
	stagedPath, stagedRoot, digest, err := stageBackup(path)
	if err != nil {
		return nil, err
	}
	inspection, ierr := m.accounts.InspectBackup(stagedPath)
	if ierr != nil {
		os.RemoveAll(stagedRoot)
		return nil, ierr
	}
	if len(inspection.Entries) == 0 || len(inspection.Entries) > transfer.MaxBackupAccounts {
		os.RemoveAll(stagedRoot)
		return nil, inspectionError("The backup preview has an invalid number of entries.")
	}
	for _, e := range inspection.Entries {
		if len(e.Provider) > 64 || len(e.Name) > 128 {
			os.RemoveAll(stagedRoot)
			return nil, inspectionError("The backup preview contains an invalid account reference.")
		}
	}

	id, err := newUUID()
	if err != nil {
		os.RemoveAll(stagedRoot)
		return nil, err
	}
	m.mu.Lock()
	m.purgeLocked()
	for len(m.records) >= maxInspections {
		oldest := ""
		var oldestExp time.Time
		for k, r := range m.records {
			if oldest == "" || r.expiresAt.Before(oldestExp) {
				oldest, oldestExp = k, r.expiresAt
			}
		}
		if oldest == "" {
			break
		}
		m.deleteLocked(oldest)
	}
	m.records[id] = &inspectionRecord{
		stagedPath: stagedPath, stagedRoot: stagedRoot, digest: digest,
		expiresAt: m.now().Add(inspectionTTL), createdAt: inspection.CreatedAt,
		entries: inspection.Entries,
	}
	m.mu.Unlock()

	out := &BackupPreviewResult{
		Version: ProtocolVersion, RequestID: requestID, Status: "ready",
		InspectionID: id, CreatedAt: inspection.CreatedAt,
		Entries: make([]BackupPreviewEntry, 0, len(inspection.Entries)),
	}
	for i, e := range inspection.Entries {
		label := e.Label
		if label == "" {
			label = e.Name
		}
		out.Entries = append(out.Entries, BackupPreviewEntry{
			ID:          strconv.FormatInt(int64(i), 36),
			ProviderID:  e.Provider,
			Name:        e.Name,
			Label:       label,
			Disposition: string(e.Disposition),
			Reason:      e.Reason,
		})
	}
	return out, nil
}

// Restore restores entryIds from the staged inspection. Replacements require
// overwriteConfirmed; blocked/unavailable entries are rejected.
func (m *InspectionManager) Restore(
	ctx context.Context,
	inspectionID string, entryIDs []string, overwriteConfirmed bool,
) (int, error) {
	m.mu.Lock()
	m.purgeLocked()
	record, ok := m.records[inspectionID]
	m.mu.Unlock()
	if !ok {
		return 0, inspectionError("The backup inspection is unknown or expired.")
	}

	selectedSet := map[string]bool{}
	ordered := make([]string, 0, len(entryIDs))
	for _, id := range entryIDs {
		if !selectedSet[id] {
			selectedSet[id] = true
			ordered = append(ordered, id)
		}
	}
	byID := map[string]transfer.PreviewEntry{}
	for i, e := range record.entries {
		byID[strconv.FormatInt(int64(i), 36)] = e
	}
	var selected []transfer.BackupEntry
	var replace []transfer.BackupEntry
	for _, id := range ordered {
		entry, known := byID[id]
		if !known || entry.Disposition == transfer.DispositionBlocked || entry.Disposition == transfer.DispositionUnavailable {
			return 0, inspectionError("The backup selection is no longer available.")
		}
		selected = append(selected, transfer.BackupEntry{Provider: entry.Provider, Name: entry.Name})
		if entry.Disposition == transfer.DispositionReplace {
			replace = append(replace, transfer.BackupEntry{Provider: entry.Provider, Name: entry.Name})
		}
	}
	if len(replace) > 0 && !overwriteConfirmed {
		return 0, inspectionError("Replacing selected accounts requires confirmation.")
	}

	// Consume the record only after validation passes; either order is safe
	// because the digest gate follows.
	digest, derr := hashBoundedFile(record.stagedPath, stagedFileLimit)
	if derr != nil || digest != record.digest {
		return 0, inspectionError("The staged backup failed its integrity check.")
	}
	current, cerr := m.accounts.InspectBackup(record.stagedPath)
	if cerr != nil {
		return 0, inspectionError("The staged backup failed its integrity check.")
	}
	if len(current.Entries) != len(record.entries) {
		return 0, inspectionError("The backup restore plan has changed.")
	}
	for i := range current.Entries {
		if current.Entries[i].Provider != record.entries[i].Provider ||
			current.Entries[i].Name != record.entries[i].Name ||
			current.Entries[i].Disposition != record.entries[i].Disposition {
			return 0, inspectionError("The backup restore plan has changed.")
		}
	}

	metas, rerr := m.accounts.Import(ctx, accountsvc.ImportRequest{
		Paths: []string{record.stagedPath}, Selection: selected, Replace: replace,
	})
	m.mu.Lock()
	m.deleteLocked(inspectionID)
	m.mu.Unlock()
	if rerr != nil {
		return 0, rerr
	}
	return len(metas), nil
}

// hashBoundedFile hashes at most limit bytes of path.
func hashBoundedFile(path string, limit int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.CopyN(h, f, limit); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (m *InspectionManager) purgeLocked() {
	now := m.now()
	for id, r := range m.records {
		if !r.expiresAt.After(now) {
			m.deleteLocked(id)
		}
	}
}

func (m *InspectionManager) deleteLocked(id string) {
	r, ok := m.records[id]
	if !ok {
		return
	}
	delete(m.records, id)
	if r.stagedRoot != "" {
		os.RemoveAll(r.stagedRoot)
	}
}

// Forget drops a staged inspection before its TTL (B3): the client calls it
// when the user discards a review, so staged credentials do not linger until
// restore, TTL, or eviction. Unknown ids succeed — forget is idempotent
// cleanup, not a lookup.
func (m *InspectionManager) Forget(id string) {
	if id == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deleteLocked(id)
}

// inspectionError builds the stable user-facing inspection error.
func inspectionError(msg string) error {
	return anyerr.Newf(msg, "BACKUP_INSPECT_FAILED")
}

// stageBackup copies the package to a private staging dir and returns
// (file, root, digest).
func stageBackup(path string) (string, string, string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", "", "", backupAccessError(err)
	}
	if info.IsDir() {
		return "", "", "", anyerr.Newf("Backup package could not be read.", "BACKUP_MISSING")
	}
	root, mkErr := os.MkdirTemp("", "anypick-tray-inspect-")
	if mkErr != nil {
		return "", "", "", mkErr
	}
	dest := filepath.Join(root, "package.anypick-backup")
	src, oerr := os.Open(path)
	if oerr != nil {
		os.RemoveAll(root)
		return "", "", "", backupAccessError(oerr)
	}
	defer src.Close()
	hash := sha256.New()
	out, cErr := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if cErr != nil {
		os.RemoveAll(root)
		return "", "", "", cErr
	}
	if _, err := io.CopyN(out, io.TeeReader(src, hash), stagedFileLimit); err != nil && !errors.Is(err, io.EOF) {
		out.Close()
		os.RemoveAll(root)
		return "", "", "", inspectionError("AnyPick could not inspect that backup. Choose a valid AnyPick backup file and try again.")
	}
	out.Close()
	return dest, root, hex.EncodeToString(hash.Sum(nil)), nil
}

// backupAccessError reports a missing file and a permission problem
// distinctly (B5): conflating them sent missing files to the permission
// copy and permission failures to "damaged".
func backupAccessError(err error) error {
	if os.IsNotExist(err) {
		return anyerr.Newf("Backup package could not be found.", "BACKUP_MISSING")
	}
	if os.IsPermission(err) {
		return anyerr.Newf("Backup package could not be read.", "BACKUP_DENIED")
	}
	return anyerr.Newf("Backup package could not be read.", "BACKUP_MISSING")
}

func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// inspectionFailure builds the error preview frame. A refused path keeps its
// own reason and the Design message instead of falling back to "damaged".
func inspectionFailure(requestID string, err error) BackupPreviewResult {
	reason := inspectionFailureReason(err)
	message := inspectionFailureMessage(reason)
	var ae *anyerr.Error
	if reason == transfer.ReasonUnsafePath && errors.As(err, &ae) {
		message = ae.Message
	}
	return BackupPreviewResult{
		Version: ProtocolVersion, RequestID: requestID, Status: "error",
		Error: "inspection-failed", Code: "BACKUP_INSPECT_FAILED", Reason: reason,
		Message: message,
	}
}

// inspectionFailureReason maps an inspection error to the protocol reason.
func inspectionFailureReason(err error) string {
	if transfer.IsUnsafePath(err) {
		return transfer.ReasonUnsafePath
	}
	if ae, ok := err.(*anyerr.Error); ok {
		switch ae.Code {
		case "BACKUP_VERSION":
			return "newer-version"
		case "BACKUP_DENIED":
			return "permission-denied"
		case "BACKUP_MISSING":
			return "missing"
		}
	}
	return "damaged"
}

func inspectionFailureMessage(reason string) string {
	switch reason {
	case "newer-version":
		return "This backup was created by a newer AnyPick version. Update AnyPick, then review it again."
	case "permission-denied":
		return "AnyPick does not have permission to read that backup. Choose another file or update its permissions."
	case "missing":
		return "That backup file is gone. It may have been moved or deleted."
	default:
		return "AnyPick could not inspect that backup. Choose a valid AnyPick backup file and try again."
	}
}
