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

// zcodeAdapter makes ZCode (Z.ai / 智谱) a *client*. Both the desktop app and
// the CLI engine bundled inside it read a provider map out of ~/.zcode and
// treat every entry in it as a user-added Anthropic- or OpenAI-compatible
// provider. That is ZCode's own documented "Add Provider" flow
// (https://zcode.z.ai/en/docs/configuration), so this writes a supported
// structure rather than patching application internals.
//
// Two flavours of that file exist and they are NOT interchangeable:
//
//	~/.zcode/cli/config.json — the CLI engine at
//	  /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs. Schema
//	  "zcode.config.v1": provider entries carry id/kind/name/options/models,
//	  and the model the CLI runs lives at the top level as model.main.
//	~/.zcode/v2/config.json — the desktop app. Same provider map, but model
//	  entries use limit/modalities/reasoning, entries carry enabled/source,
//	  and the current selection lives in setting.json, which AnyPick does
//	  not touch.
type zcodeAdapter struct{ home string }

func newZCode(home string) *zcodeAdapter { return &zcodeAdapter{home: home} }

const (
	zcodeManagedProviderID = "anypick"
	zcodeRestoreFile       = "restore.json"

	// ZCode uses a provider's declared limits for its own context meter and
	// output clamp. These are deliberately conservative: under-reporting the
	// context only makes the meter pessimistic, whereas over-reporting lets
	// the agent build a prompt the borrowed account cannot actually accept.
	zcodeDefaultContextWindow = 200000
	zcodeDefaultMaxOutput     = 32000
)

type zcodeFlavor string

const (
	zcodeFlavorCLI zcodeFlavor = "cli"
	zcodeFlavorV2  zcodeFlavor = "v2"
)

// zcodeTarget is one config file AnyPick writes, with the schema flavour that
// file uses.
type zcodeTarget struct {
	flavor zcodeFlavor
	path   string
}

// ZCodeCLIConfigPath is the config the ZCode CLI reads. An isolated run has to
// create exactly this file before the child starts, so the path is exported
// rather than rebuilt over there.
func ZCodeCLIConfigPath(home string) string {
	return filepath.Join(home, ".zcode", "cli", "config.json")
}

// zcodeTargets returns every config file AnyPick should write.
//
// Which one ZCode actually reads depends on how it was launched: the desktop
// app reads ~/.zcode/v2/config.json, the CLI reads ~/.zcode/cli/config.json,
// and neither exports anything a parent process can observe. Choosing one is a
// coin flip that fails silently, so — exactly as workbuddyModelsPaths does —
// AnyPick writes every flavour it can find.
//
// "It can find" means the config file exists, not the directory: ~/.zcode/cli
// is created by a machine that has never run the CLI's config write — it holds
// db, log and exec trees — and dropping a config.json there would replace the
// builtin providers the CLI otherwise falls back to with a file containing
// nothing but AnyPick's entry. When no config exists at all, target the CLI
// file: it is the only flavour with a documented schema.
func zcodeTargets(home string) []zcodeTarget {
	candidates := []zcodeTarget{
		{flavor: zcodeFlavorCLI, path: ZCodeCLIConfigPath(home)},
		{flavor: zcodeFlavorV2, path: filepath.Join(home, ".zcode", "v2", "config.json")},
	}
	var out []zcodeTarget
	for _, c := range candidates {
		if st, err := os.Stat(c.path); err == nil && !st.IsDir() {
			out = append(out, c)
		}
	}
	if len(out) > 0 {
		return out
	}
	return candidates[:1]
}

// ZCodeConfigPaths reports every ZCode config file AnyPick writes for a home
// directory.
//
// The runtime package needs the same list to snapshot a client's config before
// activation mutates it. Duplicating the list there is how the backup and the
// write drift apart, which is worse than widening this package's surface.
func ZCodeConfigPaths(home string) []string {
	targets := zcodeTargets(home)
	out := make([]string, 0, len(targets))
	for _, t := range targets {
		out = append(out, t.path)
	}
	return out
}

func (a *zcodeAdapter) ID() string        { return "zcode" }
func (a *zcodeAdapter) Name() string      { return "ZCode" }
func (a *zcodeAdapter) ShortName() string { return "ZCode" }

func (a *zcodeAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                "zcode",
		AcceptedProtocols: []transport.Protocol{transport.Anthropic, transport.OpenAI},
		// ZCode resolves everything relative to the home directory: the CLI
		// reads its config from `homeDir ?? os.homedir()` — see the bundled
		// zcode.cjs, which builds `<home>/.zcode/cli/config.json` — and
		// os.homedir() follows $HOME on POSIX. So relocating HOME relocates
		// both the config and the storage tree, and an isolated run touches
		// nothing of the user's real ~/.zcode.
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		RequiresDefaultModel:     true,
		ProtocolPreference:       transport.Anthropic,
	}
}

