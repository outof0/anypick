package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// cloudflareAIGateway is the Cloudflare AI Gateway account source via the
// Unified Billing REST API:
//
//	https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
//
// with `Authorization: Bearer <CF API token>` plus the per-request
// `cf-aig-gateway-id` header. Billing and provider keys stay on the Cloudflare
// side, so AnyPick only stores the account id, the gateway id and the token.
//
// The base URL is per-account (it embeds the Cloudflare account id), so this
// cannot be a static Compatible definition with a fixed OpenAIBase. It is a
// small custom provider that keeps the same credential-input contract:
// secret carries the API token, profile carries `<account_id>/<gateway_id>`.
type cloudflareAIGateway struct{}

func newCloudflareAIGateway() *cloudflareAIGateway { return &cloudflareAIGateway{} }

const (
	cloudflareAIGatewayID    = "cloudflare-aigateway"
	cloudflareCredentialKind = "api-token"
	cloudflareCredentialFile = "cloudflare-credential.json"
	cloudflareDefaultGateway = "default"
	cloudflareGatewayHeader  = "cf-aig-gateway-id"
	cloudflareProfileHint    = "<account_id>/<gateway_id>"
	cloudflareExampleProfile = "f4b3c2a1e5d647a8b9c0d1e2f3a4b5c6/default"
	cloudflareExampleAccount = "f4b3c2a1e5d647a8b9c0d1e2f3a4b5c6"
)

var (
	cloudflareAccountIDRe = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	cloudflareGatewayIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type cloudflareCredential struct {
	Version   int    `json:"version"`
	Kind      string `json:"kind"`
	AccountID string `json:"accountId"`
	GatewayID string `json:"gatewayId"`
	Secret    string `json:"secret"`
}

func (p *cloudflareAIGateway) ID() string { return cloudflareAIGatewayID }

// GatewayInfo lists Cloudflare in the Add Gateway picker. The endpoint is
// per-account (it embeds the Cloudflare account id), so there is no static
// URL to supply: the picker collects the account id and the engine derives
// and stores the base URL at create time. Asking the user to paste the URL
// would make them type what the engine already knows how to build.
func (p *cloudflareAIGateway) GatewayInfo() GatewayInfo {
	return GatewayInfo{
		ProvidesEndpoint:  true,
		RequiresAPIKey:    true,
		RequiresGatewayID: true,
		RequiresAccountID: true,
		Kind:              "hosted",
	}
}

// NormalizeGatewayID validates the gateway id for a profile gateway. Empty
// selects the provider default, matching parseCloudflareProfile's bare
// account id behavior for the account flow.
func (p *cloudflareAIGateway) NormalizeGatewayID(id string) (string, error) {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" {
		return cloudflareDefaultGateway, nil
	}
	if !cloudflareGatewayIDRe.MatchString(trimmed) {
		return "", anyerr.Newf(
			"Cloudflare gateway id must be 1-64 letters, numbers, dashes or underscores.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithSuggestions("Use the gateway id from the Cloudflare dashboard URL."))
	}
	return trimmed, nil
}

// GatewayUpstreamWithEndpoint serves profile gateways (gateway-create): the
// account id comes from the stored endpoint URL, the token from the profile
// key, and the gateway id from the profile headers. The header name stays
// provider-owned here so the stored shape never names Cloudflare specifics.
func (p *cloudflareAIGateway) GatewayUpstreamWithEndpoint(
	endpoint, apiKey string, headers map[string]string,
) (*proxy.Upstream, error) {
	accountID, err := cloudflareAccountIDFromEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	gatewayID := strings.TrimSpace(headers["gatewayId"])
	if gatewayID == "" {
		gatewayID = cloudflareDefaultGateway
	} else if !cloudflareGatewayIDRe.MatchString(gatewayID) {
		return nil, anyerr.Newf(
			"Stored Cloudflare gateway id is not a valid gateway id.",
			"STATE_CONFLICT")
	}
	base, err := url.Parse(cloudflareBaseURL(accountID))
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse Cloudflare upstream base", "PROXY_START_FAILED")
	}
	secret := strings.TrimSpace(apiKey)
	if strings.HasPrefix(strings.ToLower(secret), "bearer ") {
		secret = strings.TrimSpace(secret[len("bearer "):])
	}
	anthropicBase, err := url.Parse(cloudflareAnthropicBaseURL(accountID))
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse Cloudflare Anthropic base", "PROXY_START_FAILED")
	}
	up := &proxy.Upstream{
		BaseURL:         base,
		Auth:            secret,
		AuthHeader:      "Authorization",
		AuthValuePrefix: "Bearer ",
		ExtraHeaders: []proxy.ExtraHeader{
			{Name: cloudflareGatewayHeader, Value: gatewayID},
		},
		Anthropic: &proxy.UpstreamTarget{
			BaseURL:         anthropicBase,
			AuthHeader:      "Authorization",
			AuthValuePrefix: "Bearer ",
		},
		QuotaErrorPatterns: []string{
			"rate_limit", "quota.*exceeded", "insufficient.*credit", "billing",
		},
	}
	up.ModelDiscovery = func(ctx context.Context) ([]string, error) {
		return cloudflareLiveModels(ctx, cloudflareBaseURL(accountID), secret, gatewayID)
	}
	return up, nil
}

