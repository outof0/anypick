package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// codeAssistQuotaServer stands in for the Code Assist endpoints. It records
// request counts and the bodies so a test can prove the usage read used the
// already-live access token (no refresh, no writes) and the right client
// metadata.
type codeAssistQuotaServer struct {
	loadCalls     int
	quotaCalls    int
	summaryCalls  int
	loadBody      map[string]interface{}
	quotaBody     map[string]interface{}
	authorize     string
	project       string
	buckets       []map[string]interface{}
	summaryGroups []map[string]interface{}
	models        map[string]interface{}
	status        int // applies to every endpoint when non-zero
	summaryStatus int // overrides status for retrieveUserQuotaSummary
	quotaStatus   int // overrides status for retrieveUserQuota
}

func (s *codeAssistQuotaServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.authorize = r.Header.Get("Authorization")
		switch {
		case strings.HasSuffix(r.URL.Path, "loadCodeAssist"):
			s.loadCalls++
			_ = json.NewDecoder(r.Body).Decode(&s.loadBody)
			if s.status != 0 {
				w.WriteHeader(s.status)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{
				"cloudaicompanionProject": s.project,
			})
		case strings.HasSuffix(r.URL.Path, "fetchAvailableModels"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"models": s.models})
		case strings.HasSuffix(r.URL.Path, "retrieveUserQuotaSummary"):
			s.summaryCalls++
			_ = json.NewDecoder(r.Body).Decode(&s.quotaBody)
			code := s.summaryStatus
			if code == 0 {
				code = s.status
			}
			if code != 0 {
				w.WriteHeader(code)
				return
			}
			if len(s.summaryGroups) > 0 {
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"groups": s.summaryGroups})
				return
			}
			// Empty summary forces the client onto retrieveUserQuota.
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"groups": []interface{}{}})
		case strings.HasSuffix(r.URL.Path, "retrieveUserQuota"):
			s.quotaCalls++
			_ = json.NewDecoder(r.Body).Decode(&s.quotaBody)
			code := s.quotaStatus
			if code == 0 {
				code = s.status
			}
			if code != 0 {
				w.WriteHeader(code)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"buckets": s.buckets})
		default:
			t.Errorf("unexpected Code Assist path %s", r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("GEMINI_CODE_ASSIST_UPSTREAM", server.URL)
	return server
}

