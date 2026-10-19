package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// piAdapter configures Pi (@earendil-works/pi-coding-agent), the minimal agent
// harness. Pi reads provider credentials from ~/.pi/agent/auth.json (never
// written here) and resolves models through ~/.pi/agent/models.json, where a
// provider entry may override baseUrl/apiKey while keeping its models.
// Pointing Pi at AnyPick therefore means upserting one managed "anypick"
// provider entry plus the default provider/model selection in
// ~/.pi/agent/settings.json — the opencode pattern, not per-vendor entries,
// so no AnyPick-to-Pi provider id mapping is needed and switching vendors
// only retargets the one entry.
type piAdapter struct{ home string }

func newPi(home string) *piAdapter { return &piAdapter{home: home} }

const (
	// piManagedProviderID is the single provider entry AnyPick owns inside
	// the user's models.json. A user-owned entry under the same id is
	// checkpointed and restored, never silently kept.
	piManagedProviderID = "anypick"
	piManagedAPI        = "openai-completions"
	piRestoreFile       = "pi-restore.json"
)

func (a *piAdapter) ID() string   { return "pi" }
func (a *piAdapter) Name() string { return "Pi" }
func (a *piAdapter) ShortName() string {
	return "Pi"
}

func (a *piAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "pi",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		RequiresDefaultModel:     true,
		ProtocolPreference:       transport.OpenAI,
	}
}

// piAgentDir resolves the harness agent directory: ~/.pi/agent in default
// setups. The Pi package documents no config-dir override, so unlike dsh
// there is no env to honor — an isolated run never reaches the live tree
// because Apply targets IsolatedHome instead.
func piAgentDir(home string) string {
	return filepath.Join(home, ".pi", "agent")
}

func piModelsPath(home string) string   { return filepath.Join(piAgentDir(home), "models.json") }
func piSettingsPath(home string) string { return filepath.Join(piAgentDir(home), "settings.json") }
func piAuthPath(home string) string     { return filepath.Join(piAgentDir(home), "auth.json") }

// PiConfigPaths reports the live harness files Apply may write. Auth stays
// pi-managed: the file only ever grows provider keys through /login, and
// AnyPick must not rewrite a credential store it cannot parse back safely.
// Shared with the runtime recovery journal so backup and apply cannot drift.
func PiConfigPaths(home string) []string {
	return []string{piModelsPath(home), piSettingsPath(home)}
}

// piRestoreState checkpoints the pre-proxy models.json fragment and settings
// selection so Reset restores exactly what Apply replaced.
type piRestoreState struct {
	Version                int             `json:"version"`
	ProviderPresent        bool            `json:"providerPresent"`
	ProviderValue          json.RawMessage `json:"providerValue,omitempty"`
	DefaultProviderPresent bool            `json:"defaultProviderPresent"`
	DefaultProviderValue   string          `json:"defaultProviderValue,omitempty"`
	DefaultModelPresent    bool            `json:"defaultModelPresent"`
	DefaultModelValue      string          `json:"defaultModelValue,omitempty"`
}

func (a *piAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	modelIDs := sourceModelIDs(ctx)
	defaultModel := selectedDefaultModel(ctx)
	if ctx.Endpoint == "" || defaultModel == "" || len(modelIDs) == 0 {
		return nil, anyerr.Newf(
			"Pi routing needs an endpoint and a selected default model.",
			"CLIENT_CONFIG_INVALID")
	}
	baseURL := strings.TrimSuffix(ctx.Endpoint, "/") + "/v1"

	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: []string{
			piModelsPath(targetHome),
			piSettingsPath(targetHome),
		}}, nil
	}

	modelsDoc, err := readPiJSONObject(piModelsPath(targetHome), "models.json")
	if err != nil {
		return nil, err
	}
	settingsDoc, err := readPiJSONObject(piSettingsPath(targetHome), "settings.json")
	if err != nil {
		return nil, err
	}

	if ctx.IsolatedHome == "" {
		if err := checkpointPiRestore(ctx.AnyPickRoot, modelsDoc, settingsDoc); err != nil {
			return nil, err
		}
	}

	providers := piProviders(modelsDoc)
	entry := map[string]interface{}{
		"baseUrl": baseURL,
		"apiKey":  firstNonEmpty(ctx.APIKey, "anypick-proxy"),
		"api":     piManagedAPI,
		"models":  piModelEntries(modelIDs),
	}
	ej, _ := json.Marshal(entry)
	providers[piManagedProviderID] = ej
	pj, _ := json.Marshal(providers)
	modelsDoc["providers"] = pj
	settingsDoc["defaultProvider"] = json.RawMessage(`"anypick"`)
	dj, _ := json.Marshal("anypick/" + defaultModel)
	settingsDoc["defaultModel"] = dj

	if err := os.MkdirAll(piAgentDir(targetHome), 0o700); err != nil {
		return nil, err
	}
	// models.json now carries the proxy token: force 0600 even when the
	// user file arrived more permissive. settings.json holds selection
	// only, so it keeps its existing bits (0600 when created).
	if err := writePiJSON(piModelsPath(targetHome), modelsDoc, true); err != nil {
		return nil, err
	}
	if err := writePiJSON(piSettingsPath(targetHome), settingsDoc, false); err != nil {
		return nil, err
	}
	return &ApplyResult{ManagedPaths: []string{
		piModelsPath(targetHome),
		piSettingsPath(targetHome),
	}}, nil
}

