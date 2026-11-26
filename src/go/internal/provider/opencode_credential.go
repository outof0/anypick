package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/db"
)

// The beta OpenCode CLI records logins in its sqlite `credential` table and
// stopped rewriting auth.json on login, so a saved mirror can silently hold a
// previous account's key. These helpers read the live store best-effort: any
// failure (missing file, older schema, foreign row shape) means "no live key",
// never an error.

type openCodePlatformKey struct {
	Service string
	Key     string
}

var openCodePlatformServices = map[string]bool{
	"opencode-go":  true,
	"opencode":     true,
	"opencode-zen": true,
	"zen":          true,
}

func openCodeLiveDataDir(home string) string {
	if env := os.Getenv("OPENCODE_DATA_DIR"); env != "" {
		return expandHome(env)
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" && expandHome(home) == homeDirOf() {
		return filepath.Join(expandHome(xdg), "opencode")
	}
	return filepath.Join(expandHome(home), ".local", "share", "opencode")
}

// OpenCodeCatalogSource is one live Zen/Go platform key with the base it
// authenticates against.
type OpenCodeCatalogSource struct {
	Endpoint string
	Key      string
}

// OpenCodeServiceEndpoint maps a platform service name to its
// OpenAI-compatible base, mirroring ResolveUpstream: opencode-go rides the
// Go gateway, everything else Zen. Unknown services map to "".
func OpenCodeServiceEndpoint(service string) string {
	if strings.EqualFold(service, "opencode-go") {
		return openCodeGoBaseURL
	}
	switch strings.ToLower(service) {
	case "opencode", "zen", "opencode-zen":
		return openCodeZenBaseURL
	default:
		return ""
	}
}

// OpenCodeCatalogSources lists live Zen/Go platform keys as endpoint+key
// pairs for model catalog fetches. Server-side only: keys feed the fetch
// and the cache write; only model ids ever leave Go. Empty when the live
// store holds nothing usable — never an error.
func OpenCodeCatalogSources() []OpenCodeCatalogSource {
	keys := liveOpenCodePlatformKeys()
	seen := map[string]bool{}
	out := []OpenCodeCatalogSource{}
	for _, k := range keys {
		endpoint := OpenCodeServiceEndpoint(k.Service)
		if endpoint == "" || k.Key == "" || seen[endpoint] {
			continue
		}
		seen[endpoint] = true
		out = append(out, OpenCodeCatalogSource{Endpoint: endpoint, Key: k.Key})
	}
	return out
}

// liveOpenCodePlatformKeys lists platform API keys from the live CLI install's
// credential database.
func liveOpenCodePlatformKeys() []openCodePlatformKey {
	return readOpenCodeDBKeys(filepath.Join(openCodeLiveDataDir(homeDirOf()), "opencode.db"))
}

// openCodeSnapshotDBKeys reads the credential database that sits BESIDE a
// saved auth.json. A snapshot dir written by Backup never carries one, but a
// caller pointing at a live data directory does have one, so the step is kept.
func openCodeSnapshotDBKeys(snapshotDir string) []openCodePlatformKey {
	return readOpenCodeDBKeys(filepath.Join(snapshotDir, "opencode.db"))
}

// readOpenCodeDBKeys is best-effort and read-only: a missing file, an older
// schema or a foreign row shape all mean "no credentials here", never an error.
func readOpenCodeDBKeys(path string) []openCodePlatformKey {
	d, err := db.OpenForeign(path, true)
	if err != nil {
		return nil
	}
	defer d.Close()
	// ORDER BY keeps the ring deterministic: two platform rows in one store
	// must always resolve to the same key, and an unordered scan does not.
	rows, err := d.Query("SELECT integration_id, value FROM credential ORDER BY integration_id")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []openCodePlatformKey
	for rows.Next() {
		var integrationID, value string
		if rows.Scan(&integrationID, &value) != nil {
			continue
		}
		if !openCodePlatformServices[strings.ToLower(integrationID)] || value == "" {
			continue
		}
		// Api keys are stored as {"type":"key"|"api","key":"sk-…"}; oauth rows
		// (refresh tokens etc.) are not usable for the Zen/Go endpoints.
		var parsed struct {
			Type string `json:"type"`
			Key  string `json:"key"`
		}
		if json.Unmarshal([]byte(value), &parsed) != nil {
			continue
		}
		if (parsed.Type == "key" || parsed.Type == "api") && parsed.Key != "" {
			out = append(out, openCodePlatformKey{Service: integrationID, Key: parsed.Key})
		}
	}
	return out
}

// mirrorState is why a saved auth.json could not supply a gateway key. Each
// state maps to a different message — "no login at all" and "logged in
// without a Zen/Go key" send the user to different commands — so the
// distinction is kept instead of collapsing it into one error.
type mirrorState int

