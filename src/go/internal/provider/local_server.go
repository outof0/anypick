package provider

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// localServer is an OpenAI-compatible model server the user runs themselves:
// Ollama or LM Studio. It needs no key by default, so an account is the server
// URL plus an optional key (LM Studio can require one). Claude Code reaches it
// through the proxy's Messages translation; Codex, pi and omp through the
// same proxy, so every client sees one account and one endpoint.
//
// It is a small custom provider rather than a Compatible definition because
// the endpoint is the user's, not the vendor's: a server on another port or on
// another machine on the LAN is the same product.
type localServer struct {
	id              string
	name            string
	description     string
	defaultEndpoint string
}

const (
	localServerCredentialKind = "server"
	localServerCredentialFile = "local-server.json"
	localServerDefaultProfile = "default"
)

func newOllama() *localServer {
	return &localServer{
		id:              "ollama",
		name:            "Ollama",
		description:     "Models served by a local Ollama server (no key needed)",
		defaultEndpoint: "http://127.0.0.1:11434/v1",
	}
}

func newLMStudio() *localServer {
	return &localServer{
		id:              "lmstudio",
		name:            "LM Studio",
		description:     "Models served by LM Studio's local server (key optional)",
		defaultEndpoint: "http://127.0.0.1:1234/v1",
	}
}

type localServerCredential struct {
	Version  int    `json:"version"`
	Kind     string `json:"kind"`
	Endpoint string `json:"endpoint"`
	Secret   string `json:"secret,omitempty"`
}

func (p *localServer) ID() string          { return p.id }
func (p *localServer) Name() string        { return p.name }
func (p *localServer) Description() string { return p.description }
func (p *localServer) CanProxy() bool      { return true }

