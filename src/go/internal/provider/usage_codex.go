package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// codexLiveUsage fetches the ChatGPT rate-limit snapshot using the live
// ~/.codex/auth.json OAuth token.
func (p *codex) LiveUsage(ctx context.Context) (*LiveUsage, error) {
	raw, err := os.ReadFile(p.authPath())
	if err != nil {
		return nil, err
	}
	return codexUsageFromAuth(ctx, raw)
}

// SnapshotUsage reads a saved Codex account's windows from its auth.json copy.
func (p *codex) SnapshotUsage(ctx context.Context, snapshotDir string) (*LiveUsage, error) {
	raw, err := os.ReadFile(filepath.Join(snapshotDir, "auth.json"))
	if err != nil {
		return nil, err
	}
	return codexUsageFromAuth(ctx, raw)
}

func codexUsageFromAuth(ctx context.Context, raw []byte) (*LiveUsage, error) {
	var auth struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(raw, &auth) != nil || auth.Tokens.AccessToken == "" {
		return nil, fmt.Errorf("no access token")
	}

	endpoint, err := oauthTokenEndpoint("ANYPICK_CODEX_USAGE_ENDPOINT", "https://chatgpt.com/backend-api/wham/usage")
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+auth.Tokens.AccessToken)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage endpoint status %d", resp.StatusCode)
	}
	return parseCodexUsage(body)
}

// nowUnixMilli anchors relative vendor countdowns (reset_after_seconds) to
// this machine's clock next to the absolute reset_at instants.
func nowUnixMilli() int64 {
	return time.Now().UnixMilli()
}

// parseCodexUsage reads primary_window/secondary_window used_percent →
// remaining percent.
func parseCodexUsage(body []byte) (*LiveUsage, error) {
	var root map[string]interface{}
	if json.Unmarshal(body, &root) != nil {
		return nil, fmt.Errorf("invalid usage JSON")
	}
	rateLimit := objectMap(root["rate_limit"])
	if rateLimit == nil {
		rateLimit = objectMap(root["rate_limits"])
	}
	if rateLimit == nil {
		rateLimit = root
	}

	var windows []UsageWindow
	for _, pair := range [][2]string{
		{"primary_window", "Primary"},
		{"secondary_window", "Secondary"},
	} {
		window := objectMap(rateLimit[pair[0]])
		if window == nil {
			continue
		}
		used := numberValue(window["used_percent"])
		if math.IsNaN(used) {
			continue
		}
		w := UsageWindow{
			Label:            usageLabel(pair[1], window),
			RemainingPercent: clampPercent(100 - used),
		}
		if v, ok := window["limit_window_seconds"].(float64); ok && v > 0 {
			secs := int(v)
			w.LimitWindowSeconds = &secs
		}
		if ms := resetAtMs(window, nowUnixMilli()); ms != nil {
			w.ResetsAtMs = ms
		}
		windows = append(windows, w)
	}
	if len(windows) == 0 {
		return nil, fmt.Errorf("no usage windows")
	}
	return &LiveUsage{Windows: windows}, nil
}

func objectMap(v interface{}) map[string]interface{} {
	m, ok := v.(map[string]interface{})
	if !ok {
		return nil
	}
	return m
}

func numberValue(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case string:
		// Vendors sometimes encode fractions as JSON strings ("0.48").
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return math.NaN()
		}
		return f
	default:
		return math.NaN()
	}
}

func resetAtMs(window map[string]interface{}, nowUnixMilli int64) *float64 {
	// Absolute instants first (most precise), relative countdown last.
	for _, key := range []string{"resets_at_ms", "reset_at_ms"} {
		if v, ok := window[key].(float64); ok && !math.IsNaN(v) {
			return &v
		}
	}
	// The vendor's own clock: reset_at is unix SECONDS (limit_window_seconds
	// and reset_after_seconds share the shape).
	if v, ok := window["reset_at"].(float64); ok && !math.IsNaN(v) && v > 0 {
		ms := v * 1000
		return &ms
	}
	if v, ok := window["reset_after_seconds"].(float64); ok && !math.IsNaN(v) && v >= 0 {
		ms := float64(nowUnixMilli) + v*1000
		return &ms
	}
	return nil
}

// usageLabel returns a human label for the usage window, preferring the
// vendor-provided label when present (e.g. a plan name).
func usageLabel(fallback string, window map[string]interface{}) string {
	if label, ok := window["label"].(string); ok && strings.TrimSpace(label) != "" {
		return strings.TrimSpace(label)
	}
	return fallback
}

func clampPercent(v float64) int {
	return int(math.Max(0, math.Min(100, math.Round(v))))
}
