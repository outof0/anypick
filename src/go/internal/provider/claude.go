package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/browserlogin"
	"github.com/outof0/anypick/go/internal/transport"
)

const (
	claudeSnapshotFile  = "credentials.json"
	claudeLoginMethodID = "claude-subscription"
)

// claude manages Claude Code credentials, which live in the macOS Keychain
// ("Claude Code-credentials") or ~/.claude/.credentials.json on file-backed
// platforms. The secret never goes in process argv.
//
// It has no PreflightRestore, so a running Claude Code does not stop a switch.
// A session that is already running may go on with the login it loaded, and
// may write its copy of ~/.claude.json back over the switch.
type claude struct {
	home string
}

func newClaude(home string) *claude { return &claude{home: home} }

func (p *claude) ID() string          { return "claude" }
func (p *claude) Name() string        { return "Anthropic Claude Code" }
func (p *claude) Description() string { return "Manages Claude Code native login credentials" }
func (p *claude) CanProxy() bool      { return false }

func (p *claude) AccountAdapter(accountName string, _ bool) transport.Adapter {
	return transport.ClaudeAccountAdapter(p.ID(), accountName)
}

func (p *claude) loginCommand() browserlogin.Command {
	names := []string{"claude"}
	if env := os.Getenv("CLAUDE_BINARY"); env != "" {
		names = []string{env, "claude"}
	}
	return browserlogin.Command{
		Names: names,
		ExtraPaths: []string{
			filepath.Join(expandHome(p.home), ".local", "bin", "claude"),
			"/opt/homebrew/bin/claude",
			"/usr/local/bin/claude",
		},
		Args: []string{"auth", "login", "--claudeai"},
	}
}

func (p *claude) LoginMethods() []LoginMethod {
	return []LoginMethod{
		browserlogin.Availability(LoginMethod{
			ID:          claudeLoginMethodID,
			Label:       "Claude subscription",
			Description: "Claude Code browser sign-in for Pro, Max, Team, or Enterprise",
			Provenance:  "official",
			Preferred:   true,
			Source:      "claude-code",
		}, p.loginCommand()),
	}
}

// Login runs the provider's own login-only command; the credential it writes
// is verified and snapshotted by core.
func (p *claude) Login(ctx context.Context, methodID, source string) error {
	if methodID != claudeLoginMethodID || (source != "" && source != "claude-code") {
		return anyerr.Newf("Unknown Claude sign-in method.", "PROVIDER_LOGIN_METHOD_UNKNOWN")
	}
	return browserlogin.Run(ctx, p.loginCommand(), expandHome(p.home))
}

type claudeCredential struct {
	account    string
	credential string
}

func (p *claude) useKeychain() bool {
	return os.Getenv("ANYPICK_CLAUDE_NO_KEYCHAIN") != "1" && keychainAvailable()
}

func (p *claude) fileCredentialsPath() string {
	if env := os.Getenv("ANYPICK_CLAUDE_CREDENTIALS_PATH"); env != "" {
		return expandHome(env)
	}
	return filepath.Join(expandHome(p.home), ".claude", ".credentials.json")
}

func (p *claude) read() (*claudeCredential, error) {
	if p.useKeychain() {
		out, err := runSecurity("find-generic-password -s 'Claude Code-credentials' -a " +
			quoteSecurity(p.accountName()) + " -w")
		if err == nil && strings.TrimSpace(out) != "" {
			return &claudeCredential{account: p.accountName(), credential: strings.TrimSpace(out)}, nil
		}
		return nil, nil
	}
	path := p.fileCredentialsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	credential := strings.TrimRight(string(data), "\n")
	if strings.TrimSpace(credential) == "" {
		return nil, nil
	}
	return &claudeCredential{account: p.accountName(), credential: credential}, nil
}

func (p *claude) write(credential string) error {
	if !strings.HasSuffix(credential, "\n") {
		credential += "\n"
	}
	if p.useKeychain() {
		return writeGenericPassword("Claude Code-credentials", p.accountName(), credential)
	}
	path := p.fileCredentialsPath()
	// path is the user's live credential file. Truncating it in place leaves
	// an empty login on crash (ADR 0004), so replace by rename (atomicfile).
	return atomicfile.Write(path, []byte(credential), 0o600)
}

