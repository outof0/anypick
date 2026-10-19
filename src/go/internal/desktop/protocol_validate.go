package desktop

// Strict command validation: unknown fields rejected, required fields
// present, booleans explicit where the contract demands them, bounded
// strings, unique bounded entryIds. A payload the contract rejects must not
// reach a handler.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/outof0/anypick/go/internal/i18n"
	"github.com/outof0/anypick/go/internal/transfer"
)

// decodeStrict unmarshals with unknown-field rejection.
func decodeStrict(raw []byte, into interface{}) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return fmt.Errorf("payload rejected: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("payload rejected: trailing JSON value")
		}
		return fmt.Errorf("payload rejected: %w", err)
	}
	return nil
}

func safeStr(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func safeOptional(s string, max int) bool {
	if s == "" {
		return true
	}
	if len(s) > max {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func safePath(p string) bool {
	if p == "" || len(p) > 4096 {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func hasKey(fields map[string]json.RawMessage, key string) bool {
	_, ok := fields[key]
	return ok
}

func optionalStringField(fields map[string]json.RawMessage, key string, max int) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", nil
	}
	var value interface{}
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("invalid %s", key)
	}
	text, ok := value.(string)
	if !ok || !safeOptional(text, max) {
		return "", fmt.Errorf("invalid %s", key)
	}
	return text, nil
}

func boolField(fields map[string]json.RawMessage, key string) error {
	raw, ok := fields[key]
	if !ok {
		return nil
	}
	var value interface{}
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("%s must be boolean", key)
	}
	if _, ok := value.(bool); !ok {
		return fmt.Errorf("%s must be boolean", key)
	}
	return nil
}

func keysSubset(fields map[string]json.RawMessage, allowed ...string) bool {
	set := map[string]bool{}
	for _, k := range allowed {
		set[k] = true
	}
	for k := range fields {
		if !set[k] {
			return false
		}
	}
	return true
}

var mutationOperations = map[string]bool{
	"account-detect": true, "account-import": true, "account-export": true,
	"account-backup-all": true, "account-backup-export": true, "account-backup-import": true,
	"account-backup-forget": true,
	"account-login":         true, "account-save-current": true, "account-save": true,
	"account-save-input": true, "account-save-auth": true,
	"account-edit": true, "account-refresh": true, "account-remove": true,
	"account-clear": true, "gateway-create": true, "gateway-test": true,
	"gateway-edit": true, "gateway-refresh": true, "gateway-remove": true,
	"client-reset": true, "codex-profile-save": true, "codex-profile-update": true,
	"codex-profile-remove": true, "codex-profile-sync": true,
	"hub-source-toggle": true, "hub-rotation": true,
	"proxy-restart-all": true, "proxy-start-all": true, "proxy-stop-all": true, "proxy-token": true,
	"setting-launch-at-login": true, "setting-auto-start-proxies": true,
	"setting-show-quota": true, "setting-quota-guard": true,
	"setting-language": true,
}

// validatePayload enforces the per-kind contracts after a strict decode.
func validatePayload(kind string, raw json.RawMessage) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	version := 0
	_ = json.Unmarshal(fields["version"], &version)
	if version != ProtocolVersion {
		return fmt.Errorf("unsupported version %d", version)
	}
	requestID := ""
	_ = json.Unmarshal(fields["requestId"], &requestID)
	if !safeStr(requestID, 128) {
		return fmt.Errorf("invalid requestId")
	}

	switch kind {
	case "invoke":
		actionID := ""
		_ = json.Unmarshal(fields["actionId"], &actionID)
		if !safeStr(actionID, 256) {
			return fmt.Errorf("invalid actionId")
		}
		// Consent is optional, and a non-boolean value is rejected rather than
		// coerced: `"allowForeignConfig": "yes"` must not read as consent.
		if err := boolField(fields, "allowForeignConfig"); err != nil {
			return err
		}
		if !keysSubset(fields, "version", "requestId", "revision", "actionId",
			"allowForeignConfig") {
			return fmt.Errorf("invalid invoke payload")
		}
	case "model-roles":
		clientID := ""
		_ = json.Unmarshal(fields["clientId"], &clientID)
		if !safeStr(clientID, 64) {
			return fmt.Errorf("invalid clientId")
		}
		if scope, ok := fields["scope"]; ok {
			var scopeStr string
			if json.Unmarshal(scope, &scopeStr) != nil || (scopeStr != "connection" && scopeStr != "provider") {
				return fmt.Errorf("invalid scope")
			}
		}
		roles := map[string]string{}
		if raw, ok := fields["roleActionIds"]; ok {
			if json.Unmarshal(raw, &roles) != nil {
				return fmt.Errorf("invalid roleActionIds")
			}
			for role, model := range roles {
				if !safeStr(role, 64) || !safeOptional(model, 256) {
					return fmt.Errorf("invalid roleActionIds entry")
				}
			}
		}
	case "logs":
		providerID, name := "", ""
		lines := -1
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["name"], &name)
		_ = json.Unmarshal(fields["lines"], &lines)
		if !safeStr(providerID, 64) || !safeStr(name, 128) ||
			lines < 1 || lines > 200 {
			return fmt.Errorf("invalid logs request")
		}
	case "doctor":
		if !keysSubset(fields, "version", "requestId") {
			return fmt.Errorf("invalid doctor request")
		}
	case "backup-inspect":
		path := ""
		_ = json.Unmarshal(fields["path"], &path)
		if !keysSubset(fields, "version", "requestId", "path") || !safePath(path) {
			return fmt.Errorf("invalid backup-inspect request")
		}
	case "cancel":
		// requestId only; already validated.
	case "mutate":
		return validateMutate(fields)
	default:
		return fmt.Errorf("unknown kind %q", kind)
	}
	return nil
}

