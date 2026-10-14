package client

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
)

func TestDshApplyWritesEnvAndPatch(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_HOME", root)
	a := newDsh(home)

	res, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-chat",
		AnyPickRoot:  root,
		Home:         home,
	})
	if err != nil {
		t.Fatal(err)
	}

	// .env carries the proxy key only: newer dsh aborts when a layered file
	// sets DEEPSEEK_BASE_URL, so the base URL travels in the launcher env.
	envRaw := mustRead(t, dshEnvPath(home))
	envText := string(envRaw)
	if !strings.Contains(envText, "DEEPSEEK_API_KEY=sk-test") {
		t.Fatalf(".env missing key:\n%s", envText)
	}
	if strings.Contains(envText, "DEEPSEEK_BASE_URL") {
		t.Fatalf(".env must not set DEEPSEEK_BASE_URL:\n%s", envText)
	}

	// The launcher env (what dsh requires) carries both.
	envSh := string(mustRead(t, filepath.Join(root, "clients", "dsh", "env.sh")))
	for _, want := range []string{
		`export DEEPSEEK_API_KEY="sk-test"`,
		`export DEEPSEEK_BASE_URL="http://127.0.0.1:9000/v1"`,
	} {
		if !strings.Contains(envSh, want) {
			t.Fatalf("env.sh missing %q:\n%s", want, envSh)
		}
	}

	// cordis patch pins the default model to the chosen account model.
	patchRaw := mustRead(t, dshPatchPath(home))
	patchText := string(patchRaw)
	for _, want := range []string{
		dshPatchBegin,
		"- id: " + dshDefaultModelID,
		"provider: " + dshProviderRoute,
		"model: 'deepseek-chat'",
		dshPatchEnd,
	} {
		if !strings.Contains(patchText, want) {
			t.Fatalf("cordis patch missing %q:\n%s", want, patchText)
		}
	}

	// Launcher env files emitted to the AnyPick root for persistent runs.
	foundEnvSh := false
	for _, p := range res.ManagedPaths {
		if strings.HasSuffix(p, "env.sh") {
			foundEnvSh = true
		}
	}
	if !foundEnvSh {
		t.Fatalf("env.sh missing from managed paths: %v", res.ManagedPaths)
	}

	// Reset must strip managed env keys and remove the managed block.
	if err := a.Reset(); err != nil {
		t.Fatal(err)
	}
	envAfter := string(mustRead(t, dshEnvPath(home)))
	if strings.Contains(envAfter, "DEEPSEEK_API_KEY") {
		t.Fatalf("reset left DEEPSEEK_API_KEY behind:\n%s", envAfter)
	}
	if _, err := os.Stat(dshPatchPath(home)); !os.IsNotExist(err) {
		t.Fatalf("reset left cordis patch at %s", dshPatchPath(home))
	}
}

func TestDshRequiresASelectedModel(t *testing.T) {
	if !newDsh(t.TempDir()).Capabilities().RequiresDefaultModel {
		t.Fatal("dsh must require a source model before activation")
	}
}