func (p *claude) clearLiveCredential() error {
	if p.useKeychain() {
		_, err := runSecurity(fmt.Sprintf(
			"delete-generic-password -s 'Claude Code-credentials' -a %s",
			quoteSecurity(p.accountName())))
		return err
	}
	err := os.Remove(p.fileCredentialsPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func (p *claude) accountName() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return "anypick"
}

func (p *claude) DetectLive() (LiveAuthStatus, error) {
	current, err := p.read()
	if err != nil || current == nil {
		return LiveAuthStatus{}, err
	}
	return LiveAuthStatus{
		Present:  true,
		Identity: claudeCredentialIdentity(current.credential),
		Details:  "Claude Code secure credential store",
	}, nil
}

func (p *claude) Backup(destDir string) (SnapshotInfo, error) {
	current, err := p.read()
	if err != nil {
		return SnapshotInfo{}, err
	}
	if current == nil {
		return SnapshotInfo{}, anyerr.Newf(
			"No signed-in Claude Code account was found.", "NO_LIVE_AUTH")
	}
	snapshot := map[string]interface{}{
		"version":    1,
		"account":    current.account,
		"credential": current.credential,
	}
	data, _ := json.Marshal(snapshot)
	if err := os.WriteFile(filepath.Join(destDir, claudeSnapshotFile), data, 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{Identity: claudeCredentialIdentity(current.credential)}, nil
}

func (p *claude) Restore(srcDir string) error {
	raw, err := os.ReadFile(filepath.Join(srcDir, claudeSnapshotFile))
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("snapshot is missing %s: %s", claudeSnapshotFile, srcDir)
		}
		return err
	}
	var snapshot struct {
		Version    int    `json:"version"`
		Account    string `json:"account"`
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil ||
		snapshot.Version != 1 || snapshot.Account == "" || snapshot.Credential == "" {
		return fmt.Errorf("the Claude Code credential snapshot is invalid")
	}
	previous, readErr := p.read()
	if err := p.write(snapshot.Credential); err != nil {
		return err
	}
	if readErr != nil || previous == nil ||
		claudeFingerprint(previous.credential) != claudeFingerprint(snapshot.Credential) {
		p.markAccountRecordStale()
	}
	return nil
}

func (p *claude) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	raw, err := os.ReadFile(filepath.Join(srcDir, claudeSnapshotFile))
	if err != nil {
		if os.IsNotExist(err) {
			return SnapshotInfo{}, nil
		}
		return SnapshotInfo{}, err
	}
	var snapshot struct {
		Credential string `json:"credential"`
	}
	if json.Unmarshal(raw, &snapshot) != nil {
		return SnapshotInfo{}, nil
	}
	return SnapshotInfo{Identity: claudeCredentialIdentity(snapshot.Credential)}, nil
}

// SnapshotMatchesLive compares fingerprints with the refresh token stripped. A
// rotated access token still reads as a different credential.
func (p *claude) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	current, err := p.read()
	if err != nil {
		return false, false, err
	}
	if current == nil {
		return false, true, nil
	}
	raw, err := os.ReadFile(filepath.Join(srcDir, claudeSnapshotFile))
	if err != nil {
		if os.IsNotExist(err) {
			return false, true, nil
		}
		return false, false, err
	}
	var snapshot struct {
		Credential string `json:"credential"`
	}
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Credential == "" {
		return false, true, nil
	}
	return claudeFingerprint(current.credential) == claudeFingerprint(snapshot.Credential),
		true, nil
}

// LiveClearer removes local auth only — no server-side logout.
func (p *claude) ClearLive() error {
	current, err := p.read()
	if err != nil || current == nil {
		return err
	}
	return p.clearLiveCredential()
}

func claudeCredentialIdentity(raw string) string {
	var root map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &root) != nil {
		return ""
	}
	for _, candidate := range []string{"email"} {
		if v := stringField(root, candidate); v != "" {
			return v
		}
	}
	oauthRaw, ok := root["claudeAiOauth"]
	if !ok {
		return ""
	}
	var oauth map[string]json.RawMessage
	if json.Unmarshal(oauthRaw, &oauth) != nil {
		return ""
	}
	if email := stringField(oauth, "email"); email != "" {
		return email
	}
	if plan := stringField(oauth, "subscriptionType"); plan != "" {
		return "Claude " + plan
	}
	return ""
}

// claudeFingerprint hashes the credential JSON minus refresh token material. The
// access token stays in, so its rotation changes the fingerprint.
func claudeFingerprint(raw string) string {
	var root map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &root) != nil {
		sum := sha256.Sum256([]byte(raw))
		return hex.EncodeToString(sum[:])
	}
	if oauthRaw, ok := root["claudeAiOauth"]; ok {
		var oauth map[string]json.RawMessage
		if json.Unmarshal(oauthRaw, &oauth) == nil {
			changed := false
			for _, key := range []string{"refreshToken", "refresh_token"} {
				if _, exists := oauth[key]; exists {
					delete(oauth, key)
					changed = true
				}
			}
			if changed {
				if data, err := json.Marshal(oauth); err == nil {
					root["claudeAiOauth"] = data
				}
			}
		}
	}
	stable, err := json.Marshal(root)
	if err != nil {
		stable = []byte(raw)
	}
	sum := sha256.Sum256(stable)
	return hex.EncodeToString(sum[:])
}

func (claude *claude) ShortName() string { return "Claude" }
