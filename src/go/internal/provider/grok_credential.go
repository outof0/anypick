package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/proxy"
)

// Grok's proxy speaks OpenAI + Anthropic against cli-chat-proxy.grok.com and
// authenticates with the OIDC access token from <snapshot>/auth.json. The token
// is short-lived, so the proxy must refresh it (OIDC refresh_token grant)
// before forwarding. This file reads the saved auth.json, picks a session,
// refreshes when expired, and writes the rotated tokens back so the snapshot
// stays in sync.

const (
	grokOIDCIssuer      = "https://auth.x.ai"
	grokClientVersion   = "0.2.101"
	grokDefaultUpstream = "https://cli-chat-proxy.grok.com"
	grokRefreshSkew     = 60 * time.Second
	grokOIDCTimeout     = 30 * time.Second
	// grokRefreshLockTimeout must comfortably exceed the in-flight OIDC refresh
	// (grokOIDCTimeout) so a waiter adopting a winner's rotated token does not
	// time out while the holder is mid-redemption.
	grokRefreshLockTimeout = 60 * time.Second
)

type grokSession struct {
	// raw is the on-disk object for storageKey; mutated in place on refresh so
	// unrelated fields survive the round-trip.
	raw          map[string]json.RawMessage
	accessToken  string
	refreshToken string
	expiresAt    string // RFC3339; empty → never expires client-side
	oidcIssuer   string
	oidcClientID string
	storageKey   string
}

// Reads the saved auth.json and picks a usable OIDC session.
func loadGrokSession(authPath string) (grokSession, error) {
	raw, err := os.ReadFile(authPath)
	if err != nil {
		if os.IsNotExist(err) {
			return grokSession{}, anyerr.Newf(
				"Grok auth not found at "+authPath+". Run: grok login",
				"NO_LIVE_AUTH",
				anyerr.WithSuggestions("Sign in with the official tool, then try again."))
		}
		return grokSession{}, err
	}
	return grokSessionFromAuth(authPath, raw)
}

func grokSessionFromAuth(authPath string, raw []byte) (grokSession, error) {
	var data map[string]json.RawMessage
	if err := json.Unmarshal(raw, &data); err != nil {
		return grokSession{}, anyerr.Newf("Unreadable Grok auth: "+authPath+".", "NO_LIVE_AUTH")
	}
	storageKey, rawSession := pickGrokSession(data)
	if storageKey == "" {
		return grokSession{}, anyerr.Newf(
			"No OIDC session in "+authPath+". Run: grok login",
			"NO_LIVE_AUTH",
			anyerr.WithSuggestions("Sign in with the official tool, then try again."))
	}
	var entry map[string]json.RawMessage
	if err := json.Unmarshal(rawSession, &entry); err != nil {
		return grokSession{}, anyerr.Newf("Unreadable Grok auth: "+authPath+".", "NO_LIVE_AUTH")
	}
	s := grokSession{raw: entry, storageKey: storageKey}
	s.accessToken = stringField(entry, "key")
	if s.accessToken == "" {
		s.accessToken = stringField(entry, "access_token")
	}
	s.refreshToken = stringField(entry, "refresh_token")
	s.expiresAt = stringField(entry, "expires_at")
	s.oidcIssuer = validateGrokIssuer(stringField(entry, "oidc_issuer"))
	if s.oidcIssuer == "" {
		s.oidcIssuer = grokOIDCIssuer
	}
	s.oidcClientID = stringField(entry, "oidc_client_id")
	if s.oidcClientID == "" {
		// storageKey is "issuer::clientId"
		if parts := strings.SplitN(storageKey, "::", 2); len(parts) == 2 {
			s.oidcClientID = parts[1]
		}
	}
	if s.accessToken == "" && s.refreshToken == "" {
		return grokSession{}, anyerr.Newf("Grok session has no access or refresh token.", "NO_LIVE_AUTH")
	}
	if s.oidcClientID == "" {
		return grokSession{}, anyerr.Newf("Grok session missing oidc_client_id.", "NO_LIVE_AUTH")
	}
	return s, nil
}

