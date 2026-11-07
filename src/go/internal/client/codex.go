package client

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"

	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/protocol/gemini"
	"github.com/outof0/anypick/go/internal/transport"
)

// codexAdapter writes a managed block in the live Codex config, private
// native profile homes, and Codex's supported model catalog override. The catalog is source-scoped:
// custom providers do not cause Codex to fetch /models itself, so AnyPick must
// publish the exact list discovered from the selected proxy or gateway.
type codexAdapter struct {
	home string
	root string
}

func newCodex(home string, anyPickRoots ...string) *codexAdapter {
	root := ""
	if len(anyPickRoots) > 0 {
		root = anyPickRoots[0]
	}
	return &codexAdapter{home: home, root: root}
}

const (
	codexBeginMarker       = "# BEGIN anypick-managed"
	codexEndMarker         = "# END anypick-managed"
	codexNativeBeginMarker = "# BEGIN anypick-managed-native-profile"
	codexNativeEndMarker   = "# END anypick-managed-native-profile"
	codexCatalogFile       = "anypick-model-catalog.json"
	codexRestoreFile       = "restore.json"
)

type codexCatalogDocument struct {
	Models []codexCatalogModel `json:"models"`
}

type codexReasoningLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

type codexCatalogModel struct {
	Slug                           string                 `json:"slug"`
	DisplayName                    string                 `json:"display_name"`
	DisplayNameCamel               string                 `json:"displayName"`
	Description                    string                 `json:"description"`
	DefaultReasoningLevel          string                 `json:"default_reasoning_level"`
	SupportedReasoningLevels       []codexReasoningLevel  `json:"supported_reasoning_levels"`
	Provider                       string                 `json:"provider"`
	Hidden                         bool                   `json:"hidden"`
	Visibility                     string                 `json:"visibility"`
	SupportedInAPI                 bool                   `json:"supported_in_api"`
	Priority                       int                    `json:"priority"`
	AdditionalSpeedTiers           []string               `json:"additional_speed_tiers"`
	ServiceTiers                   []interface{}          `json:"service_tiers"`
	DefaultServiceTier             *string                `json:"default_service_tier"`
	AvailabilityNUX                interface{}            `json:"availability_nux"`
	Upgrade                        interface{}            `json:"upgrade"`
	ModelSpecialty                 *string                `json:"model_specialty"`
	SupportsSearchTool             bool                   `json:"supports_search_tool"`
	SupportsParallelToolCalls      bool                   `json:"supports_parallel_tool_calls"`
	SupportVerbosity               bool                   `json:"support_verbosity"`
	DefaultVerbosity               string                 `json:"default_verbosity"`
	DefaultReasoningSummary        string                 `json:"default_reasoning_summary"`
	ShellType                      string                 `json:"shell_type"`
	InputModalities                []string               `json:"input_modalities"`
	BaseInstructions               string                 `json:"base_instructions"`
	ModelMessages                  map[string]interface{} `json:"model_messages"`
	IncludePluginUsageInstructions bool                   `json:"include_plugin_usage_instructions"`
	IncludeAppsUsageInstructions   bool                   `json:"include_apps_usage_instructions"`
	WebSearchToolType              string                 `json:"web_search_tool_type"`
	ApplyPatchToolType             string                 `json:"apply_patch_tool_type"`
	TruncationPolicy               map[string]interface{} `json:"truncation_policy"`
	ExperimentalSupportedTools     []string               `json:"experimental_supported_tools"`
	UseResponsesLite               bool                   `json:"use_responses_lite"`
	IncludeSkillsUsageInstructions bool                   `json:"include_skills_usage_instructions"`
	SupportsImageDetailOriginal    bool                   `json:"supports_image_detail_original"`
	ContextWindow                  int64                  `json:"context_window"`
	MaxContextWindow               int64                  `json:"max_context_window"`
	CompHash                       string                 `json:"comp_hash"`
	EffectiveContextWindowPercent  int                    `json:"effective_context_window_percent"`
	SupportsExperimentalContext    bool                   `json:"supports_experimental_context"`
	SupportsReasoningEffortUpdates bool                   `json:"supports_reasoning_effort_updates"`
	NodeReplAutoReviewRequired     bool                   `json:"node_repl_auto_review_required"`
	NodeReplDisabled               bool                   `json:"node_repl_disabled"`
	ToolMode                       *string                `json:"tool_mode"`
	MultiAgentVersion              *string                `json:"multi_agent_version"`
	MultiAgentReasoningEffort      *string                `json:"multi_agent_reasoning_effort"`
	DefaultEffort                  string                 `json:"default_effort,omitempty"`
	DefaultEffortCamel             string                 `json:"defaultEffort,omitempty"`
	ReasoningLevels                []codexReasoningLevel  `json:"reasoning_levels,omitempty"`
	ReasoningLevelsCamel           []codexReasoningLevel  `json:"reasoningLevels,omitempty"`
}

func (a *codexAdapter) ID() string   { return "codex" }
func (a *codexAdapter) Name() string { return "OpenAI Codex" }

func (a *codexAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "codex",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		ProtocolPreference:       transport.OpenAI,
	}
}

func codexConfigPath(home string) string {
	return filepath.Join(codexHomePath(home), "config.toml")
}

func codexHomePath(home string) string {
	if env := os.Getenv("CODEX_HOME"); env != "" {
		return env
	}
	return filepath.Join(home, ".codex")
}

