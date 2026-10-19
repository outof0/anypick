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

// geminiAdapter applies API-key/env runtime config into ~/.gemini/.env
// plus a managed marker in settings.json.
type geminiAdapter struct{ home string }

func newGemini(home string) *geminiAdapter { return &geminiAdapter{home: home} }

func (a *geminiAdapter) ID() string   { return "gemini" }
func (a *geminiAdapter) Name() string { return "Gemini CLI" }
func (a *geminiAdapter) ShortName() string {
	return "Gemini"
}

func (a *geminiAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "gemini",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		ProtocolPreference:       transport.OpenAI,
	}
}

// geminiDir resolves ~/.gemini the way the real CLI does.
//
// GEMINI_CLI_HOME is what @google/gemini-cli actually reads (verified against
// the 0.59.0 npm bundle): its homedir() returns that variable and it replaces
// HOME, so the config dir is "$GEMINI_CLI_HOME/.gemini" — not the variable
// itself.
//
// GEMINI_CONFIG_DIR does not exist in the CLI (zero hits in that bundle). It
// survives here only as AnyPick's own knob for tests and explicit overrides,
// and it MUST lose to GEMINI_CLI_HOME: when both are set the CLI follows
// GEMINI_CLI_HOME, so AnyPick has to as well, or it writes a file the CLI
// never opens. In an isolated home that is worse than a wrong path — it means
// writing into the sandbox while the CLI reads the real ~/.gemini.
func geminiDir(home string) string {
	if home == liveHome() {
		if cliHome := os.Getenv("GEMINI_CLI_HOME"); cliHome != "" {
			return filepath.Join(cliHome, ".gemini")
		}
		if env := os.Getenv("GEMINI_CONFIG_DIR"); env != "" {
			return env
		}
	}
	return filepath.Join(home, ".gemini")
}

// geminiCredentialFiles are the OAuth files a Gemini login may leave behind.
// Which one exists is a property of the app that wrote the login, not of
// AnyPick: gemini-cli writes oauth_creds.json, Antigravity writes
// antigravity_oauth.json or the standalone Jetski token. Gemini CLI and
// Antigravity are one identity, so any of them is a usable login — read it
// wherever it happens to be.
//
// This duplicates provider/gemini_credential.go on purpose: client stays
// importable by provider, not the other way round, so the two packages cannot
// share one constant. That file is the authority — update both together.
var geminiCredentialFiles = []string{
	"oauth_creds.json",
	"antigravity_oauth.json",
	"jetski-standalone-oauth-token",
}

func geminiRestoredCredential(home string) string {
	dir := geminiDir(home)
	for _, name := range geminiCredentialFiles {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return name
		}
	}
	return ""
}

func geminiEnvPath(home string) string      { return filepath.Join(geminiDir(home), ".env") }
func geminiSettingsPath(home string) string { return filepath.Join(geminiDir(home), "settings.json") }

// GeminiConfigPaths reports the live Gemini files Apply may write:
// the layered .env plus the managed marker in settings.json.
// Shared with the runtime recovery journal so backup and apply cannot drift.
func GeminiConfigPaths(home string) []string {
	return []string{geminiEnvPath(home), geminiSettingsPath(home)}
}

func liveHome() string {
	home, _ := os.UserHomeDir()
	if env := os.Getenv("HOME"); env != "" {
		return env
	}
	return home
}

