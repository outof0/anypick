// Package accounts saves, switches, and reports the active account, with
// the live-auth checkpoints that make switches compensable. Proxy side
// effects stay behind an optional interface — a service that was never
// handed proxy collaborators must not fake them.
package accounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
	"github.com/outof0/anypick/go/internal/store"
	"github.com/outof0/anypick/go/internal/transfer"
)

// Checkpoint is the exact local auth captured before a switch, used to
// compensate failures and crash recovery.
type Checkpoint struct {
	ProviderID    string  `json:"providerId"`
	Source        *string `json:"source,omitempty"`
	ActiveAccount *string `json:"activeAccount"`
	HadLiveAuth   bool    `json:"hadLiveAuth"`
	Directory     string  `json:"directory"`
}

// SwitchResult describes a completed account switch.
type SwitchResult struct {
	Provider          string `json:"provider"`
	ProviderName      string `json:"providerName"`
	From              string `json:"from"`
	To                string `json:"to"`
	RefreshedPrevious bool   `json:"refreshedPrevious"`
	RefreshedAccount  string `json:"refreshedAccount,omitempty"`
}

// CurrentResult reports the active pointer, live detection, and whether
// they agree.
type CurrentResult struct {
	Active         string
	Live           provider.LiveAuthStatus
	Account        *store.Account
	IsLiveMatch    bool
	LiveMatchKnown bool
}

type Service struct {
	Store               *store.AccountStore
	Providers           *provider.Registry
	Proxy               ProxyStopper
	AfterSwitch         func(ctx context.Context, providerID, accountName string) error
	AfterSnapshotChange func(ctx context.Context, providerID, accountName string) error
	// BeforeDelete runs inside the deletion's own mutation lock, after the
	// proxy for this account has stopped and before the account row is
	// removed. It is the cascade hook: a named native profile whose route is
	// this account is a derived resource, and deleting the account without it
	// leaves a native profile holding the deleted account's credential in a
	// private home nothing can reach any more.
	//
	// It returns the labels of what it removed ("codex/work") so callers can
	// report the cleanup instead of letting it happen invisibly, and an error
	// aborts the deletion: "the account is gone but its profile still points
	// at it" is the state this exists to prevent.
	//
	// It is deliberately injected (app wires activation) so accounts stays
	// independent of the activation and client packages, exactly like
	// AfterSwitch.
	BeforeDelete func(ctx context.Context, providerID, accountName string) ([]string, error)
}

// DeleteResult names the derived resources that went away with an account.
// The account row itself is not listed: the caller already knows its name.
type DeleteResult struct {
	// Profiles are named native client profiles that pointed at this account
	// and were removed with it.
	Profiles []string
}

// ProxyStopper is the narrow proxy lifecycle surface account deletion needs.
// It stays optional so account services used by import/tests do not need a
// running proxy composition.
type ProxyStopper interface {
	Stop(ctx context.Context, providerID, accountName string) error
}

// ProxySwitcher is the optional lifecycle surface used by account switching.
// Keep it separate from ProxyStopper: account deletion only needs Stop, while
// a switch must preserve the previous account's enabled setting, stop its live
// listener, and start the selected account only when that account is enabled.
// It stays an interface so accounts keeps no dependency on the proxy
// implementation's stores and locks.
type ProxySwitcher interface {
	ProxyStopper
	ProxyRunning(ctx context.Context, providerID, accountName string) (bool, error)
	StopProxyForSwitch(ctx context.Context, providerID, accountName string) error
	StartProxyIfEnabled(ctx context.Context, providerID, accountName string) error
}

func New(st *store.AccountStore, reg *provider.Registry) *Service {
	return &Service{Store: st, Providers: reg}
}

// SetAfterSwitch installs the optional side effect that keeps a provider's
// homonymous native client binding on the account just made active. The
// callback is deliberately injected to keep accounts independent from the
// bindings package.
func (s *Service) SetAfterSwitch(fn func(context.Context, string, string) error) {
	s.AfterSwitch = fn
}

