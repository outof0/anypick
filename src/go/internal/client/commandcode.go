package client

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// commandCodeAdapter configures Command Code's documented BYOK provider
// surface. Command Code is an OpenAI-compatible client: the provider entry
// points at AnyPick's loopback proxy, while the key lives in auth.json where
// Command Code expects managed provider credentials.
type commandCodeAdapter struct{ home string }

func newCommandCode(home string) *commandCodeAdapter { return &commandCodeAdapter{home: home} }

const (
	commandCodeManagedProviderID = "anypick-managed"
	commandCodeRestoreFile       = "restore.json"
)

func (a *commandCodeAdapter) ID() string         { return "commandcode" }
func (a *commandCodeAdapter) Name() string       { return "Command Code" }
func (a *commandCodeAdapter) ShortName() string  { return "Command Code" }
func (a *commandCodeAdapter) Executable() string { return "cmd" }

func (a *commandCodeAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "commandcode",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		RequiresDefaultModel:     true,
		ProtocolPreference:       transport.OpenAI,
	}
}

func commandCodeDir(home string) string {
	return filepath.Join(home, ".commandcode")
}

func commandCodeProvidersPath(home string) string {
	return filepath.Join(commandCodeDir(home), "providers.json")
}

func commandCodeAuthPath(home string) string {
	return filepath.Join(commandCodeDir(home), "auth.json")
}

func commandCodeConfigPath(home string) string {
	return filepath.Join(commandCodeDir(home), "config.json")
}

func commandCodePaths(home string) []string {
	return []string{
		commandCodeProvidersPath(home),
		commandCodeAuthPath(home),
		commandCodeConfigPath(home),
	}
}

// CommandCodeConfigPaths reports every live file this adapter writes. The
// runtime recovery journal uses the same list so backup and apply cannot drift.
func CommandCodeConfigPaths(home string) []string {
	return commandCodePaths(home)
}

func commandCodeTargetHome(ctx *ApplyContext) string {
	target := ctx.Home
	if ctx.IsolatedHome != "" {
		target = ctx.IsolatedHome
	}
	if target == "" {
		target = liveHome()
	}
	return target
}

// readCommandCodeObject parses one of Command Code's JSON documents. A
// malformed user file is never replaced with an empty object: credentials and
// provider definitions are user-owned state.
func readCommandCodeObject(path, label string) (map[string]json.RawMessage, bool, error) {
	doc := map[string]json.RawMessage{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return doc, false, nil
		}
		return nil, false, err
	}
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		return nil, false, anyerr.Newf(
			fmt.Sprintf("Refusing to overwrite unreadable Command Code %s at %s.", label, path),
			"CLIENT_CONFIG_INVALID")
	}
	return doc, true, nil
}

// commandCodeProviders accepts both spellings emitted by Command Code
// versions in the wild. New files use the documented singular "provider".
func commandCodeProviders(doc map[string]json.RawMessage) (map[string]json.RawMessage, string, bool, error) {
	container := "provider"
	raw, present := doc[container]
	if !present {
		if candidate, ok := doc["providers"]; ok {
			container = "providers"
			raw = candidate
			present = true
		}
	}
	if !present || string(raw) == "null" {
		return map[string]json.RawMessage{}, container, present, nil
	}
	providers := map[string]json.RawMessage{}
	if json.Unmarshal(raw, &providers) != nil {
		return nil, "", false, anyerr.Newf(
			"Command Code providers.json provider must be an object.",
			"CLIENT_CONFIG_INVALID")
	}
	return providers, container, true, nil
}

func commandCodeBaseURL(endpoint string) string {
	base := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	base = strings.TrimSuffix(base, "/v1")
	return base + "/v1"
}

func commandCodeModelIDs(ctx *ApplyContext) []string {
	ids := make([]string, 0, len(ctx.ModelCatalog)+len(ctx.ModelRoles)+1)
	seen := map[string]bool{}
	push := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		// A persisted route may have been written by another OpenAI-compatible
		// client. Avoid creating anypick-managed/anypick-managed/<id> when it is
		// reused for Command Code.
		value = strings.TrimPrefix(value, commandCodeManagedProviderID+"/")
		if seen[value] {
			return
		}
		seen[value] = true
		ids = append(ids, value)
	}
	for _, id := range ctx.ModelCatalog {
		push(id)
	}
	push(selectedDefaultModel(ctx))
	for _, role := range sortedKeys(ctx.ModelRoles) {
		if role != "default" {
			push(ctx.ModelRoles[role])
		}
	}
	return dedupeStrings(ids)
}

