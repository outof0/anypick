package desktop

// Negative contract tests: payloads the strict command guards reject must
// be rejected at the Go boundary too (P2 — exact bounded contract).

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func b64(t *testing.T, v interface{}) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func TestStrictMutateContract(t *testing.T) {
	valid := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-save",
		"providerId": "grok", "name": "work",
	}
	if _, err := DecodeLine("mutate\t" + b64(t, valid)); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"unknown field", func(m map[string]interface{}) { m["warp"] = 1 }},
		{"oversized identity", func(m map[string]interface{}) { m["identity"] = strings.Repeat("i", 641) }},
		{"missing requestId", func(m map[string]interface{}) { delete(m, "requestId") }},
		{"empty requestId", func(m map[string]interface{}) { m["requestId"] = "" }},
		{"oversized requestId", func(m map[string]interface{}) { m["requestId"] = strings.Repeat("x", 129) }},
		{"unknown operation", func(m map[string]interface{}) { m["operation"] = "save" }},
		{"missing providerId", func(m map[string]interface{}) { delete(m, "providerId") }},
		{"missing name", func(m map[string]interface{}) { delete(m, "name") }},
		{"control char in name", func(m map[string]interface{}) { m["name"] = "wo\rk" }},
		{"oversized providerId", func(m map[string]interface{}) { m["providerId"] = strings.Repeat("p", 65) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			for k, v := range valid {
				m[k] = v
			}
			tc.mutate(m)
			if _, err := DecodeLine("mutate\t" + b64(t, m)); err == nil {
				t.Fatalf("%s: payload accepted", tc.name)
			}
		})
	}
}

func TestStrictDesktopCorrectnessMutationContracts(t *testing.T) {
	valid := []map[string]interface{}{
		{"version": 1, "requestId": "language", "operation": "setting-language",
			"name": "settings", "language": "zh-CN"},
		{"version": 1, "requestId": "detect", "operation": "account-detect",
			"providerId": "codex", "name": "detect"},
		{"version": 1, "requestId": "save", "operation": "account-save",
			"providerId": "openrouter", "name": "work", "apiKey": "sk-test",
			"region": "global", "overwrite": false, "identity": "API key account"},
		{"version": 1, "requestId": "current", "operation": "account-save-current",
			"providerId": "codex"},
		{"version": 1, "requestId": "edit", "operation": "account-edit",
			"providerId": "codex", "name": "work", "label": "Work"},
		{"version": 1, "requestId": "clear", "operation": "account-clear",
			"providerId": "codex", "name": "live"},
		{"version": 1, "requestId": "refresh", "operation": "gateway-refresh",
			"name": "gateway"},
		{"version": 1, "requestId": "reset", "operation": "client-reset",
			"name": "codex"},
	}
	for _, payload := range valid {
		if _, err := DecodeLine("mutate\t" + b64(t, payload)); err != nil {
			t.Errorf("%s rejected: %v", payload["operation"], err)
		}
	}

	invalid := []map[string]interface{}{
		{"version": 1, "requestId": "language", "operation": "setting-language",
			"name": "settings", "language": "xx"},
		{"version": 1, "requestId": "language", "operation": "setting-language",
			"name": "settings", "language": "vi", "enabled": true},
		{"version": 1, "requestId": "current", "operation": "account-save-current"},
		{"version": 1, "requestId": "current", "operation": "account-save-current",
			"providerId": "codex", "sourceId": ""},
		{"version": 1, "requestId": "save", "operation": "account-save",
			"providerId": "codex", "name": "work", "overwrite": nil},
		{"version": 1, "requestId": "save", "operation": "account-save",
			"providerId": "codex", "name": "work", "apiKey": nil},
		{"version": 1, "requestId": "detect", "operation": "account-detect",
			"providerId": "codex", "name": "detect", "identity": "work@example.com"},
	}
	for _, payload := range invalid {
		if _, err := DecodeLine("mutate\t" + b64(t, payload)); err == nil {
			t.Errorf("invalid %s payload accepted: %#v", payload["operation"], payload)
		}
	}
}