// SetAfterSnapshotChange installs the optional reapply hook for resources
// derived from an account snapshot. It runs only after the snapshot commit and
// all enclosing mutation locks have completed.
func (s *Service) SetAfterSnapshotChange(fn func(context.Context, string, string) error) {
	s.AfterSnapshotChange = fn
}

func (s *Service) afterSnapshotChange(ctx context.Context, providerID, accountName string) error {
	if s.AfterSnapshotChange == nil {
		return nil
	}
	return lock.AfterMutation(ctx, func(c context.Context) error {
		if err := s.AfterSnapshotChange(c, providerID, accountName); err != nil {
			return anyerr.Wrapf(err,
				"account snapshot was saved, but dependent Codex profiles could not be refreshed",
				"ACCOUNT_PROFILE_REFRESH_FAILED", anyerr.WithMutated(true))
		}
		return nil
	})
}

func (s *Service) afterSnapshotChanges(ctx context.Context, metas []store.Meta) error {
	var errs []error
	for _, meta := range metas {
		if err := s.afterSnapshotChange(ctx, meta.Provider, meta.Name); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// SetBeforeDelete installs the optional cascade that removes named native
// profiles bound to the account being deleted. See Service.BeforeDelete.
func (s *Service) SetBeforeDelete(fn func(context.Context, string, string) ([]string, error)) {
	s.BeforeDelete = fn
}

type CredentialInput struct {
	Kind    string
	Secret  string
	Profile string // endpoint profile id (e.g. 'global', 'china')
}

// SaveInput saves an explicitly supplied credential (API key / plan key) as an
// account snapshot — the compatible-vendor path.
func (s *Service) SaveInput(ctx context.Context, providerID, name string, in CredentialInput, force bool) (store.Meta, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return store.Meta{}, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	inputer, ok := pv.(provider.CredentialInputProvider)
	if !ok {
		return store.Meta{}, anyerr.Newf(
			"Provider "+providerID+" does not accept manual credential inputs.",
			"UNSUPPORTED_CREDENTIAL_INPUT",
			anyerr.WithSuggestions(
				"Sign in using the official application or browser sign-in.",
				"Then save the current login in AnyPick."))
	}
	accountName, err := slug.AccountName(name)
	if err != nil {
		return store.Meta{}, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	var result store.Meta
	err = lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID), func(c context.Context) error {
		existing, getErr := s.Get(c, providerID, accountName)
		if getErr != nil {
			return getErr
		}
		if existing != nil && !force {
			return anyerr.Newf(
				"Account \""+accountName+"\" already exists for "+providerID+".",
				"ACCOUNT_EXISTS",
				anyerr.WithSuggestions("Choose a different account name, or confirm overwrite to replace it."))
		}
		snapshotDir, _, err := s.Store.PrepareSnapshot(providerID, accountName)
		if err != nil {
			return err
		}
		info, err := inputer.BackupInput(in.Kind, in.Secret, in.Profile, snapshotDir)
		if err != nil {
			_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
			return err
		}
		if err := s.ensureSnapshotNotAliased(c, providerID, accountName, snapshotDir); err != nil {
			_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
			return err
		}
		now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
		meta := store.Meta{
			Name: accountName, Provider: providerID,
			CreatedAt: now, UpdatedAt: now,
			CredentialKind:  info.CredentialKind,
			CredentialClass: store.CredentialClass(info.CredentialClass),
			Label:           info.Label,
		}
		if existing != nil {
			meta.CreatedAt = existing.Meta.CreatedAt
		}
		if err := s.Store.WriteMetaContext(c, meta, snapshotDir); err != nil {
			_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
			return err
		}
		_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
		result = meta
		return nil
	})
	if err != nil {
		return store.Meta{}, err
	}
	if err := s.afterSnapshotChange(ctx, providerID, accountName); err != nil {
		return result, err
	}
	return result, nil
}

// List returns saved accounts for one provider. The service owns this read
// surface so outer layers do not reach through to the table-owning store.
func (s *Service) List(ctx context.Context, providerID string) ([]store.Account, error) {
	return s.Store.ListAccounts(ctx, providerID)
}

// Active is the cheap read behind "which account is selected for this
// provider". It deliberately does not do the live-auth probing that Current
// does: call sites that only want the pointer must not pay for, or be
// affected by, a live credential check.
func (s *Service) Active(ctx context.Context, providerID string) (string, error) {
	return s.Store.GetActive(ctx, providerID)
}

// SetActive updates only AnyPick's active pointer. Profile-scoped logins use
// this to restore the pointer that belongs to the desktop/live CODEX_HOME
// after saving a second account in an isolated profile home.
func (s *Service) SetActive(ctx context.Context, providerID, name string) error {
	return lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID), func(c context.Context) error {
		if strings.TrimSpace(name) == "" {
			return s.Store.ClearActiveContext(c, providerID)
		}
		return s.Store.SetActiveContext(c, providerID, name)
	})
}

