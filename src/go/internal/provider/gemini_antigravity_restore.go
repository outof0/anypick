package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
)

// readAntigravityOAuthPayload reads the complete nested payload kept in an
// account snapshot. Older snapshots may contain a flat OAuth object; wrapping
// that shape here keeps them restorable without inventing a new credential.
func readAntigravityOAuthPayload(path string) (*geminiAntigravityFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var payload geminiAntigravityFile
	if json.Unmarshal(raw, &payload) == nil && payload.Token.RefreshToken != "" {
		if payload.Token.TokenType == "" {
			payload.Token.TokenType = "Bearer"
		}
		if payload.Email == "" {
			// Antigravity leaves `email` empty in some releases and keeps the
			// address only in the envelope's id_token. Deriving it here is what
			// lets a saved account show an address instead of a grant hash.
			payload.Email = geminiEmailFromCredentials(raw)
		}
		return &payload, nil
	}
	creds, ok := parseGeminiOAuthCredentials(raw)
	if !ok || creds.RefreshToken == "" {
		return nil, fmt.Errorf("saved Antigravity credential has no refresh token")
	}
	payload.AuthMethod = "consumer"
	payload.Email = geminiEmailFromCredentials(raw)
	payload.Token.AccessToken = creds.AccessToken
	payload.Token.RefreshToken = creds.RefreshToken
	payload.Token.TokenType = creds.TokenType
	if creds.ExpiryDate != nil {
		payload.Token.Expiry = time.UnixMilli(*creds.ExpiryDate).UTC().Format(time.RFC3339Nano)
	}
	if payload.Token.TokenType == "" {
		payload.Token.TokenType = "Bearer"
	}
	return &payload, nil
}

func antigravityPayloadFromLiveFile(p *gemini) *geminiAntigravityFile {
	name := p.oauthCredFileFor(antigravityOAuthSource)
	if name == "" {
		return nil
	}
	payload, err := readAntigravityOAuthPayload(p.livePath(name))
	if err != nil {
		return nil
	}
	return payload
}

// authoritativeAntigravityCredential prefers the IDE's state database. A
// stale portable file is common after a switch, and treating it as live auth
// is exactly how the UI can say "user@example.com" while Antigravity still uses
// other@example.com.
func (p *gemini) authoritativeAntigravityCredential() *geminiAntigravityFile {
	state := p.antigravityStateCredential()
	if state == nil {
		return antigravityPayloadFromLiveFile(p)
	}
	if mirror := antigravityPayloadFromLiveFile(p); mirror != nil &&
		mirror.Token.RefreshToken == state.Token.RefreshToken {
		state.AuthMethod = mirror.AuthMethod
	}
	if state.Email == "" {
		// The state envelope carries tokens only; the address lives in the
		// portable mirror, and only a mirror with the same grant may donate it.
		state.Email = p.antigravityMirrorEmail(state.Token.RefreshToken)
	}
	return state
}

// antigravityMirrorEmail returns the address of the portable mirror whose
// refresh token matches the given grant. The probe order (`oauthCredFileFor`)
// is by content shape, not identity: ~/.gemini can hold a mirror for a
// different Google account, so an unmatched mirror must stay silent rather
// than donate the wrong email to a state account.
func (p *gemini) antigravityMirrorEmail(refreshToken string) string {
	if refreshToken == "" {
		return ""
	}
	for _, name := range antigravityCredentialFiles {
		payload, err := readAntigravityOAuthPayload(p.livePath(name))
		if err != nil || payload == nil || payload.Token.RefreshToken != refreshToken {
			continue
		}
		if payload.Email != "" {
			return payload.Email
		}
	}
	return ""
}

func (p *gemini) antigravityLiveStatus() LiveAuthStatus {
	if payload := p.authoritativeAntigravityCredential(); payload != nil {
		identity := payload.Email
		if identity == "" {
			identity = antigravityIdentity(payload.Token.RefreshToken)
		}
		return LiveAuthStatus{
			Present:  true,
			Identity: identity,
			Details:  "antigravity oauth",
			Source:   antigravityOAuthSource,
		}
	}
	if AntigravityKeyringProbe() {
		return LiveAuthStatus{
			Present: true,
			Details: "antigravity oauth",
			Source:  antigravityOAuthSource,
		}
	}
	return LiveAuthStatus{}
}