// isolatedCodexConfigPath deliberately ignores the process CODEX_HOME. An
// ephemeral run passes its own CODEX_HOME to the child after planning; using
// the parent environment here would write the live user's config while the
// child is supposed to be isolated.
func isolatedCodexConfigPath(home string) string {
	return filepath.Join(home, ".codex", "config.toml")
}

func codexModelCatalogPath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), codexCatalogFile)
}

// ValidateCodexProfileName keeps profile files and lock/resource identities
// inside the Codex home. Codex profile names are user-facing, so fail closed
// instead of turning a path separator or dot segment into a write outside the
// profile directory.
func ValidateCodexProfileName(name string) error {
	if name == "" || name != strings.TrimSpace(name) || len(name) > 64 {
		return fmt.Errorf("invalid Codex profile name %q (use 1-64 letters, digits, '-' or '_')", name)
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return fmt.Errorf("invalid Codex profile name %q (use 1-64 letters, digits, '-' or '_')", name)
	}
	return nil
}

// CodexProfileConfigPath is the native file Codex reads for
// `codex --profile <name>`. It honors CODEX_HOME just like config.toml.
func CodexProfileConfigPath(home, name string) string {
	return filepath.Join(codexHomePath(home), name+".config.toml")
}

// CodexProfileHomePath is the private CODEX_HOME used by one persistent
// AnyPick profile. Keeping it below the AnyPick data root gives every profile
// an independent auth.json while leaving the desktop app's CODEX_HOME alone.
func CodexProfileHomePath(root, name string) string {
	if root == "" {
		root = anyPickRootFallback()
	}
	return filepath.Join(root, "clients", "codex", "profiles", name, "codex-home")
}

// CodexProfileAuthPath reports the profile-owned copy of Codex auth.json.
func CodexProfileAuthPath(root, name string) string {
	return filepath.Join(CodexProfileHomePath(root, name), "auth.json")
}

// CodexProfileConfigPathForRoot reports the config selected after launching
// Codex with CODEX_HOME=CodexProfileHomePath(root, name).
func CodexProfileConfigPathForRoot(root, name string) string {
	return filepath.Join(CodexProfileHomePath(root, name), name+".config.toml")
}

func codexProfileConfigPath(home, root, name string, isolated bool) string {
	if isolated {
		return filepath.Join(filepath.Dir(isolatedCodexConfigPath(home)), name+".config.toml")
	}
	return CodexProfileConfigPathForRoot(root, name)
}

func codexProfileCatalogPath(configPath, name string) string {
	return filepath.Join(filepath.Dir(configPath), codexCatalogFile[:len(codexCatalogFile)-len(".json")]+"-"+name+".json")
}

// CodexProfileModelCatalogPath reports the model catalog beside one native
// profile file. Each profile gets its own catalog so switching A/B cannot
// silently make the other profile advertise the wrong entitlement.
func CodexProfileModelCatalogPath(home, name string) string {
	return codexProfileCatalogPath(CodexProfileConfigPath(home, name), name)
}

// CodexProfileModelCatalogPathForRoot reports the persistent profile catalog
// beside the profile config rather than beside the desktop app's config.
func CodexProfileModelCatalogPathForRoot(root, name string) string {
	return codexProfileCatalogPath(CodexProfileConfigPathForRoot(root, name), name)
}

// CodexProfileEnvKey is deliberately unique per profile. A single shared
// ANYPICK_PROXY_API_KEY would make `codex --profile a` depend on whichever
// profile was sourced last in the shell.
func CodexProfileEnvKey(name string) string {
	var label strings.Builder
	for _, r := range strings.ToUpper(name) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			label.WriteRune(r)
		default:
			label.WriteByte('_')
		}
	}
	sum := sha256.Sum256([]byte(name))
	return "ANYPICK_CODEX_PROFILE_" + label.String() + "_" + hex.EncodeToString(sum[:4]) + "_API_KEY"
}

// CodexProfileEnvPath is a sourceable, owner-only environment file for raw
// `codex --profile` use. It contains the per-instance proxy token, so callers
// must never print its contents.
func CodexProfileEnvPath(root, name string) string {
	return filepath.Join(root, "clients", "codex", "profiles", name+".env.sh")
}

// CodexProfileLaunchCommand is the safe shell snippet for launching one
// profile. The profile's CODEX_HOME is explicit, so the command cannot fall
// back to the desktop app's auth.json; proxy-backed profiles additionally
// source their owner-only token file.
func CodexProfileLaunchCommand(root, name string, sourceEnv bool) string {
	launch := "CODEX_HOME=" + shellQuote(CodexProfileHomePath(root, name)) +
		" codex --profile " + shellQuote(name)
	if sourceEnv {
		return "source " + shellQuote(CodexProfileEnvPath(root, name)) + " && " + launch
	}
	return launch
}

func codexProfileRestorePath(root, name string) string {
	return filepath.Join(root, "clients", "codex", "profiles", name+".restore.json")
}

// CodexProfilePaths returns every path touched by a persistent named profile;
// runtime recovery snapshots all of them before Apply runs.
func CodexProfilePaths(home, root, name string) []string {
	return []string{
		CodexProfileConfigPathForRoot(root, name),
		CodexProfileModelCatalogPathForRoot(root, name),
		CodexProfileAuthPath(root, name),
		CodexProfileEnvPath(root, name),
		codexProfileRestorePath(root, name),
		CodexProfileAppConfigPath(root, name),
	}
}

