package client

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// dshAdapter configures the DeepSeek Harness (dsh) CLI. dsh is a Cordis-based
// harness whose DeepSeek adapter (route deepseek-official) reads its API key
// from an environment variable (DEEPSEEK_API_KEY) and its endpoint from
// $DEEPSEEK_BASE_URL. The key lives in the harness home's .env (read by dsh
// as environment layers); the base URL must come from the launching
// environment instead — newer dsh refuses to start when .env sets it, since
// it decides how the process reaches the network. Because baseURL is
// overridable, dsh can ride AnyPick's gateway to any upstream, not only
// DeepSeek.
type dshAdapter struct{ home string }

func newDsh(home string) *dshAdapter { return &dshAdapter{home: home} }

const (
	dshEnvKeyAPI  = "DEEPSEEK_API_KEY"
	dshEnvKeyBase = "DEEPSEEK_BASE_URL"

	// AnyPick-owned block markers inside the user's cordis.patch.yml. dsh
	// applies every row in that file after the profile, so appending a row
	// targeted by id replaces/applies it (Cordis patch semantics).
	dshPatchBegin = "# anypick:dsh"
	dshPatchEnd   = "# anypick:dsh:end"

	// dsh's default-model plugin id and the route its DeepSeek adapter owns.
	dshDefaultModelID = "agent-default-model"
	dshProviderRoute  = "deepseek-official"

	// AnyPick-owned block markers inside the user's settings.yaml. Unlike
	// cordis patch rows (whole-config replace), a user-settings section
	// overrides per field and hot-reloads, so a partial llm-deepseek section
	// cannot wipe the plugin's other settings.
	dshSettingsBegin = "# anypick:dsh-settings"
	dshSettingsEnd   = "# anypick:dsh-settings:end"
)

func (a *dshAdapter) ID() string   { return "dsh" }
func (a *dshAdapter) Name() string { return "DeepSeek Harness" }
func (a *dshAdapter) ShortName() string {
	return "dsh"
}

func (a *dshAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "dsh",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		// dsh ships with a provider-specific placeholder model. It must be
		// replaced with a model from the selected source before it can use a
		// subscription proxy; otherwise WorkBuddy rejects `deepseek-flash`.
		RequiresDefaultModel:       true,
		SupportsEnvironmentOverlay: true,
		ProtocolPreference:         transport.OpenAI,
	}
}

// dshHome resolves the harness home: $DSH_HOME when set and we are targeting
// the live home, otherwise ~/.dsh. Mirrors gemini's config-dir resolution so an
// isolated run never reaches the user's real harness home.
func dshHome(home string) string {
	if env := os.Getenv("DSH_HOME"); env != "" && home == liveHome() {
		return env
	}
	return filepath.Join(home, ".dsh")
}

func dshEnvPath(home string) string   { return filepath.Join(dshHome(home), ".env") }
func dshPatchPath(home string) string { return filepath.Join(dshHome(home), "cordis.patch.yml") }

// dshSettingsPath is the user settings document dsh hot-reloads
// (~/.dsh/settings.yaml in default setups). A JSON document, if the user
// chose one, is left alone: only the default YAML mount is managed.
func dshSettingsPath(home string) string {
	return filepath.Join(dshHome(home), "settings.yaml")
}

// DshConfigPaths reports the live harness files Apply may write.
// Shared with the runtime recovery journal so backup and apply cannot drift.
func DshConfigPaths(home string) []string {
	return []string{dshEnvPath(home), dshPatchPath(home), dshSettingsPath(home)}
}

