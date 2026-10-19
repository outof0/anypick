package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// opencodeAdapter configures a multi-provider runtime through
// opencode.json(c) with an anypick-managed provider entry.
type opencodeAdapter struct{ home string }

func newOpenCode(home string) *opencodeAdapter { return &opencodeAdapter{home: home} }

const (
	opencodeManagedProviderID = "anypick-managed"
	opencodeRestoreFile       = "restore.json"
)

func (a *opencodeAdapter) ID() string   { return "opencode" }
func (a *opencodeAdapter) Name() string { return "OpenCode" }
func (a *opencodeAdapter) ShortName() string {
	return "OpenCode"
}

func (a *opencodeAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "opencode",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		RequiresDefaultModel:     true,
		ProtocolPreference:       transport.OpenAI,
	}
}

func openCodeConfigDir(home string) string {
	if home == liveHome() {
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return filepath.Join(xdg, "opencode")
		}
	}
	return filepath.Join(home, ".config", "opencode")
}

func openCodeCandidatePaths(home string) (string, string) {
	dir := openCodeConfigDir(home)
	return filepath.Join(dir, "opencode.json"), filepath.Join(dir, "opencode.jsonc")
}

func openCodeEffectiveConfigPath(home string) string {
	jsonPath, jsoncPath := openCodeCandidatePaths(home)
	if _, err := os.Stat(jsonPath); err == nil {
		return jsonPath
	}
	if _, err := os.Stat(jsoncPath); err == nil {
		return jsoncPath
	}
	return jsonPath
}

// OpenCodeConfigPaths reports the live OpenCode files Apply may write: the
// effective config plus the sidecar holding the proxy token.
// Shared with the runtime recovery journal so backup and apply cannot drift.
func OpenCodeConfigPaths(home string) []string {
	return []string{
		openCodeEffectiveConfigPath(home),
		filepath.Join(openCodeConfigDir(home), ".anypick-api-key"),
	}
}

// readOpenCodeConfig parses the live config, refusing to continue on garbage.
func readOpenCodeConfig(path string) (map[string]json.RawMessage, error) {
	doc := map[string]json.RawMessage{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return doc, nil
		}
		return nil, err
	}
	if uerr := json.Unmarshal(stripJsonc(raw), &doc); uerr != nil {
		return nil, anyerr.Newf(
			fmt.Sprintf("Refusing to overwrite unreadable OpenCode config at %s: %v", path, uerr),
			"CLIENT_CONFIG_INVALID")
	}
	return doc, nil
}

// stripJsonc normalizes JSONC: comments become spaces and trailing commas
// are dropped without touching string contents.
func stripJsonc(raw []byte) []byte {
	text := string(raw)
	var out strings.Builder
	inString, escaped, lineComment, blockComment := false, false, false, false
	for i := 0; i < len(text); i++ {
		char := text[i]
		var next byte
		if i+1 < len(text) {
			next = text[i+1]
		}
		switch {
		case lineComment:
			if char == '\n' || char == '\r' {
				lineComment = false
				out.WriteByte(char)
			} else {
				out.WriteByte(' ')
			}
		case blockComment:
			if char == '*' && next == '/' {
				blockComment = false
				out.WriteString("  ")
				i++
			} else if char == '\n' || char == '\r' {
				out.WriteByte(char)
			} else {
				out.WriteByte(' ')
			}
		case inString:
			out.WriteByte(char)
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
				inString = false
			}
		default:
			switch {
			case char == '"':
				inString = true
				out.WriteByte(char)
			case char == '/' && next == '/':
				lineComment = true
				out.WriteString("  ")
				i++
			case char == '/' && next == '*':
				blockComment = true
				out.WriteString("  ")
				i++
			default:
				out.WriteByte(char)
			}
		}
	}
	stripped := out.String()
	// Drop trailing commas before } or ] (outside strings — safe after strip).
	var cleaned strings.Builder
	for i := 0; i < len(stripped); i++ {
		c := stripped[i]
		if c == ',' {
			j := i + 1
			for j < len(stripped) && (stripped[j] == ' ' || stripped[j] == '\t' || stripped[j] == '\n' || stripped[j] == '\r') {
				j++
			}
			if j < len(stripped) && (stripped[j] == '}' || stripped[j] == ']') {
				continue
			}
		}
		cleaned.WriteByte(c)
	}
	return []byte(cleaned.String())
}

