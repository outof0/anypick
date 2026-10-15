package transfer

// Multi-account backup packages: export selected accounts as one owner-only
// package, inspect it with dispositions, and restore a selection atomically
// with explicit replacement approval.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
	"github.com/outof0/anypick/go/internal/store"
)

const (
	BackupVersion         = 1
	BackupKind            = "anypick-backup"
	MaxBackupAccounts     = 256
	MaxBackupFiles        = 4096
	MaxBackupDecodedBytes = 128 << 20
	MaxBackupEncodedBytes = 192 << 20
)

// BackupEntry selects one account (provider + name).
type BackupEntry struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
}

type backupPackageAccount struct {
	Provider string        `json:"provider"`
	Name     string        `json:"name"`
	Envelope *EnvelopeJSON `json:"envelope"`
}

type backupPackageJSON struct {
	Version   int                    `json:"version"`
	Kind      string                 `json:"kind"`
	CreatedAt string                 `json:"createdAt"`
	Accounts  []backupPackageAccount `json:"accounts"`
}

func backupError(code, format string, args ...interface{}) error {
	return anyerr.Newf(fmt.Sprintf(format, args...), code, anyerr.WithMutated(false))
}

func encodedSnapshotSize(files map[string]string) (int, int64) {
	decoded := int64(0)
	for _, content := range files {
		length := stdBase64.DecodedLen(len(content))
		if strings.HasSuffix(content, "=") {
			length--
		}
		if strings.HasSuffix(content, "==") {
			length--
		}
		if length < 0 {
			length = 0
		}
		decoded += int64(length)
	}
	return len(files), decoded
}

// ValidateBackupSelection normalizes and orders the selection, rejecting
// empty/duplicate/invalid entries.
func ValidateBackupSelection(accounts []BackupEntry) ([]BackupEntry, error) {
	if len(accounts) == 0 {
		return nil, backupError("BACKUP_EMPTY", "No saved accounts were selected for backup.")
	}
	if len(accounts) > MaxBackupAccounts {
		return nil, backupError("BACKUP_LIMIT",
			"A backup can contain at most %d accounts.", MaxBackupAccounts)
	}
	seen := map[string]bool{}
	selected := make([]BackupEntry, 0, len(accounts))
	for _, a := range accounts {
		if strings.TrimSpace(a.Provider) == "" {
			return nil, backupError("BACKUP_SELECTION_INVALID", "A selected backup account has no provider.")
		}
		name, err := slug.AccountName(a.Name)
		if err != nil {
			return nil, backupError("BACKUP_SELECTION_INVALID", "A selected backup account has an invalid name.")
		}
		key := a.Provider + "\x00" + name
		if seen[key] {
			return nil, backupError("BACKUP_DUPLICATE", "The backup selection contains a duplicate account.")
		}
		seen[key] = true
		selected = append(selected, BackupEntry{Provider: a.Provider, Name: name})
	}
	sort.Slice(selected, func(i, j int) bool {
		if selected[i].Provider != selected[j].Provider {
			return selected[i].Provider < selected[j].Provider
		}
		return selected[i].Name < selected[j].Name
	})
	return selected, nil
}

// ExportSelectedBackup writes one multi-account package. Non-overwrite writes
// fail when the destination exists (no silent clobber).
func ExportSelectedBackup(st *store.AccountStore, ctx context.Context, accounts []BackupEntry, destination string, overwrite bool) (int, error) {
	selected, err := ValidateBackupSelection(accounts)
	if err != nil {
		return 0, err
	}
	var encoded []byte
	err = lock.WithMutationLocks(ctx, st.Root, backupMutationScopes(selected), func(c context.Context) error {
		payload, err := buildBackupPackageLocked(st, c, selected)
		if err != nil {
			return err
		}
		raw, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return err
		}
		encoded = append(raw, '\n')
		if len(encoded) > MaxBackupEncodedBytes {
			return backupError("BACKUP_LIMIT", "Backup package exceeds the encoded size limit.")
		}
		return nil
	}, 0)
	if err != nil {
		return 0, err
	}

	if overwrite {
		if werr := atomicfile.Write(destination, encoded, 0o600); werr != nil {
			return 0, werr
		}
		return len(selected), nil
	}
	// Non-overwrite is a different operation, not a rename: a hard link never
	// clobbers an existing destination, so there is no window in which a
	// failed export has already replaced the file. Stage beside the target so
	// the link stays on one filesystem.
	if mkErr := os.MkdirAll(filepath.Dir(destination), 0o700); mkErr != nil {
		return 0, mkErr
	}
	stage, err := os.MkdirTemp(filepath.Dir(destination), ".anypick-backup-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(stage)
	stagedFile := filepath.Join(stage, "package.anypick-backup")
	if werr := os.WriteFile(stagedFile, encoded, 0o600); werr != nil {
		return 0, werr
	}
	if lerr := os.Link(stagedFile, destination); lerr != nil {
		if os.IsExist(lerr) {
			return 0, backupError("BACKUP_DESTINATION_EXISTS", "The backup destination already exists.")
		}
		return 0, lerr
	}
	return len(selected), nil
}