func (a *dshAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	targetHome := ctx.Home
	if ctx.IsolatedHome != "" {
		targetHome = ctx.IsolatedHome
	}
	baseURL := strings.TrimSuffix(ctx.Endpoint, "/") + "/v1"

	// The secret may live in .env (a credential, not launch config). The base
	// URL must not: newer dsh aborts when a layered file sets it.
	dotEnv := map[string]string{}
	if ctx.APIKey != "" {
		dotEnv[dshEnvKeyAPI] = ctx.APIKey
	}
	launcherEnv := map[string]string{}
	for k, v := range dotEnv {
		launcherEnv[k] = v
	}
	if ctx.Endpoint != "" {
		launcherEnv[dshEnvKeyBase] = baseURL
	}
	model := firstNonEmpty(ctx.ModelRoles["default"], ctx.DefaultModel)
	modelCatalog := dshModelCatalog(ctx.ModelCatalog, model)
	managedEnvKeys := sortedKeys(launcherEnv)

	if ctx.DryRun {
		return &ApplyResult{
			ManagedPaths: []string{
				dshEnvPath(targetHome),
				dshPatchPath(targetHome),
				dshSettingsPath(targetHome),
				filepath.Join(ctx.AnyPickRoot, "clients", "dsh", "env.sh"),
				filepath.Join(ctx.AnyPickRoot, "clients", "dsh", "env.ps1"),
			},
			ManagedEnvKeys: managedEnvKeys,
		}, nil
	}

	managedPaths, err := applyDshHomeConfig(
		targetHome, dotEnv, ctx.Endpoint, baseURL, model, modelCatalog,
	)
	if err != nil {
		return nil, err
	}

	// Persistent (non-isolated) also emits launcher env files the desktop app
	// sources before spawning dsh. The base URL travels here — the launching
	// environment dsh requires — never in .env.
	if ctx.IsolatedHome == "" {
		managedPaths = append(managedPaths, writeClientEnvFiles(ctx.AnyPickRoot, "dsh", launcherEnv)...)
	}

	return &ApplyResult{ManagedPaths: managedPaths, ManagedEnvKeys: managedEnvKeys}, nil
}

func applyDshHomeConfig(
	targetHome string,
	dotEnv map[string]string,
	endpoint, baseURL, model string,
	modelCatalog []string,
) ([]string, error) {
	if err := os.MkdirAll(dshHome(targetHome), 0o700); err != nil {
		return nil, err
	}
	if err := upsertEnvFile(dshEnvPath(targetHome), dotEnv); err != nil {
		return nil, err
	}
	// Newer dsh rejects a base URL in .env; heal files written by old builds.
	if err := stripKeysFromEnv(dshEnvPath(targetHome), []string{dshEnvKeyBase}); err != nil {
		return nil, err
	}
	managedPaths := []string{dshEnvPath(targetHome)}
	if model != "" {
		if err := mergeDshCordisPatch(dshPatchPath(targetHome), model); err != nil {
			return nil, err
		}
		managedPaths = append(managedPaths, dshPatchPath(targetHome))
	}
	// DSH's settings layer overrides the composition patch and the last web
	// selection, so keep endpoint, catalog, and default model together.
	if endpoint != "" || model != "" || len(modelCatalog) > 0 {
		if err := mergeDshSettings(dshSettingsPath(targetHome), baseURL, model, modelCatalog); err != nil {
			return nil, err
		}
		managedPaths = append(managedPaths, dshSettingsPath(targetHome))
	}
	return managedPaths, nil
}

func dshCordisPatchBlock(model string) string {
	var b strings.Builder
	b.WriteString(dshPatchBegin)
	// Home-level patches target an existing composition row by id. A `name`
	// only row is an insertion in older Cordis versions, and current dsh
	// rejects it before boot with "id is required"; keep the target id aligned
	// with the row shipped by dsh-base.
	b.WriteString("\n- id: ")
	b.WriteString(dshDefaultModelID)
	b.WriteString("\n")
	b.WriteString("  config:\n")
	b.WriteString("    provider: ")
	b.WriteString(dshProviderRoute)
	b.WriteString("\n")
	b.WriteString("    model: ")
	// Model ids come from a provider response; quoting keeps a value that
	// contains YAML punctuation from changing the row's shape.
	b.WriteString(dshYAMLScalar(model))
	b.WriteString("\n")
	b.WriteString(dshPatchEnd)
	b.WriteString("\n")
	return b.String()
}

// mergeDshCordisPatch writes or updates the AnyPick-managed block in the
// home-level cordis patch. cordis.patch.yml is a sequence of rows; we append a
// row targeted by id, which Cordis applies over the profile. A non-sequence
// file (map, etc.) is left untouched and rejected, exactly as the other
// adapters refuse to overwrite unreadable config.
func mergeDshCordisPatch(path, model string) error {
	block := dshCordisPatchBlock(model)
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return writeDshFile(path, []byte(block))
	}
	if err != nil {
		return err
	}
	if !dshPatchIsSequence(string(raw)) {
		return anyerr.Newf(
			"Refusing to modify non-sequence cordis patch at "+path+".",
			"CLIENT_CONFIG_INVALID")
	}
	cleaned, err := stripMarkedBlock(string(raw), dshPatchBegin, dshPatchEnd, path)
	if err != nil {
		return err
	}
	out := strings.TrimRight(cleaned, "\n")
	if out != "" {
		out += "\n"
	}
	out += block
	return writeDshFile(path, []byte(out))
}

