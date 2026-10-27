package desktop

// Regression tests for the desktop backup protocol: selective export honors
// `accounts`, and import resolves a staged inspection by inspectionId with
// entryIds + overwriteConfirmed — never a raw path.

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/store"
	"github.com/outof0/anypick/go/internal/transfer"
)

func writeTestAccount(t *testing.T, env *trayEnv, providerID, name string) {
	t.Helper()
	snapshotDir, _, err := env.Deps.Store.PrepareSnapshot(providerID, name)
	if err != nil {
		t.Fatal(err)
	}
	if werr := os.WriteFile(filepath.Join(snapshotDir, "auth.json"),
		[]byte(`{"tokens":{"access_token":"`+name+`"}}`), 0o600); werr != nil {
		t.Fatal(werr)
	}
	meta := accountMetaForTest(providerID, name)
	if werr := env.Deps.Store.WriteMetaContext(context.Background(), meta, snapshotDir); werr != nil {
		t.Fatal(werr)
	}
}

func TestBackupExportHonoursSelectedAccounts(t *testing.T) {
	env := newTrayEnv(t)
	writeTestAccount(t, env, "codex", "keep")
	writeTestAccount(t, env, "claude", "secret-one")

	dest := filepath.Join(t.TempDir(), "pkg.anypick-backup")
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload, _ := json.Marshal(Mutate{
		Version: 1, RequestID: "exp1", Operation: "account-backup-export",
		Path: dest,
		Accounts: []BackupAccountRef{
			{Provider: "codex", Name: "keep"},
		},
		Overwrite: true,
	})
	if err := srv.handle(context.Background(), &Command{Kind: "mutate", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("selective export produced no package: %v", err)
	}
	var pkg struct {
		Accounts []struct {
			Name string `json:"name"`
		} `json:"accounts"`
	}
	if json.Unmarshal(raw, &pkg) != nil {
		t.Fatalf("package unreadable: %s", raw)
	}
	if len(pkg.Accounts) != 1 || pkg.Accounts[0].Name != "keep" {
		t.Fatalf("export did not honour the selection: %+v", pkg.Accounts)
	}
}

func TestBackupAllReportsTheWrittenPath(t *testing.T) {
	env := newTrayEnv(t)
	writeTestAccount(t, env, "codex", "alpha")
	dest := filepath.Join(t.TempDir(), "all.anypick-backup")
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload, _ := json.Marshal(Mutate{
		Version: 1, RequestID: "all1", Operation: "account-backup-all", Path: dest,
	})
	if err := srv.handle(context.Background(), &Command{Kind: "mutate", Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dest); err != nil {
		t.Fatalf("backup file: %v", err)
	}
	var result Result
	if err := json.Unmarshal(decodeFramePayload(t, firstFrameLine(out.String())), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "success" || !strings.Contains(result.Message, dest) ||
		!strings.Contains(result.Message, "account credentials") {
		t.Fatalf("result = %+v", result)
	}
	if backupDestination("") == "" || !strings.HasPrefix(backupDestination(""), os.TempDir()) {
		t.Fatal("empty path must fall back to a temp file")
	}
	if backupDestination(dest) != dest {
		t.Fatal("an explicit path must be kept")
	}
}

func TestBackupImportViaInspectionFlow(t *testing.T) {
	env := newTrayEnv(t)
	writeTestAccount(t, env, "codex", "alpha")

	// Build the package outside this root.
	srcStore := env.Deps.Store
	pkgPath := filepath.Join(t.TempDir(), "pkg.anypick-backup")
	_, err := transfer.ExportSelectedBackup(srcStore, context.Background(),
		[]transfer.BackupEntry{{Provider: "codex", Name: "alpha"}}, pkgPath, false)
	if err != nil {
		t.Fatal(err)
	}
	// Remove the local account so restore lands as `create`.
	if _, gerr := srcStore.Get(context.Background(), "codex", "alpha"); gerr == nil {
		if err := srcStore.DeleteContext(context.Background(), "codex", "alpha"); err != nil {
			t.Fatalf("delete before restore: %v", err)
		}
	}

	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	ctx := context.Background()

	inspectPayload, _ := json.Marshal(backupInspectPayload{
		Version: 1, RequestID: "ins1", Path: pkgPath,
	})
	if herr := srv.handle(ctx, &Command{Kind: "backup-inspect", Payload: inspectPayload}); herr != nil {
		t.Fatal(herr)
	}
	line := firstFrameLine(out.String())
	if !strings.HasPrefix(line, "backup-preview\t") {
		t.Fatalf("want backup-preview frame, got %q", line)
	}
	var preview BackupPreviewResult
	if jerr := json.Unmarshal(decodeFramePayload(t, line), &preview); jerr != nil {
		t.Fatal(jerr)
	}
	if preview.Status != "ready" || preview.InspectionID == "" || len(preview.Entries) != 1 {
		t.Fatalf("preview wrong: %+v", preview)
	}
	// The native app drops previews whose requestId does not match.
	if preview.RequestID != "ins1" || preview.Version != ProtocolVersion {
		t.Fatalf("preview lost requestId: %+v", preview)
	}
	if preview.Entries[0].Disposition != "create" {
		t.Fatalf("disposition = %q, want create", preview.Entries[0].Disposition)
	}

	out.Reset()
	importPayload, _ := json.Marshal(Mutate{
		Version: 1, RequestID: "imp1", Operation: "account-backup-import",
		InspectionID:       preview.InspectionID,
		EntryIDs:           []string{preview.Entries[0].ID},
		OverwriteConfirmed: true,
	})
	if herr := srv.handle(ctx, &Command{Kind: "mutate", Payload: importPayload}); herr != nil {
		t.Fatal(herr)
	}
	resLine := firstFrameLine(out.String())
	if !strings.HasPrefix(resLine, "result\t") {
		t.Fatalf("want result frame, got %q", resLine)
	}
	var res Result
	if jerr := json.Unmarshal(decodeFramePayload(t, resLine), &res); jerr != nil {
		t.Fatal(jerr)
	}
	if res.Status != "success" {
		t.Fatalf("import failed: %+v", res)
	}
	acct, _ := srcStore.Get(context.Background(), "codex", "alpha")
	if acct == nil {
		t.Fatal("restored account missing after import")
	}
}

// Bulk stop/restart names per-proxy failures instead of reporting success
// (PX4): the old loop swallowed every error. Per-row progress would need
// protocol work; an honest aggregate is what fits the current result frame.
func TestBulkProxyOpsReportPerProxyFailures(t *testing.T) {
	env := newTrayEnv(t)
	var out bytes.Buffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	ctx := context.Background()
	env.writeCodexLive("bulk@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "bulk-acc", true); err != nil {
		t.Fatal(err)
	}
	if err := env.Deps.Store.SetProxyConfigContext(ctx, "codex", "bulk-acc",
		store.ProxyConfig{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	run := func(ctx context.Context, m Mutate) Result {
		t.Helper()
		out.Reset()
		raw, _ := json.Marshal(m)
		if err := srv.handleMutate(ctx, raw); err != nil {
			t.Fatal(err)
		}
		decoded := decodeFramePayload(t, firstFrameLine(out.String()))
		var res Result
		if err := json.Unmarshal(decoded, &res); err != nil {
			t.Fatalf("decode %s: %v", decoded, err)
		}
		return res
	}
	// A cancelled command context fails the stop: the failure must name the
	// proxy instead of vanishing into a success.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	res := run(cancelled, Mutate{Version: 1, RequestID: "bulk-fail", Operation: "proxy-stop-all"})
	if res.Status != "error" || !strings.Contains(res.Message, "codex/bulk-acc") ||
		!strings.Contains(res.Message, "1 of 1") {
		t.Fatalf("bulk failure: %+v", res)
	}
	// Nothing enabled succeeds with a message (the old code wrote none).
	fresh := newTrayEnv(t)
	var freshOut bytes.Buffer
	freshSrv := New(fresh.Deps, strings.NewReader(""), &freshOut)
	raw, _ := json.Marshal(Mutate{Version: 1, RequestID: "bulk-empty", Operation: "proxy-stop-all"})
	if err := freshSrv.handleMutate(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	decoded := decodeFramePayload(t, firstFrameLine(freshOut.String()))
	var emptyRes Result
	if err := json.Unmarshal(decoded, &emptyRes); err != nil {
		t.Fatalf("decode %s: %v", decoded, err)
	}
	if emptyRes.Status != "success" || !strings.Contains(emptyRes.Message, "no enabled proxies") {
		t.Fatalf("bulk empty: %+v", emptyRes)
	}
}

func accountMetaForTest(providerID, name string) store.Meta {
	return store.Meta{
		Name: name, Provider: providerID,
		CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
	}
}

// A missing file is not a permission problem and a permission problem is
// not damage (B5): each maps to its own reason.
func TestInspectionFailureReasonDistinguishesAccessErrors(t *testing.T) {
	cases := map[string]string{
		"BACKUP_VERSION": "newer-version",
		"BACKUP_DENIED":  "permission-denied",
		"BACKUP_MISSING": "missing",
		"BACKUP_FORMAT":  "damaged",
	}
	for code, want := range cases {
		if got := inspectionFailureReason(anyerr.Newf("x", code)); got != want {
			t.Errorf("code %s: reason %q, want %q", code, got, want)
		}
	}
	if got := inspectionFailureReason(os.ErrNotExist); got != "damaged" {
		t.Errorf("plain error reason = %q, want damaged", got)
	}
	if msg := inspectionFailureMessage("missing"); !strings.Contains(msg, "moved or deleted") {
		t.Errorf("missing message = %q", msg)
	}
}

func TestStageBackupReportsMissingFile(t *testing.T) {
	_, _, _, err := stageBackup(filepath.Join(t.TempDir(), "nope.anypick-backup"))
	ae, ok := err.(*anyerr.Error)
	if !ok || ae.Code != "BACKUP_MISSING" {
		t.Fatalf("missing file err = %v, want BACKUP_MISSING", err)
	}
	if got := inspectionFailureReason(err); got != "missing" {
		t.Fatalf("missing file reason = %q, want missing", got)
	}
}

// Forgetting a review drops the staged copy before its TTL (B3): a later
// restore with the same id must fail, and forgetting twice still succeeds.
func TestInspectionForgetDropsStagedCopy(t *testing.T) {
	env := newTrayEnv(t)
	writeTestAccount(t, env, "codex", "alpha")
	pkgPath := filepath.Join(t.TempDir(), "pkg.anypick-backup")
	if _, err := transfer.ExportSelectedBackup(env.Deps.Store, context.Background(),
		[]transfer.BackupEntry{{Provider: "codex", Name: "alpha"}}, pkgPath, false); err != nil {
		t.Fatal(err)
	}
	mgr := NewInspectionManager(env.Deps.Accounts)
	preview, err := mgr.Inspect("req1", pkgPath)
	if err != nil {
		t.Fatal(err)
	}
	id := preview.InspectionID
	mgr.mu.Lock()
	rec, ok := mgr.records[id]
	mgr.mu.Unlock()
	if !ok || rec.stagedRoot == "" {
		t.Fatalf("no staged record for %q", id)
	}
	if _, serr := os.Stat(rec.stagedRoot); serr != nil {
		t.Fatalf("staged copy missing before forget: %v", serr)
	}
	mgr.Forget(id)
	if _, serr := os.Stat(rec.stagedRoot); !os.IsNotExist(serr) {
		t.Fatalf("staged copy survives forget: %v", serr)
	}
	entryIDs := []string{preview.Entries[0].ID}
	if _, rerr := mgr.Restore(context.Background(), id, entryIDs, true); rerr == nil {
		t.Fatal("restore after forget succeeded")
	} else if !strings.Contains(rerr.Error(), "unknown or expired") {
		t.Fatalf("restore after forget err = %v, want unknown-or-expired", rerr)
	}
	mgr.Forget(id)
	mgr.Forget("")
}

func TestDesktopInspectsAndRestoresBothExportFormats(t *testing.T) {
	for _, format := range []string{"envelope", "backup"} {
		t.Run(format, func(t *testing.T) {
			source := newTrayEnv(t)
			writeTestAccount(t, source, "codex", "alpha")
			path := filepath.Join(t.TempDir(), format+".json")
			if format == "envelope" {
				if err := transfer.ExportEnvelope(source.Deps.Store, context.Background(), "codex", "alpha", path); err != nil {
					t.Fatal(err)
				}
			} else if _, err := transfer.ExportSelectedBackup(source.Deps.Store, context.Background(), []transfer.BackupEntry{{Provider: "codex", Name: "alpha"}}, path, false); err != nil {
				t.Fatal(err)
			}
			dest := newTrayEnv(t)
			mgr := NewInspectionManager(dest.Deps.Accounts)
			preview, err := mgr.Inspect("export-roundtrip", path)
			if err != nil {
				t.Fatal(err)
			}
			if len(preview.Entries) != 1 {
				t.Fatalf("preview entries: %v", preview.Entries)
			}
			count, err := mgr.Restore(context.Background(), preview.InspectionID, []string{preview.Entries[0].ID}, false)
			if err != nil || count != 1 {
				t.Fatalf("restore: %d, %v", count, err)
			}
			acct, err := dest.Deps.Store.Get(context.Background(), "codex", "alpha")
			if err != nil || acct == nil {
				t.Fatalf("restored account missing: %v", err)
			}
			raw, err := os.ReadFile(filepath.Join(acct.SnapshotDir, "auth.json"))
			if err != nil || string(raw) != `{"tokens":{"access_token":"alpha"}}` {
				t.Fatal("restored snapshot differs")
			}
		})
	}
}
