package client

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceModelIDsMergesExactCatalogAndSelections(t *testing.T) {
	got := sourceModelIDs(&ApplyContext{
		DefaultModel: "selected-default",
		ModelRoles: map[string]string{
			"default": "selected-default",
			"sonnet":  "selected-sonnet",
		},
		ModelCatalog: []string{"catalog-first", "selected-sonnet", "catalog-first", "  "},
	})
	want := []string{"catalog-first", "selected-sonnet", "selected-default"}
	if len(got) != len(want) {
		t.Fatalf("sourceModelIDs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sourceModelIDs[%d] = %q, want %q (all=%v)", i, got[i], want[i], got)
		}
	}
}

func TestCodexApplyPublishesSourceModelCatalog(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	t.Setenv("CODEX_HOME", "")

	if _, err := newCodex(home).Apply(&ApplyContext{
		Endpoint:     "http://127.0.0.1:8787",
		APIKey:       "proxy-secret",
		DefaultModel: "catalog-second",
		ModelCatalog: []string{"catalog-first", "catalog-second"},
		Home:         home,
		AnyPickRoot:  root,
	}); err != nil {
		t.Fatal(err)
	}

	configPath := filepath.Join(home, ".codex", "config.toml")
	config := string(mustRead(t, configPath))
	catalogPath := filepath.Join(home, ".codex", codexCatalogFile)
	if !containsAll(config, "model = \"catalog-second\"", "model_catalog_json = "+quoteTOML(catalogPath)) {
		t.Fatalf("config does not point at the selected model and catalog:\n%s", config)
	}
	var doc codexCatalogDocument
	if err := json.Unmarshal(mustRead(t, catalogPath), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Models) != 2 || doc.Models[0].Slug != "catalog-first" || doc.Models[1].Slug != "catalog-second" {
		t.Fatalf("codex catalog = %+v, want both source models", doc.Models)
	}
	if doc.Models[0].Provider != "anypick" || doc.Models[0].Visibility != "list" {
		t.Fatalf("codex catalog entry is not picker-visible: %+v", doc.Models[0])
	}
}

func TestOpenCodeApplyPublishesSourceModelCatalog(t *testing.T) {
	home := t.TempDir()
	ctx := &ApplyContext{
		Endpoint:     "http://127.0.0.1:8787",
		APIKey:       "proxy-secret",
		DefaultModel: "catalog-second",
		ModelCatalog: []string{"catalog-first", "catalog-second"},
		Home:         home,
		AnyPickRoot:  t.TempDir(),
	}
	if _, err := newOpenCode(home).Apply(ctx); err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(mustRead(t, filepath.Join(home, ".config", "opencode", "opencode.json")), &doc); err != nil {
		t.Fatal(err)
	}
	var providers map[string]json.RawMessage
	if err := json.Unmarshal(doc["provider"], &providers); err != nil {
		t.Fatal(err)
	}
	var managed struct {
		Models map[string]json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(providers[opencodeManagedProviderID], &managed); err != nil {
		t.Fatal(err)
	}
	if len(managed.Models) != 2 {
		t.Fatalf("OpenCode models = %v, want the complete source catalog", managed.Models)
	}
	if string(doc["model"]) != `"anypick-managed/catalog-second"` {
		t.Fatalf("OpenCode default = %s", doc["model"])
	}
}

func TestCommandCodeApplyPublishesSourceModelCatalog(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	ctx := commandCodeApplyContext(t, home, root)
	ctx.ModelCatalog = []string{"catalog-first", "catalog-second"}
	if _, err := newCommandCode(home).Apply(ctx); err != nil {
		t.Fatal(err)
	}
	providers := readCommandCodeTestObject(t, commandCodeProvidersPath(home))
	var providerMap map[string]json.RawMessage
	if err := json.Unmarshal(providers["provider"], &providerMap); err != nil {
		t.Fatal(err)
	}
	var managed map[string]json.RawMessage
	if err := json.Unmarshal(providerMap[commandCodeManagedProviderID], &managed); err != nil {
		t.Fatal(err)
	}
	var models map[string]json.RawMessage
	if err := json.Unmarshal(managed["models"], &models); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"catalog-first", "catalog-second"} {
		if _, ok := models[id]; !ok {
			t.Fatalf("Command Code models = %v, missing source model %q", models, id)
		}
	}
}

func TestZCodeApplyPublishesSourceModelCatalog(t *testing.T) {
	home := t.TempDir()
	ctx := zcodeApplyContext(t, home)
	ctx.ModelCatalog = []string{"catalog-first", "catalog-second"}
	if _, err := newZCode(home).Apply(ctx); err != nil {
		t.Fatal(err)
	}
	entry := zcodeEntry(t, ZCodeCLIConfigPath(home))
	var models map[string]json.RawMessage
	if err := json.Unmarshal(entry["models"], &models); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"catalog-first", "catalog-second"} {
		if _, ok := models[id]; !ok {
			t.Fatalf("ZCode models = %v, missing source model %q", models, id)
		}
	}
}

func TestWorkBuddyApplyPublishesSourceModelCatalog(t *testing.T) {
	home := t.TempDir()
	ctx := workbuddyApplyContext(t, home)
	ctx.ModelCatalog = []string{"catalog-first", "catalog-second"}
	if _, err := newWorkBuddy(home).Apply(ctx); err != nil {
		t.Fatal(err)
	}
	entries := workbuddyEntries(readWorkBuddyFile(t, workbuddyPaths(t, home)[0]))
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.ID] = true
	}
	for _, id := range []string{"catalog-first", "catalog-second"} {
		configID := workbuddyConfigModelID(id)
		if !seen[configID] {
			t.Fatalf("WorkBuddy models = %+v, missing source model %q", entries, configID)
		}
	}
}

func TestClaudeApplyFreshConfigWritesNativeModelSlots(t *testing.T) {
	home := t.TempDir()
	if _, err := newClaude(home).Apply(&ApplyContext{
		Endpoint: "http://127.0.0.1:8787",
		APIKey:   "proxy-secret",
		ModelRoles: map[string]string{
			"default": "catalog-default",
			"sonnet":  "catalog-sonnet",
			"opus":    "catalog-opus",
			"haiku":   "catalog-haiku",
		},
		Home:        home,
		AnyPickRoot: t.TempDir(),
	}); err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(mustRead(t, filepath.Join(home, ".claude", "settings.json")), &doc); err != nil {
		t.Fatal(err)
	}
	var env map[string]string
	if err := json.Unmarshal(doc["env"], &env); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"ANTHROPIC_MODEL":                "catalog-default",
		"ANTHROPIC_DEFAULT_SONNET_MODEL": "catalog-sonnet",
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   "catalog-opus",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "catalog-haiku",
	} {
		if env[key] != want {
			t.Fatalf("Claude %s = %q, want %q", key, env[key], want)
		}
	}
}

func containsAll(value string, wants ...string) bool {
	for _, want := range wants {
		if !strings.Contains(value, want) {
			return false
		}
	}
	return true
}
