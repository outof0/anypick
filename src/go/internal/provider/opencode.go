package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// Zen/Go gateway targets, the same pair compatible.go declares for the
// opencode-zen / opencode-go definitions.
//
// The base is chosen once per account, not per model: any model the live
// catalogs do not list falls back to the Go gateway for a Go subscription
// key, else to Zen. The upstream has one base and no catalog, so the
// entitlement is read from the credential itself: a key stored under the
// opencode-go service is the subscription key. Per-model routing, `public`
// mode and OPENCODE_PROXY_UPSTREAM are not supported.
const (
	openCodeZenBaseURL      = "https://opencode.ai/zen/v1"
	openCodeZenAnthropicURL = "https://opencode.ai/zen"
	openCodeGoBaseURL       = "https://opencode.ai/zen/go/v1"
	openCodeGoAnthropicURL  = "https://opencode.ai/zen/go"
)

// opencode manages OpenCode credentials: ~/.local/share/opencode/auth.json
// (XDG-aware) plus account.json.
type opencode struct{ home string }

func newOpenCode(home string) *opencode { return &opencode{home: home} }

func (p *opencode) ID() string          { return "opencode" }
func (p *opencode) Name() string        { return "OpenCode" }
func (p *opencode) Description() string { return "Manages ~/.local/share/opencode/auth.json" }
func (p *opencode) CanProxy() bool      { return true }

func (p *opencode) AccountAdapter(accountName string, _ bool) transport.Adapter {
	return transport.OpenCodeAccountAdapter(p.ID(), accountName)
}

func (p *opencode) dataDir() string {
	if env := os.Getenv("OPENCODE_DATA_DIR"); env != "" {
		return expandHome(env)
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" && expandHome(p.home) == homeDirOf() {
		return filepath.Join(xdg, "opencode")
	}
	return filepath.Join(expandHome(p.home), ".local", "share", "opencode")
}

func (p *opencode) authPath() string {
	if env := os.Getenv("OPENCODE_AUTH_PATH"); env != "" {
		return expandHome(env)
	}
	return filepath.Join(p.dataDir(), "auth.json")
}

func homeDirOf() string {
	home, _ := os.UserHomeDir()
	return home
}

// openCodeIdentity prefers an oauth entry's email (JWT claim or metadata),
// else provider:accountId prefix.
func openCodeIdentity(data map[string]json.RawMessage) string {
	for provider, raw := range data {
		var entry struct {
			Type      string `json:"type"`
			Access    string `json:"access"`
			AccountID string `json:"accountId"`
			Metadata  struct {
				Email string `json:"email"`
			} `json:"metadata"`
		}
		if json.Unmarshal(raw, &entry) != nil || entry.Type != "oauth" {
			continue
		}
		if email := jwtEmail(entry.Access); email != "" {
			return email
		}
		if entry.Metadata.Email != "" {
			return entry.Metadata.Email
		}
		if entry.AccountID != "" {
			prefix := entry.AccountID
			if len(prefix) > 12 {
				prefix = prefix[:12]
			}
			return provider + ":" + prefix
		}
	}
	return ""
}

func jwtEmail(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Email == "" {
		return ""
	}
	return claims.Email
}

func (p *opencode) DetectLive() (LiveAuthStatus, error) {
	raw, err := os.ReadFile(p.authPath())
	if err != nil {
		if os.IsNotExist(err) {
			if status, ok := liveOpenCodeAuthStatus(); ok {
				return status, nil
			}
			return LiveAuthStatus{}, nil
		}
		return LiveAuthStatus{}, err
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil || len(data) == 0 {
		// A live Zen/Go login can exist only in the CLI's sqlite store.
		if status, ok := liveOpenCodeAuthStatus(); ok {
			return status, nil
		}
		return LiveAuthStatus{}, nil
	}
	return LiveAuthStatus{Present: true, Identity: openCodeIdentity(data)}, nil
}

func (p *opencode) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	return p.SnapshotFilesMatchLive(snapshotFilesAt(srcDir))
}

func (p *opencode) SnapshotFilesMatchLive(file SnapshotFileReader) (bool, bool, error) {
	saved := openCodeSavedQuotaKey(file)
	if saved == "" {
		return false, false, nil
	}
	return p.liveQuotaKey() == saved, true, nil
}

