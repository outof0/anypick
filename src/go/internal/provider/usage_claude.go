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
	"sort"
	"strings"
	"time"
)

// LiveUsage uses the same OAuth endpoint as Claude Code's /usage. It reads
// the live login only; polling must never rotate Claude's refresh token or
// replace a credential owned by Claude Code.
func (p *claude) LiveUsage(ctx context.Context) (*LiveUsage, error) {
	credential, err := p.read()
	if err != nil || credential == nil {
		return nil, err
	}
	return claudeUsageFromCredential(ctx, credential.credential)
}

// SnapshotUsage reads a saved Claude account's windows from its snapshot.
func (p *claude) SnapshotUsage(ctx context.Context, snapshotDir string) (*LiveUsage, error) {
	raw, err := os.ReadFile(filepath.Join(snapshotDir, claudeSnapshotFile))
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		Credential string `json:"credential"`
	}
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Credential == "" {
		return nil, fmt.Errorf("claude snapshot has no credential")
	}
	return claudeUsageFromCredential(ctx, snapshot.Credential)
}

func claudeUsageFromCredential(ctx context.Context, credential string) (*LiveUsage, error) {
	var auth struct {
		OAuth struct {
			AccessToken string   `json:"accessToken"`
			ExpiresAt   int64    `json:"expiresAt"`
			Scopes      []string `json:"scopes"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal([]byte(credential), &auth) != nil {
		return nil, fmt.Errorf("invalid Claude OAuth credential")
	}
	if auth.OAuth.AccessToken == "" {
		return nil, nil
	}
	hasProfile := false
	for _, scope := range auth.OAuth.Scopes {
		if scope == "user:profile" {
			hasProfile = true
		}
	}
	if !hasProfile {
		return nil, fmt.Errorf("claude OAuth login lacks profile scope")
	}
	if auth.OAuth.ExpiresAt > 0 && auth.OAuth.ExpiresAt <= time.Now().UnixMilli() {
		return nil, fmt.Errorf("claude OAuth access token expired")
	}
	endpoint, err := oauthTokenEndpoint("ANYPICK_CLAUDE_USAGE_ENDPOINT", "https://api.anthropic.com/api/oauth/usage")
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+auth.OAuth.AccessToken)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Accept", "application/json")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("claude usage request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("claude usage HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("claude usage response unreadable")
	}
	return parseClaudeUsage(raw)
}

func parseClaudeUsage(raw []byte) (*LiveUsage, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("invalid Claude usage JSON")
	}
	var limits []struct {
		Kind     string      `json:"kind"`
		Group    string      `json:"group"`
		Percent  interface{} `json:"percent"`
		ResetsAt string      `json:"resets_at"`
		Scope    *struct {
			Model *struct {
				DisplayName string `json:"display_name"`
			} `json:"model"`
			Surface *struct {
				DisplayName string `json:"display_name"`
			} `json:"surface"`
		} `json:"scope"`
	}
	_ = json.Unmarshal(root["limits"], &limits)
	windows := []UsageWindow{}
	seen := map[string]bool{}
	for _, limit := range limits {
		label, seconds := "", 0
		switch limit.Kind {
		case "session":
			label, seconds = "5h", 18000
		case "weekly_all":
			label, seconds = "Weekly", 604800
		case "weekly_scoped":
			if limit.Scope != nil {
				if limit.Scope.Model != nil {
					label = strings.TrimSpace(limit.Scope.Model.DisplayName)
				}
				if label == "" && limit.Scope.Surface != nil {
					label = strings.TrimSpace(limit.Scope.Surface.DisplayName)
				}
			}
			if label != "" {
				label += " · Weekly"
				seconds = 604800
			}
		default:
			continue
		}
		if label == "" {
			continue
		}
		if w, ok := claudeUsageWindow(label, seconds, limit.Percent, limit.ResetsAt); ok {
			windows = append(windows, w)
			if limit.Kind == "session" {
				seen["five_hour"] = true
			}
			if limit.Kind == "weekly_all" {
				seen["seven_day"] = true
			}
			if limit.Kind == "weekly_scoped" {
				seen["seven_day_"+strings.ToLower(strings.TrimSuffix(label, " · Weekly"))] = true
			}
		}
	}
	windows = append(windows, claudeLegacyUsage(root, seen)...)
	if len(windows) == 0 {
		return nil, nil
	}
	return &LiveUsage{Windows: windows}, nil
}

func claudeLegacyUsage(root map[string]json.RawMessage, seen map[string]bool) []UsageWindow {
	windows := []UsageWindow{}
	// Older accounts expose named windows only. Include additional model/surface
	// windows even when a partially rolled-out limits array omits them.
	keys := []string{"five_hour", "seven_day"}
	extra := []string{}
	for key := range root {
		if strings.HasPrefix(key, "seven_day_") {
			extra = append(extra, key)
		}
	}
	sort.Strings(extra)
	keys = append(keys, extra...)
	for _, key := range keys {
		if seen[key] {
			continue
		}
		var value struct {
			Utilization interface{} `json:"utilization"`
			ResetsAt    string      `json:"resets_at"`
		}
		if json.Unmarshal(root[key], &value) != nil {
			continue
		}
		label, seconds := "Weekly", 604800
		if key == "five_hour" {
			label, seconds = "5h", 18000
		} else if key != "seven_day" {
			label = strings.ReplaceAll(strings.TrimPrefix(key, "seven_day_"), "_", " ") + " · Weekly"
		}
		if w, ok := claudeUsageWindow(label, seconds, value.Utilization, value.ResetsAt); ok {
			windows = append(windows, w)
		}
	}

	return windows
}

func claudeUsageWindow(label string, seconds int, used interface{}, reset string) (UsageWindow, bool) {
	value := numberValue(used)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return UsageWindow{}, false
	}
	w := UsageWindow{Label: label, RemainingPercent: clampPercent(100 - value), LimitWindowSeconds: &seconds}
	if instant, err := time.Parse(time.RFC3339Nano, reset); err == nil {
		ms := float64(instant.UnixMilli())
		w.ResetsAtMs = &ms
	}
	return w, true
}