// pickGrokSession is pickSession: prefer an xAI OIDC-looking entry, else the
// first object-valued entry.
func pickGrokSession(data map[string]json.RawMessage) (string, json.RawMessage) {
	type shape struct {
		Key      string `json:"key"`
		Refresh  string `json:"refresh_token"`
		AuthMode string `json:"auth_mode"`
	}
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]struct {
		key string
		raw json.RawMessage
	}, 0, len(keys))
	for _, key := range keys {
		raw := data[key]
		var candidate map[string]json.RawMessage
		if json.Unmarshal(raw, &candidate) != nil || len(candidate) == 0 {
			continue
		}
		entries = append(entries, struct {
			key string
			raw json.RawMessage
		}{key: key, raw: raw})
	}
	if len(entries) == 0 {
		return "", nil
	}
	for _, e := range entries {
		var sh shape
		_ = json.Unmarshal(e.raw, &sh)
		if sh.Key != "" || sh.Refresh != "" || sh.AuthMode == "oidc" {
			return e.key, e.raw
		}
	}
	return entries[0].key, entries[0].raw
}

func isGrokExpired(s grokSession, now time.Time) bool {
	if s.expiresAt == "" {
		return false
	}
	exp, err := time.Parse(time.RFC3339, s.expiresAt)
	if err != nil {
		return false
	}
	return !exp.Add(-grokRefreshSkew).After(now)
}

// grokEnsureAccessToken is ensureAccessToken: return a valid access token,
// refreshing via OIDC when expired.
func grokEnsureAccessToken(authPath string) (string, error) {
	s, err := loadGrokSession(authPath)
	if err != nil {
		return "", err
	}
	if s.accessToken != "" && !isGrokExpired(s, time.Now()) {
		return s.accessToken, nil
	}
	if s.refreshToken == "" {
		return "", anyerr.Newf(
			"Grok access token expired and no refresh_token available. Run: grok login",
			"NO_LIVE_AUTH")
	}
	s2, err := refreshGrokSession(authPath, s)
	if err != nil {
		return "", err
	}
	return s2.accessToken, nil
}