// CodexModelCatalogPath reports the source-scoped catalog file managed beside
// the effective Codex config. Runtime recovery uses the same path as Apply.
func CodexModelCatalogPath(home string) string {
	return codexModelCatalogPath(codexConfigPath(home))
}

func buildCodexModelCatalog(modelIDs []string) codexCatalogDocument {
	models := make([]codexCatalogModel, 0, len(modelIDs))
	defaultLevels := []codexReasoningLevel{
		{Effort: "low", Description: "Quick reasoning"},
		{Effort: "medium", Description: "Balanced reasoning"},
		{Effort: "high", Description: "Deep reasoning"},
		{Effort: "xhigh", Description: "Extended reasoning"},
	}
	listed := make(map[string]bool, len(modelIDs))
	for _, id := range modelIDs {
		listed[strings.ToLower(id)] = true
	}
	for i, id := range modelIDs {
		// The slug is what Codex sends, so it stays the vendor's exact id;
		// only the picker label is shortened, and not when the short form is
		// itself listed (a binding saved by 1.1.x), or two rows would read alike.
		label := gemini.DisplayModelID(id)
		if label != id && listed[strings.ToLower(label)] {
			label = id
		}
		models = append(models, codexCatalogModel{
			Slug:                           id,
			DisplayName:                    label,
			DisplayNameCamel:               label,
			Description:                    "Model supplied by the active AnyPick gateway or proxy.",
			DefaultReasoningLevel:          "medium",
			SupportedReasoningLevels:       defaultLevels,
			Provider:                       "anypick",
			Visibility:                     "list",
			SupportedInAPI:                 true,
			Priority:                       i + 1,
			AdditionalSpeedTiers:           []string{},
			ServiceTiers:                   []interface{}{},
			SupportsSearchTool:             false,
			SupportsParallelToolCalls:      false,
			SupportVerbosity:               false,
			DefaultVerbosity:               "low",
			DefaultReasoningSummary:        "none",
			ShellType:                      "unified_exec",
			InputModalities:                []string{"text", "image"},
			BaseInstructions:               "You are Codex, a coding agent. Help the user complete their task.",
			ModelMessages:                  map[string]interface{}{},
			IncludePluginUsageInstructions: false,
			IncludeAppsUsageInstructions:   false,
			WebSearchToolType:              "text_and_image",
			ApplyPatchToolType:             "freeform",
			TruncationPolicy:               map[string]interface{}{"mode": "tokens", "limit": 10000},
			ExperimentalSupportedTools:     []string{},
			UseResponsesLite:               false,
			IncludeSkillsUsageInstructions: false,
			SupportsImageDetailOriginal:    false,
			ContextWindow:                  128000,
			MaxContextWindow:               128000,
			CompHash:                       id,
			EffectiveContextWindowPercent:  95,
			SupportsExperimentalContext:    false,
			SupportsReasoningEffortUpdates: false,
			NodeReplAutoReviewRequired:     false,
			NodeReplDisabled:               true,
			DefaultEffort:                  "xhigh",
			DefaultEffortCamel:             "xhigh",
			ReasoningLevels:                defaultLevels,
			ReasoningLevelsCamel:           defaultLevels,
		})
	}
	return codexCatalogDocument{Models: models}
}

func writeCodexModelCatalog(path string, modelIDs []string) error {
	doc := buildCodexModelCatalog(modelIDs)
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, append(raw, '\n'), 0o600)
}

// Preflight reports foreign root-level config keys (model, model_provider,
// model_catalog_json) the apply would strip to make room for the managed
// block. Inside the managed block anything goes; outside it, a value with no
// AnyPick checkpoint belongs to the user.
func (a *codexAdapter) Preflight(ctx *ApplyContext) (*ConfigInspection, error) {
	if ctx.DryRun {
		return &ConfigInspection{}, nil
	}
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	configPath := codexConfigPath(targetHome)
	if ctx.IsolatedHome != "" {
		configPath = isolatedCodexConfigPath(targetHome)
	}
	if profileName := strings.TrimSpace(ctx.ProfileName); profileName != "" {
		configPath = codexProfileConfigPath(targetHome, ctx.AnyPickRoot, profileName, ctx.IsolatedHome != "")
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &ConfigInspection{}, nil
		}
		return nil, err
	}
	text := string(raw)
	// A native profile block is AnyPick's own write. The plain marker is a
	// prefix of the native one, so only the native stripper recognises it.
	// Treating those root keys as a user's would refuse every re-apply.
	if _, hasBlock := stripManagedBlock(text); hasBlock {
		return &ConfigInspection{}, nil
	}
	if _, hasNative := stripCodexNativeProfileBlock(text); hasNative {
		return &ConfigInspection{}, nil
	}
	removeModel := selectedDefaultModel(ctx) != ""
	stripped, _ := stripManagedBlock(string(raw))
	_, removed := stripCodexRootKeys(stripped, removeModel)
	if len(removed) == 0 {
		return &ConfigInspection{}, nil
	}
	// A checkpoint only owns the corresponding config file. Global ownership
	// must not suppress conflict checks for a separate named profile.
	root := a.ownershipRoot(ctx)
	if root == "" {
		root = anyPickRootFallback()
	}
	restorePath := filepath.Join(root, "clients", "codex", codexRestoreFile)
	if profileName := strings.TrimSpace(ctx.ProfileName); profileName != "" {
		restorePath = codexProfileRestorePath(root, profileName)
	}
	if _, err := os.Stat(restorePath); err == nil {
		return &ConfigInspection{}, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	present := make([]ConfigMutation, 0, len(removed))
	for range removed {
		present = append(present, ConfigMutation{Path: configPath, Selector: "root-keys"})
	}
	return &ConfigInspection{
		Conflicts: CheckOwnership(a.ID(), present, nil),
	}, nil
}