// readZCodeConfig parses a config file, refusing to touch it on garbage — a
// config AnyPick cannot parse belongs to the user, not to AnyPick.
func readZCodeConfig(path string) (map[string]json.RawMessage, error) {
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
			"Refusing to overwrite unreadable ZCode config at "+path+".",
			"CLIENT_CONFIG_INVALID")
	}
	return doc, nil
}

// zcodeProviders extracts doc.provider as raw entries keyed by provider id.
func zcodeProviders(doc map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	raw, ok := doc["provider"]
	if !ok || string(raw) == "null" {
		return map[string]json.RawMessage{}, nil
	}
	m := map[string]json.RawMessage{}
	if json.Unmarshal(raw, &m) != nil {
		return nil, anyerr.Newf("ZCode config.provider must be an object.", "CLIENT_CONFIG_INVALID")
	}
	return m, nil
}

// zcodeModelEntry builds one model entry in the schema the flavour expects.
func zcodeModelEntry(flavor zcodeFlavor, modelID string) map[string]interface{} {
	if flavor == zcodeFlavorV2 {
		return map[string]interface{}{
			"name": modelID,
			"limit": map[string]interface{}{
				"context": zcodeDefaultContextWindow,
				"output":  zcodeDefaultMaxOutput,
			},
			"modalities": map[string]interface{}{
				"input":  []string{"text"},
				"output": []string{"text"},
			},
		}
	}
	return map[string]interface{}{
		"name":                     modelID,
		"contextWindow":            zcodeDefaultContextWindow,
		"maxOutputTokens":          zcodeDefaultMaxOutput,
		"supportsToolCall":         true,
		"supportsReasoning":        true,
		"supportsImages":           false,
		"supportsStructuredOutput": true,
	}
}

// zcodeProviderEntry builds the managed provider. kind is always "anthropic":
// the proxy serves both /v1/messages and /v1/chat/completions, and the
// Anthropic surface is the one ZCode exercises for its own built-ins, so it is
// the best-tested path.

func zcodeProviderEntry(flavor zcodeFlavor, endpoint, apiKey string, modelIDs []string) (json.RawMessage, error) {
	models := map[string]interface{}{}
	for _, modelID := range modelIDs {
		models[modelID] = zcodeModelEntry(flavor, modelID)
	}
	entry := map[string]interface{}{
		"name": "AnyPick",
		"kind": "anthropic",
		"options": map[string]interface{}{
			"apiKey":         apiKey,
			"baseURL":        endpoint,
			"apiKeyRequired": true,
		},
		"models": models,
	}
	switch flavor {
	case zcodeFlavorCLI:
		// zcode.config.v1 requires the id to match the map key.
		entry["id"] = zcodeManagedProviderID
	case zcodeFlavorV2:
		// The desktop app only offers a provider in its model picker when the
		// entry is switched on; "custom" is what its own Add Provider flow
		// stamps on a user-added entry.
		entry["enabled"] = true
		entry["source"] = "custom"
	}
	return json.Marshal(entry)
}

// zcodeFileCheckpoint is what Reset needs to put one file back exactly as it
// was: whether it existed at all, and the prior provider/model values if it did.
type zcodeFileCheckpoint struct {
	Path            string          `json:"path"`
	FileExists      bool            `json:"fileExists"`
	ProviderPresent bool            `json:"providerPresent"`
	ProviderValue   json.RawMessage `json:"providerValue,omitempty"`
	ModelPresent    bool            `json:"modelPresent"`
	ModelValue      json.RawMessage `json:"modelValue,omitempty"`
}

type zcodeRestoreState struct {
	Version int                   `json:"version"`
	Files   []zcodeFileCheckpoint `json:"files"`
}

