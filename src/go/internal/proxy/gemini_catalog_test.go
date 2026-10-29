package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/protocol/gemini"
)

// Without tier routes the catalog names no picker model, so the named Google
// models are listed rather than nothing.
func TestParseCodeAssistCatalogWithoutTiersListsNamedGoogleModels(t *testing.T) {
	body := codeAssistCatalogResponse{
		Models: map[string]codeAssistModelDetails{
			"models/gemini-2.5-pro":      {DisplayName: "Gemini 2.5 Pro"},
			"models/gemini-2.5-flash":    {DisplayName: "Gemini 2.5 Flash"},
			"models/tab_flash":           {},
			"models/disabled-model":      {DisplayName: "Disabled", Disabled: true},
			"models/non-google":          {DisplayName: "Claude", APIProvider: "API_PROVIDER_ANTHROPIC"},
			"models/non-google-provider": {DisplayName: "GPT", ModelProvider: "MODEL_PROVIDER_OPENAI"},
		},
	}
	cat := parseCodeAssistCatalog(body)
	var ids []string
	for _, m := range cat.Models {
		ids = append(ids, m.ID)
	}
	if got := strings.Join(ids, ","); got != "gemini-2.5-pro,gemini-2.5-flash" {
		t.Fatalf("models = %s", got)
	}
}

func TestRefreshGeminiCatalogFromGoogle(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if !strings.HasPrefix(r.URL.Path, "/v1beta/models") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("x-goog-api-key") != "test-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.RawQuery != "" && strings.Contains(r.URL.RawQuery, "key=") {
			// A key in the URL would leak through *url.Error into user-visible
			// diagnostics; the transport must always use the header.
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"models": []map[string]interface{}{
				{"name": "models/gemini-2.5-pro", "supportedGenerationMethods": []string{"generateContent"}},
				{"name": "models/gemini-1.5-flash", "supportedGenerationMethods": []string{"generateContent", "embedContent"}},
				{"name": "models/text-embedding-004", "supportedGenerationMethods": []string{"embedContent"}},
			},
		})
	}))
	defer srv.Close()

	base, _ := url.Parse(srv.URL)
	up := &Upstream{Gemini: &GeminiTarget{APIKeyMode: true, APIKeyBase: base}, Auth: "test-key"}
	cat, err := refreshGeminiModelCatalog(context.Background(), up)
	if err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("listmodels hits = %d, want 1", hits)
	}
	ids := map[string]bool{}
	for _, m := range cat.Models {
		ids[m.ID] = true
	}
	if !ids["gemini-2.5-pro"] || !ids["gemini-1.5-flash"] {
		t.Fatalf("expected generateContent models, got %v", ids)
	}
	if ids["text-embedding-004"] {
		t.Fatalf("embedding model (no generateContent) should be filtered: %v", ids)
	}
}

func TestLiveGeminiCatalogCachesAndFallsBack(t *testing.T) {
	geminiCatalogMu.Lock()
	geminiCatalogCache = map[string]*geminiCatalogEntry{}
	geminiCatalogMu.Unlock()

	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"models": []map[string]interface{}{
				{"name": "models/gemini-2.5-pro", "supportedGenerationMethods": []string{"generateContent"}},
			},
		})
	}))
	defer srv.Close()
	base, _ := url.Parse(srv.URL)
	up := &Upstream{Gemini: &GeminiTarget{APIKeyMode: true, APIKeyBase: base}, Auth: "k"}

	// First call fetches.
	if c := liveGeminiCatalog(context.Background(), up); c == nil || len(c.Models) != 1 {
		t.Fatalf("first call returned %+v", c)
	}
	if hits != 1 {
		t.Fatalf("hits after first = %d, want 1", hits)
	}
	// Second call reuses the cache (TTL), no second upstream hit.
	if c := liveGeminiCatalog(context.Background(), up); c == nil || len(c.Models) != 1 {
		t.Fatalf("second call returned %+v", c)
	}
	if hits != 1 {
		t.Fatalf("hits after second (cached) = %d, want 1", hits)
	}

	// Failure path: a dead upstream returns nil and is not retried within the
	// failure TTL.
	geminiCatalogMu.Lock()
	geminiCatalogCache = map[string]*geminiCatalogEntry{}
	geminiCatalogMu.Unlock()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer dead.Close()
	deadBase, _ := url.Parse(dead.URL)
	deadUp := &Upstream{Gemini: &GeminiTarget{APIKeyMode: true, APIKeyBase: deadBase}, Auth: "k"}
	if c := liveGeminiCatalog(context.Background(), deadUp); c != nil {
		t.Fatalf("failed fetch should return nil, got %+v", c)
	}
	// Within failure TTL, the next call must NOT hit the upstream again.
	if c := liveGeminiCatalog(context.Background(), deadUp); c != nil {
		t.Fatalf("failed fetch (cached) should return nil, got %+v", c)
	}
	if hits != 2 { // 1 success-server hit + 1 dead-server hit; cached failures don't add
		t.Fatalf("hits = %d, want 2 (cached failure must not re-hit)", hits)
	}
}