func validateMutate(fields map[string]json.RawMessage) error {
	operation := ""
	_ = json.Unmarshal(fields["operation"], &operation)
	if !mutationOperations[operation] {
		return fmt.Errorf("unknown mutation operation")
	}
	if hasKey(fields, "identity") && operation != "account-save" {
		return fmt.Errorf("identity is only valid for account-save")
	}
	if path, ok := fields["path"]; ok {
		var p string
		_ = json.Unmarshal(path, &p)
		if !safePath(p) && !(operation == "account-backup-all") {
			return fmt.Errorf("invalid path")
		}
	}
	for key, limit := range map[string]int{
		"providerId": 64, "sourceId": 256, "methodId": 128, "name": 128,
		"label": 160, "identity": 640, "endpoint": 2048, "apiKey": 8192, "region": 64,
		"defaultModel": 256, "kind": 64, "profile": 128, "gatewayId": 64,
		"transportPolicy": 16, "language": 16,
	} {
		if _, err := optionalStringField(fields, key, limit); err != nil {
			return err
		}
	}
	for _, key := range []string{"overwrite", "enabled", "overwriteConfirmed"} {
		if err := boolField(fields, key); err != nil {
			return err
		}
	}

	switch operation {
	case "setting-language":
		name, selected := "", ""
		_ = json.Unmarshal(fields["name"], &name)
		_ = json.Unmarshal(fields["language"], &selected)
		if name != "settings" || !safeStr(selected, 16) {
			return fmt.Errorf("invalid setting-language payload")
		}
		if _, ok := i18n.NormalizePreference(selected); !ok ||
			!keysSubset(fields, "version", "requestId", "operation", "name", "language") {
			return fmt.Errorf("invalid setting-language payload")
		}
	case "account-backup-export":
		path := ""
		_ = json.Unmarshal(fields["path"], &path)
		if !hasKey(fields, "overwrite") || !hasKey(fields, "accounts") || !safePath(path) ||
			!keysSubset(fields, "version", "requestId", "operation", "path", "accounts", "overwrite") {
			return fmt.Errorf("invalid account-backup-export payload")
		}
		var accounts []BackupAccountRef
		_ = json.Unmarshal(fields["accounts"], &accounts)
		seen := map[string]bool{}
		if len(accounts) == 0 || len(accounts) > MaxBackupAccountRefs {
			return fmt.Errorf("accounts selection invalid")
		}
		for _, ref := range accounts {
			if !safeStr(ref.Provider, 64) || !safeStr(ref.Name, 128) {
				return fmt.Errorf("invalid account reference")
			}
			key := ref.Provider + "\x00" + ref.Name
			if seen[key] {
				return fmt.Errorf("duplicate account reference")
			}
			seen[key] = true
		}
	case "account-backup-import":
		inspectionID := ""
		_ = json.Unmarshal(fields["inspectionId"], &inspectionID)
		var entryIDs []string
		_ = json.Unmarshal(fields["entryIds"], &entryIDs)
		if !safeStr(inspectionID, 128) ||
			// The count matches the backup file. Each id is still a short
			// inspection index, at most 16 characters.
			len(entryIDs) == 0 || len(entryIDs) > MaxBackupAccountRefs ||
			!hasKey(fields, "overwriteConfirmed") ||
			!keysSubset(fields, "version", "requestId", "operation",
				"inspectionId", "entryIds", "overwriteConfirmed") {
			return fmt.Errorf("invalid account-backup-import payload")
		}
		seen := map[string]bool{}
		for _, id := range entryIDs {
			if !safeStr(id, 16) || seen[id] {
				return fmt.Errorf("entryIds must be unique bounded strings")
			}
			seen[id] = true
		}
	case "account-backup-all":
		rawPath, ok := fields["path"]
		if !ok {
			return fmt.Errorf("invalid account-backup-all payload")
		}
		path := ""
		_ = json.Unmarshal(rawPath, &path)
		// An empty path falls back to a timestamped temp file
		// (backupDestination): the Tauri shell UI has no file picker, so it
		// sends path:"" and reports the destination from the result. A
		// present path must still be safe. `overwrite` is deliberately not
		// an allowed key — the fallback path never exists.
		if path != "" && !safePath(path) {
			return fmt.Errorf("invalid account-backup-all payload")
		}
		if !keysSubset(fields, "version", "requestId", "operation", "path") {
			return fmt.Errorf("invalid account-backup-all payload")
		}
	case "account-backup-forget":
		inspectionID := ""
		_ = json.Unmarshal(fields["inspectionId"], &inspectionID)
		if !safeStr(inspectionID, 128) ||
			!keysSubset(fields, "version", "requestId", "operation", "inspectionId") {
			return fmt.Errorf("invalid account-backup-forget payload")
		}
	case "account-import", "account-export":
		providerID, name, path := "", "", ""
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["name"], &name)
		_ = json.Unmarshal(fields["path"], &path)
		allowed := []string{"version", "requestId", "operation", "providerId", "name", "path"}
		if operation == "account-import" {
			allowed = append(allowed, "overwrite")
		}
		if !safeStr(providerID, 64) || !safeStr(name, 128) || !safePath(path) ||
			!keysSubset(fields, allowed...) {
			return fmt.Errorf("invalid %s payload", operation)
		}
	case "account-login":
		providerID := ""
		methodID := ""
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["methodId"], &methodID)
		sourceID, loginName, loginLabel := "", "", ""
		_ = json.Unmarshal(fields["sourceId"], &sourceID)
		_ = json.Unmarshal(fields["name"], &loginName)
		_ = json.Unmarshal(fields["label"], &loginLabel)
		if !safeStr(providerID, 64) || !safeStr(methodID, 128) ||
			(hasKey(fields, "sourceId") && !safeStr(sourceID, 64)) ||
			(hasKey(fields, "name") && !safeStr(loginName, 128)) ||
			!safeOptional(loginLabel, 160) ||
			!keysSubset(fields, "version", "requestId", "operation",
				"providerId", "sourceId", "methodId", "name", "label") {
			return fmt.Errorf("invalid account-login payload")
		}
	case "account-save":
		providerID, name := "", ""
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["name"], &name)
		if !safeStr(providerID, 64) || !safeStr(name, 128) ||
			!keysSubset(fields, "version", "requestId", "operation", "providerId", "name",
				"sourceId", "label", "identity", "apiKey", "region", "overwrite") {
			return fmt.Errorf("invalid account-save payload")
		}
	case "account-save-current":
		providerID, sourceID, name := "", "", ""
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["sourceId"], &sourceID)
		_ = json.Unmarshal(fields["name"], &name)
		if !safeStr(providerID, 64) ||
			(hasKey(fields, "sourceId") && !safeStr(sourceID, 64)) ||
			(hasKey(fields, "name") && !safeStr(name, 128)) ||
			!keysSubset(fields, "version", "requestId", "operation", "providerId", "sourceId", "name") {
			return fmt.Errorf("invalid account-save-current payload")
		}
	case "account-save-auth":
		// The auth document stays in a file. name may be empty: the provider
		// names a document that carries an email or account id. apiKey is a
		// different secret field and must not ride along.
		providerID, authName, authPath := "", "", ""
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["name"], &authName)
		_ = json.Unmarshal(fields["path"], &authPath)
		if !safeStr(providerID, 64) || !safeOptional(authName, 128) || !safePath(authPath) ||
			!keysSubset(fields, "version", "requestId", "operation",
				"providerId", "name", "path", "overwrite") {
			return fmt.Errorf("invalid account-save-auth payload")
		}
	case "account-save-input":
		// Typed credential save for provider-declared products: the secret travels
		// in apiKey (the same field gateway-create uses for profile
		// secrets), while kind/profile name the credential product from the
		// provider's published credentialKinds. An empty profile selects the
		// kind's first endpoint profile server-side.
		providerID, name, kind, apiKey := "", "", "", ""
		_ = json.Unmarshal(fields["providerId"], &providerID)
		_ = json.Unmarshal(fields["name"], &name)
		_ = json.Unmarshal(fields["kind"], &kind)
		_ = json.Unmarshal(fields["apiKey"], &apiKey)
		if !safeStr(providerID, 64) || !safeStr(name, 128) || !safeStr(kind, 64) ||
			len(apiKey) == 0 || len(apiKey) > 8192 ||
			!keysSubset(fields, "version", "requestId", "operation",
				"providerId", "name", "kind", "profile", "apiKey") {
			return fmt.Errorf("invalid account-save-input payload")
		}
	case "codex-profile-save", "codex-profile-update":
		name, sourceID, policy := "", "", ""
		_ = json.Unmarshal(fields["name"], &name)
		_ = json.Unmarshal(fields["sourceId"], &sourceID)
		_ = json.Unmarshal(fields["transportPolicy"], &policy)
		if !safeStr(name, 64) || !safeStr(sourceID, 256) ||
			(policy != "" && policy != "auto" && policy != "direct" && policy != "proxy") ||
			!keysSubset(fields, "version", "requestId", "operation", "name", "sourceId",
				"defaultModel", "transportPolicy") {
			return fmt.Errorf("invalid %s payload", operation)
		}
	case "codex-profile-sync":
		var sourceIDs []string
		_ = json.Unmarshal(fields["sourceIds"], &sourceIDs)
		if len(sourceIDs) == 0 || len(sourceIDs) > 64 ||
			!keysSubset(fields, "version", "requestId", "operation", "sourceIds") {
			return fmt.Errorf("invalid codex-profile-sync payload")
		}
		seen := make(map[string]bool, len(sourceIDs))
		for _, sourceID := range sourceIDs {
			if !safeStr(sourceID, 256) || seen[sourceID] {
				return fmt.Errorf("invalid codex-profile-sync source")
			}
			seen[sourceID] = true
		}
	case "codex-profile-remove":
		name := ""
		_ = json.Unmarshal(fields["name"], &name)
		if !safeStr(name, 64) ||
			!keysSubset(fields, "version", "requestId", "operation", "name") {
			return fmt.Errorf("invalid codex-profile-remove payload")
		}
	default:
		name := ""
		_ = json.Unmarshal(fields["name"], &name)
		if !safeStr(name, 128) {
			return fmt.Errorf("invalid name")
		}
		if _, hasPath := fields["path"]; hasPath {
			return fmt.Errorf("%s must not carry a path", operation)
		}
		needsProvider := map[string]bool{
			"account-detect": true, "account-save": true, "account-edit": true,
			"account-refresh": true, "account-remove": true, "account-clear": true,
			"gateway-create": true, "gateway-test": true, "hub-source-toggle": true,
			"proxy-token": true,
		}[operation]
		if needsProvider {
			providerID := ""
			_ = json.Unmarshal(fields["providerId"], &providerID)
			if !safeStr(providerID, 64) {
				return fmt.Errorf("invalid providerId")
			}
		}
		isSetting := len(operation) > 8 && operation[:8] == "setting-"
		if isSetting || operation == "hub-source-toggle" || operation == "hub-rotation" {
			if !hasKey(fields, "enabled") {
				return fmt.Errorf("%s requires enabled", operation)
			}
		}
	}
	return nil
}

// MaxBackupAccountRefs is how many accounts one desktop export or import
// selection may name. It is the backup file limit, so a package the CLI can
// write can be reviewed and restored from the app. A selection that does not
// fit in MaxCommandBytes is still rejected as a frame, not as a count.
const MaxBackupAccountRefs = transfer.MaxBackupAccounts