// PatchMeta applies a partial metadata update to a saved account. The store's
// mutator takes the coordinator lock itself, so a caller that already holds the
// same provider scope re-enters rather than deadlocking.
func (s *Service) PatchMeta(ctx context.Context, providerID, name string, patch store.MetaPatch) (store.Meta, error) {
	return s.Store.PatchMetaContext(ctx, providerID, name, patch)
}

// Get returns a saved account with its snapshot cache materialized, and so
// takes the provider lock. Reach for CachedAccount on a display path instead:
// a browser sign-in holds that lock for its whole user-paced flow
// (browserlogin.DefaultTimeout), and a read that needs no files on disk must
// not queue behind it.
func (s *Service) Get(ctx context.Context, providerID, name string) (*store.Account, error) {
	normalized, err := slug.AccountName(name)
	if err != nil {
		return nil, err
	}
	return s.Store.Get(ctx, providerID, normalized)
}

// CachedAccount is the display read: the saved account's metadata and paths
// without materializing its snapshot cache and without the provider lock.
// Snapshot builders run on a ticker and must never block on a sign-in that
// holds refs.ProviderScope for up to ten minutes; a Get here would instead burn
// the 5s lock budget and then fall back to the provider/name label because the
// read failed. Materialization is the only thing Get adds, so callers that need
// real files (Restore, export, fingerprinting) keep using Get.
func (s *Service) CachedAccount(ctx context.Context, providerID, name string) (*store.Account, error) {
	normalized, err := slug.AccountName(name)
	if err != nil {
		return nil, err
	}
	return s.Store.CachedAccount(ctx, providerID, normalized)
}

// Save backs up live auth into a named account. writeMeta stays the atomic
// commit point: staging first, backup second, single transaction last.
func (s *Service) Save(ctx context.Context, providerID, name string, force bool) (store.Meta, error) {
	return s.SaveWithSource(ctx, providerID, name, "", force)
}

// SaveWithSource is Save with an optional provider-owned live-login source.
// The empty source retains the automatic provider probe used by all existing
// callers; providers that expose SourceScopedProvider use the non-empty source
// to select one live store, while single-store providers keep their normal
// Backup operation.
func (s *Service) SaveWithSource(ctx context.Context, providerID, name, source string, force bool) (store.Meta, error) {
	source = strings.TrimSpace(source)
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return store.Meta{}, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	accountName, err := slug.AccountName(name)
	if err != nil {
		return store.Meta{}, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	var result store.Meta
	err = lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID), func(c context.Context) error {
		existing, getErr := s.Get(c, providerID, accountName)
		if getErr != nil {
			return getErr
		}
		if existing != nil && !force {
			return anyerr.Newf(
				"Account \""+accountName+"\" already exists for "+providerID+".",
				"ACCOUNT_EXISTS",
				anyerr.WithSuggestions("Choose a different account name, or confirm overwrite to replace it."))
		}
		meta, saveErr := s.saveLockedSource(c, pv, accountName, existing, source)
		if saveErr == nil {
			result = meta
		}
		return saveErr
	})
	if err != nil {
		return store.Meta{}, err
	}
	if err := s.afterSnapshotChange(ctx, providerID, accountName); err != nil {
		return result, err
	}
	return result, nil
}