func backupMutationScopes(accounts []BackupEntry) []string {
	scopeSet := make(map[string]bool, len(accounts))
	for _, account := range accounts {
		scopeSet[refs.ProviderScope(account.Provider)] = true
	}
	scopes := make([]string, 0, len(scopeSet))
	for scope := range scopeSet {
		scopes = append(scopes, scope)
	}
	sort.Strings(scopes)
	return scopes
}

func buildBackupPackageLocked(st *store.AccountStore, ctx context.Context, selected []BackupEntry) (*backupPackageJSON, error) {
	for _, scope := range backupMutationScopes(selected) {
		if err := lock.Require(ctx, st.Root, scope); err != nil {
			return nil, err
		}
	}
	pkgAccounts := make([]backupPackageAccount, 0, len(selected))
	fileCount, decodedBytes := 0, 0
	for _, acct := range selected {
		envelope, berr := buildEnvelopeLocked(st, ctx, acct.Provider, acct.Name)
		if berr != nil {
			return nil, berr
		}
		fileCount += len(envelope.Files)
		for _, content := range envelope.Files {
			if raw, derr := stdBase64.DecodeString(content); derr == nil {
				decodedBytes += len(raw)
			}
		}
		if fileCount > MaxBackupFiles || decodedBytes > MaxBackupDecodedBytes {
			return nil, backupError("BACKUP_LIMIT", "Selected accounts exceed the backup package limits.")
		}
		pkgAccounts = append(pkgAccounts, backupPackageAccount{Provider: acct.Provider, Name: acct.Name, Envelope: envelope})
	}
	return &backupPackageJSON{
		Version: BackupVersion, Kind: BackupKind,
		CreatedAt: nowISO(), Accounts: pkgAccounts,
	}, nil
}

// ImportBackup restores every account in a backup package. The package is
// inspected before the restore so the same identity and replacement rules are
// used by the desktop, CLI, and TUI entry points. force is the explicit
// approval to replace entries whose names already exist.
func ImportBackup(ctx context.Context, st *store.AccountStore, reg *provider.Registry, path string, force bool) ([]store.Meta, error) {
	return importBackup(ctx, st, reg, path, "", force)
}

// ImportBackupForProvider restores only the entries for providerID from a
// multi-account backup. The TUI starts imports from one provider's account
// list, so importing a package there must stay scoped to that provider.
func ImportBackupForProvider(ctx context.Context, st *store.AccountStore, reg *provider.Registry, path, providerID string, force bool) ([]store.Meta, error) {
	if strings.TrimSpace(providerID) == "" {
		return nil, backupError("BACKUP_SELECTION_INVALID", "A provider is required to import a backup selection.")
	}
	return importBackup(ctx, st, reg, path, providerID, force)
}

func importBackup(ctx context.Context, st *store.AccountStore, reg *provider.Registry, path, providerID string, force bool) ([]store.Meta, error) {
	inspection, err := InspectBackup(st, reg, path)
	if err != nil {
		return nil, err
	}
	selected := make([]BackupEntry, 0, len(inspection.Entries))
	replace := make([]BackupEntry, 0, len(inspection.Entries))
	for _, entry := range inspection.Entries {
		if providerID != "" && entry.Provider != providerID {
			continue
		}
		selected = append(selected, BackupEntry{Provider: entry.Provider, Name: entry.Name})
		if force && entry.Disposition == DispositionReplace {
			replace = append(replace, BackupEntry{Provider: entry.Provider, Name: entry.Name})
		}
	}
	if len(selected) == 0 {
		return nil, backupError("BACKUP_SELECTION_INVALID", "The backup contains no accounts for the selected provider.")
	}
	return RestoreSelectedContext(ctx, st, reg, path, selected, RestoreOptions{Replace: replace})
}

