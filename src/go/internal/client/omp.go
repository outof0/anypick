package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// ompAdapter configures omp (@oh-my-pi/pi-coding-agent), the IDE-wired coding
// agent. omp reads provider overrides from <agentDir>/models.yml — a
// `providers:` mapping where each entry may set baseUrl/apiKey/api/models —
// and keeps credentials in a local SQLite store AnyPick must not parse.
// Pointing omp at AnyPick therefore means upserting one managed "anypick"
// provider entry and setting the default model in config.yml.
type ompAdapter struct{ home string }

func newOmp(home string) *ompAdapter { return &ompAdapter{home: home} }

const (
	// ompManagedProviderID is the single provider entry AnyPick owns inside
	// the user's models.yml. A user-owned entry under the same id is
	// refused, never silently kept: two mapping keys would make omp fail
	// its boot loud.
	ompManagedProviderID = "anypick"
	ompManagedAPI        = "openai-completions"
	ompRestoreFile       = "omp-restore.json"

	ompModelsBegin    = "# anypick:omp -- managed by AnyPick, do not edit --"
	ompModelsEnd      = "# anypick:omp:end"
	ompConfigBegin    = "# anypick:omp:config -- managed by AnyPick, do not edit --"
	ompConfigEnd      = "# anypick:omp:config:end"
	ompPreProxyPrefix = "# anypick:pre-proxy: "
)

func (a *ompAdapter) ID() string   { return "omp" }
func (a *ompAdapter) Name() string { return "Omp" }
func (a *ompAdapter) ShortName() string {
	return "Omp"
}

func (a *ompAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "omp",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		RequiresDefaultModel:     true,
		ProtocolPreference:       transport.OpenAI,
	}
}

// ompAgentDir resolves the harness agent directory: ~/.omp/agent in default
// setups (profiles live beside it; the default profile has no extra path
// segment). An isolated run never reaches the live tree because Apply targets
// IsolatedHome instead.
func ompAgentDir(home string) string {
	return filepath.Join(home, ".omp", "agent")
}

func ompModelsPath(home string) string { return filepath.Join(ompAgentDir(home), "models.yml") }
func ompConfigPath(home string) string { return filepath.Join(ompAgentDir(home), "config.yml") }

// OmpConfigPaths reports the live harness files Apply may write: models.yml
// carries the managed provider entry, and config.yml carries the default model
// and provider selection. Shared with the runtime recovery journal so backup
// and apply cannot drift.
func OmpConfigPaths(home string) []string {
	return []string{ompModelsPath(home), ompConfigPath(home)}
}

func (a *ompAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	if ctx.Endpoint == "" {
		return nil, anyerr.Newf(
			"Omp routing needs an endpoint.",
			"CLIENT_CONFIG_INVALID")
	}
	baseURL := strings.TrimSuffix(ctx.Endpoint, "/") + "/v1"

	modelIDs := sourceModelIDs(ctx)
	defaultModel := selectedDefaultModel(ctx)
	if defaultModel == "" && len(modelIDs) > 0 {
		defaultModel = modelIDs[0]
	}

	if ctx.DryRun {
		paths := []string{ompModelsPath(targetHome)}
		if defaultModel != "" {
			paths = append(paths, ompConfigPath(targetHome))
		}
		return &ApplyResult{ManagedPaths: paths}, nil
	}

	raw, err := os.ReadFile(ompModelsPath(targetHome))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	merged, err := ompModelsWithProvider(string(raw), baseURL,
		firstNonEmpty(ctx.APIKey, "anypick-proxy"), modelIDs)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(ompAgentDir(targetHome), 0o700); err != nil {
		return nil, err
	}
	// The entry carries the proxy token: force 0600 even when the user file
	// arrived more permissive.
	if err := atomicfile.Write(ompModelsPath(targetHome), []byte(merged), 0o600); err != nil {
		return nil, err
	}

	managedPaths := []string{ompModelsPath(targetHome)}
	if defaultModel != "" {
		if ctx.IsolatedHome == "" {
			if err := checkpointOmpRestore(ctx.AnyPickRoot, ompConfigPath(targetHome)); err != nil {
				return nil, err
			}
		}
		cfgRaw, err := os.ReadFile(ompConfigPath(targetHome))
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		cfgMerged, err := ompConfigWithRouting(string(cfgRaw), defaultModel)
		if err != nil {
			return nil, err
		}
		perm := os.FileMode(0o600)
		if fi, err := os.Stat(ompConfigPath(targetHome)); err == nil {
			perm = fi.Mode().Perm()
		}
		if err := atomicfile.Write(ompConfigPath(targetHome), []byte(cfgMerged), perm); err != nil {
			return nil, err
		}
		managedPaths = append(managedPaths, ompConfigPath(targetHome))
	}
	return &ApplyResult{ManagedPaths: managedPaths}, nil
}