// RefreshSnapshot replaces one saved account with the provider's current live
// credential. Requiring the existing row prevents a UI refresh from silently
// creating a different account after a concurrent delete.
func (s *Service) RefreshSnapshot(ctx context.Context, providerID, name string) (store.Meta, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return store.Meta{}, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	accountName, err := slug.AccountName(name)
	if err != nil {
		return store.Meta{}, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	var result store.Meta
	err = lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID), func(c context.Context) error {
		existing, getErr := s.Store.Get(c, providerID, accountName)
		if getErr != nil {
			return getErr
		}
		if existing == nil {
			return anyerr.Newf(
				`No account "`+accountName+`" for provider "`+providerID+`".`,
				"ACCOUNT_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound),
			)
		}
		refreshed, refreshErr := s.saveLocked(c, pv, accountName, existing)
		if refreshErr == nil {
			result = refreshed
		}
		return refreshErr
	})
	if err != nil {
		return store.Meta{}, err
	}
	if err := s.afterSnapshotChange(ctx, providerID, accountName); err != nil {
		return result, err
	}
	return result, nil
}

// Delete stops the exact account proxy, removes the named native profiles that
// pointed at the account, then removes the account and active pointer under the
// provider's single mutation scope (ADR 0011).
func (s *Service) Delete(ctx context.Context, providerID, name string) (DeleteResult, error) {
	var result DeleteResult
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return result, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	accountName, err := slug.AccountName(name)
	if err != nil {
		return result, anyerr.Newf(err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	err = lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID), func(c context.Context) error {
		existing, err := s.Store.Get(c, providerID, accountName)
		if err != nil {
			return err
		}
		if existing == nil {
			return anyerr.Newf(
				`No account "`+accountName+`" for provider "`+providerID+`".`,
				"ACCOUNT_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound),
			)
		}
		if s.Proxy != nil && pv.CanProxy() {
			if err := s.Proxy.Stop(c, providerID, accountName); err != nil {
				return err
			}
		}
		// Derived resources go before the row they derive from. A named
		// profile is removed with its account, not after it: once the row is
		// gone the profile is an orphan holding a credential nothing owns.
		if s.BeforeDelete != nil {
			removed, err := s.BeforeDelete(c, providerID, accountName)
			if err != nil {
				return err
			}
			result.Profiles = removed
		}
		// `c` carries the coordinator lock this closure runs under; `ctx` does
		// not, and re-entering with it would block on our own lock (ADR 0009).
		return s.Store.DeleteContext(c, providerID, accountName)
	})
	if err != nil {
		return DeleteResult{}, err
	}
	return result, nil
}

func (s *Service) saveLocked(ctx context.Context, pv provider.Provider, accountName string, existing *store.Account) (store.Meta, error) {
	return s.saveLockedSource(ctx, pv, accountName, existing, "")
}