// endpointForOpenCode normalizes a base URL to end with /v1.
func endpointForOpenCode(endpoint string) string {
	e := strings.TrimSuffix(endpoint, "/")
	e = strings.TrimSuffix(e, "/v1")
	return e + "/v1"
}

type openCodeRestoreState struct {
	Version           int             `json:"version"`
	ConfigPath        string          `json:"configPath"`
	ProviderPresent   bool            `json:"providerPresent"`
	ProviderValue     json.RawMessage `json:"providerValue,omitempty"`
	ModelPresent      bool            `json:"modelPresent"`
	ModelValue        json.RawMessage `json:"modelValue,omitempty"`
	SmallModelPresent bool            `json:"smallModelPresent"`
	SmallModelValue   json.RawMessage `json:"smallModelValue,omitempty"`
}

func (a *opencodeAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	configPath := openCodeEffectiveConfigPath(targetHome)
	secretPath := filepath.Join(openCodeConfigDir(targetHome), ".anypick-api-key")
	restorePath := filepath.Join(ctx.AnyPickRoot, "clients", "opencode", opencodeRestoreFile)

	modelIDs := sourceModelIDs(ctx)
	defaultModel := selectedDefaultModel(ctx)
	if ctx.Endpoint == "" || defaultModel == "" || len(modelIDs) == 0 {
		return nil, anyerr.Newf(
			"OpenCode routing needs an endpoint and a selected default model.",
			"CLIENT_CONFIG_INVALID")
	}

	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: []string{configPath, secretPath, restorePath}}, nil
	}

	doc, err := readOpenCodeConfig(configPath)
	if err != nil {
		return nil, err
	}
	providers, err := openCodeProviders(doc)
	if err != nil {
		return nil, err
	}

	if ctx.IsolatedHome == "" {
		if _, statErr := os.Stat(restorePath); os.IsNotExist(statErr) {
			restore := openCodeRestoreState{
				Version:           1,
				ConfigPath:        configPath,
				ProviderPresent:   providers[opencodeManagedProviderID] != nil,
				ModelPresent:      doc["model"] != nil,
				SmallModelPresent: doc["small_model"] != nil,
			}
			if v, ok := providers[opencodeManagedProviderID]; ok {
				restore.ProviderValue = v
			}
			if v, ok := doc["model"]; ok {
				restore.ModelValue = v
			}
			if v, ok := doc["small_model"]; ok {
				restore.SmallModelValue = v
			}
			rj, _ := json.MarshalIndent(restore, "", "  ")
			if mkErr := os.MkdirAll(filepath.Dir(restorePath), 0o700); mkErr == nil {
				// Checkpoint under our own root; atomic like every write.
				_ = atomicfile.Write(restorePath, append(rj, '\n'), 0o600)
			}
		}
	}

	if mkErr := os.MkdirAll(openCodeConfigDir(targetHome), 0o700); mkErr != nil {
		return nil, mkErr
	}
	apiKey := ctx.APIKey
	if apiKey == "" {
		apiKey = "anypick-proxy"
	}
	// secretPath is a live credential file (ADR 0004): rename, not truncate.
	if wErr := atomicfile.Write(secretPath, []byte(apiKey), 0o600); wErr != nil {
		return nil, wErr
	}

	models := map[string]interface{}{}
	for _, id := range modelIDs {
		models[id] = map[string]string{"name": id}
	}
	entry := map[string]interface{}{
		"npm":  "@ai-sdk/openai-compatible",
		"name": "AnyPick",
		"options": map[string]interface{}{
			"baseURL": endpointForOpenCode(ctx.Endpoint),
			"apiKey":  fmt.Sprintf("{file:%s}", secretPath),
		},
		"models": models,
	}
	ej, _ := json.Marshal(entry)
	providers[opencodeManagedProviderID] = ej
	pj, _ := json.Marshal(providers)
	doc["provider"] = pj
	doc["model"], _ = json.Marshal(opencodeManagedProviderID + "/" + defaultModel)

	out, err := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if err != nil {
		return nil, err
	}
	// configPath is the user's live opencode.json (ADR 0004): rename, not truncate.
	if err := atomicfile.Write(configPath, append(out, '\n'), 0o600); err != nil {
		return nil, err
	}
	managedPaths := []string{configPath, secretPath}
	if ctx.IsolatedHome == "" {
		managedPaths = append(managedPaths, restorePath)
	}
	return &ApplyResult{ManagedPaths: managedPaths}, nil
}