func (a *zcodeAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	targets := zcodeTargets(targetHome)
	restorePath := filepath.Join(ctx.AnyPickRoot, "clients", "zcode", zcodeRestoreFile)

	// ZCode will not start a turn against a model it does not know, and the
	// CLI has no --model flag at all, so a default model is not optional here.
	modelID := selectedDefaultModel(ctx)
	modelIDs := sourceModelIDs(ctx)
	if ctx.Endpoint == "" || modelID == "" || len(modelIDs) == 0 {
		return nil, anyerr.Newf(
			"ZCode routing needs an endpoint and a selected default model.",
			"CLIENT_CONFIG_INVALID")
	}

	managed := make([]string, 0, len(targets)+1)
	for _, t := range targets {
		managed = append(managed, t.path)
	}
	if ctx.IsolatedHome == "" {
		managed = append(managed, restorePath)
	}
	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: managed}, nil
	}

	apiKey := ctx.APIKey
	if apiKey == "" {
		apiKey = "anypick-proxy"
	}
	endpoint := strings.TrimSuffix(ctx.Endpoint, "/")

	checkpoints := make([]zcodeFileCheckpoint, 0, len(targets))
	for _, t := range targets {
		doc, err := readZCodeConfig(t.path)
		if err != nil {
			return nil, err
		}
		providers, err := zcodeProviders(doc)
		if err != nil {
			return nil, err
		}
		// Checkpoint each file before the first write so Reset can put the
		// user's providers back even if AnyPick ran several times.
		if ctx.IsolatedHome == "" {
			_, statErr := os.Stat(t.path)
			checkpoints = append(checkpoints, zcodeFileCheckpoint{
				Path:            t.path,
				FileExists:      statErr == nil,
				ProviderPresent: providers[zcodeManagedProviderID] != nil,
				ProviderValue:   providers[zcodeManagedProviderID],
				ModelPresent:    doc["model"] != nil,
				ModelValue:      doc["model"],
			})
		}

		entry, err := zcodeProviderEntry(t.flavor, endpoint, apiKey, modelIDs)
		if err != nil {
			return nil, err
		}
		providers[zcodeManagedProviderID] = entry
		pj, err := json.Marshal(providers)
		if err != nil {
			return nil, err
		}
		doc["provider"] = pj

		if t.flavor == zcodeFlavorCLI {
			// The CLI ignores --model: the model it runs is whatever
			// config.json points at, so routing is not done until this points
			// at the managed provider.
			m, merr := json.Marshal(map[string]string{
				"main": zcodeManagedProviderID + "/" + modelID,
				"lite": zcodeManagedProviderID + "/" + modelID,
			})
			if merr != nil {
				return nil, merr
			}
			doc["model"] = m
		}

		out, err := json.MarshalIndent(doc, "", "  ")
		if err != nil {
			return nil, err
		}
		if err := atomicfile.Write(t.path, append(out, '\n'), 0o600); err != nil {
			return nil, err
		}
		if err := verifyZCodeEntry(t.path, endpoint); err != nil {
			return nil, err
		}
	}

	// Write the checkpoint only after every file succeeded: a checkpoint that
	// claims more than was written would make Reset delete user data.
	if ctx.IsolatedHome == "" {
		if _, statErr := os.Stat(restorePath); os.IsNotExist(statErr) {
			state := zcodeRestoreState{Version: 1, Files: checkpoints}
			if rj, merr := json.MarshalIndent(state, "", "  "); merr == nil {
				if mkErr := os.MkdirAll(filepath.Dir(restorePath), 0o700); mkErr == nil {
					// Checkpoint under our own root; atomic like every write.
					_ = atomicfile.Write(restorePath, append(rj, '\n'), 0o600)
				}
			}
		}
	}
	return &ApplyResult{ManagedPaths: managed}, nil
}

// verifyZCodeEntry re-reads what AnyPick just wrote and confirms the managed
// provider really points at the proxy. A silent no-op here would leave ZCode
// talking to the user's own account while AnyPick reports success — the same
// check claude.go makes on settings.json.
func verifyZCodeEntry(path, endpoint string) error {
	doc, err := readZCodeConfig(path)
	if err != nil {
		return err
	}
	providers, err := zcodeProviders(doc)
	if err != nil {
		return err
	}
	raw, ok := providers[zcodeManagedProviderID]
	if !ok {
		return anyerr.Newf(
			"Failed to write proxy into "+path+": managed provider missing after write.",
			"CLIENT_CONFIG_INVALID")
	}
	var entry struct {
		Options struct {
			BaseURL string `json:"baseURL"`
		} `json:"options"`
	}
	if json.Unmarshal(raw, &entry) != nil {
		return anyerr.Newf(
			"Failed to write proxy into "+path+": managed provider is unreadable.",
			"CLIENT_CONFIG_INVALID")
	}
	if entry.Options.BaseURL != endpoint {
		return anyerr.Newf(
			fmt.Sprintf("Failed to write proxy into %s: baseURL is %q (expected %s)",
				path, entry.Options.BaseURL, endpoint),
			"CLIENT_CONFIG_INVALID")
	}
	return nil
}