func (p *opencode) Backup(destDir string) (SnapshotInfo, error) {
	src := p.authPath()
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return SnapshotInfo{}, anyerr.Newf(
				"No live OpenCode auth.json found at "+src+". Log in first, then save.",
				"NO_LIVE_AUTH",
				anyerr.WithSuggestions("Run `opencode auth login`, then try again."))
		}
		return SnapshotInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(destDir, "auth.json"), data, 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	info := SnapshotInfo{}
	var parsed map[string]json.RawMessage
	if json.Unmarshal(data, &parsed) == nil {
		info.Identity = openCodeIdentity(parsed)
	}
	return info, nil
}

func (p *opencode) Restore(srcDir string) error {
	data, err := os.ReadFile(filepath.Join(srcDir, "auth.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return errSnapshotMissing("auth.json")
		}
		return err
	}
	dest := p.authPath()
	// dest is the user's live auth file (ADR 0004): replace by rename.
	return atomicfile.Write(dest, data, 0o600)
}

func (p *opencode) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	raw, err := os.ReadFile(filepath.Join(srcDir, "auth.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return SnapshotInfo{}, nil
		}
		return SnapshotInfo{}, err
	}
	info := SnapshotInfo{}
	var parsed map[string]json.RawMessage
	if json.Unmarshal(raw, &parsed) == nil {
		info.Identity = openCodeIdentity(parsed)
	}
	return info, nil
}

// ResolveUpstream points the engine's shared proxy at the OpenCode Zen/Go
// gateway using this account's saved login.
//
// Only a Zen/Go platform key can drive a gateway. An OAuth-only auth.json
// (ChatGPT, Anthropic, GitLab…) holds nothing the gateway accepts, so it fails
// here with a coded error the caller can surface: those logins are applied to
// native clients by `anypick use`, which writes the credential back to the
// CLI, not through this proxy. The three failure messages below are kept
// distinct — "no login at all" and "logged in without a Zen/Go key" send the
// user to different commands, so they are not collapsed into one.
func (p *opencode) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	key, service, state := openCodeGatewayKey(snapshotDir)
	if key == "" {
		switch state {
		case mirrorMissing:
			return nil, anyerr.Newf(
				"No OpenCode auth available.",
				"NO_LIVE_AUTH",
				anyerr.WithSuggestions(
					"Run: opencode auth login",
					"then: anypick add opencode --name <name>"))
		case mirrorUnreadable:
			return nil, anyerr.Newf(
				"Unreadable OpenCode auth: "+filepath.Join(snapshotDir, "auth.json")+".",
				"NO_LIVE_AUTH")
		default:
			return nil, anyerr.Newf(
				"OpenCode proxy needs a Zen/Go API key in auth.json or the CLI credential store (opencode auth login → OpenCode Zen or Go). OAuth providers (ChatGPT, etc.) are activated via anypick use, not this proxy.",
				"NO_LIVE_AUTH")
		}
	}
	openAI, anthropic := openCodeZenBaseURL, openCodeZenAnthropicURL
	if strings.EqualFold(service, "opencode-go") {
		openAI, anthropic = openCodeGoBaseURL, openCodeGoAnthropicURL
	}
	base, err := url.Parse(openAI)
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse OpenCode upstream base", "PROXY_START_FAILED")
	}
	anthropicBase, err := url.Parse(anthropic)
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse OpenCode Anthropic base", "PROXY_START_FAILED")
	}
	up := &proxy.Upstream{
		BaseURL:         base,
		Auth:            key,
		AuthHeader:      "Authorization",
		AuthValuePrefix: "Bearer ",
		Anthropic: &proxy.UpstreamTarget{
			BaseURL:         anthropicBase,
			AuthHeader:      "Authorization",
			AuthValuePrefix: "Bearer ",
		},
	}
	up.ModelDiscovery = func(ctx context.Context) ([]string, error) {
		return catalog.FetchLiveModels(ctx, "openai", &catalog.FetchContext{
			Endpoint: openAI, APIKey: key,
			AuthHeader: "Authorization", AuthValuePrefix: "Bearer ",
		})
	}
	return up, nil
}

func (opencode *opencode) ShortName() string { return "OpenCode" }