// openCodeProviders extracts doc.provider as raw entries keyed by provider id.
func openCodeProviders(doc map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	raw, ok := doc["provider"]
	if !ok || string(raw) == "null" {
		return map[string]json.RawMessage{}, nil
	}
	m := map[string]json.RawMessage{}
	if json.Unmarshal(raw, &m) != nil {
		return nil, anyerr.Newf("OpenCode config.provider must be an object.", "CLIENT_CONFIG_INVALID")
	}
	return m, nil
}

func (a *opencodeAdapter) Reset() error {
	state, err := a.unroute(true)
	if err != nil {
		return err
	}
	if state == nil {
		return nil
	}
	// The effective config path can flip between opencode.json and
	// opencode.jsonc across activations. A checkpoint naming the other file
	// must not leave a managed entry behind there.
	current := openCodeEffectiveConfigPath(a.home)
	if state.ConfigPath == "" || state.ConfigPath == current {
		return nil
	}
	if err := sweepOpenCodeManagedEntry(state.ConfigPath); err != nil {
		return err
	}
	oldSecret := filepath.Join(filepath.Dir(state.ConfigPath), ".anypick-api-key")
	if filepath.Dir(oldSecret) != openCodeConfigDir(a.home) {
		_ = os.Remove(oldSecret)
	}
	return nil
}

// RestoreNative unroutes a proxy binding when activation switches back to a
// native account. Unlike Reset it keeps the checkpoint: a later Reset must
// still restore the exact pre-proxy state.
func (a *opencodeAdapter) RestoreNative() error {
	_, err := a.unroute(false)
	return err
}

// unroute removes the managed provider, selection and secret from the
// effective config. It returns the checkpoint when one exists and is usable;
// consume deletes it (Reset), while RestoreNative keeps it.
func (a *opencodeAdapter) unroute(consume bool) (*openCodeRestoreState, error) {
	configPath := openCodeEffectiveConfigPath(a.home)
	restorePath := filepath.Join(anyPickRootFallback(), "clients", "opencode", opencodeRestoreFile)

	doc, err := readOpenCodeConfig(configPath)
	if err != nil {
		return nil, err
	}
	providers, perr := openCodeProviders(doc)
	if perr != nil {
		return nil, perr
	}
	delete(providers, opencodeManagedProviderID)

	var state *openCodeRestoreState
	if raw, rerr := os.ReadFile(restorePath); rerr == nil {
		var restore openCodeRestoreState
		if json.Unmarshal(raw, &restore) == nil {
			state = &restore
			if restore.ProviderPresent && restore.ProviderValue != nil {
				providers[opencodeManagedProviderID] = restore.ProviderValue
			}
			if restore.ModelPresent && restore.ModelValue != nil {
				doc["model"] = restore.ModelValue
			} else {
				delete(doc, "model")
			}
			if restore.SmallModelPresent && restore.SmallModelValue != nil {
				doc["small_model"] = restore.SmallModelValue
			} else {
				delete(doc, "small_model")
			}
			if consume {
				_ = os.Remove(restorePath)
			}
		}
	} else if v, ok := doc["model"]; ok {
		var s string
		if json.Unmarshal(v, &s) == nil && strings.HasPrefix(s, opencodeManagedProviderID+"/") {
			delete(doc, "model")
		}
	}

	if len(providers) > 0 {
		pj, _ := json.Marshal(providers)
		doc["provider"] = pj
	} else {
		delete(doc, "provider")
	}
	out, jerr := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if jerr != nil {
		return nil, jerr
	}
	// configPath is the user's live opencode.json (ADR 0004): rename, not truncate.
	if err := atomicfile.Write(configPath, append(out, '\n'), 0o600); err != nil {
		return nil, err
	}
	_ = os.Remove(filepath.Join(openCodeConfigDir(a.home), ".anypick-api-key"))
	return state, nil
}