func TestStrictBackupImportContract(t *testing.T) {
	valid := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-backup-import",
		"inspectionId": "abc", "entryIds": []string{"0"}, "overwriteConfirmed": false,
	}
	if _, err := DecodeLine("mutate\t" + b64(t, valid)); err != nil {
		t.Fatalf("valid import rejected: %v", err)
	}

	// A full backup file is importable: exactly MaxBackupAccountRefs ids, each
	// exactly 16 characters, and the framed command still fits.
	boundary := map[string]interface{}{}
	for k, v := range valid {
		boundary[k] = v
	}
	ids := make([]string, MaxBackupAccountRefs)
	for i := range ids {
		ids[i] = fmt.Sprintf("%03d%s", i, strings.Repeat("e", 13)) // unique, exactly 16
	}
	boundary["entryIds"] = ids
	if _, err := DecodeLine("mutate\t" + b64(t, boundary)); err != nil {
		t.Fatalf("%d×16-char entryIds rejected: %v", MaxBackupAccountRefs, err)
	}

	mutations := []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"path not allowed", func(m map[string]interface{}) { m["path"] = "/tmp/x" }},
		{"missing inspectionId", func(m map[string]interface{}) { delete(m, "inspectionId") }},
		{"empty entryIds", func(m map[string]interface{}) { m["entryIds"] = []string{} }},
		{"duplicate entryIds", func(m map[string]interface{}) { m["entryIds"] = []string{"0", "0"} }},
		{"oversized entryId", func(m map[string]interface{}) { m["entryIds"] = []string{strings.Repeat("e", 17)} }},
		{"too many entryIds", func(m map[string]interface{}) {
			ids := make([]string, MaxBackupAccountRefs+1)
			for i := range ids {
				ids[i] = fmt.Sprintf("%03d", i)
			}
			m["entryIds"] = ids
		}},
		{"overwriteConfirmed not boolean", func(m map[string]interface{}) { m["overwriteConfirmed"] = "yes" }},
		{"missing overwriteConfirmed", func(m map[string]interface{}) { delete(m, "overwriteConfirmed") }},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			for k, v := range valid {
				m[k] = v
			}
			tc.mutate(m)
			if _, err := DecodeLine("mutate\t" + b64(t, m)); err == nil {
				t.Fatalf("%s: payload accepted", tc.name)
			}
		})
	}
}

func TestStrictBackupExportContract(t *testing.T) {
	valid := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-backup-export",
		"path": "/tmp/pkg", "accounts": []map[string]string{
			{"provider": "codex", "name": "work"},
		}, "overwrite": true,
	}
	if _, err := DecodeLine("mutate\t" + b64(t, valid)); err != nil {
		t.Fatalf("valid export rejected: %v", err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"missing overwrite", func(m map[string]interface{}) { delete(m, "overwrite") }},
		{"missing accounts", func(m map[string]interface{}) { delete(m, "accounts") }},
		{"empty accounts", func(m map[string]interface{}) { m["accounts"] = []map[string]string{} }},
		{"bad ref name", func(m map[string]interface{}) {
			m["accounts"] = []map[string]string{{"provider": "", "name": ""}}
		}},
		{"too many accounts", func(m map[string]interface{}) {
			refs := make([]map[string]string, MaxBackupAccountRefs+1)
			for i := range refs {
				refs[i] = map[string]string{"provider": "codex", "name": fmt.Sprintf("a%d", i)}
			}
			m["accounts"] = refs
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			for k, v := range valid {
				m[k] = v
			}
			tc.mutate(m)
			if _, err := DecodeLine("mutate\t" + b64(t, m)); err == nil {
				t.Fatalf("%s: payload accepted", tc.name)
			}
		})
	}

	// Exactly the file limit is a valid selection, and it still fits the frame.
	boundaryRefs := make([]map[string]string, MaxBackupAccountRefs)
	for i := range boundaryRefs {
		boundaryRefs[i] = map[string]string{"provider": "codex", "name": fmt.Sprintf("a%d", i)}
	}
	valid["accounts"] = boundaryRefs
	if _, err := DecodeLine("mutate\t" + b64(t, valid)); err != nil {
		t.Fatalf("%d-account selection rejected: %v", MaxBackupAccountRefs, err)
	}
}