func (a *zcodeAdapter) Reset() error {
	restorePath := filepath.Join(anyPickRootFallback(), "clients", "zcode", zcodeRestoreFile)

	restored := map[string]bool{}
	if raw, err := os.ReadFile(restorePath); err == nil {
		var state zcodeRestoreState
		if json.Unmarshal(raw, &state) == nil {
			for _, file := range state.Files {
				if err := resetZCodeFile(file); err != nil {
					return err
				}
				restored[file.Path] = true
			}
			_ = os.Remove(restorePath)
		}
	}

	// Config files that appeared after the checkpoint (a later desktop
	// install adds the v2 flavour) are not listed in it: sweep their managed
	// provider so no proxy routing survives Reset.
	for _, t := range zcodeTargets(a.home) {
		if restored[t.path] {
			continue
		}
		if err := sweepZCodeManagedEntry(t); err != nil {
			return err
		}
	}
	return nil
}

// sweepZCodeManagedEntry removes only what AnyPick recognises from one config
// file, leaving every other provider and model the user configured alone.
func sweepZCodeManagedEntry(t zcodeTarget) error {
	if _, err := os.Stat(t.path); err != nil {
		return nil
	}
	doc, err := readZCodeConfig(t.path)
	if err != nil {
		return err
	}
	providers, err := zcodeProviders(doc)
	if err != nil {
		return err
	}
	managed := false
	if _, ok := providers[zcodeManagedProviderID]; ok {
		delete(providers, zcodeManagedProviderID)
		managed = true
	}
	if len(providers) > 0 {
		pj, _ := json.Marshal(providers)
		doc["provider"] = pj
	} else {
		delete(doc, "provider")
	}
	if zcodeModelPointsAtProvider(doc) {
		delete(doc, "model")
		managed = true
	}
	if !managed {
		return nil
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(t.path, append(out, '\n'), 0o600)
}

// zcodeModelPointsAtProvider reports whether the top-level model selection
// still names the managed provider. ZCode stores it as a "provider/model"
// string in older files and as {main, lite} in zcode.config.v1.
func zcodeModelPointsAtProvider(doc map[string]json.RawMessage) bool {
	raw, ok := doc["model"]
	if !ok {
		return false
	}
	prefix := zcodeManagedProviderID + "/"
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.HasPrefix(s, prefix)
	}
	var obj struct {
		Main string `json:"main"`
		Lite string `json:"lite"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return strings.HasPrefix(obj.Main, prefix) || strings.HasPrefix(obj.Lite, prefix)
	}
	return false
}

func resetZCodeFile(file zcodeFileCheckpoint) error {
	if !file.FileExists {
		// AnyPick created this file; remove it rather than leaving a stub.
		if err := os.Remove(file.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	doc, err := readZCodeConfig(file.Path)
	if err != nil {
		return err
	}
	providers, err := zcodeProviders(doc)
	if err != nil {
		return err
	}
	if file.ProviderPresent && file.ProviderValue != nil {
		providers[zcodeManagedProviderID] = file.ProviderValue
	} else {
		delete(providers, zcodeManagedProviderID)
	}
	if len(providers) > 0 {
		pj, _ := json.Marshal(providers)
		doc["provider"] = pj
	} else {
		delete(doc, "provider")
	}
	if file.ModelPresent && file.ModelValue != nil {
		doc["model"] = file.ModelValue
	} else {
		delete(doc, "model")
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(file.Path, append(out, '\n'), 0o600)
}

func (a *zcodeAdapter) Inspect() (*InspectResult, error) {
	targets := zcodeTargets(a.home)
	res := &InspectResult{}
	managed := false
	selectionChanged := false
	// Report on every target, not just the first managed one: ConfigPaths is
	// what `anypick clients` shows the user, and stopping early would hide
	// the other file AnyPick writes.
	for _, t := range targets {
		res.ConfigPaths = append(res.ConfigPaths, t.path)
		if _, err := os.Stat(t.path); err != nil {
			continue
		}
		res.Present = true
		doc, err := readZCodeConfig(t.path)
		if err != nil {
			res.Issues = append(res.Issues, "ZCode config unreadable at "+t.path)
			continue
		}
		providers, perr := zcodeProviders(doc)
		if perr != nil {
			res.Issues = append(res.Issues, "ZCode provider map unreadable at "+t.path)
			continue
		}
		if _, ok := providers[zcodeManagedProviderID]; ok {
			managed = true
		}
		if t.flavor == zcodeFlavorCLI {
			var models map[string]string
			if json.Unmarshal(doc["model"], &models) == nil {
				if main := models["main"]; main != "" && !strings.HasPrefix(main, zcodeManagedProviderID+"/") {
					selectionChanged = true
				}
			}
		}
	}
	switch {
	case managed:
		res.Summary = "AnyPick provider configured"
	case !res.Present:
		res.Summary = "no ZCode config"
	default:
		res.Summary = "config present (no AnyPick provider)"
	}
	res.Native = !managed && !selectionChanged && len(res.Issues) == 0
	res.RoutingChanged = selectionChanged || (res.Native && res.Present)
	return res, nil
}
