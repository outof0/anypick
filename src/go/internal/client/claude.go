package client

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

const anypickManagedKey = "_anypickManaged"

type claudeAdapter struct{ home string }

func newClaude(home string) *claudeAdapter { return &claudeAdapter{home: home} }

func (a *claudeAdapter) ID() string   { return "claude" }
func (a *claudeAdapter) Name() string { return "Claude Code" }

func (a *claudeAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "claude",
		AcceptedProtocols:        []transport.Protocol{transport.Anthropic},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		ProtocolPreference:       transport.Anthropic,
	}
}

func settingsPath(home string) string {
	return filepath.Join(home, ".claude", "settings.json")
}

// bareModelID strips a provider prefix ("vendor/name" → "name").
func bareModelID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return ""
	}
	if slash := strings.LastIndex(id, "/"); slash >= 0 {
		return id[slash+1:]
	}
	return id
}

func isOfficialAnthropicEndpoint(endpoint string) bool {
	host := hostOf(endpoint)
	return host == "api.anthropic.com" || strings.HasSuffix(host, ".anthropic.com")
}

// isLoopbackEndpoint reports whether a URL can only be the machine itself.
// AnyPick's proxies are loopback-only (ADR 0006), which is what makes a
// loopback value in a client config AnyPick's own.
func isLoopbackEndpoint(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return false
	}
	// Hostname strips the port and the IPv6 brackets.
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func hostOf(rawURL string) string {
	s := rawURL
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	if slash := strings.Index(s, "/"); slash >= 0 {
		s = s[:slash]
	}
	if at := strings.Index(s, "@"); at >= 0 {
		s = s[at+1:]
	}
	if colon := strings.Index(s, ":"); colon >= 0 {
		s = s[:colon]
	}
	return strings.ToLower(s)
}

