package transfer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/store"
)

func newTransferEnv(t *testing.T) (*store.AccountStore, *provider.Registry) {
	t.Helper()
	root := t.TempDir()
	database := openTestDB(t, root)
	st := store.New(root, database)
	reg := provider.NewRegistry()
	if err := provider.RegisterBuiltin(reg, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	return st, reg
}

func saveFakeAccount(t *testing.T, st *store.AccountStore, providerID, name string) store.Meta {
	t.Helper()
	snapshotDir, _, err := st.PrepareSnapshot(providerID, name)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(snapshotDir, "auth.json"), []byte(`{"tokens":{"access_token":"tok"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	meta := store.Meta{
		Name: name, Provider: providerID,
		CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
		Identity: `{"email":"user@example.com"}`, Label: "Work",
	}
	if err = st.WriteMetaContext(context.Background(), meta, snapshotDir); err != nil {
		t.Fatal(err)
	}
	_ = st.DiscardPreparedSnapshot(snapshotDir)
	return meta
}

func TestExportImportRoundTrip(t *testing.T) {
	st, reg := newTransferEnv(t)
	saveFakeAccount(t, st, "codex", "work")
	ctx := context.Background()

	outPath := filepath.Join(t.TempDir(), "account.json")
	if err := ExportEnvelope(st, ctx, "codex", "work", outPath); err != nil {
		t.Fatal(err)
	}

	// Import under a different name.
	resolved := func(_ context.Context, _ string, identity, accountName string, allowOverwrite bool) (string, error) {
		return accountName, nil
	}
	deps := ImportDeps{Store: st, Providers: reg, ResolveIdentityTarget: resolved}
	meta, err := ImportEnvelope(deps, ctx, "codex", "personal", outPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "personal" || meta.Identity != `{"email":"user@example.com"}` {
		t.Fatalf("imported meta = %+v", meta)
	}
	imported, _ := st.Get(ctx, "codex", "personal")
	if imported == nil {
		t.Fatal("imported account missing")
	}
	raw, _ := os.ReadFile(filepath.Join(imported.SnapshotDir, "auth.json"))
	if !strings.Contains(string(raw), "access_token") {
		t.Fatalf("snapshot files were not restored: %s", raw)
	}
	cfg, _ := st.GetProxyConfig(context.Background(), "codex", "personal")
	if cfg.Enabled {
		t.Fatal("imported proxy must be disabled")
	}
}

func TestImportStoresTheSlug(t *testing.T) {
	st, reg := newTransferEnv(t)
	saveFakeAccount(t, st, "codex", "work")
	ctx := context.Background()
	outPath := filepath.Join(t.TempDir(), "account.json")
	if err := ExportEnvelope(st, ctx, "codex", "work", outPath); err != nil {
		t.Fatal(err)
	}
	deps := ImportDeps{Store: st, Providers: reg, ResolveIdentityTarget: func(_ context.Context, _, _, n string, _ bool) (string, error) {
		return n, nil
	}}
	meta, err := ImportEnvelope(deps, ctx, "codex", "Personal", outPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "personal" {
		t.Fatalf("imported name = %q, want personal", meta.Name)
	}
	got, err := st.Get(ctx, "codex", "Personal")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Meta.Name != "personal" {
		t.Fatalf("Get(Personal) = %+v, want the personal row", got)
	}
	raw, err := os.ReadFile(filepath.Join(got.SnapshotDir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "access_token") {
		t.Fatalf("snapshot = %s", raw)
	}
	if _, err := ImportEnvelope(deps, ctx, "codex", "personal", outPath, false); err == nil {
		t.Fatal("importing the slug of an existing account without --force succeeded")
	}
}

func TestImportRejectionLeavesStateUntouched(t *testing.T) {
	st, reg := newTransferEnv(t)
	saveFakeAccount(t, st, "codex", "existing")
	before, _ := st.Get(context.Background(), "codex", "existing")

	bad := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(bad, []byte(`{"kind":"anypick-account","version":1,"meta":{"name":"x","provider":"claude"},"files":{"a.txt":""}}`), 0o600)
	deps := ImportDeps{Store: st, Providers: reg, ResolveIdentityTarget: func(_ context.Context, _, _, n string, _ bool) (string, error) { return n, nil }}
	if _, err := ImportEnvelope(deps, context.Background(), "codex", "incoming", bad, false); err == nil {
		t.Fatal("expected provider mismatch rejection")
	}
	after, _ := st.Get(context.Background(), "codex", "existing")
	if before.Meta.Name != after.Meta.Name {
		t.Fatal("rejection mutated state")
	}
}

func TestDecodeEnvelopeValidationMatrix(t *testing.T) {
	valid := map[string]interface{}{
		"kind":    EnvelopeKind,
		"version": 1,
		"meta": map[string]interface{}{
			"name": "work", "provider": "codex",
			"createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
		},
		"proxy": map[string]interface{}{"enabled": true, "port": 9000, "options": map[string]string{"upstream": "https://evil"}},
		"files": map[string]interface{}{"snapshot/auth.json": "eyJhIjoxfQ=="},
	}
	raw, _ := json.Marshal(valid)
	env, err := DecodeEnvelope(raw, "codex")
	if err != nil {
		t.Fatalf("valid envelope rejected: %v", err)
	}
	if env.Proxy == nil || env.Proxy.Enabled {
		t.Fatalf("imported proxy must decode disabled and options-free: %+v", env.Proxy)
	}
	if env.Proxy.Port != 9000 {
		t.Fatalf("port lost: %+v", env.Proxy)
	}
	if _, err := DecodeEnvelope(raw, "claude"); err == nil {
		t.Fatal("provider mismatch accepted")
	}

	cases := []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"wrong kind", func(m map[string]interface{}) { m["kind"] = "other" }},
		{"wrong version", func(m map[string]interface{}) { m["version"] = 2 }},
		{"no files", func(m map[string]interface{}) { m["files"] = map[string]interface{}{} }},
		{"traversal key", func(m map[string]interface{}) {
			m["files"] = map[string]interface{}{"../escape.txt": "QUJD"}
		}},
		{"root key", func(m map[string]interface{}) {
			m["files"] = map[string]interface{}{".": "QUJD"}
		}},
		{"absolute key", func(m map[string]interface{}) {
			m["files"] = map[string]interface{}{"/etc/passwd": "QUJD"}
		}},
		{"mixed separators", func(m map[string]interface{}) {
			m["files"] = map[string]interface{}{`a\b/c.txt`: "QUJD"}
		}},
		{"file/dir collision", func(m map[string]interface{}) {
			m["files"] = map[string]interface{}{"a": "QUJD", "a/b": "QUJD"}
		}},
		{"bad base64", func(m map[string]interface{}) {
			m["files"] = map[string]interface{}{"a.txt": "not*base64!"}
		}},
		{"control chars in name", func(m map[string]interface{}) {
			m["meta"].(map[string]interface{})["identity"] = "ev\u0007il"
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			tc.mutate(m)
			mutated, _ := json.Marshal(m)
			_, derr := DecodeEnvelope(mutated, "codex")
			err := asAnyPick(derr)
			if err == nil {
				t.Fatalf("%s: envelope accepted", tc.name)
			}
			if err.Code != "IMPORT_FORMAT" && err.Code != "IMPORT_LIMIT" {
				t.Fatalf("%s: wrong code %s", tc.name, err.Code)
			}
		})
	}
}

func TestBackupPreviewRefusesRootFileKeyAsUnsafePath(t *testing.T) {
	st, reg := newTransferEnv(t)
	meta := store.Meta{
		Name: "work", Provider: "codex",
		CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
	}
	pkg := backupPackageJSON{
		Version: BackupVersion, Kind: BackupKind, CreatedAt: "2026-01-01T00:00:00.000Z",
		Accounts: []backupPackageAccount{{
			Provider: "codex", Name: "work",
			Envelope: &EnvelopeJSON{
				Version: EnvelopeVersion, Kind: EnvelopeKind, Meta: meta,
				Files: map[string]string{".": "QUJD"},
			},
		}},
	}
	raw, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "backup.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectBackup(st, reg, path); err == nil || !IsUnsafePath(err) {
		t.Fatalf("InspectBackup error = %v, want unsafe-path refusal", err)
	}
}

func asAnyPick(err error, target ...interface{}) *anyerr.Error {
	if ae, ok := err.(*anyerr.Error); ok {
		return ae
	}
	return nil
}

func TestReadBackupPackageRejectsNewerVersionDistinctly(t *testing.T) {
	st, _ := newTransferEnv(t)
	saveFakeAccount(t, st, "claude", "alpha")
	ctx := context.Background()
	dest := filepath.Join(t.TempDir(), "pkg.anypick-backup")
	if _, err := ExportSelectedBackup(st, ctx, []BackupEntry{{Provider: "claude", Name: "alpha"}}, dest, false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	rewrite := func(t *testing.T, mutate func(map[string]any)) string {
		t.Helper()
		var pkg map[string]any
		if err := json.Unmarshal(raw, &pkg); err != nil {
			t.Fatal(err)
		}
		mutate(pkg)
		out, err := json.Marshal(pkg)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "pkg.anypick-backup")
		if err := os.WriteFile(path, out, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// A newer writer is not damage: the UI offers an update (B4).
	newer := rewrite(t, func(pkg map[string]any) { pkg["version"] = BackupVersion + 1 })
	if _, err := readBackupPackage(newer); err == nil {
		t.Fatal("newer version accepted")
	} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "BACKUP_VERSION" {
		t.Fatalf("newer version code = %v, want BACKUP_VERSION", err)
	}
	// Kind drift stays a format error.
	foreign := rewrite(t, func(pkg map[string]any) { pkg["kind"] = "not-a-backup" })
	if _, err := readBackupPackage(foreign); err == nil {
		t.Fatal("foreign kind accepted")
	} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "BACKUP_FORMAT" {
		t.Fatalf("foreign kind code = %v, want BACKUP_FORMAT", err)
	}
}

func TestInspectBackupRejectsMissingEnvelopeWithoutPanicking(t *testing.T) {
	st, reg := newTransferEnv(t)
	cases := map[string]string{
		"null":    `{"version":1,"kind":"anypick-backup","accounts":[{"provider":"claude","name":"broken","envelope":null}]}`,
		"missing": `{"version":1,"kind":"anypick-backup","accounts":[{"provider":"claude","name":"broken"}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "broken.anypick-backup")
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := InspectBackup(st, reg, path); err == nil {
				t.Fatal("malformed backup was accepted")
			} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "BACKUP_FORMAT" {
				t.Fatalf("error = %v, want BACKUP_FORMAT", err)
			}
		})
	}
}