// ompModelsWithProvider upserts the managed provider block under the
// top-level providers: mapping, preserving every other line. A user-owned
// `anypick:` entry without our markers is refused instead of duplicated: two
// mapping keys would make omp fail its boot loud.
func ompModelsWithProvider(existing, baseURL, apiKey string, modelIDs []string) (string, error) {
	stripped, err := stripMarkedBlock(existing, ompModelsBegin, ompModelsEnd, "models.yml")
	if err != nil {
		return "", err
	}
	lines := strings.Split(stripped, "\n")
	providersIdx := -1
	for i, line := range lines {
		if ompIsTopLevelKey(line, "providers") {
			providersIdx = i
			break
		}
	}
	if providersIdx >= 0 {
		rest := strings.Join(lines[providersIdx+1:], "\n")
		if ompHasForeignAnypickKey(rest) {
			return "", anyerr.Newf(
				"Your models.yml already has its own anypick: provider section; "+
					"remove it or point it at the proxy before AnyPick manages the connection.",
				"CLIENT_CONFIG_INVALID")
		}
		if ompProvidersValueInline(lines[providersIdx]) {
			return "", anyerr.Newf(
				"Your models.yml declares providers: inline; expand it to a mapping "+
					"before AnyPick manages the connection.",
				"CLIENT_CONFIG_INVALID")
		}
	}
	var out []string
	if providersIdx < 0 {
		if strings.TrimSpace(stripped) != "" {
			out = append(out, strings.TrimRight(stripped, "\n"), "")
		}
		out = append(out, "providers:")
	} else {
		out = append(out, lines[:providersIdx+1]...)
	}
	out = append(out, ompProviderBlock(baseURL, apiKey, modelIDs)...)
	if providersIdx >= 0 {
		out = append(out, lines[providersIdx+1:]...)
	}
	return strings.Join(out, "\n"), nil
}

// ompIsTopLevelKey reports whether the line declares key at the document's
// top level. Indented lines are children of another key and never match.
func ompIsTopLevelKey(line, key string) bool {
	if len(line) != len(strings.TrimLeft(line, " \t")) {
		return false
	}
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return false
	}
	for _, quote := range []string{"", `"`, `'`} {
		if strings.HasPrefix(trimmed, quote+key+quote+":") {
			return true
		}
	}
	return false
}

// ompHasForeignAnypickKey reports an `anypick:` mapping key at providers
// depth (exactly one indent level) that our markers did not delimit.
func ompHasForeignAnypickKey(rest string) bool {
	for _, line := range strings.Split(rest, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		if indent == 0 {
			return false
		}
		for _, quote := range []string{"", `"`, `'`} {
			if strings.HasPrefix(trimmed, quote+"anypick"+quote+":") {
				return true
			}
		}
	}
	return false
}

// ompProvidersValueInline reports a `providers:` line that already carries a
// value (`providers: []`, `providers: {...}`), which a block append cannot
// extend without rewriting user data.
func ompProvidersValueInline(line string) bool {
	trimmed := strings.TrimSpace(line)
	for _, quote := range []string{"", `"`, `'`} {
		prefix := quote + "providers" + quote + ":"
		if strings.HasPrefix(trimmed, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, prefix)) != ""
		}
	}
	return false
}

// ompProviderBlock renders the managed provider entry. Model ids come from a
// provider response; quoting keeps a value that contains YAML punctuation
// from changing the block's shape.
func ompProviderBlock(baseURL, apiKey string, modelIDs []string) []string {
	out := []string{"  " + ompModelsBegin}
	out = append(out, "  anypick:")
	out = append(out, "    baseUrl: "+baseURL)
	out = append(out, "    apiKey: "+apiKey)
	out = append(out, "    api: "+ompManagedAPI)
	seen := map[string]bool{}
	models := make([]string, 0, len(modelIDs))
	for _, id := range modelIDs {
		id = strings.TrimSpace(id)
		if id == "" || strings.ContainsAny(id, "\r\n") || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, id)
	}
	if len(models) > 0 {
		out = append(out, "    models:")
		for _, id := range models {
			out = append(out, "      - id: "+ompYAMLScalar(id))
		}
	}
	out = append(out, "  "+ompModelsEnd)
	return out
}