func (s *Service) saveLockedSource(ctx context.Context, pv provider.Provider, accountName string, existing *store.Account, source string) (store.Meta, error) {
	snapshotDir, _, err := s.Store.PrepareSnapshot(pv.ID(), accountName)
	if err != nil {
		return store.Meta{}, err
	}
	var info provider.SnapshotInfo
	if source == "" {
		info, err = pv.Backup(snapshotDir)
	} else if scoped, ok := pv.(provider.SourceScopedProvider); ok {
		info, err = scoped.BackupSource(source, snapshotDir)
	} else {
		// LoginMethod.Source is also used by providers to describe the
		// owning client (for example Codex or Kiro). Only providers that
		// implement SourceScopedProvider have multiple snapshot stores;
		// their source is selected by the method but Backup remains the
		// correct provider-owned operation.
		info, err = pv.Backup(snapshotDir)
	}
	if err != nil {
		_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
		return store.Meta{}, err
	}
	if err := s.ensureSnapshotNotAliased(ctx, pv.ID(), accountName, snapshotDir); err != nil {
		_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
		return store.Meta{}, err
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	meta := store.Meta{
		Name:           accountName,
		Provider:       pv.ID(),
		CreatedAt:      now,
		UpdatedAt:      now,
		Identity:       info.Identity,
		Label:          info.Label,
		Notes:          info.Notes,
		CredentialKind: info.CredentialKind,
	}
	if existing != nil {
		meta.CreatedAt = existing.Meta.CreatedAt
	}
	if err := s.Store.WriteMetaContext(ctx, meta, snapshotDir); err != nil {
		_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
		return store.Meta{}, err
	}
	_ = s.Store.DiscardPreparedSnapshot(snapshotDir)
	return meta, nil
}

// Use switches live auth to a saved account (see useLocked). The previous
// login is checkpointed before anything mutates; any failure restores it.
func (s *Service) Use(ctx context.Context, providerID, name string, opts UseOptions) (SwitchResult, error) {
	result, err := useLocked(s, ctx, providerID, name, opts)
	if err != nil {
		return result, err
	}
	if result.RefreshedAccount != "" {
		if err := s.afterSnapshotChange(ctx, providerID, result.RefreshedAccount); err != nil {
			return result, err
		}
	}
	return result, nil
}

type UseOptions struct {
	NoRefresh bool
	NoProxy   bool
	// PostSwitch runs inside the switch transaction, after the target is
	// active, its binding is realigned and its proxy state settled. Callers
	// use it to reapply client configs to the new account. A failure rolls the
	// whole switch back — native auth, active pointer, binding, and the
	// previous proxy — so the user never sees a half-switched state.
	PostSwitch func(ctx context.Context) error
}

// CheckpointLiveAuth captures the real local login before a switch.
func (s *Service) CheckpointLiveAuth(ctx context.Context, providerID string, durable bool) (*Checkpoint, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return nil, err
	}
	checkpointRoot := os.TempDir()
	if durable {
		checkpointRoot = filepath.Join(s.Store.Root, "recovery", "live-auth")
	}
	if err := os.MkdirAll(checkpointRoot, 0o700); err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp(checkpointRoot, "anypick-live-checkpoint-")
	if err != nil {
		return nil, err
	}
	active, err := s.Store.GetActive(ctx, providerID)
	if err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	live, err := pv.DetectLive()
	if err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	if live.Present {
		if _, err := pv.Backup(directory); err != nil {
			_ = os.RemoveAll(directory)
			return nil, err
		}
	}
	var activePtr *string
	if active != "" {
		copyActive := active
		activePtr = &copyActive
	}
	return &Checkpoint{
		ProviderID:    providerID,
		ActiveAccount: activePtr,
		HadLiveAuth:   live.Present,
		Directory:     directory,
	}, nil
}

// RestoreLiveAuthCheckpoint restores the captured login AND the active pointer.
func (s *Service) RestoreLiveAuthCheckpoint(ctx context.Context, cp *Checkpoint) error {
	pv, err := s.Providers.Get(cp.ProviderID)
	if err != nil {
		return err
	}
	if cp.HadLiveAuth {
		if err := pv.Restore(cp.Directory); err != nil {
			return err
		}
	} else if clearer, ok := pv.(provider.LiveClearer); ok {
		if err := clearer.ClearLive(); err != nil {
			return err
		}
	} else {
		return anyerr.Newf(
			"Cannot restore an empty "+pv.Name()+" login state safely.",
			"SWITCH_ROLLBACK_UNAVAILABLE")
	}
	if cp.ActiveAccount != nil && *cp.ActiveAccount != "" {
		return s.Store.SetActiveContext(ctx, cp.ProviderID, *cp.ActiveAccount)
	}
	return s.Store.ClearActiveContext(ctx, cp.ProviderID)
}

