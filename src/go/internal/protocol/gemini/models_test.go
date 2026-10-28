package gemini

import "testing"

func tieredCatalog() GeminiModelCatalog {
	return GeminiModelCatalog{
		Models: []GeminiModelDescriptor{
			{ID: "gemini-3-flash", UpstreamID: "gemini-3-flash", DisplayName: "Gemini 3 Flash"},
			{ID: "gemini-2.5-pro", UpstreamID: "gemini-2.5-pro", DisplayName: "Gemini 2.5 Pro"},
		},
		TierRoutes: map[GeminiModelIntent]string{
			IntentFast:    "gemini-3.8-flash-tiered",
			IntentQuality: "gemini-3.8-flash-tiered",
			IntentLite:    "gemini-3.5-flash-lite",
		},
	}
}

// A tier intent goes to the vendor's own route for that tier rather than to
// the newest id that happens to contain "flash"; the client keeps its name.
func TestResolveGeminiModelSendsIntentToTierRoute(t *testing.T) {
	for requested, route := range map[string]string{
		"flash":         "gemini-3.8-flash-tiered",
		"claude-sonnet": "gemini-3.8-flash-tiered",
		"lite":          "gemini-3.5-flash-lite",
	} {
		got := ResolveGeminiModel(requested, tieredCatalog(), "")
		if got.ID != requested || got.UpstreamID != route || got.Reason != "intent" {
			t.Errorf("%s resolved to %+v, want upstream %s", requested, got, route)
		}
	}
}

// Concrete picker ids are never rerouted through a tier.
func TestResolveGeminiModelKeepsConcreteIDs(t *testing.T) {
	got := ResolveGeminiModel("gemini-3-flash", tieredCatalog(), "")
	if got.ID != "gemini-3-flash" || got.UpstreamID != "gemini-3-flash" {
		t.Fatalf("resolution = %+v", got)
	}
}

// Without tier routes (API-key catalogs, quota fallback) intents still pick
// from the listed ids.
func TestResolveGeminiModelIntentWithoutTierRoutes(t *testing.T) {
	cat := tieredCatalog()
	cat.TierRoutes = nil
	got := ResolveGeminiModel("flash", cat, "")
	if got.ID != "gemini-3-flash" || got.UpstreamID != "gemini-3-flash" {
		t.Fatalf("resolution = %+v", got)
	}
}

// AnyPick 1.1.x saved tier routes without "-tiered". Those ids reach the
// route they were cut from while Google still names it, and nothing else.
func TestResolveGeminiModelReadsLegacyStrippedTierRoute(t *testing.T) {
	got := ResolveGeminiModel("gemini-3.8-flash", tieredCatalog(), "")
	if got.ID != "gemini-3.8-flash" || got.UpstreamID != "gemini-3.8-flash-tiered" || got.Reason != "legacy" {
		t.Fatalf("legacy id resolved to %+v", got)
	}
	if got := ResolveGeminiModel("gemini-3.9-flash", tieredCatalog(), ""); got.UpstreamID != "gemini-3.9-flash" {
		t.Fatalf("an id with no matching route was rewritten: %+v", got)
	}
}