// FileImportOptions carries the choices a UI made for one import operation.
// ImportFiles owns format detection so every UI uses the same import path.
type FileImportOptions struct {
	ProviderID string
	Name       string
	Force      bool
	Selection  []BackupEntry
	Replace    []BackupEntry
}

// ImportFiles imports account envelopes or a multi-account backup. A backup
// selection is optional; when omitted, all entries in the package are selected
// (or only the entries matching ProviderID when it is set).
func ImportFiles(deps ImportDeps, ctx context.Context, paths []string, opts FileImportOptions) ([]store.Meta, error) {
	if len(paths) == 0 {
		return nil, backupError("BACKUP_EMPTY", "No import files were selected.")
	}
	if len(paths) > MaxBackupAccounts {
		return nil, backupError("BACKUP_LIMIT", "An import can contain at most %d files.", MaxBackupAccounts)
	}

	if len(paths) == 1 && (opts.Name == "" || importFileKind(paths[0]) == BackupKind) {
		if opts.Name != "" {
			return nil, anyerr.Newf(
				"A multi-account backup cannot be imported with provider and account arguments; pass only the backup file.",
				"INVALID_USAGE", anyerr.WithMutated(false))
		}
		if len(opts.Replace) > 0 && len(opts.Selection) == 0 {
			return nil, backupError("BACKUP_SELECTION_INVALID",
				"Replacement approval requires an explicit backup selection.")
		}
		if len(opts.Selection) == 0 && len(opts.Replace) == 0 {
			if opts.ProviderID != "" {
				return ImportBackupForProvider(ctx, deps.Store, deps.Providers, paths[0], opts.ProviderID, opts.Force)
			}
			return ImportBackup(ctx, deps.Store, deps.Providers, paths[0], opts.Force)
		}

		inspection, err := InspectBackup(deps.Store, deps.Providers, paths[0])
		if err != nil {
			return nil, err
		}
		selected := append([]BackupEntry(nil), opts.Selection...)
		if len(selected) == 0 {
			for _, entry := range inspection.Entries {
				if opts.ProviderID == "" || entry.Provider == opts.ProviderID {
					selected = append(selected, BackupEntry{Provider: entry.Provider, Name: entry.Name})
				}
			}
		}
		if len(selected) == 0 {
			return nil, backupError("BACKUP_SELECTION_INVALID", "The backup contains no accounts for the selected provider.")
		}
		for _, entry := range selected {
			if opts.ProviderID != "" && entry.Provider != opts.ProviderID {
				return nil, backupError("BACKUP_SELECTION_INVALID",
					"The backup selection contains an account outside the requested provider.")
			}
		}

		replace := append([]BackupEntry(nil), opts.Replace...)
		if opts.Force && len(replace) == 0 {
			selectedSet := make(map[string]bool, len(selected))
			for _, entry := range selected {
				selectedSet[entry.Provider+"\x00"+entry.Name] = true
			}
			for _, entry := range inspection.Entries {
				if entry.Disposition == DispositionReplace && selectedSet[entry.Provider+"\x00"+entry.Name] {
					replace = append(replace, BackupEntry{Provider: entry.Provider, Name: entry.Name})
				}
			}
		}
		return RestoreSelectedContext(ctx, deps.Store, deps.Providers, paths[0], selected,
			RestoreOptions{Replace: replace})
	}

	if len(opts.Selection) > 0 || len(opts.Replace) > 0 {
		return nil, backupError("BACKUP_SELECTION_INVALID",
			"A backup selection can only be applied to one multi-account backup file.")
	}
	if opts.Name != "" {
		if len(paths) != 1 || opts.ProviderID == "" {
			return nil, backupError("IMPORT_SELECTION_INVALID",
				"A named account import requires one file and a provider.")
		}
		name, err := slug.AccountName(opts.Name)
		if err != nil {
			return nil, anyerr.Newf(err.Error(), "INVALID_USAGE", anyerr.WithMutated(false))
		}
		return importEnvelopeFiles(ctx, deps.Store, deps.Providers, paths, opts.ProviderID, name, opts.Force)
	}
	return importEnvelopeFiles(ctx, deps.Store, deps.Providers, paths, opts.ProviderID, "", opts.Force)
}