func ompYAMLScalar(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

type ompRestoreState struct {
	Version       int    `json:"version"`
	ConfigExisted bool   `json:"configExisted"`
	ConfigContent string `json:"configContent,omitempty"`
}

func checkpointOmpRestore(anyPickRoot string, configPath string) error {
	if anyPickRoot == "" {
		anyPickRoot = anyPickRootFallback()
	}
	restorePath := filepath.Join(anyPickRoot, "clients", "omp", ompRestoreFile)
	if _, err := os.Stat(restorePath); err == nil {
		return nil
	}
	state := ompRestoreState{Version: 1}
	if raw, err := os.ReadFile(configPath); err == nil {
		state.ConfigExisted = true
		state.ConfigContent = string(raw)
	} else if !os.IsNotExist(err) {
		return err
	}
	rj, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(restorePath), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(restorePath, append(rj, '\n'), 0o600)
}

func ompConfigWithRouting(existing, defaultModel string) (string, error) {
	stripped, err := stripMarkedBlock(existing, ompConfigBegin, ompConfigEnd, "config.yml")
	if err != nil {
		return "", err
	}
	lines := strings.Split(stripped, "\n")
	var out []string
	inModelRoles := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		if inModelRoles {
			if indent > 0 && trimmed != "" && !strings.HasPrefix(trimmed, "#") {
				out = append(out, ompPreProxyPrefix+line)
				continue
			}
			inModelRoles = false
		}
		if ompIsTopLevelKey(line, "defaultProvider") ||
			ompIsTopLevelKey(line, "defaultModel") ||
			ompIsTopLevelKey(line, "model") {
			out = append(out, ompPreProxyPrefix+line)
			continue
		}
		if ompIsTopLevelKey(line, "modelRoles") {
			out = append(out, ompPreProxyPrefix+line)
			inModelRoles = true
			continue
		}
		out = append(out, line)
	}

	for len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
		out = out[:len(out)-1]
	}
	if len(out) > 0 {
		out = append(out, "")
	}
	out = append(out, ompConfigBlock(defaultModel)...)
	return strings.Join(out, "\n") + "\n", nil
}

func ompConfigBlock(defaultModel string) []string {
	target := "anypick/" + defaultModel
	return []string{
		ompConfigBegin,
		"defaultProvider: anypick",
		"defaultModel: " + ompYAMLScalar(target),
		"model: " + ompYAMLScalar(target),
		"modelRoles:",
		"  default: " + ompYAMLScalar(target),
		ompConfigEnd,
	}
}

func ompConfigRemainderEmpty(content string) bool {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			return false
		}
	}
	return true
}

var _ NativeRestorer = (*ompAdapter)(nil)

func (a *ompAdapter) Reset() error {
	return a.unroute(true)
}

// RestoreNative unroutes a proxy binding when activation switches back to a
// native account. Unlike Reset it keeps the checkpoint: a later Reset must
// still restore the exact pre-proxy state.
func (a *ompAdapter) RestoreNative() error {
	return a.unroute(false)
}