func (s *Service) DiscardLiveAuthCheckpoint(cp *Checkpoint) error {
	return os.RemoveAll(cp.Directory)
}

// SnapshotFingerprint returns a content digest of one snapshot directory. Two
// accounts with the same digest hold the same credential material. A directory
// with no readable files returns ok=false so callers fail open instead of
// acting on a stale or half-materialized snapshot. The save guard and the
// doctor audit share this one function so the check and the refusal cannot
// disagree about what "the same snapshot" means.
func SnapshotFingerprint(dir string) (string, bool) {
	var files []string
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return relErr
		}
		files = append(files, rel)
		return nil
	})
	if err != nil || len(files) == 0 {
		return "", false
	}
	sort.Strings(files)
	digest := sha256.New()
	for _, rel := range files {
		raw, readErr := os.ReadFile(filepath.Join(dir, rel))
		if readErr != nil {
			return "", false
		}
		_, _ = digest.Write([]byte(rel))
		_, _ = digest.Write([]byte{0})
		_, _ = digest.Write(raw)
		_, _ = digest.Write([]byte{0})
	}
	return hex.EncodeToString(digest.Sum(nil)), true
}

// ensureSnapshotNotAliased refuses to save one credential store under a second
// name. The identity is the snapshot's content: if AnyPick already holds a
// byte-equivalent snapshot, a second name would look like a second account
// while every switch between them changes nothing (the WorkBuddy `outof0` +
// `work` pair). Writing to an account that already exists is the normal
// refresh/overwrite path and skips the check.
//
// This is deliberately not an identity (email) comparison: one login can own
// several distinct credential snapshots (Codex workspaces under one email,
// Gemini CLI vs Antigravity grants), and those stay separately saveable.
func (s *Service) ensureSnapshotNotAliased(ctx context.Context, providerID, accountName, snapshotDir string) error {
	digest, ok := SnapshotFingerprint(snapshotDir)
	if !ok {
		return nil
	}
	accounts, err := s.Store.ListAccounts(ctx, providerID)
	if err != nil {
		return err
	}
	// Refreshing an account that already holds this exact snapshot adds no new
	// alias: leave the store as it is (a legacy duplicate stays removable,
	// not frozen) and let the write proceed.
	for _, acct := range accounts {
		if acct.Meta.Name != accountName {
			continue
		}
		full, gerr := s.Store.Get(ctx, providerID, accountName)
		if gerr == nil && full != nil {
			if existing, ok := SnapshotFingerprint(full.SnapshotDir); ok && existing == digest {
				return nil
			}
		}
	}
	var owners []string
	for _, acct := range accounts {
		if acct.Meta.Name == accountName {
			continue
		}
		// Get materializes the snapshot cache; ListAccounts only builds the
		// path, and a path without files would hide a duplicate.
		full, gerr := s.Store.Get(ctx, providerID, acct.Meta.Name)
		if gerr != nil || full == nil {
			continue
		}
		existing, ok := SnapshotFingerprint(full.SnapshotDir)
		if !ok || existing != digest {
			continue
		}
		owners = append(owners, acct.Meta.Name)
	}
	if len(owners) == 0 {
		return nil
	}
	qualified := make([]string, 0, len(owners))
	for _, owner := range owners {
		qualified = append(qualified, providerID+"/"+owner)
	}
	// Suggest using the account the user is already on before any removal:
	// the first name is alphabetical, not "the one in use".
	keep := owners[0]
	if active, aerr := s.Store.GetActive(ctx, providerID); aerr == nil && active != "" {
		for _, owner := range owners {
			if owner == active {
				keep = owner
				break
			}
		}
	}
	suggestions := []string{
		"Use " + providerID + "/" + keep + "; AnyPick keeps one account per login.",
	}
	if len(owners) == 1 {
		suggestions = append(suggestions,
			"anypick account remove "+providerID+"/"+keep+"  # then save this login under the new name")
	} else {
		suggestions = append(suggestions,
			"anypick doctor --verbose  # lists the duplicates and which one to keep")
	}
	return anyerr.Newf(
		"This login is already saved as "+strings.Join(qualified, ", ")+".",
		"ACCOUNT_SNAPSHOT_EXISTS",
		anyerr.WithSuggestions(suggestions...))
}