// piModelEntries builds the models list for the managed provider. Ids come
// from the source catalog and pass through unchanged; the display name falls
// back to the id, mirroring the opencode managed entry.
func piModelEntries(modelIDs []string) []map[string]string {
	seen := map[string]bool{}
	out := make([]map[string]string, 0, len(modelIDs))
	for _, id := range modelIDs {
		id = strings.TrimSpace(id)
		if id == "" || strings.ContainsAny(id, "\r\n") || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, map[string]string{"id": id, "name": id})
	}
	return out
}

// readPiJSONObject parses one of Pi's JSON documents. A missing file yields
// an empty object (first run); a malformed user file fails closed instead of
// being replaced with an empty object holding only AnyPick's entry.
func readPiJSONObject(path, label string) (map[string]json.RawMessage, error) {
	doc := map[string]json.RawMessage{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return doc, nil
		}
		return nil, err
	}
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		return nil, anyerr.Newf(
			"Refusing to overwrite unreadable Pi "+label+" at "+path+".",
			"CLIENT_CONFIG_INVALID")
	}
	return doc, nil
}

// piProviders extracts the providers object of a models.json document.
func piProviders(doc map[string]json.RawMessage) map[string]json.RawMessage {
	raw, ok := doc["providers"]
	if !ok || string(raw) == "null" {
		return map[string]json.RawMessage{}
	}
	m := map[string]json.RawMessage{}
	if json.Unmarshal(raw, &m) != nil {
		return map[string]json.RawMessage{}
	}
	return m
}

// checkpointPiRestore records the pre-proxy fragment once per activation so
// Reset restores exactly what Apply replaced, including a user-owned entry
// that happened to use the managed id.
func checkpointPiRestore(anyPickRoot string, modelsDoc, settingsDoc map[string]json.RawMessage) error {
	if anyPickRoot == "" {
		anyPickRoot = anyPickRootFallback()
	}
	restorePath := filepath.Join(anyPickRoot, "clients", "pi", piRestoreFile)
	if _, err := os.Stat(restorePath); err == nil {
		return nil
	}
	state := piRestoreState{Version: 1}
	if providers := piProviders(modelsDoc); providers != nil {
		if v, ok := providers[piManagedProviderID]; ok {
			state.ProviderPresent = true
			state.ProviderValue = v
		}
	}
	if v, ok := settingsDoc["defaultProvider"]; ok {
		var s string
		if json.Unmarshal(v, &s) == nil {
			state.DefaultProviderPresent = true
			state.DefaultProviderValue = s
		}
	}
	if v, ok := settingsDoc["defaultModel"]; ok {
		var s string
		if json.Unmarshal(v, &s) == nil {
			state.DefaultModelPresent = true
			state.DefaultModelValue = s
		}
	}
	rj, _ := json.Marshal(state)
	if err := os.MkdirAll(filepath.Dir(restorePath), 0o700); err != nil {
		return err
	}
	// Checkpoint under our own root; atomic like every write.
	return atomicfile.Write(restorePath, append(rj, '\n'), 0o600)
}