func (a *claudeAdapter) Preflight(ctx *ApplyContext) (*ConfigInspection, error) {
	settings := settingsPath(a.targetHome(ctx))
	doc := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(settings); err == nil {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, anyerr.Newf(
				fmt.Sprintf("Refusing to overwrite unreadable Claude settings at %s: %v", settings, err),
				"CLIENT_CONFIG_INVALID")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	var existingEnv map[string]interface{}
	if raw, ok := doc["env"]; ok {
		_ = json.Unmarshal(raw, &existingEnv)
	}
	intended := a.intendedEnv(ctx)
	owned := &OwnershipEvidence{Owned: map[string]map[string]bool{}}
	ownedSet := map[string]bool{}
	// A managed route always points Claude Code at a loopback proxy, so a
	// loopback ANTHROPIC_BASE_URL is AnyPick's own value even when the marker
	// is gone — the user may have rewritten settings.json, or a crash landed
	// between the write and the marker. The token, model and slot keys are
	// written together with it and mean nothing without it, so they are owned
	// as one unit.
	//
	// Any other base URL is the user's own configuration: it stays foreign and
	// AnyPick refuses to replace it without confirmation. That is the whole
	// point of this check — a client the user pointed at their own login must
	// survive an AnyPick start untouched.
	if existing, ok := existingEnv["ANTHROPIC_BASE_URL"].(string); ok && isLoopbackEndpoint(existing) {
		for key := range intended {
			ownedSet["env."+key] = true
		}
	}
	var present []ConfigMutation
	for _, key := range sortedKeys(intended) {
		if _, exists := existingEnv[key]; !exists {
			continue
		}
		present = append(present, ConfigMutation{Path: settings, Selector: "env." + key})
	}
	// A managed marker owns exactly the keys it names.
	var prevManaged struct {
		Keys []string `json:"keys"`
	}
	if raw, ok := doc[anypickManagedKey]; ok {
		_ = json.Unmarshal(raw, &prevManaged)
		for _, key := range prevManaged.Keys {
			ownedSet["env."+key] = true
		}
	}
	owned.Owned[settings] = ownedSet
	return &ConfigInspection{
		Conflicts: CheckOwnership(a.ID(), present, owned),
	}, nil
}

func (a *claudeAdapter) targetHome(ctx *ApplyContext) string {
	if ctx.IsolatedHome != "" {
		return ctx.IsolatedHome
	}
	return ctx.Home
}

// intendedEnv is the env map Apply would write for this context, shared with
// Preflight so both reason over the same mutation set.
func (a *claudeAdapter) intendedEnv(ctx *ApplyContext) map[string]string {
	env := map[string]string{}
	official := isOfficialAnthropicEndpoint(ctx.Endpoint)
	env["ANTHROPIC_BASE_URL"] = ctx.Endpoint
	if official {
		env["ANTHROPIC_API_KEY"] = ctx.APIKey
	} else {
		env["ANTHROPIC_AUTH_TOKEN"] = ctx.APIKey
	}

	// Claude Code slots: default + sonnet/opus/haiku. When only default is set,
	// fill all slots so UI model pickers still hit the proxy model.
	defaultModel := bareModelID(firstNonEmpty(ctx.ModelRoles["default"], ctx.DefaultModel))
	sonnet := firstNonEmpty(bareModelID(ctx.ModelRoles["sonnet"]), defaultModel)
	opus := firstNonEmpty(bareModelID(ctx.ModelRoles["opus"]), defaultModel)
	haiku := firstNonEmpty(bareModelID(ctx.ModelRoles["haiku"]), defaultModel)
	if defaultModel != "" {
		env["ANTHROPIC_MODEL"] = defaultModel
	}
	if sonnet != "" {
		env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = sonnet
	}
	if opus != "" {
		env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = opus
	}
	if haiku != "" {
		env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = haiku
	}
	for k, v := range ctx.ExtraEnv {
		if v == "" {
			continue
		}
		if strings.HasPrefix(k, "ANTHROPIC_") || strings.HasPrefix(k, "CLAUDE_") ||
			strings.HasPrefix(k, "CLAUDE_CODE_") {
			env[k] = v
		}
	}
	return env
}

func (a *claudeAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := a.targetHome(ctx)
	settings := settingsPath(targetHome)

	env := a.intendedEnv(ctx)
	official := isOfficialAnthropicEndpoint(ctx.Endpoint)

	managedPaths := []string{settings}
	managedEnvKeys := sortedKeys(env)

	if ctx.DryRun {
		return &ApplyResult{ManagedPaths: managedPaths, ManagedEnvKeys: managedEnvKeys}, nil
	}

	// Never turn malformed user JSON into {}. Parse before any write so a
	// failed apply leaves the user's files untouched.
	doc := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(settings); err == nil {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, anyerr.Newf(
				fmt.Sprintf("Refusing to overwrite unreadable Claude settings at %s: %v", settings, err),
				"CLIENT_CONFIG_INVALID")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	var existingEnv map[string]interface{}
	if raw, ok := doc["env"]; ok {
		_ = json.Unmarshal(raw, &existingEnv)
	}

	// Foreign takeover gate: values present but not owned by the managed
	// marker need explicit consent before AnyPick replaces them.
	if !ctx.AllowForeignConfig {
		inspection, err := a.Preflight(ctx)
		if err != nil {
			return nil, err
		}
		if len(inspection.Conflicts) > 0 {
			return nil, ForeignConfigError(inspection.Conflicts)
		}
	}

	cleanEnv := map[string]string{}
	for k, v := range existingEnv {
		if s, ok := v.(string); ok {
			cleanEnv[k] = s
		}
	}

	// Drop previously managed keys and stale cross-vendor keys.
	var prevManaged struct {
		Keys []string `json:"keys"`
	}
	if raw, ok := doc[anypickManagedKey]; ok {
		_ = json.Unmarshal(raw, &prevManaged)
	}
	for _, key := range prevManaged.Keys {
		delete(cleanEnv, key)
	}
	delete(cleanEnv, "OPENAI_API_KEY")
	delete(cleanEnv, "OPENAI_BASE_URL")
	delete(cleanEnv, "OPENAI_MODEL")
	if official {
		delete(cleanEnv, "ANTHROPIC_AUTH_TOKEN")
	} else {
		delete(cleanEnv, "ANTHROPIC_API_KEY")
	}
	for _, k := range []string{
		"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
	} {
		if _, managed := env[k]; !managed {
			delete(cleanEnv, k)
		}
	}
	for k, v := range env {
		cleanEnv[k] = v
	}

	envJSON, _ := json.Marshal(cleanEnv)
	doc["env"] = envJSON

	managedKeys := append([]string{}, managedEnvKeys...)
	if official {
		managedKeys = append(managedKeys, "ANTHROPIC_AUTH_TOKEN")
	} else {
		managedKeys = append(managedKeys, "ANTHROPIC_API_KEY")
	}
	marker, _ := json.Marshal(map[string]interface{}{
		"keys":      dedupe(managedKeys),
		"updatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	})
	doc[anypickManagedKey] = marker

	// Keep a one-time backup of the pre-AnyPick file for Reset().
	if !ctx.DryRun && ctx.AnyPickRoot != "" && ctx.IsolatedHome == "" {
		backupDir := filepath.Join(ctx.AnyPickRoot, "clients", "claude", "backup")
		backupFile := filepath.Join(backupDir, "settings.json")
		if _, err := os.Stat(backupFile); os.IsNotExist(err) {
			if _, err := os.Stat(settings); err == nil {
				_ = os.MkdirAll(backupDir, 0o700)
				data, readErr := os.ReadFile(settings)
				if readErr == nil {
					// One-time pre-AnyPick backup under our own root (ADR 0004):
					// still replace by rename — same helper, no second shape.
					_ = atomicfile.Write(backupFile, data, 0o600)
				}
			}
		}
		// Shell env stays in sync with settings.json.
		writeClientEnvFiles(ctx.AnyPickRoot, "claude", env)
	}

	if err := os.MkdirAll(filepath.Join(targetHome, ".claude"), 0o700); err != nil {
		return nil, err
	}
	out, err := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if err != nil {
		return nil, err
	}
	// settings is the user's real ~/.claude/settings.json. A truncated write
	// here leaves their Claude Code config unreadable with no copy to fall back
	// on, so replace by rename rather than overwriting in place.
	if err := atomicfile.Write(settings, append(out, '\n'), 0o600); err != nil {
		return nil, err
	}

	// Hard guarantee: Claude Code reads settings.json env, not only env.sh.
	verify, err := os.ReadFile(settings)
	if err != nil {
		return nil, anyerr.Wrapf(err, "could not verify "+settings, "CLIENT_CONFIG_INVALID")
	}
	var check map[string]json.RawMessage
	_ = json.Unmarshal(verify, &check)
	var envCheck map[string]json.RawMessage
	if raw, ok := check["env"]; ok {
		_ = json.Unmarshal(raw, &envCheck)
	}
	gotBaseURL := stringField(envCheck, "ANTHROPIC_BASE_URL")
	if gotBaseURL != ctx.Endpoint {
		return nil, anyerr.Newf(
			fmt.Sprintf("Failed to write proxy into %s: ANTHROPIC_BASE_URL is %q (expected %s)",
				settings, gotBaseURL, ctx.Endpoint),
			"CLIENT_CONFIG_INVALID")
	}

	return &ApplyResult{
		ManagedPaths:   managedPaths,
		ManagedEnvKeys: managedEnvKeys,
	}, nil
}

func (a *claudeAdapter) Reset() error {
	settings := settingsPath(a.home)
	root := anyPickRootFallback()
	backupFile := filepath.Join(root, "clients", "claude", "backup", "settings.json")
	if raw, err := os.ReadFile(backupFile); err == nil {
		if claudeBackupStillOwnsLive(settings) {
			var doc map[string]json.RawMessage
			if json.Unmarshal(raw, &doc) == nil && jsonLooksObject(raw) {
				// The pre-AnyPick file is the exact native state: put it back
				// byte-for-byte, then consume the backup so a later Reset cannot
				// resurrect it over newer user edits.
				if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
					return err
				}
				if err := atomicfile.Write(settings, raw, 0o600); err != nil {
					return err
				}
				_ = os.Remove(backupFile)
				removeClientEnvFiles(root, "claude")
				return nil
			}
			// An unreadable backup must never be written into the live file;
			// fall through to the managed-strip below so Reset still unroutes.
		}
		// The live file no longer carries AnyPick's marker, so it may hold user
		// edits made after Apply. Restoring the backup byte-for-byte would
		// delete them; strip only the managed keys and leave the one-time
		// backup in place for a later Reset.
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := stripClaudeManagedKeys(settings); err != nil {
		return err
	}
	removeClientEnvFiles(root, "claude")
	return nil
}

// claudeBackupStillOwnsLive reports whether the live settings.json is still
// the file Apply wrote (or absent entirely). Only then is byte-for-byte
// restore from the one-time pre-AnyPick backup safe.
func claudeBackupStillOwnsLive(settings string) bool {
	raw, err := os.ReadFile(settings)
	if err != nil {
		// Missing file: nothing newer to protect.
		return os.IsNotExist(err)
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		return false
	}
	_, managed := doc[anypickManagedKey]
	return managed
}

// RestoreNative unroutes a proxy binding when activation switches back to a
// native account. The native credential lives outside settings.json, so only
// the managed env block is removed: user keys are never touched, and the
// pre-AnyPick backup stays untouched for a later Reset.
func (a *claudeAdapter) RestoreNative() error {
	if err := stripClaudeManagedKeys(settingsPath(a.home)); err != nil {
		return err
	}
	removeClientEnvFiles(anyPickRootFallback(), "claude")
	return nil
}

// stripClaudeManagedKeys removes exactly the keys the managed marker names,
// preserving every user key. Without a marker there is nothing provably
// AnyPick-owned to remove, so the file is left untouched — a hardcoded
// fallback would delete user-set values.
func stripClaudeManagedKeys(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		return nil
	}
	var keys []string
	if rawMarker, ok := doc[anypickManagedKey]; ok {
		var marker struct {
			Keys []string `json:"keys"`
		}
		if json.Unmarshal(rawMarker, &marker) == nil {
			keys = marker.Keys
		}
	}
	if len(keys) == 0 {
		return nil
	}
	var env map[string]interface{}
	if rawEnv, ok := doc["env"]; ok {
		_ = json.Unmarshal(rawEnv, &env)
	}
	if env == nil {
		env = map[string]interface{}{}
	}
	changed := false
	for _, k := range keys {
		if _, ok := env[k]; ok {
			delete(env, k)
			changed = true
		}
	}
	if _, ok := doc[anypickManagedKey]; ok {
		delete(doc, anypickManagedKey)
		changed = true
	}
	if !changed {
		return nil
	}
	envJSON, _ := json.Marshal(env)
	doc["env"] = envJSON
	out, err := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, append(out, '\n'), 0o600)
}

func (a *claudeAdapter) Inspect() (*InspectResult, error) {
	raw, err := os.ReadFile(settingsPath(a.home))
	if err != nil {
		if os.IsNotExist(err) {
			return &InspectResult{Native: true, Issues: []string{"settings.json not found"}}, nil
		}
		return nil, err
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		return &InspectResult{Present: false, Issues: []string{"settings.json unreadable"}}, nil
	}
	var env map[string]json.RawMessage
	if rawEnv, ok := doc["env"]; ok {
		if json.Unmarshal(rawEnv, &env) != nil {
			return &InspectResult{Issues: []string{"settings env unreadable"}}, nil
		}
	}
	// These overrides can select API credentials or a different upstream even
	// while a subscription remains signed in. The marker alone proves neither
	// a live managed route nor a native login.
	native := true
	for _, key := range []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
	} {
		if value, ok := env[key]; ok && string(value) != `""` && string(value) != "null" {
			native = false
		}
	}
	if value, ok := doc["apiKeyHelper"]; ok && string(value) != `""` && string(value) != "null" {
		native = false
	}
	if native {
		return &InspectResult{Native: true, RoutingChanged: true, Issues: []string{"no anypick-managed route"}}, nil
	}
	_, hasEnv := doc["env"]
	_, hasMarker := doc[anypickManagedKey]
	if hasEnv && hasMarker {
		return &InspectResult{Present: true}, nil
	}
	return &InspectResult{Present: false, Issues: []string{"no anypick-managed env block"}}, nil
}

func writeClientEnvFiles(root, clientID string, env map[string]string) []string {
	dir := filepath.Join(root, "clients", clientID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil
	}
	var b strings.Builder
	var powershell strings.Builder
	b.WriteString("# Generated by AnyPick — source this to match settings.json\n")
	powershell.WriteString("# Generated by AnyPick — dot-source to apply the client environment\n")
	for _, k := range sortedKeys(env) {
		quoted := fmt.Sprintf("%q", env[k])
		quoted = strings.NewReplacer("$", `\$`, "`", "\\`").Replace(quoted)
		b.WriteString(fmt.Sprintf("export %s=%s\n", k, quoted))
		powershell.WriteString(fmt.Sprintf("$env:%s = '%s'\n", k, strings.ReplaceAll(env[k], "'", "''")))
	}
	path := filepath.Join(dir, "env.sh")
	// Generated mirror under our own root; atomic all the same — a half-written
	// env.sh is still a broken source target.
	if err := atomicfile.Write(path, []byte(b.String()), 0o600); err != nil {
		return nil
	}
	psPath := filepath.Join(dir, "env.ps1")
	if err := atomicfile.Write(psPath, []byte(powershell.String()), 0o600); err != nil {
		return nil
	}
	return []string{path, psPath}
}

func stringField(m map[string]json.RawMessage, key string) string {
	raw, ok := m[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func (a *claudeAdapter) ShortName() string { return "Claude" }

// Compile-time: the direct-account unroute path above must keep working.
var _ NativeRestorer = (*claudeAdapter)(nil)