func (a *codexAdapter) ownershipRoot(ctx *ApplyContext) string {
	if ctx.AnyPickRoot != "" {
		return ctx.AnyPickRoot
	}
	return a.root
}

func (a *codexAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	profileName := strings.TrimSpace(ctx.ProfileName)
	if profileName != "" {
		if err := ValidateCodexProfileName(profileName); err != nil {
			return nil, err
		}
	}
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	configPath := codexConfigPath(targetHome)
	if ctx.IsolatedHome != "" {
		configPath = isolatedCodexConfigPath(targetHome)
	}
	if profileName != "" {
		configPath = codexProfileConfigPath(targetHome, ctx.AnyPickRoot, profileName, ctx.IsolatedHome != "")
	}

	model := selectedDefaultModel(ctx)
	modelIDs := sourceModelIDs(ctx)
	nativeAccountProfile := isNativeCodexAccountProfile(ctx, profileName)
	if nativeAccountProfile && !ctx.DryRun {
		if err := validateCodexAuthSnapshot(ctx.NativeAuthSnapshotDir); err != nil {
			return nil, err
		}
	}
	base := codexBaseURL(ctx.Endpoint)
	catalogPath := codexModelCatalogPath(configPath)
	if profileName != "" {
		catalogPath = codexProfileCatalogPath(configPath, profileName)
	}
	envKey := "ANYPICK_PROXY_API_KEY"
	if profileName != "" {
		envKey = CodexProfileEnvKey(profileName)
	}
	managedPaths := codexManagedPaths(ctx, profileName, configPath, catalogPath,
		len(modelIDs) > 0 && !nativeAccountProfile, nativeAccountProfile)
	managedEnvKeys := []string{envKey}
	if nativeAccountProfile {
		managedEnvKeys = nil
	}
	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: managedPaths, ManagedEnvKeys: managedEnvKeys}, nil
	}
	if !ctx.AllowForeignConfig {
		inspection, err := a.Preflight(ctx)
		if err != nil {
			return nil, err
		}
		if len(inspection.Conflicts) > 0 {
			return nil, ForeignConfigError(inspection.Conflicts)
		}
	}
	if nativeAccountProfile {
		if err := writeCodexNativeProfileConfig(ctx, profileName, configPath, model); err != nil {
			return nil, err
		}
	} else if err := writeCodexConfig(ctx, profileName, configPath, catalogPath, model, modelIDs, base, envKey); err != nil {
		return nil, err
	}
	if err := writeCodexCredentials(ctx, profileName, envKey); err != nil {
		return nil, err
	}
	return &ApplyResult{ManagedPaths: managedPaths, ManagedEnvKeys: managedEnvKeys}, nil
}

func isNativeCodexAccountProfile(ctx *ApplyContext, profileName string) bool {
	return profileName != "" && ctx.SourceKind == "account" &&
		ctx.TransportCapability == transport.Direct
}

func codexProfileAuthPathForApply(ctx *ApplyContext, profileName string) string {
	if ctx.IsolatedHome != "" {
		return filepath.Join(filepath.Dir(isolatedCodexConfigPath(ctx.IsolatedHome)), "auth.json")
	}
	return CodexProfileAuthPath(ctx.AnyPickRoot, profileName)
}

func codexManagedPaths(ctx *ApplyContext, profileName, configPath, catalogPath string, hasCatalog, nativeAccountProfile bool) []string {
	managedPaths := []string{configPath}
	if hasCatalog {
		managedPaths = append(managedPaths, catalogPath)
	}
	if profileName != "" {
		managedPaths = append(managedPaths, codexProfileAuthPathForApply(ctx, profileName))
		if ctx.IsolatedHome == "" && !nativeAccountProfile {
			managedPaths = append(managedPaths, CodexProfileEnvPath(ctx.AnyPickRoot, profileName))
		}
	}
	return managedPaths
}

func validateCodexAuthSnapshot(snapshotDir string) error {
	if strings.TrimSpace(snapshotDir) == "" {
		return fmt.Errorf("codex account profile has no saved auth.json snapshot; save the account first")
	}
	path := filepath.Join(snapshotDir, "auth.json")
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("codex account profile snapshot is missing auth.json: %s", path)
		}
		return err
	}
	return nil
}

func writeCodexNativeProfileConfig(ctx *ApplyContext, profileName, configPath, model string) error {
	raw, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	stripped, managed := stripManagedBlock(string(raw))
	stripped, native := stripCodexNativeProfileBlock(stripped)
	stripped = dropCodexMarkerTail(stripped)
	stripped, removedRootKeys := stripCodexRootKeys(stripped, true)
	if err := checkpointCodexProfileRootKeys(ctx, profileName, removedRootKeys); err != nil {
		return err
	}
	block := codexNativeProfileBlock(model)
	next := reinsertManagedBlock(stripped, block, managed || native)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(configPath, []byte(next), 0o600)
}

func codexNativeProfileBlock(model string) string {
	var b strings.Builder
	b.WriteString(codexNativeBeginMarker + "\n")
	if model != "" {
		b.WriteString("model = " + quoteTOML(model) + "\n")
	}
	b.WriteString("model_provider = \"openai\"\n")
	b.WriteString(codexNativeEndMarker + "\n")
	return b.String()
}