// writeDshFile replaces a user-owned config file atomically (rename, never
// truncation): a crash mid-write must not leave a half-written login or
// settings file. An existing file keeps its permission bits; only brand-new
// files are created 0600.
func writeDshFile(path string, data []byte) error {
	perm := os.FileMode(0o600)
	if fi, err := os.Stat(path); err == nil {
		perm = fi.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return err
	}
	return atomicfile.Write(path, data, perm)
}

// stripMarkedBlock removes the lines between begin and end markers,
// preserving everything else. Markers must be balanced: a begin without its
// end (or an end without a begin) fails closed instead of silently dropping
// the tail of the user's file on the next overwrite.
func stripMarkedBlock(s, begin, end, what string) (string, error) {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	depth := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch trimmed {
		case begin:
			depth++
			continue
		case end:
			if depth == 0 {
				return "", anyerr.Newf(
					"Unbalanced AnyPick block in "+what+": end marker without begin.",
					"CLIENT_CONFIG_INVALID")
			}
			depth--
			continue
		}
		if depth == 0 {
			out = append(out, line)
		}
	}
	if depth != 0 {
		return "", anyerr.Newf(
			"Unbalanced AnyPick block in "+what+": begin marker without end; refusing to rewrite.",
			"CLIENT_CONFIG_INVALID")
	}
	return strings.Join(out, "\n"), nil
}

func dshPatchIsSequence(s string) bool {
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		return strings.HasPrefix(t, "-")
	}
	return true
}

// mergeDshSettingsEndpoint writes or updates the AnyPick-managed
// llm-deepseek section in the user's settings.yaml. The settings service
// merges per field and hot-reloads, so unrelated user content (comments,
// other sections) survives untouched. A user-owned top-level llm-deepseek
// section outside the markers is refused instead of duplicated: two mapping
// keys would make dsh fail its boot loud.
func mergeDshSettingsEndpoint(path, baseURL string) error {
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	out, err := dshSettingsWithEndpoint(string(raw), baseURL)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writeDshFile(path, []byte(out))
}

func dshSettingsBlockWithModel(baseURL, model string, modelCatalog []string) string {
	var b strings.Builder
	b.WriteString(dshSettingsBegin)
	b.WriteString("\n")
	if baseURL != "" || len(modelCatalog) > 0 {
		b.WriteString("llm-deepseek:\n")
		if baseURL != "" {
			b.WriteString("  baseURL: ")
			// The endpoint is produced by AnyPick, not a provider response;
			// keeping it plain also preserves the existing native YAML shape.
			b.WriteString(baseURL)
			b.WriteString("\n")
		}
		if len(modelCatalog) > 0 {
			b.WriteString("  models:\n")
			for _, id := range modelCatalog {
				b.WriteString("    - id: ")
				b.WriteString(dshYAMLScalar(id))
				b.WriteString("\n      name: ")
				b.WriteString(dshYAMLScalar(id))
				b.WriteString("\n")
			}
		}
	}
	if model != "" {
		b.WriteString("agent-default-model:\n")
		b.WriteString("  provider: ")
		b.WriteString(dshYAMLScalar(dshProviderRoute))
		b.WriteString("\n  model: ")
		b.WriteString(dshYAMLScalar(model))
		b.WriteString("\n")
	}
	b.WriteString(dshSettingsEnd)
	b.WriteString("\n")
	return b.String()
}