func (a *geminiAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}

	env := map[string]string{}
	if ctx.APIKey != "" {
		env["GEMINI_API_KEY"] = ctx.APIKey
	}
	if ctx.Endpoint != "" {
		// GOOGLE_GEMINI_BASE_URL is real and documented: @google/gemini-cli
		// 0.59.0 (docs/reference/configuration.md) honours it for
		// gemini-api-key auth, flips the CLI to AuthType.GATEWAY, and allows
		// plain http for localhost. It is still not a way to aim the CLI at
		// AnyPick's proxy: with it set the CLI speaks Generative Language
		// (POST /v1beta/models/<model>:generateContent), while the proxy
		// serves OpenAI/Anthropic (/v1/chat/completions, /v1/responses,
		// /v1/messages). Kept for gateway profiles that do speak Generative
		// Language.
		//
		// GEMINI_API_BASE_URL was written next to it once. The CLI has never
		// read it — zero hits in the 0.59.0 bundle. It belongs to the Google
		// GenAI SDK, not to the CLI.
		env["GOOGLE_GEMINI_BASE_URL"] = ctx.Endpoint
	}
	if defaultModel := firstNonEmpty(ctx.ModelRoles["default"], ctx.DefaultModel); defaultModel != "" {
		env["GEMINI_MODEL"] = defaultModel
	}
	for k, v := range ctx.ExtraEnv {
		if v == "" {
			continue
		}
		if strings.HasPrefix(k, "GEMINI_") || strings.HasPrefix(k, "GOOGLE_") ||
			k == "GOOGLE_APPLICATION_CREDENTIALS" {
			env[k] = v
		}
	}

	targetEnv := geminiEnvPath(targetHome)
	targetSettings := geminiSettingsPath(targetHome)
	managedPaths := []string{targetEnv, targetSettings}
	managedEnvKeys := sortedKeys(env)

	if ctx.DryRun {
		managedPaths = append(managedPaths,
			filepath.Join(ctx.AnyPickRoot, "clients", "gemini", "env.sh"),
			filepath.Join(ctx.AnyPickRoot, "clients", "gemini", "env.ps1"))
		return &ApplyResult{ManagedPaths: managedPaths, ManagedEnvKeys: managedEnvKeys}, nil
	}

	// Existing user config is authoritative. A malformed JSON file must never
	// be replaced with an empty object — fail before touching anything.
	doc := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(targetSettings); err == nil {
		var parsed map[string]json.RawMessage
		if json.Unmarshal(raw, &parsed) != nil || !jsonLooksObject(raw) {
			return nil, anyerr.Newf(
				fmt.Sprintf("Refusing to overwrite unreadable Gemini settings at %s: root value is not an object", targetSettings),
				"CLIENT_CONFIG_INVALID")
		}
		doc = parsed
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	var envPaths []string
	if ctx.IsolatedHome == "" {
		envPaths = writeClientEnvFiles(ctx.AnyPickRoot, "gemini", env)
	}

	if err := os.MkdirAll(geminiDir(targetHome), 0o700); err != nil {
		return nil, err
	}
	if err := upsertEnvFile(targetEnv, env); err != nil {
		return nil, err
	}

	marker, _ := json.Marshal(map[string]interface{}{"keys": managedEnvKeys})
	doc[anypickManagedKey] = marker
	out, err := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if err != nil {
		return nil, err
	}
	// targetSettings is the user's live Gemini settings (ADR 0004): rename, not truncate.
	if err := atomicfile.Write(targetSettings, append(out, '\n'), 0o600); err != nil {
		return nil, err
	}
	managedPaths = append(managedPaths, envPaths...)
	return &ApplyResult{ManagedPaths: managedPaths, ManagedEnvKeys: managedEnvKeys}, nil
}

// jsonLooksObject guards against arrays/scalars parsed into a non-map type.
func jsonLooksObject(raw []byte) bool {
	for _, c := range raw {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return false
}

func (a *geminiAdapter) Reset() error {
	liveEnv := geminiEnvPath(a.home)
	keys, _ := readManagedMarkerKeys(geminiSettingsPath(a.home))
	if len(keys) == 0 {
		// Fall back to the keys this adapter owns by construction.
		// GEMINI_API_BASE_URL is no longer written (see Apply) but stays here
		// so a reset still scrubs it out of .env files written by older builds.
		keys = []string{"GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GEMINI_API_BASE_URL", "GEMINI_MODEL"}
	}
	if _, err := os.Stat(liveEnv); err == nil {
		if err := stripKeysFromEnv(liveEnv, keys); err != nil {
			return err
		}
	}
	if raw, err := os.ReadFile(geminiSettingsPath(a.home)); err == nil {
		var doc map[string]json.RawMessage
		if json.Unmarshal(raw, &doc) == nil {
			delete(doc, anypickManagedKey)
			if out, merr := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  "); merr == nil {
				_ = atomicfile.Write(geminiSettingsPath(a.home), append(out, '\n'), 0o600)
			}
		}
	}
	removeClientEnvFiles(anyPickRootFallback(), "gemini")
	return nil
}

// RestoreNative unroutes a proxy binding when activation switches back to a
// native account. The live .env may still carry the keys Apply wrote for the
// proxy (GEMINI_API_KEY = proxy token, GOOGLE_GEMINI_BASE_URL = loopback
// endpoint); leaving them behind points the CLI at a stopped proxy. Only keys
// the managed marker lists are removed — a user key Apply never overwrote is
// not in that list and survives.
func (a *geminiAdapter) RestoreNative() error {
	liveEnv := geminiEnvPath(a.home)
	if keys, _ := readManagedMarkerKeys(geminiSettingsPath(a.home)); len(keys) > 0 {
		if _, err := os.Stat(liveEnv); err == nil {
			if err := stripKeysFromEnv(liveEnv, keys); err != nil {
				return err
			}
		}
	}
	if raw, err := os.ReadFile(geminiSettingsPath(a.home)); err == nil {
		var doc map[string]json.RawMessage
		if json.Unmarshal(raw, &doc) == nil {
			if _, ok := doc[anypickManagedKey]; ok {
				delete(doc, anypickManagedKey)
				if out, merr := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  "); merr == nil {
					_ = atomicfile.Write(geminiSettingsPath(a.home), append(out, '\n'), 0o600)
				}
			}
		}
	}
	removeClientEnvFiles(anyPickRootFallback(), "gemini")
	return nil
}