func writeGeminiCLICredential(t *testing.T, home, accessToken, refreshToken string, expiry time.Time) {
	t.Helper()
	dir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"access_token":"` + accessToken + `","refresh_token":"` + refreshToken +
		`","token_type":"Bearer","expiry_date":` + formatUnixMilli(expiry) + `}`
	if err := os.WriteFile(filepath.Join(dir, geminiCliCredentialFiles[0]), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestGeminiLiveUsageReadsCodeAssistQuota(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeGeminiCLICredential(t, home, "cli-access", "cli-refresh", time.Now().Add(time.Hour))

	server := &codeAssistQuotaServer{
		project: "projects/123",
		buckets: []map[string]interface{}{
			{"modelId": "models/gemini-2.5-pro", "remainingFraction": 0.42,
				"resetTime": "2026-09-16T00:00:00Z"},
			{"modelId": "models/gemini-2.5-flash", "remainingFraction": 0.42,
				"resetTime": "2026-09-16T00:00:00Z"},
			{"modelId": "models/claude-sonnet-4", "remainingFraction": 0.9},
		},
	}
	server.start(t)

	usage, err := newGemini(home).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 3 {
		t.Fatalf("windows = %+v, want every model window", usage)
	}
	if server.loadCalls != 1 || server.quotaCalls != 1 {
		t.Fatalf("load=%d quota=%d, want one call each", server.loadCalls, server.quotaCalls)
	}
	if server.authorize != "Bearer cli-access" {
		t.Fatalf("Authorization = %q", server.authorize)
	}
	if server.quotaBody["project"] != "projects/123" {
		t.Fatalf("quota project = %v", server.quotaBody["project"])
	}
	metadata, _ := server.loadBody["metadata"].(map[string]interface{})
	if metadata == nil || metadata["ideType"] != "GEMINI_CLI" {
		t.Fatalf("loadCodeAssist metadata = %v", server.loadBody["metadata"])
	}
	// Identical percentages and resets do not prove shared quota.
	if usage.Windows[0].Label != "gemini-2.5-pro" || usage.Windows[0].RemainingPercent != 42 {
		t.Fatalf("grouped window = %+v", usage.Windows[0])
	}
	if usage.Windows[2].Label != "claude-sonnet-4" || usage.Windows[2].RemainingPercent != 90 {
		t.Fatalf("single window = %+v", usage.Windows[1])
	}
	if usage.Windows[0].ResetsAtMs == nil {
		t.Fatal("resetTime must survive as a reset instant")
	}
}

func TestGeminiLiveUsageRefreshesExpiredGrantInMemory(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeGeminiCLICredential(t, home, "expired-access", "cli-refresh", time.Now().Add(-time.Hour))
	path := filepath.Join(home, ".gemini", "oauth_creds.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	refreshCalls := 0
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshCalls++
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("refresh_token") != "cli-refresh" && r.Form.Get("refresh_token") != "other-refresh" {
			t.Error("wrong grant")
		}
		if r.Form.Get("client_id") != geminiOAuthClientID {
			t.Error("wrong OAuth profile")
		}
		_, _ = w.Write([]byte(`{"access_token":"quota-only-token","expires_in":3600}`))
	}))
	defer tokenServer.Close()
	t.Setenv("GEMINI_TOKEN_ENDPOINT", tokenServer.URL)
	quota := &codeAssistQuotaServer{project: "projects/123", buckets: []map[string]interface{}{{"modelId": "gemini-pro", "remainingFraction": 0}}}
	quota.start(t)
	p := newGemini(home)
	for range 2 {
		usage, err := p.LiveUsage(context.Background())
		if err != nil || usage == nil || len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 0 {
			t.Fatalf("usage=%+v err=%v", usage, err)
		}
	}
	if refreshCalls != 1 || quota.authorize != "Bearer quota-only-token" {
		t.Fatalf("refresh=%d auth=%q", refreshCalls, quota.authorize)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("quota polling changed native credentials")
	}
	writeGeminiCLICredential(t, home, "expired-other", "other-refresh", time.Now().Add(-time.Hour))
	if _, err := p.LiveUsage(context.Background()); err != nil {
		t.Fatal(err)
	}
	if refreshCalls != 2 {
		t.Fatal("cached quota token survived an account switch")
	}
}

func TestGeminiLiveUsageReadsAntigravityState(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeAntigravityState(t, home, antigravityTokenSentinel,
		antigravityTokenInfo("anti-access", "Bearer", "1//anti", time.Now().Add(time.Hour)))

	server := &codeAssistQuotaServer{
		project: "projects/9",
		buckets: []map[string]interface{}{
			{"modelId": "models/gemini-3-pro", "remainingFraction": 1},
		},
	}
	server.start(t)

	usage, err := newGemini(home).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 100 {
		t.Fatalf("windows = %+v", usage)
	}
	if server.authorize != "Bearer anti-access" {
		t.Fatalf("Authorization = %q", server.authorize)
	}
	metadata, _ := server.loadBody["metadata"].(map[string]interface{})
	if metadata == nil || metadata["ideType"] != "ANTIGRAVITY" || metadata["platform"] != nil {
		t.Fatalf("loadCodeAssist metadata = %v", server.loadBody["metadata"])
	}
}

func TestGeminiLiveUsageWithoutLiveLoginIsEmpty(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	server := &codeAssistQuotaServer{project: "projects/1"}
	server.start(t)

	usage, err := newGemini(t.TempDir()).LiveUsage(context.Background())
	if err != nil || usage != nil {
		t.Fatalf("usage = %+v err=%v, want nothing", usage, err)
	}
	if server.loadCalls != 0 || server.quotaCalls != 0 {
		t.Fatalf("no live token must not call Code Assist: load=%d quota=%d",
			server.loadCalls, server.quotaCalls)
	}
}

func TestGeminiLiveUsageSurfacesVendorFailureAsNoUsage(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeGeminiCLICredential(t, home, "cli-access", "cli-refresh", time.Now().Add(time.Hour))
	server := &codeAssistQuotaServer{project: "projects/1", status: http.StatusForbidden}
	server.start(t)

	usage, err := newGemini(home).LiveUsage(context.Background())
	if err == nil {
		t.Fatal("a vendor rejection must be reported so the snapshot skips the row")
	}
	if usage != nil {
		t.Fatalf("usage = %+v", usage)
	}
}