func importFileKind(path string) string {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxBackupEncodedBytes {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var header struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &header) != nil {
		return ""
	}
	return header.Kind
}

// ImportEnvelopeFiles imports several single-account JSON envelopes as one
// restore operation. Shells expand a path such as `exports/*.json` before the
// CLI sees it; collecting the envelopes into a temporary backup package keeps
// the validation, collision checks, and commit behavior identical to a native
// multi-account backup.
func ImportEnvelopeFiles(ctx context.Context, st *store.AccountStore, reg *provider.Registry, paths []string, force bool) ([]store.Meta, error) {
	return importEnvelopeFiles(ctx, st, reg, paths, "", "", force)
}

func importEnvelopeFiles(ctx context.Context, st *store.AccountStore, reg *provider.Registry, paths []string, expectedProviderID, requestedName string, force bool) ([]store.Meta, error) {
	if len(paths) == 0 {
		return nil, backupError("BACKUP_EMPTY", "No JSON files were selected for import.")
	}
	if len(paths) > MaxBackupAccounts {
		return nil, backupError("BACKUP_LIMIT", "An import can contain at most %d files.", MaxBackupAccounts)
	}

	accounts := make([]backupPackageAccount, 0, len(paths))
	refs := make([]BackupEntry, 0, len(paths))
	var totalEncoded int64
	totalFiles, totalDecoded := 0, int64(0)
	for i, path := range paths {
		info, statErr := os.Stat(path)
		if statErr != nil || !info.Mode().IsRegular() {
			return nil, backupError("BACKUP_MISSING", "JSON import file %q could not be read.", path)
		}
		if info.Size() > MaxImportEnvelopeSize {
			return nil, backupError("BACKUP_LIMIT", "JSON import file %q exceeds the encoded size limit.", path)
		}
		totalEncoded += info.Size()
		if totalEncoded > MaxBackupEncodedBytes {
			return nil, backupError("BACKUP_LIMIT", "Selected JSON import files exceed the encoded size limit.")
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, backupError("BACKUP_FORMAT", "JSON import file %q could not be read.", path)
		}
		var header struct {
			Kind string `json:"kind"`
			Meta struct {
				Provider string `json:"provider"`
			} `json:"meta"`
		}
		if json.Unmarshal(raw, &header) != nil || header.Kind != EnvelopeKind {
			return nil, backupError("BACKUP_FORMAT", "Import file %d (%q) is not an AnyPick account envelope.", i+1, path)
		}
		if header.Meta.Provider == "" {
			return nil, backupError("BACKUP_FORMAT", "Import file %d (%q) has no provider.", i+1, path)
		}
		if expectedProviderID != "" && header.Meta.Provider != expectedProviderID {
			return nil, backupError("BACKUP_FORMAT",
				"Import file %d belongs to provider %q, not requested provider %q.",
				i+1, header.Meta.Provider, expectedProviderID)
		}
		env, decodeErr := DecodeEnvelope(raw, header.Meta.Provider)
		if decodeErr != nil {
			return nil, decodeErr
		}
		nameToImport := env.Meta.Name
		if requestedName != "" {
			nameToImport = requestedName
		}
		name, nameErr := slug.AccountName(nameToImport)
		if nameErr != nil {
			return nil, backupError("BACKUP_FORMAT", "Import file %d (%q) has an invalid account name.", i+1, path)
		}
		env.Meta.Name = name
		fileCount, decodedBytes := encodedSnapshotSize(env.Files)
		totalFiles += fileCount
		totalDecoded += decodedBytes
		if totalFiles > MaxBackupFiles || totalDecoded > MaxBackupDecodedBytes {
			return nil, backupError("BACKUP_LIMIT", "Selected JSON import files exceed the backup payload limits.")
		}
		accounts = append(accounts, backupPackageAccount{
			Provider: env.Meta.Provider,
			Name:     env.Meta.Name,
			Envelope: &EnvelopeJSON{
				Version: env.Version,
				Kind:    env.Kind,
				Meta:    env.Meta,
				Proxy:   env.Proxy,
				Files:   env.Files,
			},
		})
		refs = append(refs, BackupEntry{Provider: env.Meta.Provider, Name: env.Meta.Name})
	}
	selected, err := ValidateBackupSelection(refs)
	if err != nil {
		return nil, err
	}

	packagePath, err := os.CreateTemp("", "anypick-import-*.json")
	if err != nil {
		return nil, err
	}
	packageName := packagePath.Name()
	if closeErr := packagePath.Close(); closeErr != nil {
		_ = os.Remove(packageName)
		return nil, closeErr
	}
	defer os.Remove(packageName)
	payload := backupPackageJSON{
		Version:   BackupVersion,
		Kind:      BackupKind,
		CreatedAt: nowISO(),
		Accounts:  accounts,
	}
	raw, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		return nil, marshalErr
	}
	if writeErr := os.WriteFile(packageName, raw, 0o600); writeErr != nil {
		return nil, writeErr
	}

	replace := selected
	if !force {
		replace = nil
	}
	return RestoreSelectedContext(ctx, st, reg, packageName, selected, RestoreOptions{Replace: replace})
}