// writePiJSON replaces a Pi JSON document atomically. forceSecret upgrades
// permissions to 0600 because the content carries a credential; otherwise an
// existing file keeps its bits and only brand-new files are created 0600.
func writePiJSON(path string, doc map[string]json.RawMessage, forceSecret bool) error {
	out, err := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if err != nil {
		return err
	}
	perm := os.FileMode(0o600)
	if !forceSecret {
		if fi, err := os.Stat(path); err == nil {
			perm = fi.Mode().Perm()
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return atomicfile.Write(path, append(out, '\n'), perm)
}

func (a *piAdapter) Reset() error {
	state, err := a.unroute(true)
	if err != nil {
		return err
	}
	if state == nil {
		return nil
	}
	return nil
}

// RestoreNative unroutes a proxy binding when activation switches back to a
// native account. Unlike Reset it keeps the checkpoint: a later Reset must
// still restore the exact pre-proxy state.
func (a *piAdapter) RestoreNative() error {
	_, err := a.unroute(false)
	return err
}

// unroute removes the managed provider entry and selection, restoring the
// checkpoint when one exists and is usable. consume deletes it (Reset),
// while RestoreNative keeps it.
func (a *piAdapter) unroute(consume bool) (*piRestoreState, error) {
	restorePath := filepath.Join(anyPickRootFallback(), "clients", "pi", piRestoreFile)
	modelsPath := piModelsPath(a.home)
	settingsPath := piSettingsPath(a.home)

	modelsDoc, err := readPiJSONObject(modelsPath, "models.json")
	if err != nil {
		return nil, err
	}
	settingsDoc, err := readPiJSONObject(settingsPath, "settings.json")
	if err != nil {
		return nil, err
	}
	providers := piProviders(modelsDoc)
	delete(providers, piManagedProviderID)

	var state *piRestoreState
	if raw, rerr := os.ReadFile(restorePath); rerr == nil {
		var restore piRestoreState
		if json.Unmarshal(raw, &restore) == nil {
			state = &restore
			if restore.ProviderPresent && restore.ProviderValue != nil {
				providers[piManagedProviderID] = restore.ProviderValue
			}
			if restore.DefaultProviderPresent {
				dj, _ := json.Marshal(restore.DefaultProviderValue)
				settingsDoc["defaultProvider"] = dj
			} else {
				delete(settingsDoc, "defaultProvider")
			}
			if restore.DefaultModelPresent {
				dj, _ := json.Marshal(restore.DefaultModelValue)
				settingsDoc["defaultModel"] = dj
			} else {
				delete(settingsDoc, "defaultModel")
			}
			if consume {
				_ = os.Remove(restorePath)
			}
		}
	} else {
		// No checkpoint: still drop a managed selection pointing at the
		// entry being removed, so Reset never leaves Pi aimed at a
		// provider that no longer exists.
		if v, ok := settingsDoc["defaultProvider"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil && s == piManagedProviderID {
				delete(settingsDoc, "defaultProvider")
			}
		}
		if v, ok := settingsDoc["defaultModel"]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil && strings.HasPrefix(s, piManagedProviderID+"/") {
				delete(settingsDoc, "defaultModel")
			}
		}
	}
	if len(providers) > 0 {
		pj, _ := json.Marshal(providers)
		modelsDoc["providers"] = pj
	} else {
		delete(modelsDoc, "providers")
	}
	if err := writePiJSON(modelsPath, modelsDoc, false); err != nil {
		return nil, err
	}
	if err := writePiJSON(settingsPath, settingsDoc, false); err != nil {
		return nil, err
	}
	return state, nil
}

func (a *piAdapter) Inspect() (*InspectResult, error) {
	res := &InspectResult{Present: false}
	if _, err := os.Stat(piAgentDir(a.home)); err != nil {
		return res, nil
	}
	res.Present = true
	// auth.json is read-only evidence: count provider keys without ever
	// surfacing values. A Pi with no stored keys still counts as present
	// (the agent dir exists) but reports nothing to import.
	if raw, err := os.ReadFile(piAuthPath(a.home)); err == nil {
		var keys map[string]json.RawMessage
		if json.Unmarshal(raw, &keys) == nil && len(keys) > 0 {
			unit := "provider keys"
			if len(keys) == 1 {
				unit = "provider key"
			}
			res.Summary = fmt.Sprintf("auth.json with %d %s", len(keys), unit)
		} else {
			res.Summary = "agent dir present, no stored provider keys"
		}
	} else if !os.IsNotExist(err) {
		res.Issues = []string{"Pi auth.json unreadable"}
		return res, nil
	} else {
		res.Summary = "agent dir present, no stored provider keys"
	}
	if _, err := os.Stat(piModelsPath(a.home)); err == nil {
		if doc, rerr := readPiJSONObject(piModelsPath(a.home), "models.json"); rerr == nil {
			if _, managed := piProviders(doc)[piManagedProviderID]; managed {
				res.Summary += " (AnyPick provider configured)"
			}
		} else if res.Summary != "" {
			res.Issues = []string{"Pi models.json unreadable"}
		}
	}
	res.ConfigPaths = PiConfigPaths(a.home)
	if settings, err := readPiJSONObject(piSettingsPath(a.home), "settings.json"); err == nil {
		selected := stringField(settings, "defaultProvider")
		model := stringField(settings, "defaultModel")
		res.RoutingChanged = (selected != "" && selected != piManagedProviderID) ||
			(strings.Contains(model, "/") && !strings.HasPrefix(model, piManagedProviderID+"/"))
	}
	return res, nil
}

// Compile-time: the direct-account path calls RestoreNative instead of Apply
// on switch-back, so a native login must not keep a stale proxy endpoint.
var _ NativeRestorer = (*piAdapter)(nil)