func (a *ompAdapter) unroute(consume bool) error {
	modelsPath := ompModelsPath(a.home)
	if raw, err := os.ReadFile(modelsPath); err == nil {
		stripped, err := stripMarkedBlock(string(raw), ompModelsBegin, ompModelsEnd, "models.yml")
		if err != nil {
			return err
		}
		if ompModelsRemainderEmpty(stripped) {
			_ = os.Remove(modelsPath)
		} else {
			perm := os.FileMode(0o600)
			if fi, err := os.Stat(modelsPath); err == nil {
				perm = fi.Mode().Perm()
			}
			if err := atomicfile.Write(modelsPath, []byte(stripped), perm); err != nil {
				return err
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	configPath := ompConfigPath(a.home)
	restorePath := filepath.Join(anyPickRootFallback(), "clients", "omp", ompRestoreFile)
	if raw, rerr := os.ReadFile(restorePath); rerr == nil {
		var state ompRestoreState
		if json.Unmarshal(raw, &state) == nil {
			if state.ConfigExisted {
				perm := os.FileMode(0o600)
				if fi, err := os.Stat(configPath); err == nil {
					perm = fi.Mode().Perm()
				}
				if err := atomicfile.Write(configPath, []byte(state.ConfigContent), perm); err != nil {
					return err
				}
			} else {
				_ = os.Remove(configPath)
			}
			if consume {
				_ = os.Remove(restorePath)
			}
			return nil
		}
	}

	// No checkpoint: clean up config.yml best-effort
	if raw, err := os.ReadFile(configPath); err == nil {
		stripped, err := stripMarkedBlock(string(raw), ompConfigBegin, ompConfigEnd, "config.yml")
		if err == nil {
			var unPrefixed []string
			for _, line := range strings.Split(stripped, "\n") {
				if strings.HasPrefix(line, ompPreProxyPrefix) {
					unPrefixed = append(unPrefixed, strings.TrimPrefix(line, ompPreProxyPrefix))
				} else {
					unPrefixed = append(unPrefixed, line)
				}
			}
			restored := strings.Join(unPrefixed, "\n")
			if ompConfigRemainderEmpty(restored) {
				_ = os.Remove(configPath)
			} else {
				perm := os.FileMode(0o600)
				if fi, serr := os.Stat(configPath); serr == nil {
					perm = fi.Mode().Perm()
				}
				_ = atomicfile.Write(configPath, []byte(restored), perm)
			}
		}
	}
	return nil
}

// ompModelsRemainderEmpty reports a models.yml that holds nothing but an
// emptied providers: mapping after the managed block is stripped, so Reset
// removes the file it created instead of leaving a hollow header behind.
func ompModelsRemainderEmpty(stripped string) bool {
	lines := []string{}
	for _, line := range strings.Split(stripped, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			lines = append(lines, trimmed)
		}
	}
	return len(lines) == 0 || (len(lines) == 1 && lines[0] == "providers:")
}

func (a *ompAdapter) Inspect() (*InspectResult, error) {
	res := &InspectResult{Present: false}
	// The credential store is SQLite and opaque: presence comes from the
	// config surface (agent dir, models/config files), never from parsing
	// credentials. A bare agent dir still counts — omp creates files lazily.
	if _, err := os.Stat(ompAgentDir(a.home)); err != nil {
		return res, nil
	}
	res.Present = true
	if raw, err := os.ReadFile(ompModelsPath(a.home)); err == nil {
		if strings.Contains(string(raw), ompModelsBegin) {
			res.Summary = "AnyPick provider configured"
		} else {
			res.Summary = "models.yml present (no AnyPick provider)"
		}
	} else if _, err := os.Stat(ompConfigPath(a.home)); err == nil {
		res.Summary = "agent config present"
	} else {
		res.Summary = "agent dir present"
	}
	res.ConfigPaths = OmpConfigPaths(a.home)
	if raw, err := os.ReadFile(ompConfigPath(a.home)); err == nil {
		selected := ompSelectionScalar(string(raw), "defaultProvider")
		model := ompSelectionScalar(string(raw), "defaultModel")
		res.RoutingChanged = (selected != "" && selected != ompManagedProviderID) ||
			(strings.Contains(model, "/") && !strings.HasPrefix(model, ompManagedProviderID+"/"))
	}
	return res, nil
}

// Only simple top-level selection scalars are evidence. Complex YAML values
// remain unknown rather than being guessed from a marker or provider entry.
func ompSelectionScalar(content, key string) string {
	for _, line := range strings.Split(content, "\n") {
		if !ompIsTopLevelKey(line, key) {
			continue
		}
		_, value, _ := strings.Cut(line, ":")
		value, _, _ = strings.Cut(strings.TrimSpace(value), " #")
		value = strings.TrimSpace(value)
		if len(value) >= 2 && strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
			return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
		if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			var decoded string
			if json.Unmarshal([]byte(value), &decoded) == nil {
				return decoded
			}
			return ""
		}
		if strings.ContainsAny(value, " \t{}[]&*!|>\"'") {
			return ""
		}
		return value
	}
	return ""
}