func TestValidateBackupSelectionAndLimits(t *testing.T) {
	if _, err := ValidateBackupSelection(nil); err == nil {
		t.Fatal("empty selection accepted")
	}
	sel, err := ValidateBackupSelection([]BackupEntry{
		{Name: "B", Provider: "claude"}, {Name: "a", Provider: "claude"}, {Provider: "claude"},
	})
	if err == nil {
		t.Fatalf("invalid entry accepted: %+v", sel)
	}
	sel, err = ValidateBackupSelection([]BackupEntry{
		{Name: "B", Provider: "claude"}, {Name: "a", Provider: "codex"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sel[0].Name != "B" && sel[0].Provider == "claude" {
		// Sorted by provider then name.
	}
	if !(sel[0].Provider == "claude" && sel[0].Name == "b") {
		t.Fatalf("selection not normalized/sorted: %+v", sel)
	}
	if _, err := ValidateBackupSelection([]BackupEntry{
		{Provider: "codex", Name: "work"}, {Provider: "codex", Name: "work/"},
	}); err == nil {
		t.Fatal("names that normalize to the same account were accepted")
	}
}

func TestBackupExportInspectRestoreAtomic(t *testing.T) {
	st, reg := newTransferEnv(t)
	saveFakeAccount(t, st, "claude", "alpha")
	saveFakeAccount(t, st, "codex", "beta")
	ctx := context.Background()

	dest := filepath.Join(t.TempDir(), "pkg.anypick-backup")
	count, err := ExportSelectedBackup(st, ctx, []BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	}, dest, false)
	if err != nil || count != 2 {
		t.Fatalf("export failed: count=%d err=%v", count, err)
	}
	// Non-overwrite refuses clobber.
	if _, err := ExportSelectedBackup(st, ctx, []BackupEntry{{Provider: "claude", Name: "alpha"}}, dest, false); err == nil {
		t.Fatal("overwrite without flag accepted")
	}

	insp, err := InspectBackup(st, reg, dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(insp.Entries) != 2 {
		t.Fatalf("entries = %+v", insp.Entries)
	}
	// The accounts already exist locally, so inspection reports `replace`
	// and restore requires explicit approval.
	for _, e := range insp.Entries {
		if e.Disposition != DispositionReplace {
			t.Fatalf("unexpected disposition: %+v", e)
		}
	}
	if _, err := RestoreSelectedContext(t.Context(), st, reg, dest, []BackupEntry{{Provider: "claude", Name: "alpha"}}, RestoreOptions{}); err == nil {
		t.Fatal("replace without explicit approval was allowed")
	}
	metas, err := RestoreSelectedContext(t.Context(), st, reg, dest, []BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	}, RestoreOptions{Replace: []BackupEntry{{Provider: "claude", Name: "alpha"}}})
	if err == nil {
		t.Fatal("partial replacement confirmation must fail")
	}
	if len(metas) != 0 {
		t.Fatal("failed restore returned metas")
	}
	metas, err = RestoreSelectedContext(t.Context(), st, reg, dest, []BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	}, RestoreOptions{Replace: []BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	}})
	if err != nil || len(metas) != 2 {
		t.Fatalf("approved batch restore failed: %v", err)
	}
	// Original creation timestamps preserved.
	acct, _ := st.Get(ctx, "claude", "alpha")
	if acct.Meta.CreatedAt != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("createdAt not preserved: %q", acct.Meta.CreatedAt)
	}
}