// refreshGrokSession serializes refreshes across processes with a file lock
// (${authPath}.refresh.lock), reloads to adopt a winner's rotated token, then
// redeems the refresh_token and writes back so the snapshot stays current.
func refreshGrokSession(authPath string, s grokSession) (grokSession, error) {
	fl, err := lock.AcquireFileLock(authPath+".refresh.lock", grokRefreshLockTimeout)
	if err != nil {
		return grokSession{}, anyerr.Wrapf(err, "acquire Grok refresh lock", "PROXY_START_FAILED")
	}
	defer fl.Release()

	// Someone else may have refreshed while we waited; adopt their token.
	if latest, lerr := loadGrokSession(authPath); lerr == nil {
		if latest.storageKey == s.storageKey &&
			(latest.accessToken != s.accessToken || latest.refreshToken != s.refreshToken) {
			return latest, nil
		}
		s = latest
	}

	tokenURL, err := resolveGrokTokenEndpoint(s.oidcIssuer)
	if err != nil {
		return grokSession{}, err
	}
	// GROK_TOKEN_ENDPOINT overrides discovery for tests. Like the Gemini
	// hook it honors loopback URLs only and fails closed otherwise, so a
	// poisoned environment cannot redirect the refresh grant elsewhere.
	// Production always goes through the pinned xAI issuer above.
	if v := strings.TrimSpace(os.Getenv("GROK_TOKEN_ENDPOINT")); v != "" {
		if tokenURL, err = oauthTokenEndpoint("GROK_TOKEN_ENDPOINT", tokenURL); err != nil {
			return grokSession{}, err
		}
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {s.refreshToken},
		"client_id":     {s.oidcClientID},
	}
	ctx, cancel := context.WithTimeout(context.Background(), grokOIDCTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return grokSession{}, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return grokSession{}, anyerr.Newf("Grok OIDC refresh failed: "+err.Error(), "PROXY_START_FAILED")
	}
	defer resp.Body.Close()
	// Bound the OIDC body: the endpoint is outside our trust boundary and
	// its payload must never flow verbatim into errors, logs, or clients.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return grokSession{}, anyerr.Newf(
			fmt.Sprintf("Grok OIDC refresh failed (HTTP %d)", resp.StatusCode),
			"PROXY_START_FAILED")
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    *int   `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return grokSession{}, anyerr.Newf("Grok OIDC refresh returned unreadable body.", "PROXY_START_FAILED")
	}
	if tok.AccessToken == "" {
		return grokSession{}, anyerr.Newf("Grok OIDC refresh returned no access_token.", "PROXY_START_FAILED")
	}
	expiresAt := s.expiresAt
	if tok.ExpiresIn != nil {
		expiresAt = time.Now().Add(time.Duration(*tok.ExpiresIn) * time.Second).UTC().Format(time.RFC3339)
	}
	updated := s
	updated.accessToken = tok.AccessToken
	if tok.RefreshToken != "" {
		updated.refreshToken = tok.RefreshToken
	}
	updated.expiresAt = expiresAt
	setRawString(updated.raw, "key", updated.accessToken)
	setRawString(updated.raw, "refresh_token", updated.refreshToken)
	setRawString(updated.raw, "expires_at", updated.expiresAt)
	if err := writeGrokSession(authPath, updated); err != nil {
		return grokSession{}, err
	}
	return updated, nil
}

// resolveGrokTokenEndpoint is resolveTokenEndpoint: OIDC discovery with a
// pinned fallback, refusing any endpoint off the xAI issuer.
func resolveGrokTokenEndpoint(issuer string) (string, error) {
	safe := validateGrokIssuer(issuer)
	if safe == "" {
		return "", anyerr.Newf("Refusing untrusted Grok OIDC issuer "+issuer+".", "PROXY_START_FAILED")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		safe+"/.well-known/openid-configuration", nil)
	if err == nil {
		if resp, derr := http.DefaultClient.Do(req); derr == nil {
			defer resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				var conf struct {
					TokenEndpoint string `json:"token_endpoint"`
				}
				if b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10)); json.Unmarshal(b, &conf) == nil && conf.TokenEndpoint != "" {
					if ep, ok := validateGrokTokenEndpoint(conf.TokenEndpoint); ok {
						return ep, nil
					}
				}
			}
		}
	}
	return safe + "/oauth2/token", nil
}

func validateGrokIssuer(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	normalized := u.Scheme + "://" + u.Host + strings.TrimSuffix(u.Path, "/")
	if u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		normalized != grokOIDCIssuer {
		return ""
	}
	return grokOIDCIssuer
}

func validateGrokTokenEndpoint(value string) (string, bool) {
	u, err := url.Parse(value)
	if err != nil {
		return "", false
	}
	if u.Scheme != "https" || u.Host != "auth.x.ai" || u.User != nil || u.Fragment != "" {
		return "", false
	}
	return u.String(), true
}

// grokSanitizeOpenAIBody removes the OpenAI reasoning_effort knob emitted by
// subscription clients such as DSH. Grok's subscription chat endpoint rejects
// that parameter even when the selected model is a reasoning variant; its
// native thinking field remains supported and model selection is left intact.
func grokSanitizeOpenAIBody(body []byte) []byte {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	delete(payload, "reasoning_effort")
	out, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return out
}

// grokSanitizeAnthropicBody normalizes tool schemas for Grok's strict
// validator. Claude Code omits `required` (or emits it null) when no property
// is required — valid JSON Schema, but Grok rejects the request with
// `/required: null is not of type "array"`. An empty required list is the
// semantically identical valid shape, so null is rewritten to [] and a
// missing key is inserted, at any depth of each tool's input_schema.
// Anything that is not valid JSON passes through untouched.
func grokSanitizeAnthropicBody(body []byte) []byte {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	changed := fixGrokNullRequired(payload)
	if fixGrokMissingRequired(payload) {
		changed = true
	}
	if !changed {
		return body
	}
	out, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return out
}

// fixGrokMissingRequired inserts `"required": []` into every object schema
// under a tool's input_schema that lacks the key. Only schema subtrees are
// touched: the walk starts at tools[].input_schema, and a node counts as an
// object schema when it declares type object or carries properties. Request
// envelopes, messages, and content blocks are not schemas and keep their
// shape.
func fixGrokMissingRequired(v any) bool {
	root, ok := v.(map[string]any)
	if !ok {
		return false
	}
	changed := false
	tools, _ := root["tools"].([]any)
	for _, raw := range tools {
		tool, _ := raw.(map[string]any)
		if tool == nil {
			continue
		}
		schema, _ := tool["input_schema"].(map[string]any)
		if schema == nil {
			continue
		}
		if ensureGrokRequired(schema) {
			changed = true
		}
	}
	return changed
}

// ensureGrokRequired reports whether it inserted anything.
func ensureGrokRequired(schema map[string]any) bool {
	changed := false
	if _, ok := schema["required"]; !ok && isGrokObjectSchema(schema) {
		schema["required"] = []any{}
		changed = true
	}
	for key, val := range schema {
		switch key {
		case "properties", "$defs", "definitions":
			if children, ok := val.(map[string]any); ok {
				for _, child := range children {
					if sub, ok := child.(map[string]any); ok {
						if ensureGrokRequired(sub) {
							changed = true
						}
					}
				}
			}
		case "items", "additionalProperties", "contains":
			switch sub := val.(type) {
			case map[string]any:
				if ensureGrokRequired(sub) {
					changed = true
				}
			case []any:
				for _, item := range sub {
					if m, ok := item.(map[string]any); ok {
						if ensureGrokRequired(m) {
							changed = true
						}
					}
				}
			}
		case "allOf", "anyOf", "oneOf", "prefixItems":
			if items, ok := val.([]any); ok {
				for _, item := range items {
					if m, ok := item.(map[string]any); ok {
						if ensureGrokRequired(m) {
							changed = true
						}
					}
				}
			}
		}
	}
	return changed
}

// isGrokObjectSchema reports whether a schema node describes an object, the
// only shape `required` is meaningful on.
func isGrokObjectSchema(schema map[string]any) bool {
	if typ, ok := schema["type"].(string); ok {
		return typ == "object"
	}
	if types, ok := schema["type"].([]any); ok {
		for _, t := range types {
			if s, _ := t.(string); s == "object" {
				return true
			}
		}
	}
	_, hasProperties := schema["properties"]
	return hasProperties
}

// fixGrokNullRequired reports whether it replaced anything.
func fixGrokNullRequired(v any) bool {
	changed := false
	switch node := v.(type) {
	case map[string]any:
		for key, val := range node {
			if key == "required" && val == nil {
				node[key] = []any{}
				changed = true
				continue
			}
			if fixGrokNullRequired(val) {
				changed = true
			}
		}
	case []any:
		for _, item := range node {
			if fixGrokNullRequired(item) {
				changed = true
			}
		}
	}
	return changed
}

// setRawString updates one key in the on-disk session object, omitting it
// when empty so the JSON wire shape stays stable.
func setRawString(m map[string]json.RawMessage, key, val string) {
	if val == "" {
		delete(m, key)
		return
	}
	b, err := json.Marshal(val)
	if err != nil {
		return
	}
	m[key] = b
}

// writeGrokSession is writeSession: preserve every other session, overwrite the
// rotated one, keep the on-disk shape the snapshot expects.
func writeGrokSession(authPath string, s grokSession) error {
	var data map[string]json.RawMessage
	if raw, err := os.ReadFile(authPath); err == nil {
		_ = json.Unmarshal(raw, &data)
	}
	if data == nil {
		data = map[string]json.RawMessage{}
	}
	entry, err := json.Marshal(s.raw)
	if err != nil {
		return err
	}
	data[s.storageKey] = entry
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return writeGrokAuthAtomic(authPath, append(out, '\n'))
}

// writeGrokAuthAtomic replaces the live session file by rename, never by
// truncation.
//
// authPath is the real ~/.grok/auth.json, and x.ai rotates the refresh token on
// every redemption, so this runs while serving traffic rather than during a
// user action. An in-place write interrupted by SIGKILL or power loss leaves
// the user's Grok login empty or half-written with nothing to recover from:
// Backup copies live->snapshot, never the reverse, so there is no second copy
// (invariant #4, ADR 0004). The temporary file is staged beside the target so
// the rename cannot cross a filesystem.
func writeGrokAuthAtomic(authPath string, raw []byte) error {
	return atomicfile.Write(authPath, raw, 0o600)
}

// grokUpstream builds the shared-proxy Upstream for this account's saved auth
// (the dual-protocol base + injected headers). The token comes from
// AuthProvider so it refreshes per request; static ExtraHeaders pin the client
// version the upstream expects. authPath is the snapshot auth.json.
func grokUpstream(authPath string) (*proxy.Upstream, error) {
	// Fail fast when the snapshot has no usable session so the proxy refuses to
	// start with a clear error rather than 401-ing the first request.
	if _, err := loadGrokSession(authPath); err != nil {
		return nil, err
	}
	base, err := url.Parse(grokDefaultUpstream)
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse Grok upstream base", "PROXY_START_FAILED")
	}
	headers := []proxy.ExtraHeader{
		{Name: "x-grok-client-version", Value: grokClientVersion},
		{Name: "x-grok-client-identifier", Value: "anypick-grok-proxy"},
		{Name: "user-agent", Value: "anypick-grok-proxy/" + grokClientVersion},
	}
	provider := func(ctx context.Context) (string, error) { return grokEnsureAccessToken(authPath) }
	return &proxy.Upstream{
		BaseURL:            base,
		AuthHeader:         "Authorization",
		AuthValuePrefix:    "Bearer ",
		AuthProvider:       provider,
		ExtraHeaders:       headers,
		SanitizeOpenAIBody: grokSanitizeOpenAIBody,
		// Claude Code emits tool schemas with `"required": null` when no
		// property is required; Grok's endpoint validates strictly and 400s
		// (`/required: null is not of type "array"`). An empty required list
		// is the semantically identical valid shape.
		SanitizeAnthropicBody: grokSanitizeAnthropicBody,
		ModelDiscovery:        grokModelDiscovery(authPath),
		MapModel:              grokMapModel,
		// Native Anthropic target on the same base — cli-chat-proxy.grok.com
		// speaks both shapes.
		Anthropic: &proxy.UpstreamTarget{
			BaseURL:         base,
			AuthHeader:      "Authorization",
			AuthValuePrefix: "Bearer ",
			AuthProvider:    provider,
		},
	}, nil
}

// grokMapModel translates client-requested models (notably Codex native alias
// slugs such as gpt-5.6-sol) into Grok's subscription models.
func grokMapModel(model string) string {
	target := strings.TrimSpace(os.Getenv("GROK_DEFAULT_MODEL"))
	if target == "" {
		target = "grok-4.7"
	}
	switch model {
	case "gpt-5.6-sol", "gpt-5.6", "gpt-5", "gpt-default", "gpt":
		return target
	case "gpt-5.6-terra", "gpt-balanced", "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2":
		return "grok-4.5"
	case "gpt-5.6-luna", "gpt-fast", "gpt-4.1":
		return "grok-4.3"
	default:
		if strings.HasPrefix(model, "gpt-") {
			return target
		}
		return model
	}
}

// grokModelDiscovery is the provider-owned live catalog for a Grok
// subscription account. Without it DiscoverModels always returns
// ErrModelDiscoveryUnsupported, so the desktop picker publishes zero options
// (editable=false, "No models were discovered") and a Claude binding plans
// with no model pin — Claude Code then sends its native claude-* ids to a
// Grok upstream that only serves grok-* and every request fails.
//
// Live first: GET /v1/models on the subscription base with the current OIDC
// token and the vendor headers the proxy itself sends. Static fallback: the
// vendor-published grok-api list (the same fallback `anypick models` uses),
// which the proxy forwards verbatim and Grok serves. A dead login still
// publishes the static list so the user can pick a model; the proxy itself
// keeps failing fast on unusable snapshots and per-request on expired tokens.
func grokModelDiscovery(authPath string) func(context.Context) ([]string, error) {
	return func(ctx context.Context) ([]string, error) {
		if token, err := grokEnsureAccessToken(authPath); err == nil && token != "" {
			if live, lerr := fetchGrokLiveModels(ctx, token); lerr == nil && len(live) > 0 {
				return live, nil
			}
		}
		if static := discovery.StaticModels("grok-api"); len(static) > 0 {
			return static, nil
		}
		return nil, fmt.Errorf("provider returned an empty model catalog")
	}
}

// fetchGrokLiveModels lists the subscription's entitled models in OpenAI
// shape. Bounded: the endpoint is outside our trust boundary and its payload
// must never flow verbatim into errors, logs, or clients.
func fetchGrokLiveModels(ctx context.Context, token string) ([]string, error) {
	base := strings.TrimRight(grokDefaultUpstream, "/")
	// GROK_MODELS_ENDPOINT overrides discovery for tests. Like the OIDC hook
	// it honors loopback URLs only and fails closed otherwise, so a poisoned
	// environment cannot redirect the Bearer token elsewhere.
	if v := strings.TrimSpace(os.Getenv("GROK_MODELS_ENDPOINT")); v != "" {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !isLoopbackHost(u.Hostname()) {
			return nil, fmt.Errorf("GROK_MODELS_ENDPOINT must name a loopback URL (test hook)")
		}
		base = strings.TrimRight(v, "/")
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet,
		base+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("x-grok-client-version", grokClientVersion)
	req.Header.Set("x-grok-client-identifier", "anypick-grok-proxy")
	req.Header.Set("user-agent", "anypick-grok-proxy/"+grokClientVersion)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("grok models HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var shape struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &shape) != nil {
		return nil, fmt.Errorf("invalid Grok models JSON")
	}
	seen := map[string]bool{}
	out := []string{}
	for _, entry := range shape.Data {
		id := strings.TrimSpace(entry.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}