func (a *geminiAdapter) Inspect() (*InspectResult, error) {
	_, envErr := os.Stat(geminiEnvPath(a.home))
	_, setErr := os.Stat(geminiSettingsPath(a.home))
	present := envErr == nil || setErr == nil
	res := &InspectResult{Present: present}
	res.Native = true
	if setErr != nil && !os.IsNotExist(setErr) {
		res.Native = false
	}
	if raw, err := os.ReadFile(geminiEnvPath(a.home)); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
			key, value, ok := strings.Cut(line, "=")
			if !ok || strings.HasPrefix(key, "#") {
				continue
			}
			for _, override := range []string{"GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GEMINI_API_BASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI"} {
				if strings.TrimSpace(key) == override && strings.Trim(strings.TrimSpace(value), `"'`) != "" {
					res.Native = false
				}
			}
		}
	} else if !os.IsNotExist(err) {
		res.Native = false
	}
	// A direct activation restores the OAuth file and writes neither .env nor
	// settings.json, so the two paths above are blind to it and every direct
	// gemini activation ended with "gemini reports no anypick-managed
	// configuration after activation" even though the login had been
	// restored. Any OAuth file counts, whichever app wrote it.
	if name := geminiRestoredCredential(a.home); name != "" {
		res.Present = true
		res.Summary = "restored " + name
	}
	if setErr == nil {
		keys, err := readManagedMarkerKeys(geminiSettingsPath(a.home))
		if err != nil {
			res.Native = false
			res.Issues = []string{"settings.json unreadable"}
			return res, nil
		}
		switch {
		case len(keys) > 0:
			res.Summary = fmt.Sprintf("anypick-managed env keys: %d", len(keys))
		case res.Summary == "":
			// A restored credential already set a more useful summary.
			res.Summary = "settings present"
		}
	}
	res.RoutingChanged = res.Native && res.Present
	return res, nil
}

// Compile-time: the direct-account unroute path above must keep working.
var _ NativeRestorer = (*geminiAdapter)(nil)

// readManagedMarkerKeys extracts _anypickManaged.keys from a settings file.
func readManagedMarkerKeys(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Managed struct {
			Keys []string `json:"keys"`
		} `json:"_anypickManaged"`
	}
	if json.Unmarshal(raw, &doc) != nil || !jsonLooksObject(raw) {
		return nil, fmt.Errorf("unreadable settings")
	}
	return doc.Managed.Keys, nil
}

// upsertEnvFile writes KEY=VALUE lines for every entry, preserving unrelated
// lines and comments in the existing file.
func upsertEnvFile(path string, env map[string]string) error {
	existing, _ := os.ReadFile(path)
	lines := strings.Split(string(existing), "\n")
	seen := map[string]bool{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key := trimmed
		if eq := strings.Index(trimmed, "="); eq >= 0 {
			key = strings.TrimSpace(trimmed[:eq])
		}
		if v, ok := env[key]; ok {
			lines[i] = fmt.Sprintf("%s=%s", key, quoteEnvValue(v))
			seen[key] = true
		}
	}
	for _, k := range sortedKeys(env) {
		if !seen[k] {
			lines = append(lines, fmt.Sprintf("%s=%s", k, quoteEnvValue(env[k])))
		}
	}
	out := strings.TrimRight(strings.Join(lines, "\n"), "\n")
	return atomicfile.Write(path, []byte(out+"\n"), 0o600)
}

func quoteEnvValue(v string) string {
	if v == "" {
		return ""
	}
	if strings.ContainsAny(v, " \t\"'#$\\") {
		b, _ := json.Marshal(v)
		return string(b)
	}
	return v
}

func stripKeysFromEnv(path string, keys []string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	drop := map[string]bool{}
	for _, k := range keys {
		drop[k] = true
	}
	lines := strings.Split(string(raw), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			out = append(out, line)
			continue
		}
		key := trimmed
		if eq := strings.Index(trimmed, "="); eq >= 0 {
			key = strings.TrimSpace(trimmed[:eq])
		}
		if drop[key] {
			continue
		}
		out = append(out, line)
	}
	// Reset rewrites the user's live .env (ADR 0004): rename, not truncate.
	return atomicfile.Write(path, []byte(strings.TrimRight(strings.Join(out, "\n"), "\n")+"\n"), 0o600)
}

func removeClientEnvFiles(root, clientID string) {
	dir := filepath.Join(root, "clients", clientID)
	_ = os.Remove(filepath.Join(dir, "env.sh"))
	_ = os.Remove(filepath.Join(dir, "env.ps1"))
}

func anyPickRootFallback() string {
	if env := os.Getenv("ANYPICK_HOME"); env != "" {
		return env
	}
	return filepath.Join(liveHome(), ".anypick")
}
