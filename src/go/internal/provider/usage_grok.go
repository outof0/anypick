package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// grokUsageEndpoint is a variable so tests can point the read at a loopback
// server instead of xAI.
var grokUsageEndpoint = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"

// LiveUsage reads the CLI's credit window with the live OIDC session. Like
// the other providers, quota polling never refreshes or writes a credential —
// an expired session stays unread until the user acts.
func (p *grok) LiveUsage(ctx context.Context) (*LiveUsage, error) {
	session, err := loadGrokSession(p.authPath())
	if err != nil || session.accessToken == "" || isGrokExpired(session, time.Now()) {
		return nil, nil
	}
	return grokUsageFromSession(ctx, session)
}

func (p *grok) LiveQuotaForSnapshot(ctx context.Context, file SnapshotFileReader) (*LiveUsage, error) {
	live, err := loadGrokSession(p.authPath())
	if err != nil || live.accessToken == "" || isGrokExpired(live, time.Now()) {
		return nil, err
	}
	saved, err := grokSavedSession(file)
	if err != nil || !sameGrokQuotaLogin(live, saved) {
		return nil, err
	}
	return grokUsageFromSession(ctx, live)
}

func sameGrokQuotaLogin(live, saved grokSession) bool {
	if live.accessToken != "" && live.accessToken == saved.accessToken {
		return true
	}
	if live.refreshToken != "" && live.refreshToken == saved.refreshToken {
		return true
	}
	liveID, savedID := grokSessionUserID(live), grokSessionUserID(saved)
	if liveID != "" && savedID != "" {
		return liveID == savedID
	}
	email := grokSessionIdentity(live.raw)
	return email != "" && strings.EqualFold(email, grokSessionIdentity(saved.raw))
}

func (*grok) ReadSavedQuota(ctx context.Context, file SnapshotFileReader) (*LiveUsage, error) {
	session, err := grokSavedSession(file)
	if err != nil {
		return nil, err
	}
	if session.accessToken == "" || isGrokExpired(session, time.Now()) {
		return nil, ErrQuotaLoginRequired
	}
	return grokUsageFromSession(ctx, session)
}

func grokSavedSession(file SnapshotFileReader) (grokSession, error) {
	raw, err := file("auth.json")
	if err != nil {
		return grokSession{}, err
	}
	return grokSessionFromAuth("saved auth.json", raw)
}

func grokUsageFromSession(ctx context.Context, session grokSession) (*LiveUsage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, grokUsageEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+session.accessToken)
	req.Header.Set("x-xai-token-auth", "xai-grok-cli")
	if userID := grokSessionUserID(session); userID != "" {
		req.Header.Set("x-userid", userID)
	}
	req.Header.Set("x-grok-client-version", envOr("GROK_CLIENT_VERSION", grokClientVersion))
	client := &http.Client{
		Timeout: 5 * time.Second,
		// A redirect must not carry the bearer token to another host.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, ErrQuotaLoginRequired
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("grok billing HTTP %d", resp.StatusCode)
	}
	return parseGrokUsage(raw)
}

// grokSessionUserID is the x-userid the CLI sends when the session carries an
// account id.
func grokSessionUserID(session grokSession) string {
	if id := stringField(session.raw, "user_id"); id != "" {
		return id
	}
	return stringField(session.raw, "userId")
}

// parseGrokUsage parses the billing payload: config.creditUsagePercent wins,
// else the used/monthlyLimit pair; the window name comes from the vendor's
// period type.
func parseGrokUsage(raw []byte) (*LiveUsage, error) {
	var root map[string]interface{}
	if json.Unmarshal(raw, &root) != nil {
		return nil, fmt.Errorf("invalid Grok billing JSON")
	}
	config := objectMap(root["config"])
	if config == nil {
		return nil, nil
	}
	period := objectMap(config["currentPeriod"])
	label := "Current period"
	periodType := stringValue(period["type"])
	switch {
	case strings.Contains(periodType, "WEEKLY"):
		label = "Weekly"
	case strings.Contains(periodType, "MONTHLY"):
		label = "Monthly"
	}
	usedPercent := numberValue(config["creditUsagePercent"])
	if math.IsNaN(usedPercent) {
		limit := wrappedNumberValue(config["monthlyLimit"])
		used := wrappedNumberValue(config["used"])
		if !math.IsNaN(limit) && limit > 0 && !math.IsNaN(used) {
			usedPercent = used / limit * 100
		}
	}
	if math.IsNaN(usedPercent) {
		return nil, nil
	}
	window := UsageWindow{
		Label:            label,
		RemainingPercent: clampPercent(100 - usedPercent),
	}
	reset := stringValue(period["end"])
	if reset == "" {
		reset = stringValue(config["billingPeriodEnd"])
	}
	if at, err := time.Parse(time.RFC3339, reset); err == nil {
		ms := float64(at.UnixMilli())
		window.ResetsAtMs = &ms
	}
	return &LiveUsage{Windows: []UsageWindow{window}}, nil
}

// wrappedNumberValue reads the {"val": N} wrapper the Grok billing amounts
// use.
func wrappedNumberValue(v interface{}) float64 {
	return numberValue(objectMap(v)["val"])
}

func stringValue(v interface{}) string {
	s, _ := v.(string)
	return s
}