func TestStrictLogsAndInspectContracts(t *testing.T) {
	logs := map[string]interface{}{"version": 1, "requestId": "r", "providerId": "p", "name": "n", "lines": 201}
	if _, err := DecodeLine("logs\t" + b64(t, logs)); err == nil {
		t.Fatal("lines=201 accepted")
	}
	logs["lines"] = 200
	if _, err := DecodeLine("logs\t" + b64(t, logs)); err != nil {
		t.Fatalf("lines=200 rejected: %v", err)
	}
	inspect := map[string]interface{}{"version": 1, "requestId": "r"}
	if _, err := DecodeLine("backup-inspect\t" + b64(t, inspect)); err == nil {
		t.Fatal("inspect without path accepted")
	}
	invoke := map[string]interface{}{"version": 1, "requestId": "r", "revision": 1, "actionId": "a", "extra": true}
	if _, err := DecodeLine("invoke\t" + b64(t, invoke)); err == nil {
		t.Fatal("invoke with unknown field accepted")
	}
}

func TestStrictBackupForgetContract(t *testing.T) {
	valid := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-backup-forget",
		"inspectionId": "abc",
	}
	if _, err := DecodeLine("mutate\t" + b64(t, valid)); err != nil {
		t.Fatalf("valid forget rejected: %v", err)
	}
	mutations := []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"path not allowed", func(m map[string]interface{}) { m["path"] = "/tmp/x" }},
		{"missing inspectionId", func(m map[string]interface{}) { delete(m, "inspectionId") }},
		{"oversized inspectionId", func(m map[string]interface{}) {
			m["inspectionId"] = strings.Repeat("i", 129)
		}},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			for k, v := range valid {
				m[k] = v
			}
			tc.mutate(m)
			if _, err := DecodeLine("mutate\t" + b64(t, m)); err == nil {
				t.Fatalf("%s: payload accepted", tc.name)
			}
		})
	}
}

// The Tauri shell UI has no file picker: its backup button sends exactly
// {version, requestId, operation, path:""} and reports the temp destination
// from the result. This contract pins that shape so a UI/protocol drift fails
// here instead of stranding the button on a silent rejection.
func TestStrictBackupAllContract(t *testing.T) {
	uiPayload := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-backup-all", "path": "",
	}
	if _, err := DecodeLine("mutate\t" + b64(t, uiPayload)); err != nil {
		t.Fatalf("shell UI backup payload rejected: %v", err)
	}
	explicit := map[string]interface{}{
		"version": 1, "requestId": "r", "operation": "account-backup-all", "path": "/tmp/pkg",
	}
	if _, err := DecodeLine("mutate\t" + b64(t, explicit)); err != nil {
		t.Fatalf("explicit-path backup-all rejected: %v", err)
	}

	for _, tc := range []struct {
		name   string
		mutate func(m map[string]interface{})
	}{
		{"overwrite is not an allowed key", func(m map[string]interface{}) { m["overwrite"] = false }},
		{"control bytes in path", func(m map[string]interface{}) { m["path"] = "/tmp/\npkg" }},
		{"missing path key", func(m map[string]interface{}) { delete(m, "path") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]interface{}{}
			for k, v := range uiPayload {
				m[k] = v
			}
			tc.mutate(m)
			if _, err := DecodeLine("mutate\t" + b64(t, m)); err == nil {
				t.Fatalf("%s: payload accepted", tc.name)
			}
		})
	}
}