// The shape below is trimmed from a live Antigravity fetchAvailableModels
// response (October 2026). Both the pro and flash tiers route to one flash
// model, so the picker also lists the Gemini models Google recommends by name;
// the rest of the catalog backs IDE helpers, commit messages, search and image
// generation. gemini-2.5-flash really is named "Gemini 3.5 Flash Lite".
func TestParseCodeAssistCatalogListsTierRoutes(t *testing.T) {
	var body codeAssistCatalogResponse
	if err := json.Unmarshal([]byte(`{
		"models": {
			"gemini-2.5-pro":   {"displayName": "Gemini 2.5 Pro", "recommended": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-2.5-flash": {"displayName": "Gemini 3.5 Flash Lite", "recommended": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-3.1-flash-lite": {"displayName": "Gemini 3.1 Flash Lite", "recommended": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-3-flash":   {"displayName": "Gemini 3 Flash", "recommended": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-3.5-flash-lite": {"displayName": "Gemini 3.5 Flash Lite", "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-3.8-flash-tiered": {"recommended": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-3.1-flash-image": {"displayName": "Gemini 3.1 Flash Image", "recommended": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"gemini-3-internal":      {"displayName": "Gemini 3 Internal", "recommended": true, "isInternal": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"tab_flash_lite_preview": {"modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_GOOGLE_GEMINI"},
			"chat_20706": {"isInternal": true, "modelProvider": "MODEL_PROVIDER_GOOGLE", "apiProvider": "API_PROVIDER_INTERNAL"},
			"claude-sonnet-4-6": {"displayName": "Claude Sonnet 4.6 (Thinking)", "modelProvider": "MODEL_PROVIDER_ANTHROPIC", "apiProvider": "API_PROVIDER_ANTHROPIC_VERTEX"}
		},
		"defaultAgentModelId": "claude-sonnet-4-6",
		"tabModelIds": ["chat_20706"],
		"imageGenerationModelIds": ["gemini-3.1-flash-image"],
		"tieredModelIds": {"flashLite": ["gemini-3.5-flash-lite"], "flash": ["gemini-3.8-flash-tiered"], "pro": ["gemini-3.8-flash-tiered"]}
	}`), &body); err != nil {
		t.Fatal(err)
	}
	cat := parseCodeAssistCatalog(body)

	var ids []string
	for _, m := range cat.Models {
		if m.UpstreamID != m.ID {
			t.Fatalf("%s sent upstream as %s, want Google's own id", m.ID, m.UpstreamID)
		}
		ids = append(ids, m.ID)
	}
	if want := []string{"gemini-3.8-flash-tiered", "gemini-3-flash", "gemini-2.5-pro"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("models = %v, want the tier route then Google's recommended Gemini models, newest first: %v", ids, want)
	}
	// Unlisted ids stay callable as themselves.
	if got := gemini.ResolveGeminiModel("gemini-3.1-flash-lite", cat, ""); got.UpstreamID != "gemini-3.1-flash-lite" {
		t.Fatalf("gemini-3.1-flash-lite resolved to %+v", got)
	}
	tiers := map[gemini.GeminiModelIntent]string{
		gemini.IntentFast:    "gemini-3.8-flash-tiered",
		gemini.IntentQuality: "gemini-3.8-flash-tiered",
		gemini.IntentLite:    "gemini-3.5-flash-lite",
	}
	for intent, route := range tiers {
		if cat.TierRoutes[intent] != route {
			t.Fatalf("tier %s = %q, want %q (all: %v)", intent, cat.TierRoutes[intent], route, cat.TierRoutes)
		}
	}
}

// A tier route the catalog marks disabled is not a route: its friendly names
// fall back to the remaining tiers' choice instead of a model the account
// cannot call. The key may carry the models/ prefix.
func TestParseCodeAssistCatalogSkipsDisabledTierRoute(t *testing.T) {
	body := codeAssistCatalogResponse{
		Models: map[string]codeAssistModelDetails{
			"models/gemini-3.8-flash-tiered": {Disabled: true},
			"gemini-3-pro-tiered":            {},
		},
		TieredModelIDs: map[string][]interface{}{
			"flash": {"gemini-3.8-flash-tiered"},
			"pro":   {"gemini-3-pro-tiered"},
		},
	}
	cat := parseCodeAssistCatalog(body)
	if _, ok := cat.TierRoutes[gemini.IntentFast]; ok {
		t.Fatalf("disabled flash route kept: %v", cat.TierRoutes)
	}
	if len(cat.Models) != 1 || cat.Models[0].ID != "gemini-3-pro-tiered" {
		t.Fatalf("models = %+v", cat.Models)
	}
}

// A catalog with neither tiers nor display names lists nothing, which must
// not be answered as success: the quota ids are listed instead.
func TestCodeAssistCatalogWithNothingListableFallsBackToQuota(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ":fetchAvailableModels"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"models": map[string]interface{}{"gemini-2.5-pro": map[string]interface{}{}},
			})
		case strings.HasSuffix(r.URL.Path, ":retrieveUserQuota"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"buckets": []map[string]string{{"modelId": "gemini-2.5-pro"}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	cat, err := fetchGeminiCatalogFromCodeAssist(context.Background(), srv.URL, "tok", "proj", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Models) != 1 || cat.Models[0].ID != "gemini-2.5-pro" {
		t.Fatalf("models = %+v", cat.Models)
	}
}

// When quota metadata names nothing either, the catalog is a failure, so
// /v1/models answers 502 rather than an empty list with no default.
func TestCodeAssistCatalogWithNothingListableAndEmptyQuotaFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ":fetchAvailableModels"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"models": map[string]interface{}{}})
		case strings.HasSuffix(r.URL.Path, ":retrieveUserQuota"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"buckets": []interface{}{}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	if cat, err := fetchGeminiCatalogFromCodeAssist(context.Background(), srv.URL, "tok", "proj", ""); err == nil {
		t.Fatalf("empty discovery answered as success: %+v", cat)
	}
}