func TestParseGeminiQuotaIgnoresMalformedBuckets(t *testing.T) {
	usage, err := parseGeminiQuota([]byte(`{"buckets":[
		{"modelId":"models/gemini-2.5-pro","remainingFraction":1.4},
		{"modelId":"","remainingFraction":0.5},
		{"modelId":"models/gemini-2.5-flash","remainingFraction":"half"},
		{"modelId":"models/gpt-oss-120b","remainingFraction":-0.2}
	]}`))
	if err != nil {
		t.Fatalf("parseGeminiQuota: %v", err)
	}
	if usage == nil || len(usage.Windows) != 2 {
		t.Fatalf("windows = %+v", usage)
	}
	// Clamped to 0..100: 1.4 → 100, -0.2 → 0.
	if usage.Windows[0].RemainingPercent != 100 {
		t.Fatalf("clamp high = %d", usage.Windows[0].RemainingPercent)
	}
	if usage.Windows[1].RemainingPercent != 0 {
		t.Fatalf("clamp low = %d", usage.Windows[1].RemainingPercent)
	}
}

func TestParseGeminiQuotaEmptyIsNil(t *testing.T) {
	usage, err := parseGeminiQuota([]byte(`{"buckets":[]}`))
	if err != nil || usage != nil {
		t.Fatalf("usage = %+v err=%v", usage, err)
	}
}

func TestParseGeminiQuotaSummaryGroupsWeeklyAndFiveHour(t *testing.T) {
	usage, err := parseGeminiQuotaSummary([]byte(`{
		"groups": [
			{
				"displayName": "Gemini Models",
				"buckets": [
					{
						"bucketId": "gemini-5h",
						"displayName": "Five Hour Limit Remaining",
						"window": "5h",
						"remainingFraction": 1,
						"resetTime": "2026-10-12T20:00:00Z"
					},
					{
						"bucketId": "gemini-weekly",
						"displayName": "Weekly Limit Remaining",
						"window": "weekly",
						"remainingFraction": 0.95,
						"resetTime": "2026-10-16T09:00:00Z"
					}
				]
			},
			{
				"displayName": "Claude and GPT models",
				"buckets": [
					{
						"bucketId": "3p-weekly",
						"displayName": "Weekly Limit Remaining",
						"window": "weekly",
						"remainingFraction": 0.48,
						"resetTime": "2026-10-16T15:00:00Z"
					},
					{
						"bucketId": "3p-5h",
						"displayName": "Five Hour Limit Remaining",
						"window": "5h",
						"remainingFraction": 1
					}
				]
			}
		]
	}`))
	if err != nil {
		t.Fatalf("parseGeminiQuotaSummary: %v", err)
	}
	if usage == nil || len(usage.Windows) != 4 {
		t.Fatalf("windows = %+v", usage)
	}
	// Weekly before 5h within each group; groups keep payload order.
	w0 := usage.Windows[0]
	if w0.Group != "Gemini Models" || w0.Label != "Weekly Limit Remaining" || w0.RemainingPercent != 95 {
		t.Fatalf("gemini weekly = %+v", w0)
	}
	if w0.LimitWindowSeconds == nil || *w0.LimitWindowSeconds != 604800 {
		t.Fatalf("gemini weekly cadence = %+v", w0.LimitWindowSeconds)
	}
	w1 := usage.Windows[1]
	if w1.Label != "Five Hour Limit Remaining" || w1.RemainingPercent != 100 {
		t.Fatalf("gemini 5h = %+v", w1)
	}
	if w1.LimitWindowSeconds == nil || *w1.LimitWindowSeconds != 18000 {
		t.Fatalf("gemini 5h cadence = %+v", w1.LimitWindowSeconds)
	}
	w2 := usage.Windows[2]
	if w2.Group != "Claude and GPT models" || w2.RemainingPercent != 48 {
		t.Fatalf("3p weekly = %+v", w2)
	}
	if usage.Windows[3].RemainingPercent != 100 {
		t.Fatalf("3p 5h = %+v", usage.Windows[3])
	}
}