// The adapter endpoint rides the user settings document (hot-reloaded,
// per-field merge), so plain `dsh` runs need no exports. User content
// outside the markers survives; a user-owned llm-deepseek section is
// refused instead of duplicated (duplicate keys fail dsh boot loud).
func TestDshApplyWritesSettingsEndpoint(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("ANYPICK_HOME", root)
	a := newDsh(home)
	res, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-chat",
		AnyPickRoot:  root,
		Home:         home,
	})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range res.ManagedPaths {
		if p == dshSettingsPath(home) {
			found = true
		}
	}
	if !found {
		t.Fatalf("settings path missing from managed paths: %v", res.ManagedPaths)
	}
	settings := string(mustRead(t, dshSettingsPath(home)))
	for _, want := range []string{
		dshSettingsBegin,
		"llm-deepseek:",
		"baseURL: http://127.0.0.1:9000/v1",
		"models:",
		"id: 'deepseek-chat'",
		"agent-default-model:",
		"provider: 'deepseek-official'",
		"model: 'deepseek-chat'",
		dshSettingsEnd,
	} {
		if !strings.Contains(settings, want) {
			t.Fatalf("settings missing %q:\n%s", want, settings)
		}
	}

	// Re-apply is idempotent: exactly one managed block, user content kept.
	userYAML := "ui-theme:\n  preference: dark\n"
	if err := os.WriteFile(
		dshSettingsPath(home), []byte(userYAML+settings), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9001",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-chat",
		AnyPickRoot:  root,
		Home:         home,
	}); err != nil {
		t.Fatal(err)
	}
	again := string(mustRead(t, dshSettingsPath(home)))
	blocks := 0
	for _, line := range strings.Split(again, "\n") {
		if strings.TrimSpace(line) == dshSettingsBegin {
			blocks++
		}
	}
	if blocks != 1 {
		t.Fatalf("managed block duplicated:\n%s", again)
	}
	for _, want := range []string{
		"ui-theme:", "preference: dark", "baseURL: http://127.0.0.1:9001/v1",
	} {
		if !strings.Contains(again, want) {
			t.Fatalf("re-apply lost %q:\n%s", want, again)
		}
	}

	// A user-owned llm-deepseek section refuses loudly instead of forking
	// the mapping key.
	if err := os.WriteFile(
		dshSettingsPath(home), []byte("llm-deepseek:\n  baseURL: https://example.test\n"), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Apply(&ApplyContext{
		Endpoint: "http://127.0.0.1:9000", APIKey: "sk-test",
		AnyPickRoot: root, Home: home,
	}); err == nil {
		t.Fatal("user-owned llm-deepseek section accepted")
	}

	// Reset removes a file that holds only the managed block.
	fresh := t.TempDir()
	fa := newDsh(fresh)
	if _, err := fa.Apply(&ApplyContext{
		Endpoint: "http://127.0.0.1:9000", APIKey: "sk-test",
		AnyPickRoot: t.TempDir(), Home: fresh,
	}); err != nil {
		t.Fatal(err)
	}
	if err := fa.Reset(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dshSettingsPath(fresh)); !os.IsNotExist(err) {
		t.Fatalf("reset left sole-managed settings at %s", dshSettingsPath(fresh))
	}
}

func TestDshApplyWritesSourceModelCatalogAndSelectedModel(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	if _, err := newDsh(home).Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-v4.1-flash",
		ModelCatalog: []string{"deepseek-v4.1-flash", "gemini-3.8-flash", "deepseek-v4.1-flash"},
		AnyPickRoot:  root,
		Home:         home,
	}); err != nil {
		t.Fatal(err)
	}
	settings := string(mustRead(t, dshSettingsPath(home)))
	for _, want := range []string{
		"id: 'deepseek-v4.1-flash'",
		"id: 'gemini-3.8-flash'",
		"model: 'deepseek-v4.1-flash'",
	} {
		if strings.Count(settings, want) != 1 {
			t.Fatalf("settings should contain one %q, got:\n%s", want, settings)
		}
	}
	if strings.Contains(settings, "deepseek-flash") {
		t.Fatalf("bundled model alias leaked into managed settings:\n%s", settings)
	}
}

// DSH's own model picker persists its selection as a top-level
// agent-default-model section. AnyPick takes that key over instead of refusing
// — two top-level copies would break the YAML document — while unrelated
// sections survive untouched. A selection the new catalog no longer offers is
// replaced, because the harness would otherwise boot pointing at a model the
// source cannot serve.
func TestDshAdoptsHarnessWrittenDefaultModelSection(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	settings := dshSettingsPath(home)
	if err := os.MkdirAll(dshHome(home), 0o700); err != nil {
		t.Fatal(err)
	}
	own := "ui-theme:\n  preference: dark\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n"
	if err := os.WriteFile(settings, []byte(own), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newDsh(home).Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-v4.1-flash",
		AnyPickRoot:  root,
		Home:         home,
	}); err != nil {
		t.Fatal(err)
	}
	merged := string(mustRead(t, settings))
	if got := strings.Count(merged, "agent-default-model:"); got != 1 {
		t.Fatalf("expected exactly one default-model section, got %d:\n%s", got, merged)
	}
	if strings.Contains(merged, "deepseek-v4-pro") {
		t.Fatalf("stale harness selection survived adoption:\n%s", merged)
	}
	for _, want := range []string{"ui-theme:", "preference: dark", "model: 'deepseek-v4.1-flash'"} {
		if !strings.Contains(merged, want) {
			t.Fatalf("adoption lost %q:\n%s", want, merged)
		}
	}
}