func commandCodeProviderEntry(endpoint string, modelIDs []string) (json.RawMessage, error) {
	models := map[string]interface{}{}
	for _, id := range modelIDs {
		// `{}` is a complete model declaration in Command Code. The display
		// name keeps the provider picker useful without inventing capabilities
		// such as context size or reasoning support.
		models[id] = map[string]string{}
	}
	entry := map[string]interface{}{
		"name":    "AnyPick",
		"api":     "openai-completions",
		"baseURL": commandCodeBaseURL(endpoint),
		// Raw secrets are rejected by Command Code's providers parser. The
		// stored auth.json credential below wins over this keyless marker.
		"apiKey": false,
		"models": models,
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

type commandCodeRestoreState struct {
	Version int `json:"version"`

	ProvidersPath            string          `json:"providersPath"`
	ProvidersFilePresent     bool            `json:"providersFilePresent"`
	ProviderContainer        string          `json:"providerContainer"`
	ProviderContainerPresent bool            `json:"providerContainerPresent"`
	ProviderPresent          bool            `json:"providerPresent"`
	ProviderValue            json.RawMessage `json:"providerValue,omitempty"`

	AuthPath        string          `json:"authPath"`
	AuthFilePresent bool            `json:"authFilePresent"`
	AuthPresent     bool            `json:"authPresent"`
	AuthValue       json.RawMessage `json:"authValue,omitempty"`

	ConfigPath           string          `json:"configPath"`
	ConfigFilePresent    bool            `json:"configFilePresent"`
	ModelPresent         bool            `json:"modelPresent"`
	ModelValue           json.RawMessage `json:"modelValue,omitempty"`
	ModelProviderPresent bool            `json:"modelProviderPresent"`
	ModelProviderValue   json.RawMessage `json:"modelProviderValue,omitempty"`
}

type commandCodeApplyState struct {
	providersPath, authPath, configPath string
	providersDoc, authDoc, configDoc    map[string]json.RawMessage
	providers                           map[string]json.RawMessage
	providerContainer                   string
	providerContainerPresent            bool
	providersFilePresent                bool
	authFilePresent                     bool
	configFilePresent                   bool
}

func readCommandCodeApplyState(home string) (*commandCodeApplyState, error) {
	paths := commandCodePaths(home)
	providersDoc, providersPresent, err := readCommandCodeObject(paths[0], "providers.json")
	if err != nil {
		return nil, err
	}
	authDoc, authPresent, err := readCommandCodeObject(paths[1], "auth.json")
	if err != nil {
		return nil, err
	}
	configDoc, configPresent, err := readCommandCodeObject(paths[2], "config.json")
	if err != nil {
		return nil, err
	}
	providers, container, containerPresent, err := commandCodeProviders(providersDoc)
	if err != nil {
		return nil, err
	}
	return &commandCodeApplyState{
		providersPath:            paths[0],
		authPath:                 paths[1],
		configPath:               paths[2],
		providersDoc:             providersDoc,
		authDoc:                  authDoc,
		configDoc:                configDoc,
		providers:                providers,
		providerContainer:        container,
		providerContainerPresent: containerPresent,
		providersFilePresent:     providersPresent,
		authFilePresent:          authPresent,
		configFilePresent:        configPresent,
	}, nil
}

func (a *commandCodeAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := commandCodeTargetHome(ctx)
	providersPath := commandCodeProvidersPath(targetHome)
	authPath := commandCodeAuthPath(targetHome)
	configPath := commandCodeConfigPath(targetHome)
	restorePath := filepath.Join(ctx.AnyPickRoot, "clients", "commandcode", commandCodeRestoreFile)

	modelIDs := commandCodeModelIDs(ctx)
	if strings.TrimSpace(ctx.Endpoint) == "" || selectedDefaultModel(ctx) == "" || len(modelIDs) == 0 {
		return nil, anyerr.Newf(
			"Command Code routing needs an endpoint and a selected default model.",
			"CLIENT_CONFIG_INVALID")
	}

	managedPaths := []string{providersPath, authPath, configPath}
	if ctx.IsolatedHome == "" && ctx.AnyPickRoot != "" {
		managedPaths = append(managedPaths, restorePath)
	}
	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: managedPaths}, nil
	}

	state, err := readCommandCodeApplyState(targetHome)
	if err != nil {
		return nil, err
	}
	entry, err := commandCodeProviderEntry(ctx.Endpoint, modelIDs)
	if err != nil {
		return nil, err
	}
	apiKey := ctx.APIKey
	if apiKey == "" {
		apiKey = "anypick-proxy"
	}
	authEntry, err := json.Marshal(map[string]interface{}{
		"type": "api",
		"key":  apiKey,
	})
	if err != nil {
		return nil, err
	}
	if err := checkpointCommandCode(ctx, restorePath, state); err != nil {
		return nil, err
	}
	if err := writeCommandCodeRouting(state, entry, authEntry, selectedDefaultModel(ctx)); err != nil {
		return nil, err
	}
	return &ApplyResult{ManagedPaths: managedPaths}, nil
}