// Disposition is the per-account restore outcome.
type Disposition string

const (
	DispositionCreate      Disposition = "create"
	DispositionReplace     Disposition = "replace"
	DispositionBlocked     Disposition = "blocked"
	DispositionUnavailable Disposition = "unavailable"
)

// PreviewEntry is one account's restore preview.
type PreviewEntry struct {
	Provider    string      `json:"provider"`
	Name        string      `json:"name"`
	Label       string      `json:"label"`
	Disposition Disposition `json:"disposition"`
	Reason      string      `json:"reason,omitempty"`
}

// Inspection is the decoded package with per-account dispositions.
type Inspection struct {
	CreatedAt string         `json:"createdAt"`
	Entries   []PreviewEntry `json:"entries"`
}

type plannedEntry struct {
	acct        backupPackageAccount
	label       string
	identity    string
	disposition Disposition
	reason      string
}

// InspectBackup decodes the package and reports per-account dispositions.
func InspectBackup(st *store.AccountStore, reg *provider.Registry, path string) (*Inspection, error) {
	prepared, err := prepareBackup(st, reg, path)
	if err != nil {
		return nil, err
	}
	out := &Inspection{CreatedAt: prepared.createdAt, Entries: make([]PreviewEntry, 0, len(prepared.entries))}
	for _, e := range prepared.entries {
		out.Entries = append(out.Entries, PreviewEntry{
			Provider: e.acct.Provider, Name: e.acct.Name, Label: e.label,
			Disposition: e.disposition, Reason: e.reason,
		})
	}
	return out, nil
}

// RestoreOptions carries explicit replacement approval.
type RestoreOptions struct {
	Replace []BackupEntry
}

// RestoreSelectedContext restores a selection in one atomic batch under sorted,
// provider-scoped coordinator locks (invariant #5). Replacing an existing
// account requires its exact provider/name pair in opts.Replace.
func RestoreSelectedContext(ctx context.Context, st *store.AccountStore, reg *provider.Registry, path string, selected []BackupEntry, opts RestoreOptions) ([]store.Meta, error) {
	// Sorted provider-scoped locks cover every account the batch touches so a
	// concurrent save/refresh/remove cannot interleave (ADR 0009/0011).
	scopeSet := map[string]bool{}
	for _, e := range append(append([]BackupEntry{}, selected...), opts.Replace...) {
		scopeSet[refs.ProviderScope(e.Provider)] = true
	}
	scopes := make([]string, 0, len(scopeSet))
	for scope := range scopeSet {
		scopes = append(scopes, scope)
	}
	sort.Strings(scopes)
	var metas []store.Meta
	err := lock.WithMutationLocks(ctx, st.Root, scopes,
		func(ctx context.Context) error {
			m, err := restoreSelectedLocked(ctx, st, reg, path, selected, opts)
			metas = m
			return err
		}, 0)
	if err != nil {
		return nil, err
	}
	return metas, nil
}