// A section named agent-default-model that is nested under another key is not
// DSH's own state and must never be deleted by adoption.
func TestDshAdoptionLeavesNestedSectionsAlone(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	settings := dshSettingsPath(home)
	if err := os.MkdirAll(dshHome(home), 0o700); err != nil {
		t.Fatal(err)
	}
	own := "plugins:\n  agent-default-model:\n    provider: keep\n"
	if err := os.WriteFile(settings, []byte(own), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newDsh(home).Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-v4.1-flash",
		AnyPickRoot:  root,
		Home:         home,
	}); err != nil {
		t.Fatal(err)
	}
	merged := string(mustRead(t, settings))
	if !strings.Contains(merged, "plugins:") || !strings.Contains(merged, "provider: keep") {
		t.Fatalf("adoption deleted a nested key:\n%s", merged)
	}
}

// Refreshing the catalog must not move the user off the model they picked in
// dsh's own picker. The selection survives when the new catalog still offers
// it, and the catalog itself is updated in the same write.
func TestDshKeepsHarnessSelectionAcrossCatalogRefresh(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	settings := dshSettingsPath(home)
	if err := os.MkdirAll(dshHome(home), 0o700); err != nil {
		t.Fatal(err)
	}
	// The harness picked gemini-3.8-flash itself; AnyPick is re-publishing with
	// a model list that still contains it.
	own := "agent-default-model:\n  provider: deepseek-official\n  model: gemini-3.8-flash\n"
	if err := os.WriteFile(settings, []byte(own), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newDsh(home).Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk-test",
		DefaultModel: "deepseek-v4.1-flash",
		ModelCatalog: []string{"deepseek-v4.1-flash", "gemini-3.8-flash"},
		AnyPickRoot:  root,
		Home:         home,
	}); err != nil {
		t.Fatal(err)
	}
	merged := string(mustRead(t, settings))
	if got := strings.Count(merged, "agent-default-model:"); got != 1 {
		t.Fatalf("expected exactly one default-model section, got %d:\n%s", got, merged)
	}
	if !strings.Contains(merged, "model: 'gemini-3.8-flash'") {
		t.Fatalf("catalog refresh discarded the harness selection:\n%s", merged)
	}
	// The catalog itself still refreshed: a new id is published alongside it.
	if !strings.Contains(merged, "id: 'deepseek-v4.1-flash'") {
		t.Fatalf("catalog did not refresh:\n%s", merged)
	}
}

// A .env poisoned by an older AnyPick (DEEPSEEK_BASE_URL inline, which newer
// dsh aborts on) heals on the next apply: the line is stripped while the key
// and unrelated user lines survive.
func TestDshApplyStripsLegacyBaseURL(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	dir := dshHome(home)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	poisoned := "# user comment\nDEEPSEEK_BASE_URL=http://127.0.0.1:9000/v1\nDEEPSEEK_API_KEY=sk-old\n"
	if err := os.WriteFile(dshEnvPath(home), []byte(poisoned), 0o600); err != nil {
		t.Fatal(err)
	}
	a := newDsh(home)
	if _, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9001",
		APIKey:       "sk-new",
		DefaultModel: "deepseek-chat",
		AnyPickRoot:  root,
		Home:         home,
	}); err != nil {
		t.Fatal(err)
	}
	envText := string(mustRead(t, dshEnvPath(home)))
	if strings.Contains(envText, "DEEPSEEK_BASE_URL") {
		t.Fatalf("stale base URL survives apply:\n%s", envText)
	}
	for _, want := range []string{"# user comment", "DEEPSEEK_API_KEY=sk-new"} {
		if !strings.Contains(envText, want) {
			t.Fatalf(".env missing %q:\n%s", want, envText)
		}
	}
}

