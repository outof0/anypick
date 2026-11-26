package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/browserlogin"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// grok manages Grok credentials: ~/.grok/auth.json holds OIDC sessions keyed
// by account; no external binary needed.
type grok struct{ home string }

const grokLoginMethodID = "grok-subscription"

func newGrok(home string) *grok { return &grok{home: home} }

func (p *grok) ID() string { return "grok" }
func (p *grok) Name() string {
	return "xAI Grok"
}
func (p *grok) Description() string {
	return "Manages ~/.grok/auth.json + OpenAI/Anthropic compat proxy (Codex + Claude)"
}
func (p *grok) CanProxy() bool { return true }

func (p *grok) AccountAdapter(accountName string, _ bool) transport.Adapter {
	return transport.GrokAccountAdapter(p.ID(), accountName)
}

func (p *grok) loginCommand() browserlogin.Command {
	names := []string{"grok"}
	if env := os.Getenv("GROK_BINARY"); env != "" {
		names = []string{env, "grok"}
	}
	return browserlogin.Command{
		Names:      names,
		ExtraPaths: []string{filepath.Join(expandHome(p.home), ".grok", "bin", "grok")},
		Args:       []string{"login", "--oauth"},
	}
}

func (p *grok) LoginMethods() []LoginMethod {
	return []LoginMethod{
		browserlogin.Availability(LoginMethod{
			ID:          grokLoginMethodID,
			Label:       "Grok subscription",
			Description: "Grok browser sign-in through auth.x.ai",
			Provenance:  "official",
			Preferred:   true,
		}, p.loginCommand()),
	}
}

// Login runs the browser sign-in (no source-scoped methods).
func (p *grok) Login(ctx context.Context, methodID, source string) error {
	if methodID != grokLoginMethodID || source != "" {
		return anyerr.Newf("Unknown Grok sign-in method.", "PROVIDER_LOGIN_METHOD_UNKNOWN")
	}
	return browserlogin.Run(ctx, p.loginCommand(), expandHome(p.home))
}

func (p *grok) authPath() string {
	if env := os.Getenv("GROK_AUTH_PATH"); env != "" {
		return expandHome(env)
	}
	return filepath.Join(expandHome(p.home), ".grok", "auth.json")
}

// grokIdentity reads the identity of the session used for requests.
func grokIdentity(data map[string]json.RawMessage) string {
	_, raw := pickGrokSession(data)
	var session map[string]json.RawMessage
	if json.Unmarshal(raw, &session) != nil {
		return ""
	}
	return grokSessionIdentity(session)
}

func grokSessionIdentity(session map[string]json.RawMessage) string {
	for _, key := range []string{"email", "user_email"} {
		if value := stringField(session, key); strings.Contains(value, "@") {
			return value
		}
	}
	raw, ok := session["user"]
	if ok {
		var user map[string]json.RawMessage
		if json.Unmarshal(raw, &user) == nil {
			if value := stringField(user, "email"); strings.Contains(value, "@") {
				return value
			}
		}
	}
	return ""
}

func (p *grok) DetectLive() (LiveAuthStatus, error) {
	raw, err := os.ReadFile(p.authPath())
	if err != nil {
		if os.IsNotExist(err) {
			return LiveAuthStatus{}, nil
		}
		return LiveAuthStatus{}, err
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil {
		return LiveAuthStatus{Present: true, Details: "auth.json present (unreadable)"}, nil
	}
	sessions := 0
	for _, v := range data {
		var obj map[string]json.RawMessage
		if json.Unmarshal(v, &obj) == nil && len(obj) > 0 {
			sessions++
		}
	}
	if sessions == 0 {
		return LiveAuthStatus{}, nil
	}
	return LiveAuthStatus{Present: true, Identity: grokIdentity(data)}, nil
}

func (p *grok) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	return p.SnapshotFilesMatchLive(snapshotFilesAt(srcDir))
}

func (p *grok) SnapshotFilesMatchLive(file SnapshotFileReader) (bool, bool, error) {
	live, liveErr := loadGrokSession(p.authPath())
	saved, savedErr := grokSavedSession(file)
	if liveErr != nil || savedErr != nil {
		// Older documents can still report an email without a usable OIDC grant.
		return false, false, nil
	}
	return sameGrokQuotaLogin(live, saved), true, nil
}

func (p *grok) Backup(destDir string) (SnapshotInfo, error) {
	src := p.authPath()
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return SnapshotInfo{}, anyerr.Newf(
				"No live Grok auth.json found at "+src+". Log in first, then save.",
				"NO_LIVE_AUTH",
				anyerr.WithSuggestions("Sign in with the official tool, then try again."))
		}
		return SnapshotInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(destDir, "auth.json"), data, 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	info := SnapshotInfo{}
	var parsed map[string]json.RawMessage
	if json.Unmarshal(data, &parsed) == nil {
		info.Identity = grokIdentity(parsed)
	}
	return info, nil
}

func (p *grok) Restore(srcDir string) error {
	data, err := os.ReadFile(filepath.Join(srcDir, "auth.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return errSnapshotMissing("auth.json")
		}
		return err
	}
	dest := p.authPath()
	// dest is the user's real ~/.grok/auth.json. A truncated write here
	// destroys their live login with nothing to fall back on, so replace by
	// rename rather than overwriting in place.
	return atomicfile.Write(dest, data, 0o600)
}

func (p *grok) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
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
		info.Identity = grokIdentity(parsed)
	}
	return info, nil
}

func (grok *grok) ShortName() string { return "Grok" }

// GatewayInfo makes Grok's live-session gateway capability provider-owned.
// The gateway has no API-key field because the provider refreshes its OIDC
// session per request.
func (p *grok) GatewayInfo() GatewayInfo {
	return GatewayInfo{
		ProvidesEndpoint: true,
		RequiresAPIKey:   false,
		DefaultEndpoint:  "https://cli-chat-proxy.grok.com",
		Kind:             "hosted",
	}
}

// ResolveUpstream points the engine's shared proxy at cli-chat-proxy.grok.com
// using this account's saved OIDC session. The token is short-lived, so it is
// supplied per request by grokEnsureAccessToken (OIDC refresh) rather than
// frozen at start; x-grok-* + user-agent headers are injected on every
// forwarded request. The same base serves both OpenAI and native Anthropic.
func (p *grok) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	return grokUpstream(filepath.Join(snapshotDir, "auth.json"))
}

// GatewayUpstream resolves the upstream for a Grok gateway from the live x.ai
// OIDC session (~/.grok/auth.json) shared with the account flow. A gateway
// carries no account snapshot and no API key; it reuses the session the user
// established with `grok login`, refreshing the token per request.
func (p *grok) GatewayUpstream() (*proxy.Upstream, error) {
	return grokUpstream(p.authPath())
}