func writeCodexConfig(ctx *ApplyContext, profileName, configPath, catalogPath, model string, modelIDs []string, base, envKey string) error {
	raw, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(modelIDs) > 0 {
		if err := writeCodexModelCatalog(catalogPath, modelIDs); err != nil {
			return err
		}
	}
	block := codexManagedBlock(model, catalogPath, len(modelIDs) > 0, base, envKey, ctx.APIKey)
	stripped, hadBlock := stripManagedBlock(string(raw))
	stripped, removedRootKeys := stripCodexRootKeys(stripped, model != "")
	stripped = dropCodexMarkerTail(stripped)
	next := reinsertManagedBlock(stripped, block, hadBlock)
	if profileName != "" {
		if err := checkpointCodexProfileRootKeys(ctx, profileName, removedRootKeys); err != nil {
			return err
		}
	} else if err := checkpointCodexRootKeys(ctx, removedRootKeys); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		return err
	}
	if err := atomicfile.Write(configPath, []byte(next), 0o600); err != nil {
		return err
	}
	return nil
}

func codexManagedBlock(model, catalogPath string, hasCatalog bool, base, envKey, apiKey string) string {
	var b strings.Builder
	b.WriteString(codexBeginMarker + "\n")
	if model != "" {
		b.WriteString("model = " + quoteTOML(model) + "\n")
	}
	if hasCatalog {
		b.WriteString("model_catalog_json = " + quoteTOML(catalogPath) + "\n")
	}
	b.WriteString("model_provider = \"anypick\"\n\n")
	b.WriteString("[model_providers.anypick]\n")
	b.WriteString("name = \"AnyPick\"\n")
	b.WriteString("base_url = " + quoteTOML(base) + "\n")
	b.WriteString("env_key = " + quoteTOML(envKey) + "\n")
	if apiKey != "" {
		b.WriteString("experimental_bearer_token = " + quoteTOML(apiKey) + "\n")
	}
	b.WriteString("wire_api = \"responses\"\n")
	// Codex otherwise treats the provider as OpenAI-hosted and tries its
	// websocket/HTTPS auth flow against api.openai.com before honoring the
	// configured local endpoint. AnyPick proxies authenticate per request.
	b.WriteString("requires_openai_auth = false\n")
	b.WriteString("supports_websockets = false\n")
	b.WriteString(codexEndMarker + "\n")
	return b.String()
}

func writeCodexCredentials(ctx *ApplyContext, profileName, envKey string) error {
	if profileName != "" {
		if isNativeCodexAccountProfile(ctx, profileName) {
			return writeCodexProfileAuth(ctx, profileName)
		}
		if err := writeCodexProfileAuth(ctx, profileName); err != nil {
			return err
		}
	}
	if profileName != "" && ctx.IsolatedHome != "" {
		if ctx.ExtraEnv != nil {
			ctx.ExtraEnv[envKey] = ctx.APIKey
		}
	} else if profileName != "" {
		if err := writeCodexProfileEnvFile(ctx.AnyPickRoot, profileName, envKey, ctx.APIKey); err != nil {
			return err
		}
	} else if ctx.AnyPickRoot != "" && ctx.IsolatedHome == "" {
		writeClientEnvFiles(ctx.AnyPickRoot, "codex", map[string]string{
			"ANYPICK_PROXY_API_KEY": ctx.APIKey,
		})
	}
	return nil
}

// writeCodexProfileAuth materializes an account snapshot into the profile's
// own CODEX_HOME. A gateway profile has no native account, so any stale auth
// left by an earlier account-backed activation is removed instead.
func writeCodexProfileAuth(ctx *ApplyContext, profileName string) error {
	path := codexProfileAuthPathForApply(ctx, profileName)
	if strings.TrimSpace(ctx.NativeAuthSnapshotDir) == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	snapshot := filepath.Join(ctx.NativeAuthSnapshotDir, "auth.json")
	raw, err := os.ReadFile(snapshot)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("codex account profile snapshot is missing auth.json: %s", snapshot)
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(path, raw, 0o600)
}

func codexBaseURL(endpoint string) string {
	base := strings.TrimRight(endpoint, "/")
	if strings.HasSuffix(base, "/v1") {
		return base
	}
	return base + "/v1"
}

// codexRestoreState remembers the root-level keys Apply stripped to make
// room for the managed block, so Reset can put the user's own model pin back
// instead of silently dropping it.
type codexRestoreState struct {
	Version  int      `json:"version"`
	RootKeys []string `json:"rootKeys,omitempty"`
}