// AccountAdapter mirrors the compatible-vendor pairing: claude, codex, pi and
// omp ride the builtin proxy, every other client is unsupported.
func (p *localServer) AccountAdapter(accountName string, _ bool) transport.Adapter {
	a := transport.Adapter{}
	a.SourceRef.Kind = "account"
	a.SourceRef.Provider = p.id
	a.SourceRef.Name = accountName
	a.Capabilities = transport.Capabilities{
		SourceKind:             "account",
		Provider:               p.id,
		NativeClients:          []string{},
		Protocols:              []transport.Protocol{transport.OpenAI},
		SupportsModelDiscovery: true,
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

// DetectLive: a model server has no login on this machine to save.
func (p *localServer) DetectLive() (LiveAuthStatus, error) { return LiveAuthStatus{}, nil }

func (p *localServer) Backup(_ string) (SnapshotInfo, error) {
	return SnapshotInfo{}, anyerr.Newf(
		p.name+" has no login to save. Add the server instead.",
		"NO_LIVE_AUTH",
		anyerr.WithSuggestions(
			"anypick add account "+p.id+" --name <name> --credential "+localServerCredentialKind,
			"add --option profile=<url> for a server that is not at "+p.defaultEndpoint))
}

// Restore is a no-op: the proxy reads the snapshot directly.
func (p *localServer) Restore(_ string) error { return nil }

func (p *localServer) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	cred, err := readLocalServerCredential(srcDir)
	if err != nil || cred == nil {
		return SnapshotInfo{}, nil
	}
	return p.snapshotInfo(cred.Endpoint), nil
}

func (p *localServer) snapshotInfo(endpoint string) SnapshotInfo {
	identity := endpoint
	if u, err := url.Parse(endpoint); err == nil && u.Host != "" {
		identity = u.Host
	}
	return SnapshotInfo{
		Identity:        identity,
		Notes:           p.name,
		CredentialKind:  "proxy-only",
		CredentialClass: "provider_api_key",
	}
}

// CredentialDefinitions publishes one product, the server. Its one profile is
// the default URL; any other URL is passed as the profile itself.
//
// The label is what both apps print over the key field, so it names the key,
// not the server: "Ollama server" there reads as "type the URL here".
func (p *localServer) CredentialDefinitions() []CredentialDefinition {
	return []CredentialDefinition{{
		Kind:            localServerCredentialKind,
		Label:           "Server key (optional)",
		CredentialClass: "provider_api_key",
		Profiles: []EndpointProfile{{
			ID:         localServerDefaultProfile,
			Label:      "This computer (" + p.defaultEndpoint + ")",
			OpenAIBase: p.defaultEndpoint,
		}},
		SecretOptional: true,
	}}
}

// BackupInput stores the server URL and the optional key.
func (p *localServer) BackupInput(kind, secret, profile, destDir string) (SnapshotInfo, error) {
	if kind != localServerCredentialKind {
		return SnapshotInfo{}, anyerr.Newf(
			p.name+" does not accept credential kind \""+kind+"\". Use --credential "+localServerCredentialKind+".",
			"UNSUPPORTED_CREDENTIAL_INPUT")
	}
	key := strings.TrimSpace(secret)
	if strings.HasPrefix(strings.ToLower(key), "bearer ") {
		key = strings.TrimSpace(key[len("bearer "):])
	}
	if strings.ContainsAny(key, "\r\n") {
		return SnapshotInfo{}, anyerr.Newf("The key must be a single line.", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	endpoint, err := p.resolveEndpoint(profile, key != "")
	if err != nil {
		return SnapshotInfo{}, err
	}
	data, err := json.Marshal(localServerCredential{
		Version: 1, Kind: localServerCredentialKind, Endpoint: endpoint, Secret: key,
	})
	if err != nil {
		return SnapshotInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(destDir, localServerCredentialFile), data, 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	return p.snapshotInfo(endpoint), nil
}

// resolveEndpoint turns the profile into the server's OpenAI base. The CLI
// defaults an omitted profile to "global", which means the default here too.
//
// A key travels only over HTTPS or to this machine: a plain-HTTP LAN server is
// a normal setup for a keyless Ollama, but sending a key that way hands it to
// anyone on the network.
func (p *localServer) resolveEndpoint(profile string, hasKey bool) (string, error) {
	raw := strings.TrimSpace(profile)
	switch raw {
	case "", "global", localServerDefaultProfile:
		return p.defaultEndpoint, nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", anyerr.Newf(
			"The "+p.name+" server must be an http(s) URL such as "+p.defaultEndpoint+".",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", anyerr.Newf(
			"The "+p.name+" server URL must not carry credentials, a query or a fragment.",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if hasKey && u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return "", anyerr.Newf(
			"A key is sent to "+u.Host+" only over https. Use an https URL, or a server on this computer.",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	path := strings.TrimRight(u.Path, "/")
	if path == "" {
		// Both servers serve their OpenAI surface under /v1.
		path = "/v1"
	}
	return u.Scheme + "://" + u.Host + path, nil
}

func readLocalServerCredential(dir string) (*localServerCredential, error) {
	raw, err := os.ReadFile(filepath.Join(dir, localServerCredentialFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var cred localServerCredential
	if json.Unmarshal(raw, &cred) != nil || cred.Version != 1 ||
		cred.Kind != localServerCredentialKind || cred.Endpoint == "" {
		return nil, anyerr.Newf("Invalid "+localServerCredentialFile+" in snapshot.", "SNAPSHOT_INVALID")
	}
	return &cred, nil
}

// ResolveUpstream points the proxy at the server's OpenAI surface. Messages
// from Claude Code are translated to chat completions, which every version of
// both servers serves; native Anthropic support varies by server version.
func (p *localServer) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	cred, err := readLocalServerCredential(snapshotDir)
	if err != nil {
		return nil, err
	}
	if cred == nil {
		return nil, anyerr.Newf(
			"No saved server in this snapshot ("+localServerCredentialFile+").", "NO_CREDENTIAL")
	}
	base, err := url.Parse(cred.Endpoint)
	if err != nil {
		return nil, anyerr.Wrapf(err, "parse "+p.name+" server URL", "PROXY_START_FAILED")
	}
	endpoint, secret := cred.Endpoint, cred.Secret
	// No QuotaErrorPatterns: a local server has no quota, and treating "out of
	// memory" as one would cool the account down for an error a retry fixes.
	up := &proxy.Upstream{
		BaseURL:            base,
		Auth:               secret,
		TranslateAnthropic: true,
	}
	up.ModelDiscovery = func(ctx context.Context) ([]string, error) {
		return listOpenAIModels(ctx, endpoint, secret, nil)
	}
	return up, nil
}