const (
	mirrorMissing mirrorState = iota // no auth.json in the snapshot
	mirrorUnreadable
	mirrorRead
)

// openCodeSnapshotKeys lists platform keys from a saved auth.json mirror
// (listPlatformCredentials). A snapshot dir carries no credential database —
// Backup copies auth.json and the optional account.json only — so the mirror is
// the whole material a saved account can contribute.
//
// Rows come back in service order: a mirror holding several platform rows must
// resolve the same key every time, and a Go map iteration does not.
func openCodeSnapshotKeys(snapshotDir string) ([]openCodePlatformKey, mirrorState) {
	return openCodeSnapshotFileKeys(snapshotFilesAt(snapshotDir))
}

func openCodeSnapshotFileKeys(file SnapshotFileReader) ([]openCodePlatformKey, mirrorState) {
	raw, err := file("auth.json")
	if err != nil {
		return nil, mirrorMissing
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil {
		return nil, mirrorUnreadable
	}
	services := make([]string, 0, len(data))
	for service := range data {
		services = append(services, service)
	}
	sort.Strings(services)
	var out []openCodePlatformKey
	for _, service := range services {
		if !openCodePlatformServices[strings.ToLower(service)] {
			continue
		}
		// Platform rows are {"type":"api","key":"sk-…"}; older builds spelled
		// the field apiKey or token. OAuth rows carry "access" and never
		// satisfy a Zen/Go gateway, so they contribute nothing here.
		var entry struct {
			Key    string `json:"key"`
			APIKey string `json:"apiKey"`
			Token  string `json:"token"`
		}
		if json.Unmarshal(data[service], &entry) != nil {
			continue
		}
		key := entry.Key
		if key == "" {
			key = entry.APIKey
		}
		if key == "" {
			key = entry.Token
		}
		if key == "" {
			continue
		}
		out = append(out, openCodePlatformKey{Service: service, Key: key})
	}
	return out, mirrorRead
}

// pickOpenCodeGatewayKey is pickPreferredKey: a Go subscription row wins,
// otherwise the first Zen/Go row. Only platform rows are candidates here, so a
// row for another vendor can never win.
//
// This deliberately differs from preferredLiveOpenCodeKey: a compatible
// definition is pinned to one catalog (Zen never takes a Go row), while the
// native provider serves both.
func pickOpenCodeGatewayKey(keys []openCodePlatformKey) (key, service string) {
	for _, k := range keys {
		if strings.EqualFold(k.Service, "opencode-go") {
			return k.Key, k.Service
		}
	}
	for _, k := range keys {
		return k.Key, k.Service
	}
	return "", ""
}

// openCodeGatewayKey resolves the credential the Zen/Go gateway must use
// (auto mode, one auth path):
//
//  1. the live CLI install's credential table — the beta CLI stopped rewriting
//     auth.json on login, so a saved mirror can hold a previous account's key;
//  2. the credential database beside the mirror, when there is one;
//  3. the mirror itself.
//
// One rule, on purpose: live rows prefer the Go subscription key on every
// branch — an unordered database scan is not a rule. state reports why no key
// was found when key is empty.
func openCodeGatewayKey(snapshotDir string) (key, service string, state mirrorState) {
	if key, service = pickOpenCodeGatewayKey(liveOpenCodePlatformKeys()); key != "" {
		return key, service, mirrorRead
	}
	if key, service = pickOpenCodeGatewayKey(openCodeSnapshotDBKeys(snapshotDir)); key != "" {
		return key, service, mirrorRead
	}
	keys, state := openCodeSnapshotKeys(snapshotDir)
	if state != mirrorRead {
		return "", "", state
	}
	key, service = pickOpenCodeGatewayKey(keys)
	return key, service, state
}

// preferredLiveOpenCodeKey picks the live key that backs a compatible gateway:
// the Go subscription id for opencode-go, any platform id for Zen. Empty when
// the live store has nothing usable.
func preferredLiveOpenCodeKey(definitionID string) string {
	keys := liveOpenCodePlatformKeys()
	if definitionID == "opencode-go" {
		for _, k := range keys {
			if k.Service == "opencode-go" {
				return k.Key
			}
		}
		return ""
	}
	for _, k := range keys {
		switch k.Service {
		case "opencode", "zen", "opencode-zen":
			return k.Key
		}
	}
	return ""
}

// liveOpenCodeAuthStatus reports a db-only login: present with the platform
// service as identity, or absent when the live store has no usable key.
func liveOpenCodeAuthStatus() (LiveAuthStatus, bool) {
	keys := liveOpenCodePlatformKeys()
	if len(keys) == 0 {
		return LiveAuthStatus{}, false
	}
	service := keys[0].Service
	for _, k := range keys {
		if k.Service == "opencode-go" {
			service = k.Service
			break
		}
	}
	return LiveAuthStatus{Present: true, Identity: service}, true
}
