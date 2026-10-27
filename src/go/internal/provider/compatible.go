// Compatible providers are declarative vendor definitions turned into full
// Providers. A definition needs no access to stores or proxy internals — core
// supplies the secret-boundary snapshot, the dual-protocol loopback proxy
// wiring, and the pairing rules.
package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// AuthScheme describes how the upstream expects the key.
type AuthScheme string

const (
	AuthBearer  AuthScheme = "bearer" // Authorization: Bearer <key>
	AuthXAPIKey AuthScheme = "x-api-key"
	AuthAPIKey  AuthScheme = "api-key"
)

// EndpointProfile describes one vendor endpoint. Bases are Chat Completions /
// Messages roots WITHOUT their final path segments.
type EndpointProfile struct {
	ID              string     `json:"id"`
	Label           string     `json:"label,omitempty"`
	OpenAIBase      string     `json:"openaiBase"`
	OpenAIAuth      AuthScheme `json:"openaiAuth,omitempty"` // default bearer
	NativeResponses bool       `json:"nativeResponses,omitempty"`
	AnthropicBase   string     `json:"anthropicBase,omitempty"` // omit → translate via OpenAI
	AnthropicAuth   AuthScheme `json:"anthropicAuth,omitempty"` // default x-api-key
}

// CredentialDefinition describes a provider-owned credential product. The
// compatible-provider path uses its endpoint profiles for upstream routing;
// native providers may publish the same picker shape while keeping routing
// semantics in their own implementation.
type CredentialDefinition struct {
	Kind            string            `json:"kind"`
	Label           string            `json:"label"`
	CredentialClass string            `json:"credentialClass,omitempty"` // provider_api_key | coding_plan_key | external_oauth
	Profiles        []EndpointProfile `json:"profiles"`
	// SecretOptional marks a product that works without a secret, such as a
	// local model server. Pickers then accept an empty key; the provider's
	// BackupInput is still what decides.
	SecretOptional bool `json:"secretOptional,omitempty"`
}

type CompatibleDefinition struct {
	ID                 string                 `json:"id"`
	Name               string                 `json:"name"`
	ShortName          string                 `json:"shortName,omitempty"`
	Description        string                 `json:"description"`
	DefaultProxyPort   int                    `json:"defaultProxyPort,omitempty"`
	Models             []string               `json:"models,omitempty"`
	Credentials        []CredentialDefinition `json:"credentials"`
	QuotaErrorPatterns []string               `json:"quotaErrorPatterns,omitempty"`
}

const compatibleCredentialFile = "compatible-credential.json"

type storedCompatibleCredential struct {
	Version int    `json:"version"`
	Kind    string `json:"kind"`
	Profile string `json:"profile"`
	Secret  string `json:"secret"`
}

// Compatible is the Provider built from an inert definition.
type Compatible struct{ Def CompatibleDefinition }

func NewCompatible(def CompatibleDefinition) (*Compatible, error) {
	if def.ID == "" || def.Name == "" || len(def.Credentials) == 0 {
		return nil, fmt.Errorf("compatible provider %q needs id, name, and credentials", def.ID)
	}
	seenKind := map[string]bool{}
	for _, c := range def.Credentials {
		if c.Kind == "" || seenKind[c.Kind] {
			return nil, fmt.Errorf("credential kind %q invalid or duplicated", c.Kind)
		}
		seenKind[c.Kind] = true
		if len(c.Profiles) == 0 {
			return nil, fmt.Errorf("credential %q needs at least one endpoint profile", c.Kind)
		}
	}
	return &Compatible{Def: def}, nil
}

// DefaultProxyPorter optionally exposes a compatible provider's advertised
// default proxy port without widening the Provider interface for everyone else.
type DefaultProxyPorter interface {
	DefaultProxyPort() int
}

func (p *Compatible) ID() string          { return p.Def.ID }
func (p *Compatible) Name() string        { return p.Def.Name }
func (p *Compatible) Description() string { return p.Def.Description }
func (p *Compatible) CanProxy() bool      { return true }