func TestImportEnvelopeFilesRestoresMultipleJSONEnvelopes(t *testing.T) {
	src, reg := newTransferEnv(t)
	saveFakeAccount(t, src, "claude", "alpha")
	saveFakeAccount(t, src, "codex", "beta")

	paths := []string{filepath.Join(t.TempDir(), "alpha.json"), filepath.Join(t.TempDir(), "beta.json")}
	if err := ExportEnvelope(src, t.Context(), "claude", "alpha", paths[0]); err != nil {
		t.Fatal(err)
	}
	if err := ExportEnvelope(src, t.Context(), "codex", "beta", paths[1]); err != nil {
		t.Fatal(err)
	}
	dstRoot := t.TempDir()
	dstDB := openTestDB(t, dstRoot)
	dst := store.New(dstRoot, dstDB)
	metas, err := ImportEnvelopeFiles(t.Context(), dst, reg, paths, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 2 {
		t.Fatalf("imported %d accounts, want 2", len(metas))
	}
	for _, ref := range []BackupEntry{{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"}} {
		acct, getErr := dst.Get(t.Context(), ref.Provider, ref.Name)
		if getErr != nil || acct == nil {
			t.Fatalf("imported %s/%s missing: %v", ref.Provider, ref.Name, getErr)
		}
	}
}

func TestImportEnvelopeFilesNormalizesBeforeCollisionChecks(t *testing.T) {
	st, reg := newTransferEnv(t)
	saveFakeAccount(t, st, "codex", "work")
	path := filepath.Join(t.TempDir(), "work.json")
	if err := ExportEnvelope(st, t.Context(), "codex", "work", path); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var envelope EnvelopeJSON
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Meta.Name = "work/"
	envelope.Meta.Label = "Must not replace"
	raw, err = json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := ImportEnvelopeFiles(t.Context(), st, reg, []string{path}, false); err == nil {
		t.Fatal("normalized-name collision imported without --force")
	}
	account, err := st.Get(t.Context(), "codex", "work")
	if err != nil {
		t.Fatal(err)
	}
	if account == nil || account.Meta.Label != "Work" {
		t.Fatalf("existing account changed after rejected import: %+v", account)
	}

	metas, err := ImportEnvelopeFiles(t.Context(), st, reg, []string{path}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 1 || metas[0].Name != "work" {
		t.Fatalf("forced import metadata = %+v, want canonical work", metas)
	}
	account, err = st.Get(t.Context(), "codex", "work")
	if err != nil || account == nil || account.Meta.Label != "Must not replace" {
		t.Fatalf("forced import did not replace canonical account: %+v, err=%v", account, err)
	}
}

func TestImportBackupRestoresWholePackage(t *testing.T) {
	src, reg := newTransferEnv(t)
	saveFakeAccount(t, src, "claude", "alpha")
	saveFakeAccount(t, src, "codex", "beta")
	dest := filepath.Join(t.TempDir(), "accounts.json")
	if _, err := ExportSelectedBackup(src, t.Context(), []BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	}, dest, false); err != nil {
		t.Fatal(err)
	}
	dstRoot := t.TempDir()
	dstDB := openTestDB(t, dstRoot)
	dst := store.New(dstRoot, dstDB)
	metas, err := ImportBackup(t.Context(), dst, reg, dest, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 2 {
		t.Fatalf("imported %d accounts, want 2", len(metas))
	}
}

func TestImportBackupForProviderRestoresOnlyThatProvider(t *testing.T) {
	src, reg := newTransferEnv(t)
	saveFakeAccount(t, src, "claude", "alpha")
	saveFakeAccount(t, src, "codex", "beta")
	path := filepath.Join(t.TempDir(), "accounts.json")
	if _, err := ExportSelectedBackup(src, t.Context(), []BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	}, path, false); err != nil {
		t.Fatal(err)
	}
	dstRoot := t.TempDir()
	dst := store.New(dstRoot, openTestDB(t, dstRoot))
	metas, err := ImportBackupForProvider(t.Context(), dst, reg, path, "codex", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 1 || metas[0].Provider != "codex" || metas[0].Name != "beta" {
		t.Fatalf("provider-scoped import = %+v", metas)
	}
	if account, err := dst.Get(t.Context(), "claude", "alpha"); err != nil || account != nil {
		t.Fatalf("unselected provider was imported: account=%+v err=%v", account, err)
	}
	if account, err := dst.Get(t.Context(), "codex", "beta"); err != nil || account == nil {
		t.Fatalf("selected provider account missing: account=%+v err=%v", account, err)
	}
}

func TestInspectAndImportRejectNormalizedDuplicatePackageNames(t *testing.T) {
	src, reg := newTransferEnv(t)
	saveFakeAccount(t, src, "codex", "work")
	envelope, err := BuildEnvelope(src, t.Context(), "codex", "work")
	if err != nil {
		t.Fatal(err)
	}
	second := *envelope
	second.Meta.Name = "work/"
	pkg := backupPackageJSON{
		Version: BackupVersion,
		Kind:    BackupKind,
		Accounts: []backupPackageAccount{
			{Provider: "codex", Name: "work", Envelope: envelope},
			{Provider: "codex", Name: "work/", Envelope: &second},
		},
	}
	raw, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "duplicate.anypick-backup")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	destRoot := t.TempDir()
	dst := store.New(destRoot, openTestDB(t, destRoot))
	if _, err := InspectBackup(dst, reg, path); err == nil {
		t.Fatal("inspection accepted duplicate normalized account refs")
	} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "BACKUP_DUPLICATE" {
		t.Fatalf("inspection error = %v, want BACKUP_DUPLICATE", err)
	}
	if _, err := ImportBackup(t.Context(), dst, reg, path, true); err == nil {
		t.Fatal("import accepted duplicate normalized account refs")
	} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "BACKUP_DUPLICATE" {
		t.Fatalf("import error = %v, want BACKUP_DUPLICATE", err)
	}
	if account, err := dst.Get(t.Context(), "codex", "work"); err != nil || account != nil {
		t.Fatalf("rejected package mutated destination: account=%+v err=%v", account, err)
	}
}

func TestBackupPackageBuildRequiresAllProviderLocks(t *testing.T) {
	st, reg := newTransferEnv(t)
	saveFakeAccount(t, st, "claude", "alpha")
	saveFakeAccount(t, st, "codex", "beta")
	selected, err := ValidateBackupSelection([]BackupEntry{
		{Provider: "claude", Name: "alpha"}, {Provider: "codex", Name: "beta"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildBackupPackageLocked(st, t.Context(), selected); err == nil {
		t.Fatal("package builder accepted an unlocked context")
	} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "MUTATION_LOCK_NOT_HELD" {
		t.Fatalf("unlocked build error = %v, want MUTATION_LOCK_NOT_HELD", err)
	}
	err = lock.WithMutationLocks(t.Context(), st.Root, backupMutationScopes(selected), func(ctx context.Context) error {
		_, err := buildBackupPackageLocked(st, ctx, selected)
		return err
	}, 0)
	if err != nil {
		t.Fatalf("package builder failed while every provider lock was held: %v", err)
	}

	// The public export waits for a concurrent mutation lock before it reads
	// the saved snapshot; after release it writes the complete package.
	held := make(chan struct{})
	release := make(chan struct{})
	lockDone := make(chan error, 1)
	go func() {
		lockDone <- lock.WithMutationLock(t.Context(), st.Root, refs.ProviderScope("codex"), func(context.Context) error {
			close(held)
			<-release
			return nil
		})
	}()
	released := false
	defer func() {
		if !released {
			close(release)
			<-lockDone
		}
	}()
	<-held
	destination := filepath.Join(t.TempDir(), "locked.anypick-backup")
	exportDone := make(chan error, 1)
	go func() {
		_, err := ExportSelectedBackup(st, t.Context(), []BackupEntry{{Provider: "codex", Name: "beta"}}, destination, false)
		exportDone <- err
	}()
	select {
	case err := <-exportDone:
		t.Fatalf("export completed while provider mutation lock was held: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	released = true
	if err := <-lockDone; err != nil {
		t.Fatal(err)
	}
	if err := <-exportDone; err != nil {
		t.Fatalf("export failed after provider lock release: %v", err)
	}
	if _, err := InspectBackup(st, reg, destination); err != nil {
		t.Fatalf("exported package did not inspect: %v", err)
	}
}

func TestReadBackupPackageEnforcesAggregateFileLimit(t *testing.T) {
	files := make(map[string]string, MaxBackupFiles+1)
	for i := 0; i <= MaxBackupFiles; i++ {
		files[fmt.Sprintf("file-%04d", i)] = "eA=="
	}
	pkg := backupPackageJSON{
		Version: BackupVersion,
		Kind:    BackupKind,
		Accounts: []backupPackageAccount{{
			Provider: "codex",
			Name:     "work",
			Envelope: &EnvelopeJSON{
				Version: EnvelopeVersion,
				Kind:    EnvelopeKind,
				Meta:    store.Meta{Provider: "codex", Name: "work"},
				Files:   files,
			},
		}},
	}
	raw, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "too-many-files.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBackupPackage(path); err == nil {
		t.Fatal("backup with more than MaxBackupFiles was accepted")
	} else if ae, ok := err.(*anyerr.Error); !ok || ae.Code != "BACKUP_LIMIT" {
		t.Fatalf("error = %v, want BACKUP_LIMIT", err)
	}
}

func openTestDB(t *testing.T, root string) *db.DB {
	t.Helper()
	database, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}