// sweepOpenCodeManagedEntry removes a managed provider left in a config file
// AnyPick no longer targets (see Reset). Best-effort: a missing file is not
// an error, but an unreadable one fails closed.
func sweepOpenCodeManagedEntry(path string) error {
	doc, err := readOpenCodeConfig(path)
	if err != nil {
		return err
	}
	providers, perr := openCodeProviders(doc)
	if perr != nil {
		return perr
	}
	managed := false
	if _, ok := providers[opencodeManagedProviderID]; ok {
		delete(providers, opencodeManagedProviderID)
		managed = true
	}
	if v, ok := doc["model"]; ok {
		var s string
		if json.Unmarshal(v, &s) == nil && strings.HasPrefix(s, opencodeManagedProviderID+"/") {
			delete(doc, "model")
			managed = true
		}
	}
	if v, ok := doc["small_model"]; ok {
		var s string
		if json.Unmarshal(v, &s) == nil && strings.HasPrefix(s, opencodeManagedProviderID+"/") {
			delete(doc, "small_model")
			managed = true
		}
	}
	if !managed {
		return nil
	}
	if len(providers) > 0 {
		pj, _ := json.Marshal(providers)
		doc["provider"] = pj
	} else {
		delete(doc, "provider")
	}
	out, jerr := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if jerr != nil {
		return jerr
	}
	// RestoreNative rewrites the user's live config (ADR 0004): rename, not truncate.
	return atomicfile.Write(path, append(out, '\n'), 0o600)
}

// Compile-time: the direct-account unroute path above must keep working.
var _ NativeRestorer = (*opencodeAdapter)(nil)

func (a *opencodeAdapter) Inspect() (*InspectResult, error) {
	configPath := openCodeEffectiveConfigPath(a.home)
	if _, err := os.Stat(configPath); err != nil {
		if os.IsNotExist(err) {
			return &InspectResult{Native: true}, nil
		}
		return nil, err
	}
	res := &InspectResult{Present: true}
	doc, err := readOpenCodeConfig(configPath)
	if err != nil || doc == nil {
		res.Issues = []string{"OpenCode config unreadable"}
		return res, nil
	}
	providers, perr := openCodeProviders(doc)
	if perr == nil {
		selected := stringField(doc, "model")
		selectedProvider := strings.SplitN(selected, "/", 2)[0]
		res.Native = selectedProvider != opencodeManagedProviderID
		if selected == "" {
			_, managed := providers[opencodeManagedProviderID]
			res.Native = !managed
		}
		_, hasManaged := providers[opencodeManagedProviderID]
		res.RoutingChanged = !hasManaged || (selected != "" && selectedProvider != opencodeManagedProviderID)
		if rawProvider, ok := providers[selectedProvider]; ok {
			var custom struct {
				Options struct {
					BaseURL string          `json:"baseURL"`
					APIKey  json.RawMessage `json:"apiKey"`
				} `json:"options"`
			}
			if json.Unmarshal(rawProvider, &custom) != nil || custom.Options.BaseURL != "" || len(custom.Options.APIKey) > 0 {
				res.Native = false
			}
		}
		if _, managed := providers[opencodeManagedProviderID]; managed {
			res.Summary = "AnyPick provider configured"
		} else {
			res.Summary = "config present (no AnyPick provider)"
		}
	}
	return res, nil
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
