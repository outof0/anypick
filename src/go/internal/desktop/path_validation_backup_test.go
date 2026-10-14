package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/transfer"
)

// A backup whose file key the path validator refuses reports its own reason
// and the Design message, never "damaged".
func TestPathValidationBackupInspectReportsUnsafePath(t *testing.T) {
	for _, key := range []string{"../outside.json", `..\outside.json`, `C:x`, "/abs.json", "a\x01b.json"} {
		t.Run(key, func(t *testing.T) {
			env := newTrayEnv(t)
			writeTestAccount(t, env, "codex", "alpha")
			pkgPath := filepath.Join(t.TempDir(), "pkg.anypick-backup")
			if _, err := transfer.ExportSelectedBackup(env.Deps.Store, context.Background(),
				[]transfer.BackupEntry{{Provider: "codex", Name: "alpha"}}, pkgPath, false); err != nil {
				t.Fatal(err)
			}
			renameFirstBackupFileKey(t, pkgPath, key)

			var out bytes.Buffer
			srv := newWaitedServerOut(t, env.Deps, &out)
			payload, _ := json.Marshal(backupInspectPayload{Version: 1, RequestID: "ins1", Path: pkgPath})
			if err := srv.handle(context.Background(), &Command{Kind: "backup-inspect", Payload: payload}); err != nil {
				t.Fatal(err)
			}
			line := firstFrameLine(out.String())
			if !strings.HasPrefix(line, "backup-preview\t") {
				t.Fatalf("want backup-preview frame, got %q", line)
			}
			var preview BackupPreviewResult
			if err := json.Unmarshal(decodeFramePayload(t, line), &preview); err != nil {
				t.Fatal(err)
			}
			if preview.Status != "error" || preview.Reason == "damaged" || preview.Reason != transfer.ReasonUnsafePath {
				t.Fatalf("preview = %+v, want reason %q", preview, transfer.ReasonUnsafePath)
			}
			want := fmt.Sprintf("Can't use %q. It points outside AnyPick's folder, so nothing was imported.", key)
			if strings.ContainsRune(key, 0x01) {
				want = "Can't use this file. It contains an entry with no usable name, so nothing was imported."
			}
			if preview.Message != want {
				t.Fatalf("message = %q, want %q", preview.Message, want)
			}
		})
	}
}

func renameFirstBackupFileKey(t *testing.T, pkgPath, key string) {
	t.Helper()
	raw, err := os.ReadFile(pkgPath)
	if err != nil {
		t.Fatal(err)
	}
	var pkg map[string]any
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	accounts, _ := pkg["accounts"].([]any)
	if len(accounts) == 0 {
		t.Fatal("backup has no accounts")
	}
	acct, _ := accounts[0].(map[string]any)
	envelope, _ := acct["envelope"].(map[string]any)
	files, _ := envelope["files"].(map[string]any)
	for old, v := range files {
		delete(files, old)
		files[key] = v
		break
	}
	if len(files) == 0 {
		t.Fatal("backup envelope has no files")
	}
	out, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pkgPath, out, 0o600); err != nil {
		t.Fatal(err)
	}
}