// hydrateAntigravityOAuthPayload refreshes a snapshot only when its access
// token is absent or expired. Antigravity's desktop client expects a usable
// access token and expiry in the state/keyring payload after a switch.
func hydrateAntigravityOAuthPayload(path string, payload *geminiAntigravityFile) (*geminiAntigravityFile, error) {
	if payload == nil || payload.Token.RefreshToken == "" {
		return nil, fmt.Errorf("saved Antigravity credential has no refresh token")
	}
	expiry := parseGeminiExpiry(payload.Token.Expiry)
	if payload.Token.AccessToken != "" && expiry != nil &&
		*expiry > time.Now().Add(geminiOAuthRefreshSkew).UnixMilli() {
		if payload.Email == "" {
			// The login is usable as-is; only the display identity is missing.
			// The valid access token still answers userinfo, and the caller
			// writes the envelope back to the live mirror, so one switch is
			// enough to make the account identifiable.
			payload.Email = geminiOAuthUserEmail(context.Background(), payload.Token.AccessToken)
		}
		return payload, nil
	}
	creds, ok := parseGeminiOAuthCredentials(mustMarshal(payload))
	if !ok {
		return nil, fmt.Errorf("saved Antigravity credential could not be prepared for refresh")
	}
	if _, err := refreshGeminiOAuth(path, antigravityOAuthSource, creds); err != nil {
		return nil, err
	}
	updated, err := readAntigravityOAuthPayload(path)
	if err != nil || updated == nil {
		if err == nil {
			err = fmt.Errorf("refreshed Antigravity credential disappeared")
		}
		return nil, err
	}
	if updated.Email == "" {
		updated.Email = payload.Email
	}
	if updated.Email == "" {
		// Some grants return no id_token, so the refreshed credential still
		// carries no readable address. The access token answers userinfo (the
		// login flow uses the same call); without it the account falls back to
		// a grant hash in the UI for good.
		updated.Email = geminiOAuthUserEmail(context.Background(), updated.Token.AccessToken)
	}
	if updated.AuthMethod == "" {
		updated.AuthMethod = payload.AuthMethod
	}
	return updated, nil
}