// DefaultProxyPort is the deterministic bind target when no explicit pool port
// is persisted (pool.port ?? provider.defaultProxyPort ?? 8080).
func (p *Compatible) DefaultProxyPort() int { return p.Def.DefaultProxyPort }

// AccountAdapter: claude, codex, pi and omp ride the builtin proxy — every
// other client is unsupported regardless of protocols declared.
func (p *Compatible) AccountAdapter(accountName string, _ bool) transport.Adapter {
	a := transport.Adapter{}
	a.SourceRef.Kind = "account"
	a.SourceRef.Provider = p.Def.ID
	a.SourceRef.Name = accountName
	a.Capabilities = transport.Capabilities{
		SourceKind:              "account",
		Provider:                p.Def.ID,
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

// DetectLive: compatible vendors have no native login.
func (p *Compatible) DetectLive() (LiveAuthStatus, error) { return LiveAuthStatus{}, nil }

// Backup: use SaveInput (backupInput) with an explicit credential instead.
func (p *Compatible) Backup(destDir string) (SnapshotInfo, error) {
	return SnapshotInfo{}, anyerr.Newf(
		p.Def.Name+" has no native login to save. Add an API or subscription credential instead.",
		"NO_LIVE_AUTH")
}

// Restore is a no-op: the proxy reads the snapshot directly; nothing lives on
// the machine to switch.
func (p *Compatible) Restore(srcDir string) error { return nil }

func (p *Compatible) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	stored, err := readStoredCredential(srcDir)
	if err != nil {
		return SnapshotInfo{}, nil
	}
	class := ""
	for _, c := range p.Def.Credentials {
		if c.Kind == stored.Kind {
			class = c.CredentialClass
		}
	}
	return SnapshotInfo{
		CredentialKind:  "proxy-only",
		CredentialClass: credentialClassOf(class),
	}, nil
}

func credentialClassOf(class string) string {
	switch class {
	case "coding_plan_key", "external_oauth", "provider_api_key":
		return class
	default:
		return "provider_api_key"
	}
}

// CredentialDefinitions returns the public credential products for UI and
// protocol pickers. It contains no secret material.
func (p *Compatible) CredentialDefinitions() []CredentialDefinition {
	out := make([]CredentialDefinition, len(p.Def.Credentials))
	copy(out, p.Def.Credentials)
	for i := range out {
		out[i].Profiles = append([]EndpointProfile(nil), p.Def.Credentials[i].Profiles...)
	}
	return out
}

// BackupInput is the optional capability for credential-input saves.
func (p *Compatible) BackupInput(kind, secret, profile string, destDir string) (SnapshotInfo, error) {
	cred := p.credentialDefinition(kind)
	if cred == nil {
		return SnapshotInfo{}, anyerr.Newf(
			p.Def.Name+" does not accept credential kind \""+kind+"\".",
			"UNSUPPORTED_CREDENTIAL_INPUT")
	}
	ep := p.endpointProfile(cred, profile)
	if ep == nil {
		return SnapshotInfo{}, anyerr.Newf(
			p.Def.Name+" has no endpoint profile \""+profile+"\" for "+kind+".",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if secret == "" {
		return SnapshotInfo{}, anyerr.Newf(
			"A non-empty "+cred.Label+" is required.", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	stored := storedCompatibleCredential{Version: 1, Kind: kind, Profile: ep.ID, Secret: secret}
	data, err := json.Marshal(stored)
	if err != nil {
		return SnapshotInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(destDir, compatibleCredentialFile), data, 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{CredentialKind: "proxy-only", CredentialClass: credentialClassOf(cred.CredentialClass)}, nil
}

func (p *Compatible) credentialDefinition(kind string) *CredentialDefinition {
	for i := range p.Def.Credentials {
		if p.Def.Credentials[i].Kind == kind {
			return &p.Def.Credentials[i]
		}
	}
	return nil
}

func (p *Compatible) endpointProfile(cred *CredentialDefinition, id string) *EndpointProfile {
	for i := range cred.Profiles {
		if cred.Profiles[i].ID == id {
			return &cred.Profiles[i]
		}
	}
	return nil
}

// ResolveUpstream reads the saved snapshot credential and maps it onto the
// endpoint profile the account was saved with — including a native Anthropic
// target when the profile declares one.
func (p *Compatible) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	stored, err := readStoredCredential(snapshotDir)
	if err != nil {
		return nil, err
	}
	cred := p.credentialDefinition(stored.Kind)
	if cred == nil {
		return nil, anyerr.Newf(
			"Snapshot references unknown credential kind \""+stored.Kind+"\".", "STATE_CONFLICT")
	}
	ep := p.endpointProfile(cred, stored.Profile)
	if ep == nil {
		return nil, anyerr.Newf(
			"Snapshot references unknown endpoint profile \""+stored.Profile+"\".",
			"STATE_CONFLICT")
	}
	scheme := ep.OpenAIAuth
	if scheme == "" {
		scheme = AuthBearer
	}
	header, prefix := schemeHeaders(scheme)
	base, err := url.Parse(ep.OpenAIBase)
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse upstream base", "PROXY_START_FAILED")
	}
	up := &proxy.Upstream{
		BaseURL:    base,
		Auth:       stored.Secret,
		AuthHeader: header, AuthValuePrefix: prefix,
		// Provider-declared quota patterns ride with every resolved member so
		// the pool classifier can fail over on vendor-specific error codes.
		QuotaErrorPatterns: p.Def.QuotaErrorPatterns,
	}
	// Compatible providers expose an OpenAI-shaped model endpoint even when
	// their static definition also carries a small convenience list.
	up.ModelDiscovery = compatibleModelDiscovery(up, ep.OpenAIBase)
	// The beta CLI's sqlite store is the login that exists right now; a saved
	// mirror can predate the current subscription. When this gateway is backed
	// by an OpenCode platform key, the live one outranks the stored secret.
	if live := preferredLiveOpenCodeKey(p.Def.ID); live != "" {
		up.Auth = live
	}
	// A declared anthropicBase wins: /v1/messages forwards natively and never
	// needs translation. Its auth scheme defaults to x-api-key per the
	// Anthropic SDK unless the profile says otherwise.
	if ep.AnthropicBase != "" {
		aScheme := ep.AnthropicAuth
		if aScheme == "" {
			aScheme = AuthXAPIKey
		}
		aHeader, aPrefix := schemeHeaders(aScheme)
		aBase, perr := url.Parse(ep.AnthropicBase)
		if perr != nil {
			return nil, anyerr.Wrapf(perr, "parse anthropic base", "PROXY_START_FAILED")
		}
		up.Anthropic = &proxy.UpstreamTarget{
			BaseURL: aBase, AuthHeader: aHeader, AuthValuePrefix: aPrefix,
		}
	} else {
		up.TranslateAnthropic = true
	}
	return up, nil
}

func compatibleModelDiscovery(up *proxy.Upstream, endpoint string) func(context.Context) ([]string, error) {
	return func(ctx context.Context) ([]string, error) {
		key := up.Auth
		if up.AuthProvider != nil {
			refreshed, err := up.AuthProvider(ctx)
			if err != nil {
				return nil, err
			}
			key = refreshed
		}
		return catalog.FetchLiveModels(ctx, "openai", &catalog.FetchContext{
			Endpoint: endpoint, APIKey: key,
			AuthHeader: up.AuthHeader, AuthValuePrefix: up.AuthValuePrefix,
		})
	}
}

func schemeHeaders(scheme AuthScheme) (header, prefix string) {
	switch scheme {
	case AuthXAPIKey:
		return "x-api-key", ""
	case AuthAPIKey:
		return "api-key", ""
	default:
		return "Authorization", "Bearer "
	}
}

func readStoredCredential(dir string) (*storedCompatibleCredential, error) {
	raw, err := os.ReadFile(filepath.Join(dir, compatibleCredentialFile))
	if err != nil {
		return nil, anyerr.Newf(
			"No saved credential in this snapshot ("+compatibleCredentialFile+").",
			"NO_CREDENTIAL")
	}
	var stored storedCompatibleCredential
	if json.Unmarshal(raw, &stored) != nil || stored.Version != 1 ||
		stored.Kind == "" || stored.Profile == "" || stored.Secret == "" {
		return nil, anyerr.Newf(
			"Invalid "+compatibleCredentialFile+" in snapshot.", "SNAPSHOT_INVALID")
	}
	return &stored, nil
}

// BuiltinDefinitions returns well-known OpenAI/Anthropic-compatible vendors.
// Endpoint bases follow each vendor's official docs (Chat Completions root,
// without /chat/completions).
func BuiltinDefinitions() []CompatibleDefinition {
	return []CompatibleDefinition{
		{
			ID: "openrouter", Name: "OpenRouter", ShortName: "OR",
			Description: "Multi-model gateway (Claude/GPT/Gemini via one key)",
			Models:      []string{"anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "anthropic/claude-haiku-4.5", "openai/gpt-5.6-sol"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "OpenRouter API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID: "global", Label: "Global", OpenAIBase: "https://openrouter.ai/api/v1",
				}},
			}},
		},
		{
			ID: "deepseek", Name: "DeepSeek", ShortName: "DS",
			Description: "DeepSeek V3/R1 API",
			Models:      []string{"deepseek-chat", "deepseek-reasoner"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "DeepSeek API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID: "global", OpenAIBase: "https://api.deepseek.com/v1",
				}},
			}},
		},
		{
			ID: "kimi", Name: "Moonshot Kimi", ShortName: "Kimi",
			Description: "Kimi K2 API (global + mainland China)",
			Models:      []string{"kimi-k2-thinking", "kimi-k2-turbo-preview", "kimi-k2-instruct"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Moonshot API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{
					{ID: "global", Label: "Global",
						OpenAIBase:    "https://api.moonshot.ai/v1",
						AnthropicBase: "https://api.moonshot.ai/anthropic"},
					{ID: "china", Label: "Mainland China",
						OpenAIBase:    "https://api.moonshot.cn/v1",
						AnthropicBase: "https://api.moonshot.cn/anthropic"},
				},
			}},
		},
		{
			ID: "zai", Name: "Z.ai (GLM)", ShortName: "GLM",
			Description: "Z.ai GLM coding plan + pay-as-you-go",
			Models:      []string{"glm-4.7", "glm-4.6", "glm-4.5-air"},
			Credentials: []CredentialDefinition{{
				Kind: "subscription-key", Label: "GLM Coding Plan key",
				CredentialClass: "coding_plan_key",
				Profiles: []EndpointProfile{
					{ID: "global", Label: "Global",
						OpenAIBase:    "https://api.z.ai/api/coding/paas/v4",
						AnthropicBase: "https://api.z.ai/api/anthropic"},
					{ID: "china", Label: "Mainland China",
						OpenAIBase:    "https://open.bigmodel.cn/api/coding/paas/v4",
						AnthropicBase: "https://open.bigmodel.cn/api/anthropic"},
				},
			}},
			QuotaErrorPatterns: []string{"1113", "1302"},
		},
		{
			ID: "qwen", Name: "Qwen (DashScope)", ShortName: "Qwen",
			Description: "Qwen3 family via DashScope compatible mode",
			Models:      []string{"qwen3-coder-plus", "qwen3-max"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "DashScope API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{
					{ID: "intl", Label: "International", OpenAIBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"},
					{ID: "china", Label: "Mainland China", OpenAIBase: "https://dashscope.aliyuncs.com/compatible-mode/v1"},
				},
			}},
		},
		{
			ID: "groq", Name: "Groq", ShortName: "Groq",
			Description: "Ultra-fast open-model inference",
			Models:      []string{"llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Groq API key",
				Profiles: []EndpointProfile{{ID: "global", OpenAIBase: "https://api.groq.com/openai/v1"}},
			}},
		},
		{
			ID: "mistral", Name: "Mistral AI", ShortName: "Mistral",
			Description: "Mistral Large / Codestral API",
			Models:      []string{"mistral-large-latest", "codestral-latest"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Mistral API key",
				Profiles: []EndpointProfile{{ID: "global", OpenAIBase: "https://api.mistral.ai/v1"}},
			}},
		},
		{
			ID: "together", Name: "Together AI", ShortName: "Together",
			Description: "Open-model hosting gateway",
			Models:      []string{"deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-Coder"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Together API key",
				Profiles: []EndpointProfile{{ID: "global", OpenAIBase: "https://api.together.xyz/v1"}},
			}},
		},
		{
			ID: "mimo", Name: "Xiaomi MiMo", ShortName: "MiMo",
			Description: "MiMo-V2/V2.5 family (pay-as-you-go + regional token plans)",
			Models:      []string{"mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-flash"},
			Credentials: []CredentialDefinition{
				{
					Kind: "api-key", Label: "MiMo API key (sk-…)",
					CredentialClass: "provider_api_key",
					Profiles: []EndpointProfile{
						{ID: "global", Label: "Pay-as-you-go", OpenAIBase: "https://api.xiaomimimo.com/v1"},
						// Token Plan keys present credentials via api-key.
						{ID: "token-plan-cn", Label: "Token Plan · China", OpenAIBase: "https://token-plan-cn.xiaomimimo.com/v1", OpenAIAuth: AuthAPIKey},
						{ID: "token-plan-sgp", Label: "Token Plan · Singapore", OpenAIBase: "https://token-plan-sgp.xiaomimimo.com/v1", OpenAIAuth: AuthAPIKey},
						{ID: "token-plan-ams", Label: "Token Plan · Europe", OpenAIBase: "https://token-plan-ams.xiaomimimo.com/v1", OpenAIAuth: AuthAPIKey},
					},
				},
				{
					Kind: "subscription-key", Label: "MiMo Token Plan key (tp-…)",
					CredentialClass: "coding_plan_key",
					Profiles: []EndpointProfile{
						{ID: "token-plan-cn", Label: "Token Plan · China", OpenAIBase: "https://token-plan-cn.xiaomimimo.com/v1", OpenAIAuth: AuthAPIKey,
							AnthropicBase: "https://token-plan-cn.xiaomimimo.com/anthropic"},
						{ID: "token-plan-sgp", Label: "Token Plan · Singapore", OpenAIBase: "https://token-plan-sgp.xiaomimimo.com/v1", OpenAIAuth: AuthAPIKey},
						{ID: "token-plan-ams", Label: "Token Plan · Europe", OpenAIBase: "https://token-plan-ams.xiaomimimo.com/v1", OpenAIAuth: AuthAPIKey},
					},
				},
			},
		},
		{
			ID: "minimax", Name: "MiniMax", ShortName: "MiniMax",
			Description: "MiniMax M2/abab family (global + China)",
			Models:      []string{"MiniMax-M2", "MiniMax-M2.1"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "MiniMax API key",
				Profiles: []EndpointProfile{
					{ID: "global", Label: "Global",
						OpenAIBase:    "https://api.minimax.io/v1",
						AnthropicBase: "https://api.minimax.io/anthropic"},
					{ID: "china", Label: "Mainland China",
						OpenAIBase:    "https://api.minimaxi.com/v1",
						AnthropicBase: "https://api.minimaxi.com/anthropic"},
				},
			}},
		},
		{
			ID: "doubao", Name: "Doubao (Volcengine Ark)", ShortName: "Doubao",
			Description: "ByteDance Doubao family via Volcengine Ark",
			Models:      []string{"doubao-seed-code", "doubao-seed-1-6", "doubao-1-5-thinking-pro"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Ark API key",
				Profiles: []EndpointProfile{{
					ID: "cn-beijing", Label: "Beijing region",
					OpenAIBase: "https://ark.cn-beijing.volces.com/api/v3",
				}},
			}},
		},
		{
			ID: "siliconflow", Name: "SiliconFlow", ShortName: "SF",
			Description: "200+ hosted models (DeepSeek/Qwen/GLM/Kimi)",
			Models:      []string{"deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-32B", "moonshotai/Kimi-K2-Instruct"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "SiliconFlow API key",
				Profiles: []EndpointProfile{
					{ID: "china", Label: "Mainland China", OpenAIBase: "https://api.siliconflow.cn/v1",
						AnthropicBase: "https://api.siliconflow.cn"},
					{ID: "global", Label: "Global", OpenAIBase: "https://api.siliconflow.com/v1",
						AnthropicBase: "https://api.siliconflow.com"},
				},
			}},
		},
		{
			ID: "stepfun", Name: "StepFun", ShortName: "Step",
			Description: "Step-3 / Step-R series",
			Models:      []string{"step-3", "step-r1-v-mini"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "StepFun API key",
				Profiles: []EndpointProfile{
					{ID: "global", OpenAIBase: "https://api.stepfun.com/v1",
						AnthropicBase: "https://api.stepfun.com/step_plan"},
					{ID: "intl-step-plan", Label: "Step Plan (intl)",
						OpenAIBase:    "https://api.stepfun.ai/v1",
						AnthropicBase: "https://api.stepfun.ai/step_plan"},
				},
			}},
		},
		{
			ID: "hunyuan", Name: "Tencent Hunyuan", ShortName: "Hunyuan",
			Description: "Tencent Hunyuan OpenAI-compatible endpoint",
			Models:      []string{"hunyuan-turbos-latest", "hunyuan-large"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Hunyuan API key",
				Profiles: []EndpointProfile{{ID: "global", OpenAIBase: "https://api.hunyuan.cloud.tencent.com/v1"}},
			}},
		},
		{
			ID: "modelscope", Name: "ModelScope", ShortName: "MS",
			Description: "ModelScope API-Inference (open models)",
			Models:      []string{"ZhipuAI/GLM-4.6", "Qwen/Qwen3-Coder-480B-A35B-Instruct"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "ModelScope SDK token",
				Profiles: []EndpointProfile{{ID: "global", OpenAIBase: "https://api-inference.modelscope.cn/v1"}},
			}},
		},
		{
			// OpenCode Zen: pay-per-use curated gateway (GPT/Claude/Gemini +
			// open models). One key serves both Zen and Go.
			ID: "opencode-zen", Name: "OpenCode Zen", ShortName: "Zen",
			Description: "Curated coding gateway (GPT/Claude/GLM/Kimi/Qwen, pay-per-use)",
			Models: []string{
				"gpt-5.3-codex", "claude-sonnet-4-5", "glm-5.1", "kimi-k2.6",
				"minimax-m2.7", "qwen3.7-plus", "big-pickle",
			},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "OpenCode API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID:              "global",
					OpenAIBase:      "https://opencode.ai/zen/v1",
					AnthropicBase:   "https://opencode.ai/zen",
					NativeResponses: true,
				}},
			}},
		},
		{
			// OpenCode Go: $10/mo fixed subscription for open coding models.
			ID: "opencode-go", Name: "OpenCode Go", ShortName: "Go",
			Description: "Subscription gateway for open coding models (GLM/Kimi/DeepSeek/MiMo/Qwen/MiniMax)",
			Models: []string{
				"glm-5.2", "kimi-k2.7-code", "deepseek-v4-pro",
				"mimo-v2.5-pro", "minimax-m3", "qwen3.7-max",
			},
			Credentials: []CredentialDefinition{{
				Kind: "subscription-key", Label: "OpenCode Go subscription key",
				CredentialClass: "coding_plan_key",
				Profiles: []EndpointProfile{{
					ID:            "global",
					OpenAIBase:    "https://opencode.ai/zen/go/v1",
					AnthropicBase: "https://opencode.ai/zen/go",
				}},
			}},
		},

		// ── Vendors ported from the removed popular-providers ESM pack ──────
		// These shipped as executable plugin registrations before ADR-0020 §5
		// removed the host. They were always inert data, so they compile in.
		//
		// Ids were NOT all worth keeping. The pack registered several vendors
		// the built-in table already had, and preserving those verbatim would
		// have shipped duplicate rows the user cannot tell apart:
		//   - together-ai was dropped: identical name ("Together AI") to the
		//     built-in `together`, and the built-in's api.together.xyz is the
		//     documented endpoint.
		//   - groq-cloud is kept but renamed: same api.groq.com host as
		//     `groq`, yet it enables NativeResponses, which `groq` does not.
		//     The name says so instead of making the user guess.
		//   - ark is kept: same host as `doubao` but a different product
		//     (the Volcengine Ark platform vs the Doubao model API).
		// Preserving those verbatim would have preserved a bug, not a feature.
		{
			// Ark Coding Plan keys bill against a separate endpoint from the
			// platform API key; the two must never drift onto each other.
			ID: "ark", Name: "Volcengine Ark / BytePlus ModelArk", ShortName: "Ark",
			Description:      "Ark pay-as-you-go APIs and separate Volcengine/BytePlus Coding Plan keys",
			DefaultProxyPort: 4155,
			Models:           []string{"ark-code-latest", "doubao-seed-2.0-code"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Ark platform API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{
					{ID: "china", Label: "Volcengine China",
						OpenAIBase: "https://ark.cn-beijing.volces.com/api/v3"},
					{ID: "global", Label: "BytePlus Singapore",
						OpenAIBase: "https://ark.ap-southeast.bytepluses.com/api/v3"},
				},
			}, {
				Kind: "subscription-key", Label: "Ark Coding Plan key",
				CredentialClass: "coding_plan_key",
				Profiles: []EndpointProfile{
					{ID: "china-coding", Label: "Volcengine Coding Plan",
						OpenAIBase:    "https://ark.cn-beijing.volces.com/api/coding/v3",
						AnthropicBase: "https://ark.cn-beijing.volces.com/api/coding",
						AnthropicAuth: AuthBearer},
					{ID: "global-coding", Label: "BytePlus Coding Plan",
						OpenAIBase:    "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
						AnthropicBase: "https://ark.ap-southeast.bytepluses.com/api/coding",
						AnthropicAuth: AuthBearer},
				},
			}},
			QuotaErrorPatterns: []string{
				"coding plan.*quota", "套餐.*额度", "余额不足", "quota.*exceeded",
			},
		},
		{
			ID: "tokenhub", Name: "Tencent Cloud TokenHub", ShortName: "TokenHub",
			Description:      "Tencent TokenHub pay-go API and separate Coding/Token Plan keys",
			DefaultProxyPort: 4156,
			Models:           []string{"glm-5", "kimi-k2.5", "minimax-m2.5"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "TokenHub API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID: "paygo", OpenAIBase: "https://tokenhub.tencentmaas.com/v1",
				}},
			}, {
				Kind: "subscription-key", Label: "TokenHub Coding Plan key",
				CredentialClass: "coding_plan_key",
				Profiles: []EndpointProfile{{
					ID:            "coding-plan",
					OpenAIBase:    "https://api.lkeap.cloud.tencent.com/plan/v3",
					AnthropicBase: "https://api.lkeap.cloud.tencent.com/plan/anthropic",
					AnthropicAuth: AuthBearer,
				}},
			}},
			QuotaErrorPatterns: []string{
				"coding plan.*quota", "token plan.*quota", "套餐.*额度", "余额不足",
			},
		},
		{
			// The trailing qualifier is load-bearing: without it this row is
			// indistinguishable from `groq` in every list that shows a name.
			ID: "groq-cloud", Name: "GroqCloud (native /responses)", ShortName: "GroqCloud",
			Description:      "GroqCloud fast inference API with native OpenAI Responses support",
			DefaultProxyPort: 4148,
			Models:           []string{"openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Groq API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID:              "global",
					OpenAIBase:      "https://api.groq.com/openai/v1",
					NativeResponses: true,
				}},
			}},
			QuotaErrorPatterns: []string{"rate_limit_exceeded", "quota.*exceeded"},
		},
		{
			ID: "fireworks", Name: "Fireworks AI", ShortName: "Fireworks",
			Description:      "Fireworks serverless API with native OpenAI Responses and Anthropic Messages",
			DefaultProxyPort: 4151,
			Models: []string{
				"accounts/fireworks/models/kimi-k2p5",
				"accounts/fireworks/models/deepseek-v3p1",
			},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Fireworks API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID:              "global",
					OpenAIBase:      "https://api.fireworks.ai/inference/v1",
					NativeResponses: true,
					AnthropicBase:   "https://api.fireworks.ai/inference",
				}},
			}},
			QuotaErrorPatterns: []string{"insufficient.*credits", "quota.*exceeded"},
		},
		{
			ID: "cerebras", Name: "Cerebras Inference", ShortName: "Cerebras",
			Description:      "Cerebras high-speed OpenAI-compatible inference API",
			DefaultProxyPort: 4152,
			Models:           []string{"gpt-oss-120b", "zai-glm-4.7"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "Cerebras API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID: "global", OpenAIBase: "https://api.cerebras.ai/v1",
				}},
			}},
			QuotaErrorPatterns: []string{"quota.*exceeded", "rate_limit_exceeded"},
		},
		{
			ID: "nvidia-nim", Name: "NVIDIA NIM", ShortName: "NVIDIA",
			Description:      "NVIDIA hosted NIM OpenAI-compatible inference API",
			DefaultProxyPort: 4154,
			Models:           []string{"z-ai/glm5.1", "qwen/qwen3.5-122b-a10b"},
			Credentials: []CredentialDefinition{{
				Kind: "api-key", Label: "NVIDIA API key",
				CredentialClass: "provider_api_key",
				Profiles: []EndpointProfile{{
					ID: "hosted", OpenAIBase: "https://integrate.api.nvidia.com/v1",
				}},
			}},
			QuotaErrorPatterns: []string{"payment required", "quota.*exceeded", "rate.*limit"},
		},
	}
}