// DeriveGatewayEndpoint implements GatewayEndpointDeriver: the Add Gateway
// sheet collects the bare account id (no URL to mistype) and the engine
// stores the derived base URL like any other gateway endpoint.
func (p *cloudflareAIGateway) DeriveGatewayEndpoint(profile string) (string, error) {
	trimmed := strings.TrimSpace(profile)
	if trimmed == "" {
		return "", anyerr.Newf(
			"A Cloudflare account id is required.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithSuggestions("Find it in the Cloudflare dashboard URL after /accounts/."))
	}
	if strings.Contains(trimmed, "/") {
		return "", anyerr.Newf(
			"Put the account id here alone; the gateway id belongs in Gateway ID.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if !cloudflareAccountIDRe.MatchString(trimmed) {
		return "", anyerr.Newf(
			"Cloudflare account id must be a 32-character hex string.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithSuggestions("Find it in the Cloudflare dashboard URL after /accounts/."))
	}
	return cloudflareBaseURL(trimmed), nil
}

// cloudflareAccountIDFromEndpoint recovers the account id from a stored
// gateway endpoint (.../client/v4/accounts/{id}/ai/v1). The Add Gateway sheet
// collects the full URL because the id lives inside it; failing closed here
// (instead of guessing) keeps a typo'd endpoint from routing billing to the
// wrong Cloudflare account.
func cloudflareAccountIDFromEndpoint(endpoint string) (string, error) {
	trimmed := strings.TrimSpace(endpoint)
	lower := strings.ToLower(trimmed)
	marker := "/client/v4/accounts/"
	idx := strings.Index(lower, marker)
	if idx < 0 {
		return "", anyerr.Newf(
			"Cloudflare endpoint must look like https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	rest := trimmed[idx+len(marker):]
	accountID := rest
	if cut := strings.Index(rest, "/"); cut >= 0 {
		accountID = rest[:cut]
	}
	if !cloudflareAccountIDRe.MatchString(accountID) {
		return "", anyerr.Newf(
			"Cloudflare endpoint must contain a 32-hex-digit account id.",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return accountID, nil
}
func (p *cloudflareAIGateway) Name() string {
	return "Cloudflare AI Gateway"
}
func (p *cloudflareAIGateway) Description() string {
	return "Cloudflare AI Gateway REST API (Unified Billing) — OpenAI + Anthropic via one Cloudflare token"
}
func (p *cloudflareAIGateway) CanProxy() bool    { return true }
func (p *cloudflareAIGateway) ShortName() string { return "CF Gateway" }

// AccountAdapter mirrors the compatible-vendor pairing: claude, codex, pi
// and omp ride the builtin proxy — every other client is unsupported.
func (p *cloudflareAIGateway) AccountAdapter(accountName string, _ bool) transport.Adapter {
	a := transport.Adapter{}
	a.SourceRef.Kind = "account"
	a.SourceRef.Provider = p.ID()
	a.SourceRef.Name = accountName
	a.Capabilities = transport.Capabilities{
		SourceKind:              "account",
		Provider:                p.ID(),
		NativeClients:           []string{},
		Protocols:               []transport.Protocol{transport.OpenAI, transport.Anthropic},
		CanRefresh:              false,
		SupportsModelDiscovery:  true,
		RequiresNativeAuthWrite: false,
	}
	a.TransportFor = func(clientID string) transport.Capability {
		switch clientID {
		case "claude", "codex", "pi", "omp":
			return transport.ManagedBuiltinProxy
		default:
			return transport.Unsupported
		}
	}
	return a
}

// DetectLive: the gateway has no native login on this machine.
func (p *cloudflareAIGateway) DetectLive() (LiveAuthStatus, error) {
	return LiveAuthStatus{}, nil
}

// Backup: use SaveInput with an explicit credential instead.
func (p *cloudflareAIGateway) Backup(_ string) (SnapshotInfo, error) {
	return SnapshotInfo{}, anyerr.Newf(
		p.Name()+" has no native login to save. Add a Cloudflare API token instead.",
		"NO_LIVE_AUTH",
		anyerr.WithSuggestions(
			"anypick add account "+p.ID()+" --name <name> --credential "+cloudflareCredentialKind+" --secret <CF_API_TOKEN> --profile "+cloudflareProfileHint))
}

// Restore is a no-op: the proxy reads the snapshot directly.
func (p *cloudflareAIGateway) Restore(_ string) error { return nil }

func (p *cloudflareAIGateway) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	cred, err := readCloudflareCredential(srcDir)
	if err != nil || cred == nil {
		return SnapshotInfo{}, nil
	}
	return SnapshotInfo{
		Identity:        cred.GatewayID,
		Notes:           "Cloudflare AI Gateway",
		CredentialKind:  "proxy-only",
		CredentialClass: "provider_api_key",
	}, nil
}

// CredentialDefinitions publishes the single token product. The profile is
// free-form `<account_id>/<gateway_id>` (see parseCloudflareProfile); the
// listed placeholder only documents the shape for pickers.
func (p *cloudflareAIGateway) CredentialDefinitions() []CredentialDefinition {
	return []CredentialDefinition{{
		Kind:            cloudflareCredentialKind,
		Label:           "Cloudflare API token",
		CredentialClass: "provider_api_key",
		Profiles: []EndpointProfile{{
			ID:         "gateway",
			Label:      "Account/Gateway — pass profile as " + cloudflareProfileHint,
			OpenAIBase: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
		}},
	}}
}

// BackupInput stores the token plus the account/gateway routing pair. The
// secret stays the token alone so rotation never needs the routing pair, and
// the profile stays the routing pair alone so `anypick models` and proxy
// diagnostics can print it without touching the secret (invariant #2).
func (p *cloudflareAIGateway) BackupInput(kind, secret, profile, destDir string) (SnapshotInfo, error) {
	if kind != cloudflareCredentialKind {
		return SnapshotInfo{}, anyerr.Newf(
			p.Name()+" does not accept credential kind \""+kind+"\".",
			"UNSUPPORTED_CREDENTIAL_INPUT")
	}
	token := strings.TrimSpace(secret)
	if strings.HasPrefix(strings.ToLower(token), "bearer ") {
		token = strings.TrimSpace(token[len("bearer "):])
	}
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return SnapshotInfo{}, anyerr.Newf(
			"A non-empty Cloudflare API token without newlines is required.", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	accountID, gatewayID, err := parseCloudflareProfile(profile)
	if err != nil {
		return SnapshotInfo{}, err
	}
	stored := cloudflareCredential{
		Version: 1, Kind: cloudflareCredentialKind,
		AccountID: accountID, GatewayID: gatewayID, Secret: token,
	}
	data, err := json.Marshal(stored)
	if err != nil {
		return SnapshotInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(destDir, cloudflareCredentialFile), data, 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{
		Identity:        gatewayID,
		Notes:           "Cloudflare AI Gateway",
		CredentialKind:  "proxy-only",
		CredentialClass: "provider_api_key",
	}, nil
}

// parseCloudflareProfile splits `<account_id>/<gateway_id>`. A bare account id
// routes through the account's `default` gateway. The CLI defaults an omitted
// profile to "global", which is never a valid routing pair — report it as a
// missing value rather than an invalid id so the fix is obvious.
func parseCloudflareProfile(profile string) (accountID, gatewayID string, err error) {
	trimmed := strings.TrimSpace(profile)
	if trimmed == "" || trimmed == "global" {
		return "", "", anyerr.Newf(
			"Cloudflare AI Gateway needs a routing profile: --profile "+cloudflareProfileHint+" (e.g. --profile "+cloudflareExampleProfile+").",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithSuggestions(
				"Find the account ID with `wrangler whoami`; the gateway slug is the AI Gateway name (`default` works without setup)."))
	}
	accountID, gatewayID = trimmed, cloudflareDefaultGateway
	if before, after, ok := strings.Cut(trimmed, "/"); ok {
		accountID, gatewayID = strings.TrimSpace(before), strings.TrimSpace(after)
		if gatewayID == "" {
			gatewayID = cloudflareDefaultGateway
		}
	} else {
		accountID = strings.TrimSpace(trimmed)
	}
	if !cloudflareAccountIDRe.MatchString(accountID) {
		return "", "", anyerr.Newf(
			"Invalid Cloudflare account ID \""+accountID+"\": want 32 hex chars (e.g. "+cloudflareExampleAccount+").",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithSuggestions("Run `wrangler whoami` to print the account ID."))
	}
	if !cloudflareGatewayIDRe.MatchString(gatewayID) {
		return "", "", anyerr.Newf(
			"Invalid Cloudflare gateway ID \""+gatewayID+"\": use letters, digits, - or _ (e.g. default).",
			"INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return accountID, gatewayID, nil
}

func readCloudflareCredential(dir string) (*cloudflareCredential, error) {
	raw, err := os.ReadFile(filepath.Join(dir, cloudflareCredentialFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var cred cloudflareCredential
	if json.Unmarshal(raw, &cred) != nil || cred.Version != 1 ||
		cred.Kind != cloudflareCredentialKind ||
		cred.AccountID == "" || cred.GatewayID == "" || cred.Secret == "" {
		return nil, anyerr.Newf(
			"Invalid "+cloudflareCredentialFile+" in snapshot.", "SNAPSHOT_INVALID")
	}
	return &cred, nil
}

func cloudflareBaseURL(accountID string) string {
	return "https://api.cloudflare.com/client/v4/accounts/" + accountID + "/ai/v1"
}

// cloudflareAnthropicBaseURL is the native Anthropic target base. The proxy
// joins it with the inbound /v1/messages path, so it must NOT carry the /v1
// the OpenAI surface needs — otherwise Claude Code lands on
// .../ai/v1/v1/messages. Mirrors the catalog convention (Anthropic surfaces
// never end in /v1; the SDK appends /v1/messages itself).
func cloudflareAnthropicBaseURL(accountID string) string {
	return strings.TrimSuffix(cloudflareBaseURL(accountID), "/v1")
}

// ResolveUpstream points the shared proxy at the account's Unified Billing
// REST API. One base serves both protocols: .../ai/v1/chat/completions for
// OpenAI and .../ai/v1/messages for Anthropic, both under Bearer auth with
// the gateway selected per request by cf-aig-gateway-id.
func (p *cloudflareAIGateway) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	cred, err := readCloudflareCredential(snapshotDir)
	if err != nil {
		return nil, err
	}
	if cred == nil {
		return nil, anyerr.Newf(
			"No saved credential in this snapshot ("+cloudflareCredentialFile+").",
			"NO_CREDENTIAL")
	}
	base, err := url.Parse(cloudflareBaseURL(cred.AccountID))
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse Cloudflare upstream base", "PROXY_START_FAILED")
	}
	anthropicBase, err := url.Parse(cloudflareAnthropicBaseURL(cred.AccountID))
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse Cloudflare Anthropic base", "PROXY_START_FAILED")
	}
	accountID, gatewayID, secret := cred.AccountID, cred.GatewayID, cred.Secret
	up := &proxy.Upstream{
		BaseURL:         base,
		Auth:            secret,
		AuthHeader:      "Authorization",
		AuthValuePrefix: "Bearer ",
		ExtraHeaders: []proxy.ExtraHeader{
			{Name: cloudflareGatewayHeader, Value: gatewayID},
		},
		Anthropic: &proxy.UpstreamTarget{
			BaseURL:         anthropicBase,
			AuthHeader:      "Authorization",
			AuthValuePrefix: "Bearer ",
		},
		QuotaErrorPatterns: []string{
			"rate_limit", "quota.*exceeded", "insufficient.*credit", "billing",
		},
	}
	up.ModelDiscovery = func(ctx context.Context) ([]string, error) {
		return cloudflareLiveModels(ctx, cloudflareBaseURL(accountID), secret, gatewayID)
	}
	return up, nil
}

// cloudflareLiveModels lists .../ai/v1/models with the same auth the proxy
// uses. A model list is advisory: transport errors and non-2xx answers fall
// back to the static catalog instead of failing the proxy start.
func cloudflareLiveModels(ctx context.Context, base, secret, gatewayID string) ([]string, error) {
	var headers map[string]string
	if gatewayID != "" {
		headers = map[string]string{cloudflareGatewayHeader: gatewayID}
	}
	return listOpenAIModels(ctx, base, secret, headers)
}

// listOpenAIModels reads an OpenAI-shaped GET {base}/models. The secret is
// optional: a local model server answers without one.
func listOpenAIModels(ctx context.Context, base, secret string, headers map[string]string) ([]string, error) {
	target := strings.TrimRight(base, "/") + "/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := egress.NewClient(6 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var shape struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &shape) != nil {
		return nil, nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(shape.Data))
	for _, item := range shape.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// ValidateSnapshot probes .../ai/v1/models with a bounded request: a
// definitive 401/403 means the token is dead and the account fails fast before
// any mutation. Transport errors fail open — the vendor decides at request
// time.
func (p *cloudflareAIGateway) ValidateSnapshot(snapshotDir string) error {
	cred, err := readCloudflareCredential(snapshotDir)
	if err != nil || cred == nil || cred.Secret == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	target := strings.TrimRight(cloudflareBaseURL(cred.AccountID), "/") + "/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+cred.Secret)
	req.Header.Set(cloudflareGatewayHeader, cred.GatewayID)
	resp, err := egress.NewClient(10 * time.Second).Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		return nil
	}
	return anyerr.Newf(
		"Cloudflare rejected the saved API token (HTTP "+http.StatusText(resp.StatusCode)+"). Rotate the token to repair it.",
		"AUTH_REQUIRED",
		anyerr.WithExitCode(anyerr.AuthRequired),
		anyerr.WithSuggestions(
			"Create a new token (Account → AI Gateway → API tokens), then re-add the account with --force."))
}