// checkpointCodexRootKeys records stripped root lines once, before the first
// write. Later activations must not overwrite it: it describes the
// pre-AnyPick file, not the current one.
func checkpointCodexRootKeys(ctx *ApplyContext, removed []string) error {
	if ctx.IsolatedHome != "" || ctx.AnyPickRoot == "" || len(removed) == 0 {
		return nil
	}
	restorePath := filepath.Join(ctx.AnyPickRoot, "clients", "codex", codexRestoreFile)
	if _, err := os.Stat(restorePath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	state := codexRestoreState{Version: 1, RootKeys: removed}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(restorePath), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(restorePath, append(raw, '\n'), 0o600)
}

func checkpointCodexProfileRootKeys(ctx *ApplyContext, profileName string, removed []string) error {
	if ctx.IsolatedHome != "" || ctx.AnyPickRoot == "" || len(removed) == 0 {
		return nil
	}
	restorePath := codexProfileRestorePath(ctx.AnyPickRoot, profileName)
	if _, err := os.Stat(restorePath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	state := codexRestoreState{Version: 1, RootKeys: removed}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(restorePath), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(restorePath, append(raw, '\n'), 0o600)
}

func writeCodexProfileEnvFile(root, profileName, envKey, value string) error {
	path := CodexProfileEnvPath(root, profileName)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	content := "# Generated by AnyPick — source this before `codex --profile " + profileName + "`\n" +
		"export " + envKey + "=" + shellQuote(value) + "\n"
	return atomicfile.Write(path, []byte(content), 0o600)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// restoreCodexRootKeys re-inserts checkpointed root lines that are still
// absent. The presence check keeps a checkpoint written before a failed Apply
// from duplicating lines that never left the file.
func restoreCodexRootKeys(content string, restorePath string) string {
	raw, err := os.ReadFile(restorePath)
	if err != nil {
		return content
	}
	var state codexRestoreState
	if json.Unmarshal(raw, &state) != nil || state.Version != 1 || len(state.RootKeys) == 0 {
		return content
	}
	var missing []string
	for _, line := range state.RootKeys {
		key := codexRootKeyOf(line)
		if key == "" || hasCodexRootKey(content, key) {
			continue
		}
		missing = append(missing, line)
	}
	if len(missing) == 0 {
		return content
	}
	content = strings.TrimRight(content, "\n")
	if content == "" {
		return strings.Join(missing, "\n") + "\n"
	}
	return strings.Join(missing, "\n") + "\n\n" + content + "\n"
}

func codexRootKeyOf(line string) string {
	trimmed := strings.TrimSpace(line)
	if eq := strings.Index(trimmed, "="); eq > 0 {
		return strings.TrimSpace(trimmed[:eq])
	}
	return ""
}

func hasCodexRootKey(content, key string) bool {
	want := map[string]bool{key: true}
	tableSeen := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") &&
			strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			tableSeen = true
		}
		if !tableSeen && codexRootAssignment(trimmed, want) {
			return true
		}
	}
	return false
}

// stripCodexRootKeys removes only root-level keys owned by the managed block,
// returning the removed lines for the Reset checkpoint. Keeping an older
// root `model` beside the new one would make TOML invalid; table-local keys
// and unrelated user settings remain untouched.
func stripCodexRootKeys(content string, removeModel bool) (string, []string) {
	keys := map[string]bool{"model_provider": true, "model_catalog_json": true}
	if removeModel {
		keys["model"] = true
	}
	lines := strings.Split(content, "\n")
	tableSeen := false
	out := make([]string, 0, len(lines))
	var removed []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") &&
			strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			tableSeen = true
		}
		if !tableSeen && codexRootAssignment(trimmed, keys) {
			removed = append(removed, line)
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n"), removed
}

func codexRootAssignment(line string, keys map[string]bool) bool {
	for key := range keys {
		if !strings.HasPrefix(line, key) {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, key))
		if strings.HasPrefix(rest, "=") {
			return true
		}
	}
	return false
}

// RestoreNative removes the managed block so Codex talks to its native login —
// the persistent direct-account path calls this instead of Apply.
func (a *codexAdapter) RestoreNative() error {
	path := codexConfigPath(a.home)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			if removeErr := os.Remove(codexModelCatalogPath(path)); removeErr != nil && !os.IsNotExist(removeErr) {
				return removeErr
			}
			return nil
		}
		return err
	}
	stripped, changed := stripManagedBlock(string(raw))
	if changed {
		stripped = restoreCodexRootKeys(stripped, codexCheckpointPath())
		if err := atomicfile.Write(path, []byte(stripped), 0o600); err != nil {
			return err
		}
	}
	if err := os.Remove(codexModelCatalogPath(path)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ResetProfile removes only AnyPick's named route and restores root keys that
// existed in a pre-existing native profile file. The profile-owned auth.json
// is removed with the route; the desktop app's CODEX_HOME/auth.json is never
// touched.
//
// The credential home directory itself is left in place: an explicit
// `profile remove` is often followed by a fresh login under the same name, and
// removing the home would also drop anything the user put beside it. Removing
// the home is RemoveProfileFiles' job, because an account deletion must not
// leave the deleted account's token in a directory nothing references.
func (a *codexAdapter) ResetProfile(name string) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	if err := a.ProfileInUse(name); err != nil {
		return err
	}
	root := a.profileRoot()
	path := CodexProfileConfigPathForRoot(root, name)
	if err := resetCodexProfileConfig(path, codexProfileRestorePath(root, name)); err != nil {
		return err
	}
	// Clean profiles created by the first config-only implementation. Only a
	// file carrying AnyPick's marker is eligible, so a user's unrelated native
	// `CODEX_HOME/<name>.config.toml` is left intact.
	legacyPath := CodexProfileConfigPath(a.home, name)
	if legacyPath != path {
		if err := resetCodexProfileConfig(legacyPath, codexProfileRestorePath(root, name)); err != nil {
			return err
		}
	}
	for _, generated := range []string{
		codexProfileCatalogPath(path, name),
		codexProfileCatalogPath(legacyPath, name),
		CodexProfileAuthPath(root, name),
		CodexProfileEnvPath(root, name),
		codexProfileRestorePath(root, name),
		// The desktop app's copy of the route carries the same bearer
		// token as the env file.
		CodexProfileAppConfigPath(root, name),
		CodexProfileTerminalScriptPath(root, name),
	} {
		if removeErr := os.Remove(generated); removeErr != nil && !os.IsNotExist(removeErr) {
			return removeErr
		}
	}
	return nil
}