// RegisterBuiltinCompatibles wires every built-in compatible vendor.
//
// Z.ai is the one exception to the otherwise declarative table: its coding
// subscription is also owned by the ZCode desktop app, so it needs a native
// detector and browser login while retaining the compatible API-key product.
// The home argument is required: falling back to the real user home would let
// an isolated registry silently read the developer's live Z.ai login, so an
// empty call fails instead of guessing.
func RegisterBuiltinCompatibles(r *Registry, homes ...string) error {
	if len(homes) == 0 || homes[0] == "" {
		return anyerr.Newf("RegisterBuiltinCompatibles requires an explicit home directory", "INVALID_USAGE")
	}
	zaiHome := homes[0]
	for _, def := range BuiltinDefinitions() {
		if def.ID == "zai" {
			p, err := newZAI(zaiHome)
			if err != nil {
				return err
			}
			if err := r.Register(p); err != nil {
				return err
			}
			continue
		}
		p, err := NewCompatible(def)
		if err != nil {
			return err
		}
		if err := r.Register(p); err != nil {
			return err
		}
	}
	return nil
}

// Definition exposes the inert vendor definition for desktop/UI surfaces
// without leaking credential material.
func (p *Compatible) Definition() *CompatibleDefinition { return &p.Def }

func (p *Compatible) ShortName() string {
	if p.Def.ShortName != "" {
		return p.Def.ShortName
	}
	return p.Def.Name
}