func TestDshApplyRefusesNonSequencePatch(t *testing.T) {
	home := t.TempDir()
	dir := dshHome(home)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A map document is not a valid cordis patch sequence.
	if err := os.WriteFile(dshPatchPath(home), []byte("foo: bar\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := newDsh(home)
	_, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9000",
		APIKey:       "sk",
		DefaultModel: "deepseek-chat",
		AnyPickRoot:  t.TempDir(),
		Home:         home,
	})
	if err == nil {
		t.Fatal("want refusal for non-sequence cordis patch")
	}
	var ae *anyerr.Error
	if !asAnyPickGo(err, &ae) || ae.Code != "CLIENT_CONFIG_INVALID" {
		t.Fatalf("wrong error: %v", err)
	}
}

func TestDshApplyIsolatedStaysInTree(t *testing.T) {
	a := newDsh(t.TempDir())
	root := t.TempDir()
	iso := t.TempDir()

	isoRes, err := a.Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:9100",
		APIKey:       "iso",
		DefaultModel: "deepseek-chat",
		AnyPickRoot:  root,
		IsolatedHome: iso,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Managed paths must live under the isolated tree, never the live root.
	for _, p := range isoRes.ManagedPaths {
		if !strings.HasPrefix(p, iso) {
			t.Fatalf("isolated managed path escapes tree: %s", p)
		}
	}
	// The isolated harness home actually got the env + patch.
	if _, err := os.Stat(filepath.Join(iso, ".dsh", ".env")); err != nil {
		t.Fatalf("isolated .env not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(iso, ".dsh", "cordis.patch.yml")); err != nil {
		t.Fatalf("isolated cordis patch not written: %v", err)
	}
}

// An unbalanced managed block must fail closed: a begin marker without its
// end previously dropped the rest of the user's file on overwrite.
func TestDshSettingsUnbalancedMarkersRefuseRewrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.yaml")
	victim := "keep: me\n" + dshSettingsBegin + "\nllm-deepseek:\n  baseURL: http://old/\n"
	if err := os.WriteFile(path, []byte(victim), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mergeDshSettingsEndpoint(path, "http://127.0.0.1:9000/v1"); err == nil {
		t.Fatal("unbalanced begin marker must refuse the rewrite")
	}
	if raw, _ := os.ReadFile(path); string(raw) != victim {
		t.Fatalf("user file was modified by a refused rewrite: %q", raw)
	}
	if _, _, err := stripDshSettingsBlock(victim); err == nil {
		t.Fatal("strip must report unbalanced markers")
	}
	if _, err := stripDshManagedBlock("a: 1\n" + dshPatchBegin + "\n- orphan\n"); err == nil {
		t.Fatal("strip must report an unterminated patch block")
	}
}

// Merges preserve the file's existing permission bits and keep user content
// outside the markers byte-identical.
func TestDshMergePreservesPermissionsAndUserContent(t *testing.T) {
	t.Setenv("ANYPICK_HOME", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.yaml")
	user := "# user comment\ntheme: dark\n"
	if err := os.WriteFile(path, []byte(user), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := mergeDshSettingsEndpoint(path, "http://127.0.0.1:9000/v1"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), user) || !strings.Contains(string(raw), "http://127.0.0.1:9000/v1") {
		t.Fatalf("merge lost user content or endpoint: %q", raw)
	}
	if fi, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm() != 0o644) {
		t.Fatalf("merge changed file permissions: %v", fi.Mode())
	}
	// Reset on an unbalanced file refuses instead of truncating it.
	home := t.TempDir()
	settings := filepath.Join(home, ".dsh", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	broken := "keep: me\n" + dshSettingsBegin + "\nunclosed\n"
	if err := os.WriteFile(settings, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := newDsh(home).Reset(); err == nil {
		t.Fatal("reset must refuse an unbalanced managed block")
	}
	if raw, _ := os.ReadFile(settings); string(raw) != broken {
		t.Fatalf("reset modified a file it refused: %q", raw)
	}
}
