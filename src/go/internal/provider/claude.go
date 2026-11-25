package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/browserlogin"
	"github.com/outof0/anypick/go/internal/transport"
)

const (
	claudeSnapshotFile  = "credentials.json"
	claudeLoginMethodID = "claude-subscription"
	claudeKeychainName  = "Claude Code-credentials"
)

// claude manages Claude Code credentials, which live in the macOS Keychain
// ("Claude Code-credentials") or ~/.claude/.credentials.json on file-backed
// platforms.
//
// It has no PreflightRestore, so a running Claude Code does not stop a switch.
// A session that is already running may go on with the login it loaded, and
// may write its copy of ~/.claude.json back over the switch.
type claude struct {
	home         string
	keychainRead func(string) (string, error)
}

func newClaude(home string) *claude { return &claude{home: home, keychainRead: runSecurity} }

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
	original   string
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
		out, err := p.keychainRead("find-generic-password -s 'Claude Code-credentials' -a " +
			quoteSecurity(p.accountName()) + " -w")
		if err != nil {
			return nil, nil
		}
		return p.decodeLive(out)
	}
	path := p.fileCredentialsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return p.decodeLive(string(data))
}

func (p *claude) decodeLive(raw string) (*claudeCredential, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	credential := normalizeClaudeCredential(raw)
	if credential == "" {
		// An unreadable item is not an empty store. Stop before a switch
		// overwrites a credential its checkpoint cannot restore (ADR 0004).
		return nil, anyerr.Newf("The current Claude Code credential could not be read.",
			"CLAUDE_LIVE_AUTH_INVALID",
			anyerr.WithSuggestions("Check the current login with claude auth status."))
	}
	return &claudeCredential{
		account: p.accountName(), credential: credential, original: raw,
	}, nil
}

func (p *claude) write(credential, original string) error {
	if p.useKeychain() {
		stdin, args, err := claudeKeychainWriteInvocation(p.accountName(), credential, original)
		if err != nil {
			return err
		}
		return runGenericPasswordWrite(stdin, args)
	}
	path := p.fileCredentialsPath()
	// path is the user's live credential file. Truncating it in place leaves
	// an empty login on crash (ADR 0004), so replace by rename (atomicfile).
	return atomicfile.Write(path, []byte(credential+"\n"), 0o600)
}

func claudeKeychainWriteInvocation(account, credential, original string) (string, []string, error) {
	password, err := claudeKeychainPassword(credential)
	if err != nil {
		return "", nil, err
	}
	// security interprets backslashes even inside its stdin quotes. The
	// argv form expects the original bytes, so never reuse the escaped args.
	stdin, _ := darwinAddGenericInvocation(claudeKeychainName, account,
		strings.ReplaceAll(password, `\`, `\\`))
	if stdin != "" {
		return stdin, nil, nil
	}

	// JSON escaping can make a previously stdin-safe value exceed the
	// command buffer. Fail before writing if that would move it onto argv.
	if legacyClaudeCredentialFitsStdin(account, original) ||
		(original != credential && legacyClaudeCredentialFitsStdin(account, credential)) {
		return "", nil, anyerr.Newf("The Claude Code credential exceeds the safe Keychain input size after encoding.",
			"CLAUDE_KEYCHAIN_WRITE_TOO_LARGE",
			anyerr.WithSuggestions("Sign in with Claude Code to restore this account."))
	}
	return "", darwinAddGenericArgv(claudeKeychainName, account, password), nil
}

func legacyClaudeCredentialFitsStdin(account, credential string) bool {
	if !strings.HasSuffix(credential, "\n") {
		credential += "\n"
	}
	stdin, _ := darwinAddGenericInvocation(claudeKeychainName, account, credential)
	return stdin != ""
}

// security -w prints a keychain item as hex if it contains non-printable ASCII
// or non-ASCII bytes. Claude Code expects JSON from that command.
func claudeKeychainPassword(credential string) (string, error) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, []byte(credential)); err != nil {
		return "", fmt.Errorf("the Claude Code credential is invalid")
	}
	return escapeClaudeJSON(compact.String()), nil
}

func escapeClaudeJSON(credential string) string {
	var password strings.Builder
	password.Grow(len(credential))
	for _, r := range credential {
		switch {
		case r < unicode.MaxASCII:
			password.WriteByte(byte(r))
		case r <= '\uFFFF':
			fmt.Fprintf(&password, `\u%04x`, r)
		default:
			high, low := utf16.EncodeRune(r)
			fmt.Fprintf(&password, `\u%04x\u%04x`, high, low)
		}
	}
	return password.String()
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
	status := LiveAuthStatus{Present: true, Details: "Claude Code secure credential store"}
	// Preserve the recoverable login for checkpointing without letting the
	// active-account identity shortcut skip the rewrite of its live bytes.
	if current.original == current.credential {
		status.Identity = claudeCredentialIdentity(current.credential)
	}
	return status, nil
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
	if p.useKeychain() {
		// Backup also creates rollback checkpoints. A checkpoint must be
		// restorable before the account service can replace this live item.
		if _, _, err := claudeKeychainWriteInvocation(current.account, current.credential, current.original); err != nil {
			return SnapshotInfo{}, err
		}
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
	_, original, _ := claudeWrapperFields(raw)
	credential := normalizeClaudeCredential(original)
	if credential == "" {
		return fmt.Errorf("the Claude Code credential snapshot is invalid")
	}
	previous, readErr := p.read()
	if err := p.write(credential, original); err != nil {
		return err
	}
	if readErr != nil || previous == nil || previous.original != previous.credential ||
		claudeFingerprint(previous.credential) != claudeFingerprint(credential) {
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
	return SnapshotInfo{Identity: claudeCredentialIdentity(claudeSnapshotCredential(raw))}, nil
}

// SnapshotMatchesLive compares fingerprints with the refresh token stripped. A
// rotated access token still reads as a different credential.
func (p *claude) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	current, err := p.read()
	if err != nil {
		return false, false, err
	}
	if current == nil || current.original != current.credential {
		return false, true, nil
	}
	raw, err := os.ReadFile(filepath.Join(srcDir, claudeSnapshotFile))
	if err != nil {
		if os.IsNotExist(err) {
			return false, true, nil
		}
		return false, false, err
	}
	credential := claudeSnapshotCredential(raw)
	if credential == "" {
		return false, true, nil
	}
	return claudeFingerprint(current.credential) == claudeFingerprint(credential),
		true, nil
}

func claudeSnapshotCredential(raw []byte) string {
	_, credential, ok := claudeWrapperFields(raw)
	if !ok {
		return ""
	}
	return normalizeClaudeCredential(credential)
}

// Older versions snapshotted security -w output verbatim. If a restore stored
// that hex with a newline, the next read added another hex layer.
func normalizeClaudeCredential(raw string) string {
	raw = strings.TrimSpace(raw)
	for raw != "" {
		if strings.HasPrefix(raw, "{") && json.Valid([]byte(raw)) {
			return raw
		}
		decoded, err := hex.DecodeString(raw)
		if err != nil {
			return ""
		}
		raw = strings.TrimSpace(string(decoded))
	}
	return ""
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
	// Keychain writes escape Unicode, so hash the same JSON form for live and
	// saved credentials even when the snapshot used literal characters.
	sum := sha256.Sum256([]byte(escapeClaudeJSON(string(stable))))
	return hex.EncodeToString(sum[:])
}

func (claude *claude) ShortName() string { return "Claude" }
