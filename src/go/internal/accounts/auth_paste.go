package accounts

import (
	"bytes"
	"context"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
	"github.com/outof0/anypick/go/internal/store"
)

type plannedPaste struct {
	name     string
	snap     provider.PastedSnapshot
	existing *store.Account
}

type stagedPaste struct {
	plannedPaste
	dir string
}

// SavePastedAuth stores one provider auth document, or a JSON list of them,
// as account snapshots. It does not rewrite the live CLI login and it does
// not select the account: Use does that later.
//
// The provider plans the files before the lock. The commit is one
// WriteAccountsBatchContext after every name and alias check, so a rejected
// list leaves nothing behind.
func (s *Service) SavePastedAuth(ctx context.Context, providerID, name string, raw []byte, force bool) ([]store.Meta, error) {
	items, err := s.planPastedAuth(providerID, name, raw)
	if err != nil {
		return nil, err
	}
	return s.commitPastedAuth(ctx, providerID, items, force)
}

func (s *Service) planPastedAuth(providerID, name string, raw []byte) ([]plannedPaste, error) {
	if len(raw) > provider.MaxAuthPasteBytes {
		return nil, anyerr.Newf("Pasted auth JSON is larger than 256 KiB.", "AUTH_PASTE_TOO_LARGE")
	}
	pv, err := s.Providers.Get(providerID)
	if err != nil {
		return nil, anyerr.Newf("Unknown provider "+providerID+".", "PROVIDER_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	paster, ok := pv.(provider.AuthPaster)
	if !ok {
		return nil, anyerr.Newf(
			pv.Name()+" does not accept pasted auth JSON. Sign in with its app, or use the API key field when that provider shows one.",
			"UNSUPPORTED_AUTH_PASTE")
	}
	trimmed := bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	trimmed = bytes.TrimSpace(trimmed)
	planned, err := paster.PlanAuthPaste(trimmed)
	if err != nil {
		return nil, err
	}
	if len(planned) == 0 {
		return nil, anyerr.Newf("Auth JSON is not valid.", "AUTH_DOCUMENT_INVALID")
	}
	if len(planned) > 1 && strings.TrimSpace(name) != "" {
		return nil, anyerr.Newf("A pasted list names each account. Remove --name.", "INVALID_USAGE")
	}
	items := make([]plannedPaste, 0, len(planned))
	for _, snap := range planned {
		accountName, nameErr := pasteAccountName(name, snap.SuggestedName)
		if nameErr != nil {
			return nil, nameErr
		}
		items = append(items, plannedPaste{name: accountName, snap: snap})
	}
	return items, nil
}

func (s *Service) commitPastedAuth(ctx context.Context, providerID string, items []plannedPaste, force bool) ([]store.Meta, error) {
	var saved []store.Meta
	err := lock.WithMutationLock(ctx, s.Store.Root, refs.ProviderScope(providerID), func(c context.Context) error {
		staged, discard, err := s.preparePastedSnapshots(c, providerID, items)
		if err != nil {
			return err
		}
		if err := s.rejectPastedSnapshots(c, providerID, staged, force); err != nil {
			discard()
			return err
		}
		metas, err := s.writePastedSnapshots(c, providerID, staged)
		if err != nil {
			discard()
			return err
		}
		discard()
		saved = metas
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := s.afterSnapshotChanges(ctx, saved); err != nil {
		return saved, err
	}
	return saved, nil
}

func (s *Service) preparePastedSnapshots(c context.Context, providerID string, items []plannedPaste) ([]stagedPaste, func(), error) {
	var staged []stagedPaste
	discard := func() {
		for _, item := range staged {
			_ = s.Store.DiscardPreparedSnapshot(item.dir)
		}
	}
	for i := range items {
		existing, getErr := s.Get(c, providerID, items[i].name)
		if getErr != nil {
			discard()
			return nil, nil, getErr
		}
		items[i].existing = existing
		dir, _, prepErr := s.Store.PrepareSnapshot(providerID, items[i].name)
		if prepErr != nil {
			discard()
			return nil, nil, prepErr
		}
		staged = append(staged, stagedPaste{plannedPaste: items[i], dir: dir})
		if writeErr := items[i].snap.WriteTo(dir); writeErr != nil {
			discard()
			return nil, nil, writeErr
		}
	}
	return staged, discard, nil
}

func (s *Service) rejectPastedSnapshots(c context.Context, providerID string, staged []stagedPaste, force bool) error {
	// Identical documents in one paste are one login. Reporting that
	// before the shared-name check keeps "the same object twice" from
	// looking like a naming mistake.
	digests := map[string]struct{}{}
	for _, item := range staged {
		digest, ok := SnapshotFingerprint(item.dir)
		if !ok {
			return anyerr.Newf("Auth JSON is not valid.", "AUTH_DOCUMENT_INVALID")
		}
		if _, exists := digests[digest]; exists {
			return anyerr.Newf(
				"This paste contains the same login more than once.",
				"ACCOUNT_SNAPSHOT_EXISTS")
		}
		digests[digest] = struct{}{}
	}
	seenNames := map[string]struct{}{}
	for _, item := range staged {
		if _, exists := seenNames[item.name]; exists {
			return anyerr.Newf(
				"These auth documents would be saved as the same account name \""+item.name+"\".",
				"INVALID_USAGE")
		}
		seenNames[item.name] = struct{}{}
	}
	for _, item := range staged {
		if item.existing != nil && !force {
			return anyerr.Newf(
				"Account \""+item.name+"\" already exists for "+providerID+".",
				"ACCOUNT_EXISTS",
				anyerr.WithSuggestions("Choose a different account name, or confirm overwrite to replace it."))
		}
	}
	for _, item := range staged {
		if aliasErr := s.ensureSnapshotNotAliased(c, providerID, item.name, item.dir); aliasErr != nil {
			return aliasErr
		}
	}
	return nil
}

func (s *Service) writePastedSnapshots(c context.Context, providerID string, staged []stagedPaste) ([]store.Meta, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	entries := make([]store.BatchWrite, 0, len(staged))
	metas := make([]store.Meta, 0, len(staged))
	for _, item := range staged {
		meta := store.Meta{
			Name:           item.name,
			Provider:       providerID,
			CreatedAt:      now,
			UpdatedAt:      now,
			Identity:       item.snap.Info.Identity,
			Label:          item.snap.Info.Label,
			Notes:          item.snap.Info.Notes,
			CredentialKind: item.snap.Info.CredentialKind,
		}
		// WriteAccountsBatchContext replaces proxy_json on conflict.
		// A force-replace keeps the proxy the row already had; a new row
		// uses the default WriteMetaContext would insert.
		proxy := store.DefaultProxyConfig()
		if item.existing != nil {
			meta.CreatedAt = item.existing.Meta.CreatedAt
			proxy = item.existing.Proxy
		}
		entries = append(entries, store.BatchWrite{
			Meta: meta, Proxy: proxy, SnapshotDir: item.dir,
		})
		metas = append(metas, meta)
	}
	if err := s.Store.WriteAccountsBatchContext(c, entries); err != nil {
		return nil, err
	}
	return metas, nil
}

func pasteAccountName(caller, suggested string) (string, error) {
	raw := strings.TrimSpace(caller)
	if raw == "" {
		raw = strings.TrimSpace(suggested)
	}
	if raw == "" {
		return "", anyerr.Newf(
			"This auth document has no email or account id to name it. Pass --name.",
			"AUTH_PASTE_NAME_REQUIRED")
	}
	accountName, err := slug.AccountName(raw)
	if err != nil {
		return "", anyerr.Newf(err.Error(), "INVALID_USAGE")
	}
	return accountName, nil
}