func dshYAMLScalar(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func dshModelCatalog(models []string, selected string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(models)+1)
	push := func(value string) {
		value = strings.TrimSpace(value)
		// Model ids come from a provider response. Reject line breaks before
		// serializing them into YAML so an upstream cannot inject settings.
		if value == "" || strings.ContainsAny(value, "\r\n") || seen[value] {
			return
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, value := range models {
		push(value)
	}
	push(selected)
	return out
}

func dshSettingsKeyLine(line, key string) bool {
	trimmed := strings.TrimSpace(line)
	for _, quote := range []string{"", `"`, `'`} {
		prefix := quote + key + quote + ":"
		if strings.HasPrefix(trimmed, prefix) {
			rest := strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
			if rest == "" || strings.HasPrefix(rest, "#") {
				return true
			}
		}
	}
	return false
}

func dshSettingsWithConfig(
	existing, baseURL, model string, modelCatalog []string,
) (string, error) {
	stripped, err := stripMarkedBlock(existing, dshSettingsBegin, dshSettingsEnd, "settings.yaml")
	if err != nil {
		return "", err
	}
	lines := strings.Split(stripped, "\n")
	if model != "" {
		// DSH's own model picker persists its selection as a top-level
		// agent-default-model section. AnyPick must carry that key inside its
		// managed block: two top-level copies would make the YAML document
		// ambiguous and break the next harness boot, so the existing section
		// is taken over. An llm-deepseek section stays refused: that is
		// deliberate endpoint configuration, not harness-owned state.
		//
		// Taking the key over does not mean overwriting the selection. The
		// harness's choice survives whenever it is still in the catalog being
		// published, so refreshing that catalog — a hub gained a source, a
		// vendor added an id — never silently returns the user to the model
		// they moved off. A selection the catalog no longer offers is not
		// preservable: the harness would boot pointing at a model it cannot
		// reach, so the activation's model wins.
		if current := dshHarnessSelectedModel(lines); current != "" &&
			dshCatalogContains(modelCatalog, current) {
			model = current
		}
		lines = takeDshDefaultModelSection(lines)
	}
	var out []string
	for _, line := range lines {
		if dshSettingsKeyLine(line, "llm-deepseek") {
			return "", anyerr.Newf(
				"Your settings.yaml already has its own llm-deepseek: section; "+
					"remove it or point it at the proxy before AnyPick manages the connection.",
				"CLIENT_CONFIG_INVALID")
		}
		out = append(out, line)
	}
	cleaned := strings.TrimRight(strings.Join(out, "\n"), "\n")
	if cleaned != "" {
		cleaned += "\n"
	}
	return cleaned + dshSettingsBlockWithModel(
		baseURL, model, dshModelCatalog(modelCatalog, model),
	), nil
}

// dshTopLevelKeyLine reports whether the line declares key at the document's
// top level, in section (`key:`) or inline (`key: {…}`) form. Indented lines
// are children of another key and never match, so adoption cannot delete a
// nested section that merely happens to share the name.
func dshTopLevelKeyLine(line, key string) bool {
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

// dshCatalogContains reports whether the published catalog still offers id.
// Checked against the caller's raw catalog, never against the rendered list:
// dshModelCatalog appends the selected model, so a selection would always look
// present and preservation would never fall back.
func dshCatalogContains(models []string, id string) bool {
	for _, m := range models {
		if strings.TrimSpace(m) == id {
			return true
		}
	}
	return false
}

// dshHarnessSelectedModel reads the model id out of a top-level
// agent-default-model section, accepting the bare, single-quoted and
// double-quoted forms. Blank lines inside the section are skipped, matching
// takeDshDefaultModelSection so the two agree on where the section ends.
func dshHarnessSelectedModel(lines []string) string {
	inSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		indented := len(line) != len(strings.TrimLeft(line, " \t"))
		if inSection {
			if trimmed == "" || indented {
				if indented {
					if value := dshYAMLValue(trimmed, "model"); value != "" {
						return value
					}
				}
				continue
			}
			inSection = false
		}
		if dshTopLevelKeyLine(line, "agent-default-model") {
			inSection = true
		}
	}
	return ""
}

// dshYAMLValue reads `key: value` out of one indented line and unwraps the
// quoting dshYAMLScalar applies (or does not) to a model id.
func dshYAMLValue(trimmed, key string) string {
	for _, quote := range []string{"", `"`, `'`} {
		prefix := quote + key + quote + ":"
		if !strings.HasPrefix(trimmed, prefix) {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
		if len(value) >= 2 && strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
			return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
		if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			return value[1 : len(value)-1]
		}
		return value
	}
	return ""
}

// takeDshDefaultModelSection removes a top-level agent-default-model mapping —
// the section DSH's own model picker writes — while preserving every other
// line. The key line plus its indented continuation (and blank separators
// inside it) are dropped; the document's remaining keys keep their order.
func takeDshDefaultModelSection(lines []string) []string {
	out := make([]string, 0, len(lines))
	inSection := false
	for _, line := range lines {
		if inSection {
			trimmed := strings.TrimSpace(line)
			indented := len(line) != len(strings.TrimLeft(line, " \t"))
			if trimmed == "" || indented {
				continue
			}
			inSection = false
		}
		if dshTopLevelKeyLine(line, "agent-default-model") {
			inSection = true
			continue
		}
		out = append(out, line)
	}
	return out
}

func dshSettingsWithEndpoint(existing, baseURL string) (string, error) {
	return dshSettingsWithConfig(existing, baseURL, "", nil)
}

func mergeDshSettings(path, baseURL, model string, modelCatalog []string) error {
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	out, err := dshSettingsWithConfig(string(raw), baseURL, model, modelCatalog)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writeDshFile(path, []byte(out))
}

// stripDshSettingsBlock removes the AnyPick-managed settings section,
// preserving everything else. Empty remainder means the file is ours alone.
// Unbalanced markers fail closed: Reset must not rewrite a file it cannot
// parse.
func stripDshSettingsBlock(s string) (string, bool, error) {
	stripped, err := stripMarkedBlock(s, dshSettingsBegin, dshSettingsEnd, "settings.yaml")
	if err != nil {
		return "", false, err
	}
	rest := strings.TrimSpace(stripped)
	return rest, rest == "", nil
}

// stripDshManagedBlock removes the AnyPick-managed block (between markers),
// preserving every other line the user or another tool wrote. Unbalanced
// markers fail closed (see stripMarkedBlock).
func stripDshManagedBlock(s string) (string, error) {
	return stripMarkedBlock(s, dshPatchBegin, dshPatchEnd, "cordis.patch.yml")
}

func (a *dshAdapter) Reset() error {
	liveEnv := dshEnvPath(a.home)
	if _, err := os.Stat(liveEnv); err == nil {
		if err := stripKeysFromEnv(liveEnv, []string{dshEnvKeyAPI, dshEnvKeyBase}); err != nil {
			return err
		}
	}
	patchPath := dshPatchPath(a.home)
	if _, err := os.Stat(patchPath); err == nil {
		raw, rerr := os.ReadFile(patchPath)
		if rerr != nil {
			return rerr
		}
		cleaned, cerr := stripDshManagedBlock(string(raw))
		if cerr != nil {
			return cerr
		}
		cleaned = strings.TrimSpace(cleaned)
		if cleaned == "" {
			_ = os.Remove(patchPath)
		} else if werr := writeDshFile(patchPath, []byte(cleaned+"\n")); werr != nil {
			return werr
		}
	}
	settingsPath := dshSettingsPath(a.home)
	if raw, err := os.ReadFile(settingsPath); err == nil {
		rest, empty, rerr := stripDshSettingsBlock(string(raw))
		if rerr != nil {
			return rerr
		}
		if empty {
			_ = os.Remove(settingsPath)
		} else if werr := writeDshFile(settingsPath, []byte(rest+"\n")); werr != nil {
			return werr
		}
	}
	removeClientEnvFiles(anyPickRootFallback(), "dsh")
	return nil
}

func (a *dshAdapter) Inspect() (*InspectResult, error) {
	res := &InspectResult{Present: false, Summary: "no dsh config"}
	if raw, err := os.ReadFile(dshEnvPath(a.home)); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			t := strings.TrimSpace(line)
			if strings.HasPrefix(t, dshEnvKeyAPI+"=") || strings.HasPrefix(t, dshEnvKeyBase+"=") {
				res.Present = true
			}
		}
	}
	if raw, err := os.ReadFile(dshPatchPath(a.home)); err == nil {
		if strings.Contains(string(raw), dshPatchBegin) {
			res.Present = true
		}
	}
	if raw, err := os.ReadFile(dshSettingsPath(a.home)); err == nil {
		if strings.Contains(string(raw), dshSettingsBegin) {
			res.Present = true
		}
	}
	if res.Present {
		res.Summary = "AnyPick proxy configured"
	}
	if !res.Present {
		for _, path := range DshConfigPaths(a.home) {
			if _, err := os.Stat(path); err == nil {
				res.RoutingChanged = true
			}
		}
	}
	return res, nil
}