// DuplicateSnapshotGroup names saved accounts of one provider that hold the
// same snapshot content under different names.
type DuplicateSnapshotGroup struct {
	Provider string
	Names    []string // every account in the group, sorted
	// Keep is the account a cleanup should leave in place: the provider's
	// active account when it belongs to the group, otherwise the first name.
	Keep string
}

// DuplicateSnapshotGroups reports saved accounts that hold one snapshot under
// different names. It is the read-only counterpart of the save guard and shares
// its fingerprint, so what doctor recommends cannot disagree with what a save
// refuses. A store read failure is returned alongside whatever groups were
// still collected; the caller decides whether that is worth reporting.
func (s *Service) DuplicateSnapshotGroups(ctx context.Context) ([]DuplicateSnapshotGroup, error) {
	if s == nil || s.Store == nil || s.Providers == nil {
		return nil, nil
	}
	var groups []DuplicateSnapshotGroup
	var errs []error
	for _, providerID := range s.Providers.IDs() {
		list, err := s.Store.ListAccounts(ctx, providerID)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		byDigest := map[string][]string{}
		for _, acct := range list {
			full, gerr := s.Store.Get(ctx, providerID, acct.Meta.Name)
			if gerr != nil || full == nil {
				continue
			}
			digest, ok := SnapshotFingerprint(full.SnapshotDir)
			if !ok {
				continue
			}
			byDigest[digest] = append(byDigest[digest], acct.Meta.Name)
		}
		active, _ := s.Store.GetActive(ctx, providerID)
		for _, names := range byDigest {
			if len(names) < 2 {
				continue
			}
			sort.Strings(names)
			keep := names[0]
			for _, name := range names {
				if name == active {
					keep = name
					break
				}
			}
			groups = append(groups, DuplicateSnapshotGroup{Provider: providerID, Names: names, Keep: keep})
		}
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Provider != groups[j].Provider {
			return groups[i].Provider < groups[j].Provider
		}
		return groups[i].Names[0] < groups[j].Names[0]
	})
	return groups, errors.Join(errs...)
}

// ResolveIdentityTarget resolves a duplicate identity to its existing local
// account after confirmation.
func (s *Service) ResolveIdentityTarget(ctx context.Context, providerID string, identity, accountName string, allowOverwrite bool) (string, error) {
	if !provider.AccountScopedIdentity(identity) {
		return accountName, nil
	}
	accounts, err := s.Store.ListAccounts(ctx, providerID)
	if err != nil {
		return "", err
	}
	norm := normalizeIdentity(identity)
	var existingName string
	for _, acct := range accounts {
		if acct.Meta.Identity != "" && normalizeIdentity(acct.Meta.Identity) == norm {
			existingName = acct.Meta.Name
			break
		}
	}
	if existingName == "" || existingName == accountName {
		return accountName, nil
	}
	if allowOverwrite {
		return existingName, nil
	}
	return "", anyerr.Newf(
		fmt.Sprintf("Login %s is already saved as %s/%s.", identity, providerID, existingName),
		"ACCOUNT_IDENTITY_EXISTS",
		anyerr.WithSuggestions(fmt.Sprintf("Use %s/%s instead of saving a duplicate.", providerID, existingName)))
}