// ProfileInUse refuses to remove a profile whose Codex app instance is open:
// the instance rewrites config.toml (with the route's bearer token) and
// refreshes auth.json in CODEX_HOME, so it would recreate them in a directory
// nothing tracks any more.
func (a *codexAdapter) ProfileInUse(name string) error {
	if CodexProfileAppRunning(a.profileRoot(), name) {
		return errCodexProfileAppRunning(name)
	}
	return nil
}

func (a *codexAdapter) profileRoot() string {
	if a.root != "" {
		return a.root
	}
	return anyPickRootFallback()
}

func resetCodexProfileConfig(path, restorePath string) error {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	stripped, managed := stripManagedBlock(string(raw))
	stripped, native := stripCodexNativeProfileBlock(stripped)
	if !managed && !native {
		return nil
	}
	stripped = restoreCodexRootKeys(stripped, restorePath)
	if strings.TrimSpace(stripped) == "" {
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			return removeErr
		}
		return nil
	}
	return atomicfile.Write(path, []byte(stripped), 0o600)
}

// RemoveProfileFiles deletes every file AnyPick created for one named profile,
// including the private CODEX_HOME holding its auth.json.
//
// ResetProfile deliberately keeps auth.json (a later activation of the same
// name reuses it), which is the right choice for an explicit profile removal
// where the account survives. It is the wrong one when the account the profile
// points at is gone: the leftover home still holds that account's OAuth
// credential, and nothing in AnyPick can reach it any more. The cascade path
// (planProfileRemoval) calls this instead.
//
// Only the profile's own directories are removed. The client's global config
// and the desktop app's CODEX_HOME are never touched.
func (a *codexAdapter) RemoveProfileFiles(name string) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	// Read before ResetProfile deletes the app config it is recorded in.
	shared := codexProfileSharesMainSessions(a.profileRoot(), name)
	if err := a.ResetProfile(name); err != nil {
		return err
	}
	home := CodexProfileHomePath(a.profileRoot(), name)
	if shared {
		if err := removeCodexHomeKeepingSessions(home); err != nil {
			return err
		}
	} else if err := os.RemoveAll(home); err != nil {
		return err
	}
	return os.RemoveAll(CodexProfileAppUserDataPath(a.profileRoot(), name))
}

// InspectProfile verifies the file selected by Codex's --profile flag rather
// than inspecting the one global config.toml.
func (a *codexAdapter) InspectProfile(name string) (*InspectResult, error) {
	if err := ValidateCodexProfileName(name); err != nil {
		return nil, err
	}
	root := a.profileRoot()
	path := CodexProfileConfigPathForRoot(root, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &InspectResult{Present: false, Issues: []string{"profile config not found"}, ConfigPaths: []string{path}}, nil
		}
		return nil, err
	}
	if hasMarkerLine(string(raw), codexBeginMarker) || hasMarkerLine(string(raw), codexNativeBeginMarker) {
		// Present stays true because the block is there, but a profile whose
		// config Codex cannot parse has to be reported, not called healthy.
		return &InspectResult{Present: true, Issues: codexConfigIssues(path, string(raw)), ConfigPaths: []string{
			path, CodexProfileAuthPath(root, name), codexProfileCatalogPath(path, name),
		}}, nil
	}
	return &InspectResult{Present: false, Issues: []string{"no anypick-managed profile block"}, ConfigPaths: []string{path}}, nil
}

// codexCheckpointPath resolves the Reset checkpoint the same way every other
// adapter does: through the AnyPick root fallback, not the client home.
func codexCheckpointPath() string {
	return filepath.Join(anyPickRootFallback(), "clients", "codex", codexRestoreFile)
}

func (a *codexAdapter) Reset() error {
	if err := a.RestoreNative(); err != nil {
		return err
	}
	// The checkpoint described the pre-AnyPick file just restored; keeping it
	// would resurrect those lines over newer user edits on a later Reset.
	_ = os.Remove(codexCheckpointPath())
	return nil
}

func (a *codexAdapter) Inspect() (*InspectResult, error) {
	configPath := codexConfigPath(a.home)
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &InspectResult{Native: true, Issues: []string{"config.toml not found"}, ConfigPaths: []string{configPath}}, nil
		}
		return nil, err
	}
	// Validate before answering. A marker substring is not a block: the plain
	// marker is a prefix of the native one, and a comment can mention either.
	// The same whole-line rule as the strippers decides presence.
	issues := codexConfigIssues(configPath, string(raw))
	var config struct {
		Provider string `toml:"model_provider"`
		BaseURL  string `toml:"openai_base_url"`
		Profile  string `toml:"profile"`
		Profiles map[string]struct {
			Provider string `toml:"model_provider"`
		} `toml:"profiles"`
		Providers map[string]struct {
			BaseURL string `toml:"base_url"`
		} `toml:"model_providers"`
	}
	parsed := toml.Unmarshal(raw, &config) == nil
	if config.Profile != "" {
		profile, ok := config.Profiles[config.Profile]
		parsed = parsed && ok
		if profile.Provider != "" {
			config.Provider = profile.Provider
		}
	}
	native := parsed &&
		(config.Provider == "" || config.Provider == "openai") && config.BaseURL == "" && config.Providers["openai"].BaseURL == ""
	rawText := string(raw)
	if !hasMarkerLine(rawText, codexBeginMarker) && !hasMarkerLine(rawText, codexNativeBeginMarker) {
		issues = append(issues, "no anypick-managed block")
		return &InspectResult{Native: native, RoutingChanged: parsed && config.Provider != "anypick", Issues: issues, ConfigPaths: []string{configPath}}, nil
	}
	return &InspectResult{
		Present:        true,
		Native:         native,
		RoutingChanged: parsed && config.Provider != "anypick",
		Issues:         issues,
		ConfigPaths:    []string{configPath, codexModelCatalogPath(configPath)},
	}, nil
}