func TestGeminiLiveUsagePrefersQuotaSummary(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeAntigravityState(t, home, antigravityTokenSentinel,
		antigravityTokenInfo("anti-access", "Bearer", "1//anti", time.Now().Add(time.Hour)))

	server := &codeAssistQuotaServer{
		project: "projects/9",
		models:  map[string]interface{}{"gemini-pro": map[string]interface{}{"displayName": "Gemini Pro", "modelProvider": "MODEL_PROVIDER_GOOGLE", "quotaInfo": map[string]interface{}{"remainingFraction": 0.62, "resetTime": "2026-10-17T00:00:00Z"}}},
		summaryGroups: []map[string]interface{}{
			{
				"displayName": "Gemini Models",
				"buckets": []map[string]interface{}{
					{"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining",
						"window": "weekly", "remainingFraction": 0.95,
						"resetTime": "2026-10-16T09:00:00Z"},
					{"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining",
						"window": "5h", "remainingFraction": 1},
				},
			},
		},
		// Would produce a different shape if the client wrongly fell back.
		buckets: []map[string]interface{}{
			{"modelId": "models/gemini-3-pro", "remainingFraction": 0.1},
		},
	}
	server.start(t)

	usage, err := newGemini(home).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 2 {
		t.Fatalf("aggregate summary must not acquire per-model rows: %+v", usage)
	}
	if server.summaryCalls != 1 || server.quotaCalls != 0 {
		t.Fatalf("summary=%d quota=%d, want summary only", server.summaryCalls, server.quotaCalls)
	}
	if usage.Windows[0].Group != "Gemini Models" || usage.Windows[0].RemainingPercent != 95 {
		t.Fatalf("summary window = %+v", usage.Windows[0])
	}
	if usage.Windows[1].Label != "Five Hour Limit Remaining" {
		t.Fatalf("summary cadence lost: %+v", usage.Windows)
	}
}

func TestGeminiLiveUsageUsesModelsWhenGoogleSummaryIsMissing(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeAntigravityState(t, home, antigravityTokenSentinel,
		antigravityTokenInfo("anti-access", "Bearer", "1//anti", time.Now().Add(time.Hour)))

	server := &codeAssistQuotaServer{
		project: "projects/9",
		models:  map[string]interface{}{"gemini-pro": map[string]interface{}{"displayName": "Gemini Pro", "modelProvider": "MODEL_PROVIDER_GOOGLE", "quotaInfo": map[string]interface{}{"remainingFraction": 0.62, "resetTime": "2026-10-17T00:00:00Z"}}},
		summaryGroups: []map[string]interface{}{
			{
				"displayName": "Claude and GPT models",
				"buckets": []map[string]interface{}{
					{"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining",
						"window": "weekly", "remainingFraction": 0.95,
						"resetTime": "2026-10-16T09:00:00Z"},
					{"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining",
						"window": "5h", "remainingFraction": 1},
				},
			},
		},
		// Would produce a different shape if the client wrongly fell back.
		buckets: []map[string]interface{}{
			{"modelId": "models/gemini-3-pro", "remainingFraction": 0.1},
		},
	}
	server.start(t)

	usage, err := newGemini(home).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 3 {
		t.Fatalf("missing Google summary needs independent model readings: %+v", usage)
	}
	if server.summaryCalls != 1 || server.quotaCalls != 0 {
		t.Fatalf("summary=%d quota=%d, want summary only", server.summaryCalls, server.quotaCalls)
	}
	if usage.Windows[0].Group != "Claude and GPT models" || usage.Windows[0].RemainingPercent != 95 {
		t.Fatalf("summary window = %+v", usage.Windows[0])
	}
	if usage.Windows[2].Label != "Gemini Pro" || usage.Windows[2].RemainingPercent != 62 || usage.Windows[2].LimitWindowSeconds != nil {
		t.Fatalf("per-model fallback must preserve the reported reading without inventing a cadence: %+v", usage.Windows)
	}
}

func TestParseGeminiQuotaSummaryEmptyFallsThrough(t *testing.T) {
	usage, err := parseGeminiQuotaSummary([]byte(`{"groups":[]}`))
	if err != nil || usage != nil {
		t.Fatalf("usage = %+v err=%v", usage, err)
	}
}