func mustMarshal(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func (p *gemini) PreflightRestore(srcDir string) error {
	snapshotPath := filepath.Join(srcDir, "antigravity_oauth.json")
	if _, err := os.Stat(snapshotPath); os.IsNotExist(err) {
		return nil
	}
	payload, err := readAntigravityOAuthPayload(snapshotPath)
	if err != nil || payload == nil {
		if err == nil {
			err = fmt.Errorf("saved Antigravity credential has no refresh token")
		}
		return anyerr.Wrapf(err, "validate Antigravity account", "ANTIGRAVITY_RESTORE_FAILED")
	}
	if _, err := assertAntigravityStateSafeToMutate(p.home); err != nil {
		return anyerr.Wrapf(err, "validate Antigravity state", "ANTIGRAVITY_RESTORE_FAILED")
	}
	return nil
}

func (p *gemini) restoreAntigravity(snapshotPath string) error {
	payload, err := readAntigravityOAuthPayload(snapshotPath)
	if err != nil || payload == nil {
		if err == nil {
			err = fmt.Errorf("saved Antigravity credential has no refresh token")
		}
		return anyerr.Wrapf(err, "read Antigravity account", "ANTIGRAVITY_RESTORE_FAILED")
	}
	hydrated, err := hydrateAntigravityOAuthPayload(snapshotPath, payload)
	if err != nil {
		return anyerr.Wrapf(err, "refresh Antigravity account", "ANTIGRAVITY_RESTORE_FAILED")
	}
	// Restore copied the snapshot before hydration. Keep the local mirror in
	// the same shape/token generation as the state and Keychain writers.
	if raw, marshalErr := json.MarshalIndent(hydrated, "", "  "); marshalErr != nil {
		return anyerr.Wrapf(marshalErr, "encode Antigravity account", "ANTIGRAVITY_RESTORE_FAILED")
	} else if writeErr := atomicfile.Write(p.livePath(antigravityCredentialFiles[0]), append(raw, '\n'), 0o600); writeErr != nil {
		return anyerr.Wrapf(writeErr, "update Antigravity local mirror", "ANTIGRAVITY_RESTORE_FAILED")
	}
	paths, err := assertAntigravityStateSafeToMutate(p.home)
	if err != nil {
		return anyerr.Wrapf(err, "validate Antigravity state", "ANTIGRAVITY_RESTORE_FAILED")
	}
	// Keep the OS mirror and the IDE state in sync. The keyring write happens
	// first because it is the credential source used by older Antigravity
	// builds. If the state database write then fails (e.g. the IDE held it
	// busy past the timeout), the keychain is rolled back so the two stores
	// cannot disagree about the signed-in account.
	if err := restoreAntigravityKeyring(hydrated); err != nil {
		// User-facing copy names the surface, not the syscall: the raw
		// "exit status 1" chain stays in the wrapped cause for logs, while
		// the app and CLI render this message plus the recovery hints.
		return anyerr.Wrapf(err, "Couldn't save the Antigravity login to the macOS Keychain",
			"ANTIGRAVITY_RESTORE_FAILED",
			anyerr.WithSuggestions(
				"Unlock the login keychain in Keychain Access and try again.",
				"If it keeps failing, run `anypick doctor`."))
	}
	if err := writeAntigravityStateOAuthPayload(p.home, hydrated, paths); err != nil {
		// The read happens only on the failure path: it can raise a keychain
		// prompt, and the user is already looking at an error.
		if previous := AntigravityKeyringRead(); previous != nil {
			if rbErr := restoreAntigravityKeyring(previous); rbErr != nil {
				err = fmt.Errorf("%w (keychain rollback also failed: %v)", err, rbErr)
			}
		}
		return anyerr.Wrapf(err, "write Antigravity state", "ANTIGRAVITY_RESTORE_FAILED")
	}
	return nil
}

// geminiAuthFingerprint compares durable material only. Access tokens rotate
// during normal use and must not make the current account look different.
func geminiAuthFingerprint(dir string) string {
	return geminiFingerprintFiles(snapshotFilesAt(dir))
}

func geminiFingerprintFiles(file SnapshotFileReader) string {
	var parts []string
	for _, source := range []string{geminiCliOAuthSource, antigravityOAuthSource} {
		if credential := readGeminiSnapshotCredential(file, source); credential != nil {
			token := firstNonEmpty(credential.RefreshToken, credential.AccessToken)
			parts = append(parts, source+":"+hashGeminiAuth(token))
		}
	}
	if raw, err := file(".env"); err == nil {
		if key := geminiAPIKeyFromEnvFile(string(raw)); key != "" {
			parts = append(parts, "key:"+hashGeminiAuth(key))
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}

func hashGeminiAuth(value string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(value)))
	return hex.EncodeToString(sum[:])
}

// SnapshotMatchesLive gives Gemini the same honest current-account signal as
// the other native providers. Antigravity compares against the IDE state, not
// the stale portable mirror; CLI/API-key accounts compare durable local files.
func (p *gemini) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	return p.SnapshotFilesMatchLive(snapshotFilesAt(srcDir))
}

func (p *gemini) SnapshotFilesMatchLive(file SnapshotFileReader) (bool, bool, error) {
	source := geminiSourceMarkerFromFiles(file)
	if saved := readGeminiSnapshotCredential(file, antigravityOAuthSource); saved != nil && source != geminiCliOAuthSource {
		live := p.authoritativeAntigravityCredential()
		if live == nil {
			return false, false, nil
		}
		if saved.RefreshToken == "" || live.Token.RefreshToken == "" {
			return false, false, nil
		}
		match := saved.RefreshToken == live.Token.RefreshToken
		if !match || source == antigravityOAuthSource {
			return match, true, nil
		}
		// Broad snapshots can contain an independent CLI login or API key.
		return geminiFingerprintFiles(file) == geminiAuthFingerprint(p.configDir()), true, nil
	}
	savedFingerprint := geminiFingerprintFiles(file)
	if savedFingerprint == "" || p.antigravityLiveStatus().Present {
		return false, true, nil
	}
	if source == geminiCliOAuthSource {
		live := readGeminiSnapshotCredential(snapshotFilesAt(p.configDir()), geminiCliOAuthSource)
		saved := readGeminiSnapshotCredential(file, geminiCliOAuthSource)
		return sameGeminiQuotaLogin(live, saved), true, nil
	}
	return savedFingerprint == geminiAuthFingerprint(p.configDir()), true, nil
}

// geminiSourceMarkerFromFiles returns the GEMINI_OAUTH_SOURCE written into a
// source-scoped snapshot's .env, or "" for a broad snapshot.
func geminiSourceMarkerFromFiles(file SnapshotFileReader) string {
	raw, err := file(".env")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		if strings.HasPrefix(line, "GEMINI_OAUTH_SOURCE=") {
			return strings.Trim(strings.TrimPrefix(line, "GEMINI_OAUTH_SOURCE="), `"`)
		}
	}
	return ""
}