func checkpointCommandCode(ctx *ApplyContext, restorePath string, state *commandCodeApplyState) error {
	if ctx.IsolatedHome != "" || ctx.AnyPickRoot == "" {
		return nil
	}
	checkpoint := commandCodeRestoreState{
		Version:                  1,
		ProvidersPath:            state.providersPath,
		ProvidersFilePresent:     state.providersFilePresent,
		ProviderContainer:        state.providerContainer,
		ProviderContainerPresent: state.providerContainerPresent,
		ProviderPresent:          state.providers[commandCodeManagedProviderID] != nil,
		AuthPath:                 state.authPath,
		AuthFilePresent:          state.authFilePresent,
		AuthPresent:              state.authDoc[commandCodeManagedProviderID] != nil,
		ConfigPath:               state.configPath,
		ConfigFilePresent:        state.configFilePresent,
		ModelPresent:             state.configDoc["model"] != nil,
		ModelProviderPresent:     state.configDoc["modelProvider"] != nil,
		ProviderValue:            state.providers[commandCodeManagedProviderID],
		AuthValue:                state.authDoc[commandCodeManagedProviderID],
		ModelValue:               state.configDoc["model"],
		ModelProviderValue:       state.configDoc["modelProvider"],
	}
	return writeCommandCodeRestore(restorePath, checkpoint)
}

func writeCommandCodeRouting(state *commandCodeApplyState, entry, authEntry json.RawMessage, modelID string) error {
	state.providers[commandCodeManagedProviderID] = entry
	providerJSON, err := json.Marshal(state.providers)
	if err != nil {
		return err
	}
	state.providersDoc[state.providerContainer] = providerJSON
	state.authDoc[commandCodeManagedProviderID] = authEntry
	state.configDoc["model"], err = json.Marshal(commandCodeManagedProviderID + "/" + modelID)
	if err != nil {
		return err
	}
	if err := writeCommandCodeJSON(state.providersPath, state.providersDoc); err != nil {
		return err
	}
	if err := writeCommandCodeJSON(state.authPath, state.authDoc); err != nil {
		return err
	}
	return writeCommandCodeJSON(state.configPath, state.configDoc)
}