func TestGeminiLiveUsageFallsBackWhenSummary5xx(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeGeminiCLICredential(t, home, "cli-access", "cli-refresh", time.Now().Add(time.Hour))

	server := &codeAssistQuotaServer{
		project:       "projects/123",
		summaryStatus: http.StatusBadGateway,
		buckets: []map[string]interface{}{
			{"modelId": "models/gemini-2.5-pro", "remainingFraction": 0.42},
		},
	}
	server.start(t)

	usage, err := newGemini(home).LiveUsage(context.Background())
	if err != nil {
		t.Fatalf("LiveUsage: %v", err)
	}
	if usage == nil || len(usage.Windows) != 1 || usage.Windows[0].RemainingPercent != 42 {
		t.Fatalf("windows = %+v, want legacy fallback", usage)
	}
	if server.summaryCalls != 1 || server.quotaCalls != 1 {
		t.Fatalf("summary=%d quota=%d, want both (fallback)", server.summaryCalls, server.quotaCalls)
	}
}

func TestGeminiLiveUsageSkipsFallbackOnSummaryAuth(t *testing.T) {
	t.Setenv("GEMINI_CONFIG_DIR", "")
	t.Setenv("GEMINI_CLI_HOME", "")
	t.Setenv("ANTIGRAVITY_USER_DATA_DIR", "")
	home := t.TempDir()
	writeGeminiCLICredential(t, home, "cli-access", "cli-refresh", time.Now().Add(time.Hour))

	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			server := &codeAssistQuotaServer{
				project:       "projects/123",
				summaryStatus: code,
				buckets: []map[string]interface{}{
					{"modelId": "models/gemini-2.5-pro", "remainingFraction": 0.42},
				},
			}
			server.start(t)

			usage, err := newGemini(home).LiveUsage(context.Background())
			if err == nil {
				t.Fatal("auth summary failure must be reported")
			}
			if usage != nil {
				t.Fatalf("usage = %+v", usage)
			}
			var he *geminiCodeAssistHTTPError
			if !errors.As(err, &he) || he.Status != code {
				t.Fatalf("err = %v, want code assist HTTP %d", err, code)
			}
			if server.summaryCalls != 1 || server.quotaCalls != 0 {
				t.Fatalf("summary=%d quota=%d, want no legacy fallback",
					server.summaryCalls, server.quotaCalls)
			}
		})
	}
}

func TestParseGeminiQuotaSummaryAcceptsStringFraction(t *testing.T) {
	usage, err := parseGeminiQuotaSummary([]byte(`{
		"groups": [{
			"displayName": "Claude and GPT models",
			"buckets": [{
				"bucketId": "3p-weekly",
				"displayName": "Weekly Limit Remaining",
				"window": "weekly",
				"remainingFraction": "0.48",
				"resetTime": "2026-10-16T15:00:00Z"
			}]
		}]
	}`))
	if err != nil {
		t.Fatalf("parseGeminiQuotaSummary: %v", err)
	}
	if usage == nil || len(usage.Windows) != 1 {
		t.Fatalf("windows = %+v", usage)
	}
	if usage.Windows[0].RemainingPercent != 48 {
		t.Fatalf("string fraction = %+v", usage.Windows[0])
	}
}

func TestGeminiModelQuotaKeepsNativeLabelsAndIndependentLimits(t *testing.T) {
	windows := parseGeminiModelQuota([]byte(`{"models":{
 "alias-a":{"displayName":"Gemini Flash","modelProvider":"MODEL_PROVIDER_GOOGLE","quotaInfo":{"remainingFraction":0.75,"resetTime":"2026-10-17T00:00:00Z"}},
 "alias-b":{"displayName":"Gemini Flash","modelProvider":"MODEL_PROVIDER_GOOGLE","quotaInfo":{"remainingFraction":0.75,"resetTime":"2026-10-17T00:00:00Z"}},
 "pro":{"displayName":"Gemini Pro","modelProvider":"MODEL_PROVIDER_GOOGLE","quotaInfo":{"remainingFraction":0.75,"resetTime":"2026-10-17T00:00:00Z"}},
 "claude":{"displayName":"Claude","modelProvider":"MODEL_PROVIDER_ANTHROPIC","quotaInfo":{"remainingFraction":1}},
 "bad":{"displayName":"Bad","modelProvider":"MODEL_PROVIDER_GOOGLE","quotaInfo":{"remainingFraction":"bad"}}
 }}`))
	if len(windows) != 2 || windows[0].Label != "Gemini Flash" || windows[1].Label != "Gemini Pro" {
		t.Fatalf("windows=%+v", windows)
	}
	for _, window := range windows {
		if window.RemainingPercent != 75 || window.Group != "Gemini models" || window.ResetsAtMs == nil || window.LimitWindowSeconds != nil {
			t.Fatalf("window=%+v", window)
		}
	}
}