// restoreSelectedLocked must receive the context that holds the coordinator
// locks: it calls WriteAccountsBatchContext, which re-enters the same scopes.
// Building a fresh context here deadlocks on the in-process path mutex (ADR
// 0009 re-entrancy is carried in the context).
func restoreSelectedLocked(ctx context.Context, st *store.AccountStore, reg *provider.Registry, path string, selected []BackupEntry, opts RestoreOptions) ([]store.Meta, error) {
	prepared, err := prepareBackup(st, reg, path)
	if err != nil {
		return nil, err
	}
	selectedKeys, err := validateRefs(selected)
	if err != nil {
		return nil, err
	}
	replacementKeys, err := validateRefs(opts.Replace)
	if err != nil {
		return nil, err
	}
	for key := range replacementKeys {
		if !selectedKeys[key] {
			return nil, backupError("BACKUP_REPLACE_INVALID",
				"Replacement confirmation does not match the selected accounts.")
		}
	}
	byKey := map[string]plannedEntry{}
	for _, e := range prepared.entries {
		byKey[e.acct.Provider+"\x00"+e.acct.Name] = e
	}
	chosen := make([]plannedEntry, 0, len(selectedKeys))
	for key := range selectedKeys {
		entry, ok := byKey[key]
		if !ok {
			return nil, backupError("BACKUP_SELECTION_INVALID",
				"The restore selection contains an unknown account.")
		}
		switch entry.disposition {
		case DispositionBlocked:
			return nil, backupError("BACKUP_COLLISION",
				"A selected account has a different-name identity collision.")
		case DispositionUnavailable:
			return nil, backupError("BACKUP_UNAVAILABLE",
				"A selected account cannot be prepared by its provider.")
		case DispositionReplace:
			if !replacementKeys[key] {
				return nil, backupError("BACKUP_REPLACE_REQUIRED",
					"Replacing an existing account requires explicit confirmation.")
			}
		}
		chosen = append(chosen, entry)
	}
	sort.Slice(chosen, func(i, j int) bool {
		a, b := chosen[i].acct, chosen[j].acct
		if a.Provider != b.Provider {
			return a.Provider < b.Provider
		}
		return a.Name < b.Name
	})

	stage, err := os.MkdirTemp("", "anypick-restore-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stage)

	now := nowISO()
	writes := make([]store.BatchWrite, 0, len(chosen))
	metas := make([]store.Meta, 0, len(chosen))
	for i, entry := range chosen {
		snapshotDir := filepath.Join(stage, fmt.Sprint(i))
		if werr := WriteSnapshotFiles(snapshotDir, entry.acct.Envelope.Files); werr != nil {
			return nil, werr
		}
		existing, _ := st.Get(ctx, entry.acct.Provider, entry.acct.Name)
		createdAt := firstNonEmpty(metaCreatedAt(existing), entry.acct.Envelope.Meta.CreatedAt, now)
		meta := store.Meta{
			Name:            entry.acct.Name,
			Provider:        entry.acct.Provider,
			CreatedAt:       createdAt,
			UpdatedAt:       now,
			Label:           entry.label,
			Identity:        entry.identity,
			Notes:           entry.acct.Envelope.Meta.Notes,
			CredentialKind:  entry.acct.Envelope.Meta.CredentialKind,
			CredentialClass: entry.acct.Envelope.Meta.CredentialClass,
		}
		proxy := store.DefaultProxyConfig()
		if entry.acct.Envelope.Proxy != nil {
			proxy = *entry.acct.Envelope.Proxy
		}
		proxy.Enabled = false
		proxy.Options = nil
		writes = append(writes, store.BatchWrite{Meta: meta, Proxy: proxy, SnapshotDir: snapshotDir})
		metas = append(metas, meta)
	}
	if err := st.WriteAccountsBatchContext(ctx, writes); err != nil {
		return nil, err
	}
	return metas, nil
}

func validateRefs(entries []BackupEntry) (map[string]bool, error) {
	keys := map[string]bool{}
	for _, e := range entries {
		if strings.TrimSpace(e.Provider) == "" {
			return nil, backupError("BACKUP_SELECTION_INVALID",
				"The restore selection contains an invalid account reference.")
		}
		name, err := slug.AccountName(e.Name)
		if err != nil {
			return nil, backupError("BACKUP_SELECTION_INVALID",
				"The restore selection contains an invalid account reference.")
		}
		keys[e.Provider+"\x00"+name] = true
	}
	return keys, nil
}

type preparedPackage struct {
	createdAt string
	entries   []plannedEntry
}

// readBackupPackage reads and validates the whole package before any state is
// touched. Every envelope is re-run through the same codec as single imports.
func readBackupPackage(path string) (*backupPackageJSON, error) {
	info, statErr := os.Stat(path)
	if statErr != nil || !info.Mode().IsRegular() {
		return nil, backupError("BACKUP_MISSING", "Backup package could not be read.")
	}
	if info.Size() > MaxBackupEncodedBytes {
		return nil, backupError("BACKUP_LIMIT", "Backup package exceeds the encoded size limit.")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, backupError("BACKUP_FORMAT", "Backup package is not valid JSON.")
	}
	var pkg backupPackageJSON
	if json.Unmarshal(raw, &pkg) != nil {
		return nil, backupError("BACKUP_FORMAT", "Backup package is not valid JSON.")
	}
	// Normalize a single-account export into the same restore plan as a package.
	// Desktop preview and commit must interpret the exact same staged bytes.
	if pkg.Kind == EnvelopeKind {
		var envelope EnvelopeJSON
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return nil, importFormat("Invalid account envelope.")
		}
		decoded, err := DecodeEnvelope(raw, envelope.Meta.Provider)
		if err != nil {
			return nil, err
		}
		pkg = backupPackageJSON{
			Version: BackupVersion, Kind: BackupKind, CreatedAt: decoded.Meta.CreatedAt,
			Accounts: []backupPackageAccount{{Provider: decoded.Meta.Provider, Name: decoded.Meta.Name, Envelope: &envelope}},
		}
	}
	if pkg.Kind != BackupKind {
		return nil, backupError("BACKUP_FORMAT", "Unrecognized backup package format.")
	}
	// A newer writer is not a damaged file (B4): report it so the UI can
	// offer an update instead of "damaged".
	if pkg.Version > BackupVersion {
		return nil, backupError(
			"BACKUP_VERSION", "Backup package was created by a newer AnyPick version.")
	}
	if pkg.Version != BackupVersion {
		return nil, backupError("BACKUP_FORMAT", "Unrecognized backup package format.")
	}
	if len(pkg.Accounts) == 0 {
		return nil, backupError("BACKUP_EMPTY", "Backup package contains no accounts.")
	}
	if len(pkg.Accounts) > MaxBackupAccounts {
		return nil, backupError("BACKUP_LIMIT", "A backup can contain at most %d accounts.", MaxBackupAccounts)
	}
	totalFiles, totalDecoded := 0, int64(0)
	for i, acct := range pkg.Accounts {
		// The envelope is untrusted input. A missing or explicit null envelope
		// must be reported as a format error before prepareBackup dereferences
		// its metadata (the desktop inspection path accepts user-selected files).
		if acct.Envelope == nil {
			return nil, backupError("BACKUP_FORMAT", "Backup entry %d is missing its envelope.", i+1)
		}
		if strings.TrimSpace(acct.Provider) == "" {
			return nil, backupError("BACKUP_FORMAT", "Backup entry %d has an invalid account reference.", i+1)
		}
		if _, nameErr := slug.AccountName(acct.Name); nameErr != nil {
			return nil, backupError("BACKUP_FORMAT", "Backup entry %d has an invalid account reference.", i+1)
		}
		fileCount, decodedBytes := encodedSnapshotSize(acct.Envelope.Files)
		totalFiles += fileCount
		totalDecoded += decodedBytes
		if totalFiles > MaxBackupFiles || totalDecoded > MaxBackupDecodedBytes {
			return nil, backupError("BACKUP_LIMIT", "Backup package exceeds the file or decoded payload limit.")
		}
	}
	return &pkg, nil
}