// codexConfigIssues turns a config document into doctor findings. A file that
// cannot be parsed keeps Present set — the block is there — but stops reading
// as healthy, which is the whole point: `anypick doctor codex` has to say why
// the client will not start.
func codexConfigIssues(path, raw string) []string {
	if err := ValidateTOMLDocument(raw); err != nil {
		return []string{path + ": " + err.Error()}
	}
	return nil
}

// findMarkerLine returns where marker occupies a whole line, or -1. The plain
// and native marker families overlap: codexBeginMarker is a strict prefix of
// codexNativeBeginMarker, and codexEndMarker of codexNativeEndMarker, so a
// plain strings.Index matches the native block's own marker line. Stripping
// then advances len(codexEndMarker) past the longer native END line and leaves
// that line's tail — "-native-profile" — alone at the document root, a bare
// line Codex refuses with "key with no value". Requiring the line to start and
// end at the marker keeps the families apart without changing the on-disk
// contract, and matches how the other adapters compare their markers.
func findMarkerLine(content, marker string) int {
	for offset := 0; offset < len(content); {
		i := strings.Index(content[offset:], marker)
		if i < 0 {
			return -1
		}
		i += offset
		startsLine := i == 0 || content[i-1] == '\n' || content[i-1] == '\r'
		rest := content[i+len(marker):]
		endsLine := rest == "" || rest[0] == '\n' || rest[0] == '\r'
		if startsLine && endsLine {
			return i
		}
		offset = i + 1
	}
	return -1
}

// hasMarkerLine reports whether a whole line of the document is exactly marker.
// Presence checks need the same whole-line rule as the strippers: a substring
// test cannot tell the plain family from the native one.
func hasMarkerLine(content, marker string) bool { return findMarkerLine(content, marker) >= 0 }

// stripManagedBlock removes an existing managed block, reporting whether one
// was present.
func stripManagedBlock(content string) (string, bool) {
	begin := findMarkerLine(content, codexBeginMarker)
	end := findMarkerLine(content, codexEndMarker)
	if begin < 0 || end < 0 || end < begin {
		return content, false
	}
	before := strings.TrimRight(content[:begin], "\n")
	after := content[end+len(codexEndMarker):]
	after = strings.TrimLeft(after, "\n")
	switch {
	case before == "":
		return after, true
	case after == "":
		return before + "\n", true
	default:
		return before + "\n\n" + after, true
	}
}

// dropCodexMarkerTail removes a root line that is only the suffix left when an
// older plain-marker strip cut a native marker. The line has no '=', so Codex
// refuses the file ("key with no value") and every later re-apply used to
// write it back. An assignment, a comment, and the same spelling inside a
// table stay: those can be user content. The strippers themselves stay pure.
func dropCodexMarkerTail(content string) string {
	if !strings.Contains(content, "-native-profile") {
		return content
	}
	lines := strings.Split(content, "\n")
	tableSeen := false
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !tableSeen && trimmed == "-native-profile" {
			continue
		}
		if !strings.HasPrefix(trimmed, "#") &&
			strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			tableSeen = true
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func stripCodexNativeProfileBlock(content string) (string, bool) {
	begin := findMarkerLine(content, codexNativeBeginMarker)
	end := findMarkerLine(content, codexNativeEndMarker)
	if begin < 0 || end < 0 || end < begin {
		return content, false
	}
	before := strings.TrimRight(content[:begin], "\n")
	after := content[end+len(codexNativeEndMarker):]
	after = strings.TrimLeft(after, "\n")
	switch {
	case before == "":
		return after, true
	case after == "":
		return before + "\n", true
	default:
		return before + "\n\n" + after, true
	}
}

// reinsertManagedBlock inserts the managed block in the document root while
// keeping user content intact. TOML table context continues to the end of the
// file, so appending root keys after a user's first [table] silently nests
// them under that table and makes Codex fall back to its native provider.
func reinsertManagedBlock(content, block string, _ bool) string {
	content = strings.TrimRight(content, "\n")
	if content == "" {
		return block
	}

	lines := strings.Split(content, "\n")
	firstTable := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			firstTable = i
			break
		}
	}
	if firstTable < 0 {
		return content + "\n\n" + block
	}

	root := strings.TrimRight(strings.Join(lines[:firstTable], "\n"), "\n")
	tables := strings.TrimLeft(strings.Join(lines[firstTable:], "\n"), "\n")
	if root == "" {
		return block + "\n\n" + tables
	}
	return root + "\n\n" + block + "\n\n" + tables
}

func quoteTOML(s string) string {
	return "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(s) + "\""
}

func (a *codexAdapter) ShortName() string { return "Codex" }