// Current reports the active pointer, live detection, and whether they agree.
func (s *Service) Current(ctx context.Context, providerID string) (*CurrentResult, error) {
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return nil, err
	}
	active, err := s.Store.GetActive(ctx, providerID)
	if err != nil {
		return nil, err
	}
	live, err := pv.DetectLive()
	if err != nil {
		return nil, err
	}
	out := &CurrentResult{Active: active, Live: live}
	if active == "" {
		return out, nil
	}
	account, err := s.Store.Get(ctx, providerID, active)
	if err != nil || account == nil {
		return out, err
	}
	out.Account = account
	match, known, matchErr := computeLiveMatch(pv, account.SnapshotDir, live)
	if matchErr == nil {
		out.LiveMatchKnown = known
		out.IsLiveMatch = match || (!known && active != "" && live.Present)
	} else {
		out.IsLiveMatch = live.Present
	}
	// Identity fallback: refreshed tokens can change material while keeping
	// the same upstream identity.
	if !out.IsLiveMatch && account.Meta.CredentialKind != "proxy-only" &&
		account.Meta.Identity != "" && live.Identity != "" &&
		identitiesEqual(account.Meta.Identity, live.Identity) {
		out.IsLiveMatch = true
	}
	return out, nil
}

func computeLiveMatch(pv provider.Provider, snapshotDir string, live provider.LiveAuthStatus) (match, known bool, err error) {
	matcher, ok := pv.(provider.LiveMatcher)
	if !ok {
		return false, false, nil
	}
	match, known, err = matcher.SnapshotMatchesLive(snapshotDir)
	if err != nil {
		return false, true, err
	}
	return match, known, nil
}

func identitiesEqual(a, b string) bool { return normalizeIdentity(a) == normalizeIdentity(b) }

// normalizeIdentity compares emails case-insensitively.
func normalizeIdentity(identity string) string {
	var parsed struct {
		Email string `json:"email"`
		Raw   string
	}
	if err := json.Unmarshal([]byte(identity), &parsed); err == nil && parsed.Email != "" {
		return lower(parsed.Email)
	}
	return lower(identity)
}

func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

// ExportEnvelope serializes a saved account to a portable owner-only JSON file.
// Lives on the service so the outer layers ask for an export instead of
// reaching through the raw store the service owns.
func (s *Service) ExportEnvelope(ctx context.Context, providerID, name, outPath string) error {
	return transfer.ExportEnvelope(s.Store, ctx, providerID, name, outPath)
}

// ExportSelectedBackup writes one multi-account package. The selection is the
// same BackupEntry slice transfer expects; the store belongs to the service.
func (s *Service) ExportSelectedBackup(ctx context.Context, accounts []transfer.BackupEntry, dest string, overwrite bool) (int, error) {
	return transfer.ExportSelectedBackup(s.Store, ctx, accounts, dest, overwrite)
}

// ImportRequest is the shared account-import contract used by the CLI, TUI,
// and desktop service. Format detection and mutation semantics stay below the
// UI boundary; optional fields express provider-scoped, named, or reviewed
// backup imports.
type ImportRequest struct {
	Paths      []string
	ProviderID string
	Name       string
	Force      bool
	Selection  []transfer.BackupEntry
	Replace    []transfer.BackupEntry
}

// Import detects and imports account envelopes or AnyPick backup packages.
func (s *Service) Import(ctx context.Context, request ImportRequest) ([]store.Meta, error) {
	deps := transfer.ImportDeps{
		Store:                 s.Store,
		Providers:             s.Providers,
		ResolveIdentityTarget: s.ResolveIdentityTarget,
	}
	metas, err := transfer.ImportFiles(deps, ctx, request.Paths, transfer.FileImportOptions{
		ProviderID: request.ProviderID,
		Name:       request.Name,
		Force:      request.Force,
		Selection:  request.Selection,
		Replace:    request.Replace,
	})
	if err != nil {
		return metas, err
	}
	if err := s.afterSnapshotChanges(ctx, metas); err != nil {
		return metas, err
	}
	return metas, nil
}

// InspectBackup prepares the preview used by reviewed desktop imports.
func (s *Service) InspectBackup(path string) (*transfer.Inspection, error) {
	return transfer.InspectBackup(s.Store, s.Providers, path)
}