// prepareBackup describes each envelope against its provider, then computes
// dispositions from local identities.
func prepareBackup(st *store.AccountStore, reg *provider.Registry, path string) (*preparedPackage, error) {
	pkg, err := readBackupPackage(path)
	if err != nil {
		return nil, err
	}
	type described struct {
		acct        backupPackageAccount
		label       string
		identity    string
		unavailable bool
	}
	list := make([]described, 0, len(pkg.Accounts))
	stage, merr := os.MkdirTemp("", "anypick-inspect-")
	if merr != nil {
		return nil, merr
	}
	defer os.RemoveAll(stage)

	for i, acct := range pkg.Accounts {
		envRaw, jerr := json.Marshal(acct.Envelope)
		if jerr != nil {
			return nil, jerr
		}
		env, derr := DecodeEnvelope(envRaw, acct.Envelope.Meta.Provider)
		if derr != nil {
			if IsUnsafePath(derr) {
				// Keep the Design copy and the unsafe-path reason intact.
				return nil, derr
			}
			return nil, backupError("BACKUP_FORMAT", "Backup entry %d failed validation: %v", i+1, derr)
		}
		outerName, nameErr := slug.AccountName(acct.Name)
		if nameErr != nil {
			return nil, backupError("BACKUP_FORMAT", "Backup entry %d has an invalid account name.", i+1)
		}
		metaName, metaNameErr := slug.AccountName(env.Meta.Name)
		if metaNameErr != nil || outerName != metaName || acct.Provider != env.Meta.Provider {
			return nil, backupError("BACKUP_FORMAT", "Backup entry %d account reference does not match its envelope.", i+1)
		}
		env.Meta.Name = outerName
		item := described{
			acct: backupPackageAccount{Provider: env.Meta.Provider, Name: outerName, Envelope: &EnvelopeJSON{
				Version: env.Version, Kind: env.Kind, Meta: env.Meta, Proxy: env.Proxy, Files: env.Files,
			}},
			label:    firstNonEmpty(env.Meta.Label, outerName),
			identity: env.Meta.Identity,
		}
		pv, gerr := reg.Get(env.Meta.Provider)
		if gerr != nil {
			item.unavailable = true
			list = append(list, item)
			continue
		}
		if desc, ok := pv.(interface {
			DescribeSnapshot(srcDir string) (provider.SnapshotInfo, error)
		}); ok && len(env.Files) > 0 {
			dir := filepath.Join(stage, fmt.Sprint(i))
			werr := WriteSnapshotFiles(dir, env.Files)
			if werr != nil {
				item.unavailable = true
			} else if details, derr2 := desc.DescribeSnapshot(dir); derr2 == nil {
				if details.Label != "" {
					item.label = details.Label
				}
				if details.Identity != "" {
					item.identity = details.Identity
				}
			} else {
				item.unavailable = true
			}
		}
		list = append(list, item)
	}
	refs := make([]BackupEntry, 0, len(list))
	for _, item := range list {
		refs = append(refs, BackupEntry{Provider: item.acct.Provider, Name: item.acct.Name})
	}
	if _, err := ValidateBackupSelection(refs); err != nil {
		return nil, err
	}

	// Duplicate identities inside the package itself are conflicts too.
	packageIdentityCounts := map[string]int{}
	for _, item := range list {
		if provider.AccountScopedIdentity(item.identity) {
			packageIdentityCounts[item.acct.Provider+"\x00"+normalizeIdentityKey(item.identity)]++
		}
	}

	entries := make([]plannedEntry, 0, len(list))
	for _, item := range list {
		e := plannedEntry{acct: item.acct, label: item.label, identity: item.identity}
		if item.unavailable {
			e.disposition = DispositionUnavailable
			e.reason = "provider-unavailable"
			entries = append(entries, e)
			continue
		}
		local, lerr := st.ListAccounts(context.Background(), item.acct.Provider)
		if lerr != nil {
			return nil, lerr
		}
		normIdentity := normalizeIdentityKey(item.identity)
		collision := false
		if provider.AccountScopedIdentity(item.identity) {
			for _, acct := range local {
				if acct.Meta.Name != item.acct.Name && provider.AccountScopedIdentity(acct.Meta.Identity) &&
					normalizeIdentityKey(acct.Meta.Identity) == normIdentity {
					collision = true
					break
				}
			}
			if packageIdentityCounts[item.acct.Provider+"\x00"+normIdentity] > 1 {
				collision = true
			}
		}
		if collision {
			e.disposition = DispositionBlocked
			e.reason = "identity-conflict"
			entries = append(entries, e)
			continue
		}
		exists := false
		for _, acct := range local {
			if acct.Meta.Name == item.acct.Name {
				exists = true
				break
			}
		}
		if exists {
			e.disposition = DispositionReplace
		} else {
			e.disposition = DispositionCreate
		}
		entries = append(entries, e)
	}
	return &preparedPackage{createdAt: pkg.CreatedAt, entries: entries}, nil
}

// normalizeIdentityKey is the case-insensitive identity comparison used for
// identity collisions.
func normalizeIdentityKey(identity string) string {
	if identity == "" {
		return ""
	}
	var parsed struct {
		Email string `json:"email"`
	}
	if json.Unmarshal([]byte(identity), &parsed) == nil && parsed.Email != "" {
		return strings.ToLower(parsed.Email)
	}
	return strings.ToLower(identity)
}