func writeCommandCodeRestore(path string, state commandCodeRestoreState) error {
	if raw, err := os.ReadFile(path); err == nil {
		var existing commandCodeRestoreState
		if json.Unmarshal(raw, &existing) != nil || existing.Version != 1 {
			return anyerr.Newf(
				"Refusing to overwrite unreadable Command Code restore state at "+path+".",
				"CLIENT_CONFIG_INVALID")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, append(raw, '\n'), 0o600)
}

func writeCommandCodeJSON(path string, doc map[string]json.RawMessage) error {
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	perm := os.FileMode(0o600)
	if info, statErr := os.Stat(path); statErr == nil {
		perm = info.Mode().Perm()
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	return atomicfile.Write(path, append(raw, '\n'), perm)
}

func removeOrWriteCommandCodeJSON(path string, doc map[string]json.RawMessage, originallyPresent bool) error {
	if !originallyPresent && len(doc) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeCommandCodeJSON(path, doc)
}

func (a *commandCodeAdapter) Reset() error {
	home := a.home
	if home == "" {
		home = liveHome()
	}
	paths := commandCodePaths(home)
	restorePath := filepath.Join(anyPickRootFallback(), "clients", "commandcode", commandCodeRestoreFile)
	if raw, err := os.ReadFile(restorePath); err == nil {
		var state commandCodeRestoreState
		if json.Unmarshal(raw, &state) == nil && state.Version == 1 {
			if err := resetCommandCodeFromRestore(state, paths); err != nil {
				return err
			}
			return os.Remove(restorePath)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return removeCommandCodeManaged(paths)
}

func resetCommandCodeFromRestore(state commandCodeRestoreState, fallback []string) error {
	providersPath, authPath, configPath := fallback[0], fallback[1], fallback[2]
	if state.ProvidersPath != "" {
		providersPath = state.ProvidersPath
	}
	if state.AuthPath != "" {
		authPath = state.AuthPath
	}
	if state.ConfigPath != "" {
		configPath = state.ConfigPath
	}

	providersDoc, _, err := readCommandCodeObject(providersPath, "providers.json")
	if err != nil {
		return err
	}
	providers, container, _, err := commandCodeProviders(providersDoc)
	if err != nil {
		return err
	}
	if state.ProviderContainer != "" {
		container = state.ProviderContainer
	}
	if state.ProviderPresent && state.ProviderValue != nil {
		providers[commandCodeManagedProviderID] = state.ProviderValue
	} else {
		delete(providers, commandCodeManagedProviderID)
	}
	if len(providers) > 0 || state.ProviderContainerPresent {
		encoded, marshalErr := json.Marshal(providers)
		if marshalErr != nil {
			return marshalErr
		}
		providersDoc[container] = encoded
	} else {
		delete(providersDoc, container)
	}
	if err := removeOrWriteCommandCodeJSON(providersPath, providersDoc, state.ProvidersFilePresent); err != nil {
		return err
	}

	authDoc, _, err := readCommandCodeObject(authPath, "auth.json")
	if err != nil {
		return err
	}
	if state.AuthPresent && state.AuthValue != nil {
		authDoc[commandCodeManagedProviderID] = state.AuthValue
	} else {
		delete(authDoc, commandCodeManagedProviderID)
	}
	if err := removeOrWriteCommandCodeJSON(authPath, authDoc, state.AuthFilePresent); err != nil {
		return err
	}

	configDoc, _, err := readCommandCodeObject(configPath, "config.json")
	if err != nil {
		return err
	}
	if state.ModelPresent && state.ModelValue != nil {
		configDoc["model"] = state.ModelValue
	} else {
		delete(configDoc, "model")
	}
	if state.ModelProviderPresent && state.ModelProviderValue != nil {
		configDoc["modelProvider"] = state.ModelProviderValue
	} else {
		delete(configDoc, "modelProvider")
	}
	return removeOrWriteCommandCodeJSON(configPath, configDoc, state.ConfigFilePresent)
}

func removeCommandCodeManaged(paths []string) error {
	providersDoc, providersPresent, err := readCommandCodeObject(paths[0], "providers.json")
	if err != nil {
		return err
	}
	providers, container, _, err := commandCodeProviders(providersDoc)
	if err != nil {
		return err
	}
	delete(providers, commandCodeManagedProviderID)
	if len(providers) > 0 {
		encoded, marshalErr := json.Marshal(providers)
		if marshalErr != nil {
			return marshalErr
		}
		providersDoc[container] = encoded
	} else {
		delete(providersDoc, container)
	}
	if err := removeOrWriteCommandCodeJSON(paths[0], providersDoc, providersPresent); err != nil {
		return err
	}

	authDoc, authPresent, err := readCommandCodeObject(paths[1], "auth.json")
	if err != nil {
		return err
	}
	delete(authDoc, commandCodeManagedProviderID)
	if err := removeOrWriteCommandCodeJSON(paths[1], authDoc, authPresent); err != nil {
		return err
	}

	configDoc, configPresent, err := readCommandCodeObject(paths[2], "config.json")
	if err != nil {
		return err
	}
	if model, ok := configDoc["model"]; ok {
		var value string
		if json.Unmarshal(model, &value) == nil && strings.HasPrefix(value, commandCodeManagedProviderID+"/") {
			delete(configDoc, "model")
		}
	}
	if provider, ok := configDoc["modelProvider"]; ok {
		var value string
		if json.Unmarshal(provider, &value) == nil && value == commandCodeManagedProviderID {
			delete(configDoc, "modelProvider")
		}
	}
	return removeOrWriteCommandCodeJSON(paths[2], configDoc, configPresent)
}

func (a *commandCodeAdapter) Inspect() (*InspectResult, error) {
	home := a.home
	if home == "" {
		home = liveHome()
	}
	paths := commandCodePaths(home)
	res := &InspectResult{ConfigPaths: paths}
	managed := false
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		res.Present = true
	}
	providersDoc, _, err := readCommandCodeObject(paths[0], "providers.json")
	if err != nil {
		res.Issues = append(res.Issues, "Command Code providers.json is unreadable")
	} else if providers, _, _, providerErr := commandCodeProviders(providersDoc); providerErr == nil {
		if _, ok := providers[commandCodeManagedProviderID]; ok {
			managed = true
		}
	}
	authDoc, _, err := readCommandCodeObject(paths[1], "auth.json")
	if err != nil {
		res.Issues = append(res.Issues, "Command Code auth.json is unreadable")
	} else if _, ok := authDoc[commandCodeManagedProviderID]; ok {
		managed = true
	}
	configDoc, _, err := readCommandCodeObject(paths[2], "config.json")
	if err != nil {
		res.Issues = append(res.Issues, "Command Code config.json is unreadable")
	} else if raw, ok := configDoc["model"]; ok {
		var model string
		if json.Unmarshal(raw, &model) == nil && strings.HasPrefix(model, commandCodeManagedProviderID+"/") {
			managed = true
		}
	}
	switch {
	case !res.Present:
		res.Summary = "no Command Code config"
	case managed:
		res.Summary = "AnyPick provider configured"
	default:
		res.Summary = "config present (no AnyPick provider)"
	}
	if config, _, err := readCommandCodeObject(paths[2], "config.json"); err == nil {
		selected := stringField(config, "modelProvider")
		model := stringField(config, "model")
		res.RoutingChanged = (selected != "" && selected != commandCodeManagedProviderID) ||
			(strings.Contains(model, "/") && !strings.HasPrefix(model, commandCodeManagedProviderID+"/"))
	}
	return res, nil
}

// CreateEphemeralRuntime gives `anypick run commandcode` a fresh HOME. This
// is deliberately implemented by the adapter instead of a runtime switch so
// Command Code's native paths remain owned by one package.
func (a *commandCodeAdapter) CreateEphemeralRuntime(_ context.Context, input *EphemeralContext) (*IsolatedRuntime, error) {
	if input == nil {
		input = &EphemeralContext{}
	}
	root, err := os.MkdirTemp("", "anypick-commandcode-")
	if err != nil {
		return nil, err
	}
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	// Preserve non-routing preferences, but never copy auth.json: a child
	// invoked through AnyPick only needs the managed provider credential.
	if input.Home != "" {
		if err := copyCommandCodeFile(commandCodeConfigPath(input.Home), commandCodeConfigPath(home)); err != nil {
			_ = os.RemoveAll(root)
			return nil, err
		}
	}
	if _, err := a.Apply(&ApplyContext{
		Endpoint:     input.Endpoint,
		APIKey:       input.APIKey,
		DefaultModel: input.DefaultModel,
		ModelRoles:   input.ModelRoles,
		ModelCatalog: input.ModelCatalog,
		AnyPickRoot:  input.AnyPickRoot,
		Home:         input.Home,
		IsolatedHome: home,
	}); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	return NewIsolatedRuntime(
		root,
		home,
		map[string]string{"HOME": home},
		nil,
		func() error { return os.RemoveAll(root) },
	), nil
}

func copyCommandCodeFile(src, dst string) error {
	raw, err := os.ReadFile(src)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return atomicfile.Write(dst, raw, 0o600)
}

// Keep the compile-time assertion close to the adapter: a future refactor
// must not silently lose isolated-run support while retaining the capability.
var _ EphemeralAdapter = (*commandCodeAdapter)(nil)
var _ ExecutableAdapter = (*commandCodeAdapter)(nil)
