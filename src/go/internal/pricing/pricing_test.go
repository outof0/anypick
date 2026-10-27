package pricing

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestLookupMatchesFamiliesWithoutCrossingThem(t *testing.T) {
	table, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if table.AsOf == "" {
		t.Fatal("the bundled table carries no date; every surface must show one")
	}
	for model, want := range map[string]float64{
		"claude-opus-5-5":           4,
		"anthropic/claude-opus-5-5": 4,
		"CLAUDE-OPUS-5-5":           4,
		"claude-opus-5":             5,
		"claude-opus-5-20260101":    5,
		"claude-opus-4-6@20260101":  5,
	} {
		p, ok := table.Lookup(model)
		if !ok || p.Input != want {
			t.Errorf("Lookup(%q) = %+v, %v; want input %v", model, p, ok, want)
		}
	}
	for _, model := range []string{"", "gpt-unknown", "claude-opus-55", "claude"} {
		if _, ok := table.Lookup(model); ok {
			t.Errorf("Lookup(%q) priced a model the table does not list", model)
		}
	}
}

func TestCostChargesUnknownCachePricesAtInput(t *testing.T) {
	read := 0.2
	priced := Price{Input: 4, Output: 20, CacheRead: &read}
	if got := priced.Cost(1_000_000, 1_000_000, 1_000_000, 0); math.Abs(got-24.2) > 1e-9 {
		t.Fatalf("cost = %v, want 24.2", got)
	}
	unpriced := Price{Input: 5, Output: 25}
	if got := unpriced.Cost(0, 0, 1_000_000, 1_000_000); math.Abs(got-10) > 1e-9 {
		t.Fatalf("cost = %v, want cache tokens at the input price (10)", got)
	}
}

func TestOverridesAddAndReplacePrices(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, OverrideFile),
		[]byte(`{"models":{"glm-4.7":{"input":0.6,"output":2.2},"claude-opus-5-5":{"input":1,"output":2}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	table, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := table.Lookup("glm-4.7"); !ok || p.Output != 2.2 {
		t.Fatalf("override did not add glm-4.7: %+v %v", p, ok)
	}
	if p, _ := table.Lookup("claude-opus-5-5"); p.Input != 1 {
		t.Fatalf("override did not replace a bundled price: %+v", p)
	}
	if len(table.Overridden) != 2 {
		t.Fatalf("overridden = %v", table.Overridden)
	}
	if err := os.WriteFile(filepath.Join(root, OverrideFile), []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root); err == nil {
		t.Fatal("a malformed override file was ignored")
	}
}
