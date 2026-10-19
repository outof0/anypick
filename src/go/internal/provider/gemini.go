package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/transport"
)

// gemini manages Gemini's local account sources: gemini-cli's ~/.gemini store
// plus Antigravity's IDE state/keychain login.
type gemini struct {
	home      string
	usageAuth geminiUsageAuth
}

func newGemini(home string) *gemini { return &gemini{home: home} }

// geminiSnapshotFiles is the live-login set copied by Backup and restored by
// Restore. It covers both OAuth writers: gemini-cli's flat oauth_creds.json
// and Antigravity's two interchangeable nested files (see
// geminiAllCredentialFiles). Missing names here is why an Antigravity login
// read as "no live auth" and could not be saved at all.
var geminiSnapshotFiles = append([]string{".env"}, append(
	geminiAllCredentialFiles(), "google_accounts.json")...)

func (p *gemini) ID() string   { return "gemini" }
func (p *gemini) Name() string { return "Google Gemini" }
func (p *gemini) Description() string {
	return "Manages ~/.gemini (oauth_creds.json, .env) and the Antigravity IDE login"
}
func (p *gemini) CanProxy() bool { return true }

// CanClearLive refuses to advertise sign-out for Antigravity's IDE state and
// keychain. AnyPick can import that login and can own its OAuth mirror, but it
// must not claim to sign out a credential store owned by another application.
func (p *gemini) CanClearLive(source string) bool {
	return strings.TrimSpace(source) != antigravityOAuthSource
}

// PreserveAuthEnv snapshots the live dotenv before a login clear. Rollback
// and success both merge it back: ClearLive (the empty-checkpoint rollback)
// strips Vertex and API-key lines that the new OAuth file does not replace.
func (p *gemini) PreserveAuthEnv() (string, error) {
	raw, err := os.ReadFile(p.livePath(".env"))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(raw), nil
}

// RestoreAuthEnv merges a preserved dotenv over the live file. Snapshot lines
// win; every other live line stays. An empty snapshot is a no-op so a login
// that never saw a .env does not create one.
func (p *gemini) RestoreAuthEnv(body string) error {
	if strings.TrimSpace(body) == "" {
		return nil
	}
	return mergeGeminiEnvFile(p.livePath(".env"), geminiEnvAssignments([]byte(body)), nil)
}

// SourceSaveDropsSnapshot reports that replacing this snapshot with a
// source-scoped OAuth backup would discard an API key, Vertex settings, or
// the other Gemini source. Login must keep that snapshot instead of writing
// the new account over it.
func (p *gemini) SourceSaveDropsSnapshot(snapshotDir, source string) bool {
	if raw, err := os.ReadFile(filepath.Join(snapshotDir, ".env")); err == nil {
		if geminiAPIKeyFromEnvFile(string(raw)) != "" || geminiEnvHasPreservedAuth(string(raw)) {
			return true
		}
	}
	other := antigravityOAuthSource
	if source == antigravityOAuthSource {
		other = geminiCliOAuthSource
	}
	return geminiHasCredentials(snapshotDir, other)
}

// geminiEnvHasPreservedAuth reports Vertex and application-credential lines.
// GEMINI_OAUTH_SOURCE is the marker a source snapshot writes itself, and the
// API-key variables are reported by geminiAPIKeyFromEnvFile.
func geminiEnvHasPreservedAuth(raw string) bool {
	for _, line := range splitLines(raw) {
		key, ok := envLineKey(line)
		if !ok || !geminiAuthEnvKeys[key] {
			continue
		}
		if key == "GEMINI_API_KEY" || key == "GOOGLE_API_KEY" {
			continue
		}
		return true
	}
	return false
}

// AccountAdapter keeps invariant #1: direct ONLY for the gemini client; other
// clients ride the builtin proxy.
func (p *gemini) AccountAdapter(accountName string, _ bool) transport.Adapter {
	return transport.GeminiAccountAdapter(p.ID(), accountName)
}

// CredentialDefinitions publishes Gemini's native API-key account path. It
// intentionally does not expose Definition: Gemini is not an inert
// OpenAI-compatible vendor, and its upstream/auth shape stays provider-owned.
func (p *gemini) CredentialDefinitions() []CredentialDefinition {
	return []CredentialDefinition{{
		Kind:            "api-key",
		Label:           "Gemini API key",
		CredentialClass: "provider_api_key",
		Profiles: []EndpointProfile{{
			ID:         "global",
			Label:      "Google AI Studio",
			OpenAIBase: "https://generativelanguage.googleapis.com/v1beta",
		}},
	}}
}

// BackupInput makes an API key a first-class Gemini account snapshot. Gateway
// profiles keep their secret in the profile store; this path is different: a
// named account is deliberately portable and resolves through .env when it is
// activated.
func (p *gemini) BackupInput(kind, secret, profile string, destDir string) (SnapshotInfo, error) {
	if kind != "api-key" {
		return SnapshotInfo{}, anyerr.Newf(
			p.Name()+" does not accept credential kind \""+kind+"\".",
			"UNSUPPORTED_CREDENTIAL_INPUT")
	}
	if profile == "" {
		profile = "global"
	}
	if profile != "global" {
		return SnapshotInfo{}, anyerr.Newf(
			p.Name()+" has no endpoint profile \""+profile+"\" for "+kind+".",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	secret = strings.TrimSpace(secret)
	if secret == "" || strings.ContainsAny(secret, "\r\n") {
		return SnapshotInfo{}, anyerr.Newf(
			"A non-empty Gemini API key without newlines is required.", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if err := os.WriteFile(filepath.Join(destDir, ".env"),
		[]byte("GEMINI_API_KEY="+secret+"\n"), 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{
		CredentialKind:  "native",
		CredentialClass: "provider_api_key",
		Notes:           "API key",
	}, nil
}

func (p *gemini) configDir() string {
	// Same rule as client.geminiDir, and for the same reason: GEMINI_CLI_HOME
	// is the variable @google/gemini-cli actually reads and it replaces HOME,
	// so the config dir is "$GEMINI_CLI_HOME/.gemini". GEMINI_CONFIG_DIR is
	// AnyPick's own knob and must lose to it — see the note there.
	if cliHome := os.Getenv("GEMINI_CLI_HOME"); cliHome != "" {
		return filepath.Join(expandHome(cliHome), ".gemini")
	}
	if env := os.Getenv("GEMINI_CONFIG_DIR"); env != "" {
		return expandHome(env)
	}
	return filepath.Join(expandHome(p.home), ".gemini")
}

func (p *gemini) livePath(name string) string { return filepath.Join(p.configDir(), name) }

func (p *gemini) oauthCredFileFor(source string) string {
	names := geminiAllCredentialFiles()
	if source != "" {
		names = geminiCredentialFilesFor(source)
	}
	for _, name := range names {
		raw, err := os.ReadFile(p.livePath(name))
		if err != nil {
			continue
		}
		if _, ok := parseGeminiOAuthCredentials(raw); ok {
			return name
		}
	}
	return ""
}

// antigravityStateCredential is the IDE-state login, or nil when Antigravity
// is not installed or is signed out. Read-only by construction: detecting an
// account must never touch another product's credential store.
func (p *gemini) antigravityStateCredential() *geminiAntigravityFile {
	return antigravityStateCredential(p.home)
}

func (p *gemini) hasEnvAPIKey() bool {
	data, err := os.ReadFile(p.livePath(".env"))
	if err != nil {
		return false
	}
	return geminiAPIKeyFromEnvFile(string(data)) != ""
}

func (p *gemini) DetectLive() (LiveAuthStatus, error) {
	// Antigravity's state database is authoritative. A stale nested file can
	// survive a previous switch and must never win over the account the IDE
	// itself will read.
	if live := p.antigravityLiveStatus(); live.Present {
		return live, nil
	}
	if name := p.oauthCredFileFor(geminiCliOAuthSource); name != "" {
		return LiveAuthStatus{
			Present:  true,
			Identity: p.oauthEmailFor(geminiCliOAuthSource),
			Details:  geminiCliOAuthSource + " oauth",
			Source:   geminiCliOAuthSource,
		}, nil
	}
	if p.hasEnvAPIKey() {
		return LiveAuthStatus{Present: true, Details: "API key (.env)"}, nil
	}
	return LiveAuthStatus{}, nil
}

// DetectLiveSource probes exactly one Gemini sign-in source. It is used by
// explicit --source/account-save-current requests; automatic status polls
// continue to use DetectLive and never read the Antigravity secret.
func (p *gemini) DetectLiveSource(source string) (LiveAuthStatus, error) {
	source = strings.TrimSpace(source)
	switch source {
	case geminiCliOAuthSource, antigravityOAuthSource:
	default:
		return LiveAuthStatus{}, anyerr.Newf(
			"Unknown Gemini sign-in source \""+source+"\".", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if source == antigravityOAuthSource {
		return p.antigravityLiveStatus(), nil
	}
	if name := p.oauthCredFileFor(source); name != "" {
		return LiveAuthStatus{
			Present:  true,
			Identity: p.oauthEmailFor(source),
			Details:  source + " oauth",
			Source:   source,
		}, nil
	}
	return LiveAuthStatus{}, nil
}

func (p *gemini) oauthEmail() string {
	// Antigravity writes the address in clear text; gemini-cli hides it in
	// the id_token. Probe the OAuth files first for either.
	return p.oauthEmailFor("")
}

func (p *gemini) oauthEmailFor(source string) string {
	names := geminiAllCredentialFiles()
	if source != "" {
		names = geminiCredentialFilesFor(source)
	}
	// An Antigravity state database is authoritative about which portable
	// mirror is the live login. ~/.gemini can hold a mirror for a different
	// Google account (its id_token even carries that account's address), so a
	// mirror for another grant must stay silent instead of donating an email.
	grant := ""
	if source == "" || source == antigravityOAuthSource {
		if state := p.antigravityStateCredential(); state != nil {
			grant = state.Token.RefreshToken
		}
	}
	for _, name := range names {
		raw, err := os.ReadFile(p.livePath(name))
		if err != nil {
			continue
		}
		if grant != "" && isAntigravityCredentialFileName(name) {
			payload, payloadErr := readAntigravityOAuthPayload(p.livePath(name))
			if payloadErr != nil || payload == nil || payload.Token.RefreshToken != grant {
				continue
			}
		}
		if email := geminiEmailFromCredentials(raw); email != "" {
			return email
		}
	}
	if grant != "" {
		// google_accounts.json belongs to whichever gemini-cli login wrote it,
		// not necessarily the Antigravity grant.
		return ""
	}
	acctRaw, err := os.ReadFile(p.livePath("google_accounts.json"))
	if err != nil {
		return ""
	}
	var accounts []struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(acctRaw, &accounts) == nil && len(accounts) > 0 &&
		strings.Contains(accounts[0].Email, "@") {
		return accounts[0].Email
	}
	return ""
}

func isAntigravityCredentialFileName(name string) bool {
	for _, candidate := range antigravityCredentialFiles {
		if name == candidate {
			return true
		}
	}
	return false
}

// BackupSource snapshots only the selected OAuth source. In particular it
// does not copy a live .env API key into an OAuth account, because API-key
// resolution intentionally outranks OAuth when both are present.
func (p *gemini) BackupSource(source, destDir string) (SnapshotInfo, error) {
	source = strings.TrimSpace(source)
	live, err := p.DetectLiveSource(source)
	if err != nil {
		return SnapshotInfo{}, err
	}
	if !live.Present {
		return SnapshotInfo{}, anyerr.Newf(
			"No live Gemini "+source+" sign-in was found.", "NO_LIVE_AUTH",
			anyerr.WithSuggestions("Sign in to the selected Gemini source, then try again."))
	}
	found := false
	if source == antigravityOAuthSource {
		// The state DB is what Antigravity is actually using. Only fall back to
		// the portable file/keyring when no IDE state exists.
		cred := p.authoritativeAntigravityCredential()
		notes := "Antigravity login (IDE state)"
		if p.antigravityStateCredential() == nil {
			notes = "Antigravity login (portable mirror)"
			if cred == nil && antigravityKeyringExists() {
				cred = antigravityKeyringCredential()
				notes = "Antigravity login (OS keyring)"
			}
		}
		if cred != nil {
			raw, marshalErr := json.Marshal(cred)
			if marshalErr != nil {
				return SnapshotInfo{}, marshalErr
			}
			if writeErr := os.WriteFile(filepath.Join(destDir, antigravityCredentialFiles[0]), raw, 0o600); writeErr != nil {
				return SnapshotInfo{}, writeErr
			}
			found = true
			if cred.Email != "" {
				live.Identity = cred.Email
			} else if cred.IDToken != "" {
				if email := jwtEmail(cred.IDToken); email != "" {
					live.Identity = email
				}
			}
			if live.Identity == "" && cred.Token.IDToken != "" {
				if email := jwtEmail(cred.Token.IDToken); email != "" {
					live.Identity = email
				}
			}
			if live.Identity == "" {
				live.Identity = antigravityIdentity(cred.Token.RefreshToken)
			}
			live.Details = notes
		}
	} else {
		for _, name := range geminiCredentialFilesFor(source) {
			raw, readErr := os.ReadFile(p.livePath(name))
			if readErr != nil {
				continue
			}
			if _, ok := parseGeminiOAuthCredentials(raw); !ok {
				continue
			}
			if writeErr := os.WriteFile(filepath.Join(destDir, name), raw, 0o600); writeErr != nil {
				return SnapshotInfo{}, writeErr
			}
			found = true
		}
	}
	if !found {
		return SnapshotInfo{}, anyerr.Newf(
			"Gemini "+source+" sign-in was detected but no usable refresh credential could be read.",
			"NO_LIVE_AUTH",
			anyerr.WithSuggestions("Keep the selected app open and sign in again, then retry."))
	}
	if err := os.WriteFile(filepath.Join(destDir, ".env"),
		[]byte("GEMINI_OAUTH_SOURCE="+source+"\n"), 0o600); err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{Identity: live.Identity, Notes: live.Details}, nil
}

func (p *gemini) backupUsableFiles(destDir string) (found, oauthFound, apiKeyFound bool, err error) {
	for _, name := range geminiSnapshotFiles {
		src := p.livePath(name)
		data, readErr := os.ReadFile(src)
		if readErr != nil {
			continue
		}
		switch name {
		case ".env":
			// A dotenv file can contain editor settings or the OAuth-source
			// marker restored from an account. It counts as auth only when it
			// contains a real API key.
			if !p.hasEnvAPIKey() {
				continue
			}
			apiKeyFound = true
		case "google_accounts.json":
			// This is identity metadata, not a credential. Copy it only
			// after one of the credential files above has proved usable.
			if !oauthFound && !apiKeyFound {
				continue
			}
		default:
			if _, ok := parseGeminiOAuthCredentials(data); !ok {
				continue
			}
			oauthFound = true
		}
		found = true
		if writeErr := os.WriteFile(filepath.Join(destDir, name), data, 0o600); writeErr != nil {
			return false, oauthFound, apiKeyFound, writeErr
		}
	}
	return found, oauthFound, apiKeyFound, nil
}

// backupAntigravityAlternate imports the IDE-owned OAuth mirror when a
// gemini-cli/API-key login was already found. Antigravity can remain usable
// while ~/.gemini/oauth_creds.json is stale or tied to a different Code Assist
// route, so keeping only the first detected source makes proxy fallback
// impossible. The state database is read-only. If it has no credential, the
// keychain is read only after the user explicitly asks to save/refresh an
// account; routine DetectLive polling never reads that secret.
func (p *gemini) backupAntigravityAlternate(destDir string) error {
	if geminiHasCredentials(destDir, antigravityOAuthSource) {
		return nil
	}
	cred := p.antigravityStateCredential()
	if cred == nil && antigravityKeyringExists() {
		cred = antigravityKeyringCredential()
	}
	if cred == nil {
		return nil
	}
	out, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(destDir, antigravityCredentialFiles[0]), out, 0o600)
}

func (p *gemini) Backup(destDir string) (SnapshotInfo, error) {
	found, oauthFound, apiKeyFound, err := p.backupUsableFiles(destDir)
	if err != nil {
		return SnapshotInfo{}, err
	}
	info := SnapshotInfo{}
	stateIdentity, stateNotes := "", ""
	// Replace any stale portable Antigravity mirror with the authoritative IDE
	// state before the snapshot is used as a checkpoint or saved account.
	if state := p.antigravityStateCredential(); state != nil {
		wasOnlyState := !oauthFound && !apiKeyFound
		raw, marshalErr := json.Marshal(state)
		if marshalErr != nil {
			return SnapshotInfo{}, marshalErr
		}
		if writeErr := os.WriteFile(filepath.Join(destDir, antigravityCredentialFiles[0]), raw, 0o600); writeErr != nil {
			return SnapshotInfo{}, writeErr
		}
		found = true
		oauthFound = true
		if wasOnlyState {
			stateIdentity = state.Email
			if stateIdentity == "" {
				stateIdentity = antigravityIdentity(state.Token.RefreshToken)
			}
			stateNotes = "Antigravity login (IDE state)"
		}
	}
	if oauthFound && !apiKeyFound {
		if err := p.backupAntigravityAlternate(destDir); err != nil {
			return SnapshotInfo{}, err
		}
	}
	// No file-based credential was found. The IDE state was read above and was
	// either absent or already snapshotted, so the OS keyring is the remaining
	// source for a keyring-only Antigravity install.
	if !oauthFound && !apiKeyFound {
		// Reading the secret here is deliberate: the user asked to save this
		// account and the snapshot is useless without the material.
		// DetectLive must never do this.
		cred := antigravityKeyringCredential()
		notes := "Antigravity login (OS keyring)"
		if cred != nil {
			out, err := json.Marshal(cred)
			if err == nil {
				dest := filepath.Join(destDir, antigravityCredentialFiles[0])
				if err := os.WriteFile(dest, out, 0o600); err == nil {
					found = true
					stateIdentity = antigravityIdentity(cred.Token.RefreshToken)
					stateNotes = notes
				}
			}
		}
	}
	if !found {
		return SnapshotInfo{}, anyerr.Newf(
			"No usable live Gemini auth found under "+p.configDir()+". Log in or configure an API key first, then save.",
			"NO_LIVE_AUTH",
			anyerr.WithSuggestions("Run `gemini` and sign in, or set GEMINI_API_KEY, then try again."))
	}
	if stateIdentity != "" {
		info.Identity = stateIdentity
		info.Notes = stateNotes
	} else if oauthFound {
		info.Identity = p.oauthEmail()
	} else if apiKeyFound {
		info.Notes = "API key"
		info.CredentialKind = "native"
	}
	return info, nil
}

// geminiClientManagedKey mirrors client.anypickManagedKey: the marker the
// gemini client adapter writes into settings.json listing the .env keys it
// owns (GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL, …) while a proxy binding is
// active. Duplicated on purpose: client imports provider's peers, not the
// other way round, so the two packages cannot share one constant.
const geminiClientManagedKey = "_anypickManaged"

// geminiOwnedEnvKey is provider-owned: BackupSource writes it as the only
// content of a source-scoped .env, so a restore must set or drop it explicitly.
const geminiOwnedEnvKey = "GEMINI_OAUTH_SOURCE"

func (p *gemini) Restore(srcDir string) error {
	restored := false
	// .env is layered, not a complete credential file. A source-scoped
	// snapshot stores only the source marker, so replacing the live file would
	// destroy a user's own GEMINI_API_KEY; deleting it when absent would
	// destroy their whole environment. Merge instead, and remove only keys
	// AnyPick itself wrote (recorded in the client's managed marker) that the
	// snapshot does not define.
	envRestored, err := p.restoreGeminiEnv(srcDir)
	if err != nil {
		return err
	}
	restored = restored || envRestored
	for _, name := range geminiSnapshotFiles {
		if name == ".env" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(srcDir, name))
		if err != nil {
			// Auth files are a complete source snapshot. Leaving a credential
			// from the previous account in ~/.gemini makes source detection pick
			// the wrong identity after a switch.
			_ = os.Remove(p.livePath(name))
			continue
		}
		dest := p.livePath(name)
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		if err := atomicfile.Write(dest, data, 0o600); err != nil {
			return err
		}
		restored = true
	}
	if _, err := os.Stat(filepath.Join(srcDir, antigravityCredentialFiles[0])); err == nil {
		if err := p.restoreAntigravity(filepath.Join(srcDir, antigravityCredentialFiles[0])); err != nil {
			return err
		}
		restored = true
	}
	if !restored {
		return errSnapshotMissing("any Gemini CLI credential file")
	}
	return nil
}

// restoreGeminiEnv merges the snapshot's .env over the live file. The snapshot
// wins for every assignment it contains; AnyPick-owned keys the snapshot does
// not define are removed so a restored login cannot keep pointing at a stopped
// proxy. Everything else in the live file (user keys, comments) is preserved.
func (p *gemini) restoreGeminiEnv(srcDir string) (bool, error) {
	livePath := p.livePath(".env")
	snapshotPath := filepath.Join(srcDir, ".env")
	snapshot, readErr := os.ReadFile(snapshotPath)
	managed := geminiClientManagedEnvKeys(geminiSettingsPathFromEnv(livePath))
	if readErr != nil {
		if !os.IsNotExist(readErr) {
			return false, readErr
		}
		// No snapshot .env: keep every user line, but scrub the provider marker
		// and any keys a previous proxy binding wrote.
		if _, statErr := os.Stat(livePath); statErr != nil {
			return false, nil
		}
		drop := append([]string{geminiOwnedEnvKey}, managed...)
		if err := stripGeminiEnvKeys(livePath, drop); err != nil {
			return false, err
		}
		clearGeminiClientManagedMarker(geminiSettingsPathFromEnv(livePath))
		return true, nil
	}

	overrides := geminiEnvAssignments(snapshot)
	overrideKeys := make(map[string]bool, len(overrides))
	for _, assignment := range overrides {
		overrideKeys[assignment.key] = true
	}
	// Only keys AnyPick wrote are candidates for removal. A user's own
	// GEMINI_API_KEY predates any marker and must survive the restore.
	drop := []string{}
	if !overrideKeys[geminiOwnedEnvKey] {
		drop = append(drop, geminiOwnedEnvKey)
	}
	for _, key := range managed {
		if !overrideKeys[key] {
			drop = append(drop, key)
		}
	}
	if err := mergeGeminiEnvFile(livePath, overrides, drop); err != nil {
		return false, err
	}
	clearGeminiClientManagedMarker(geminiSettingsPathFromEnv(livePath))
	return true, nil
}

type geminiEnvAssignment struct {
	key string
	raw string // the snapshot's full `KEY=value` line, quoting preserved
}

// geminiEnvAssignments extracts assignments from a dotenv body in order.
func geminiEnvAssignments(raw []byte) []geminiEnvAssignment {
	lines := splitLines(string(raw))
	out := make([]geminiEnvAssignment, 0, len(lines))
	for _, line := range lines {
		key, ok := envLineKey(line)
		if !ok {
			continue
		}
		out = append(out, geminiEnvAssignment{key: key, raw: strings.TrimSpace(line)})
	}
	return out
}

// mergeGeminiEnvFile applies overrides to the live file (last occurrence per
// key) and appends new keys, then removes drop keys.
func mergeGeminiEnvFile(path string, overrides []geminiEnvAssignment, drop []string) error {
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(raw) == 0 && len(overrides) == 0 {
		// Nothing to merge and no file to scrub: do not create an empty .env.
		return nil
	}
	lines := splitLines(string(raw))
	index := map[string]int{}
	for i, line := range lines {
		if key, ok := envLineKey(line); ok {
			index[key] = i
		}
	}
	for _, assignment := range overrides {
		if i, ok := index[assignment.key]; ok {
			lines[i] = assignment.raw
			continue
		}
		lines = append(lines, assignment.raw)
		index[assignment.key] = len(lines) - 1
	}
	if len(drop) > 0 {
		dropSet := make(map[string]bool, len(drop))
		for _, key := range drop {
			dropSet[key] = true
		}
		kept := lines[:0]
		for _, line := range lines {
			if key, ok := envLineKey(line); ok && dropSet[key] {
				continue
			}
			kept = append(kept, line)
		}
		lines = kept
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(path, []byte(strings.TrimRight(joinLines(lines), "\n")+"\n"), 0o600)
}

// stripGeminiEnvKeys removes the named assignments from .env, preserving every
// other line. Missing files are a no-op.
func stripGeminiEnvKeys(path string, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	drop := make(map[string]bool, len(keys))
	for _, key := range keys {
		drop[key] = true
	}
	lines := splitLines(string(raw))
	kept := lines[:0]
	for _, line := range lines {
		if key, ok := envLineKey(line); ok && drop[key] {
			continue
		}
		kept = append(kept, line)
	}
	return atomicfile.Write(path, []byte(strings.TrimRight(joinLines(kept), "\n")+"\n"), 0o600)
}

func geminiSettingsPathFromEnv(envPath string) string {
	return filepath.Join(filepath.Dir(envPath), "settings.json")
}

// geminiClientManagedEnvKeys returns the keys the client adapter recorded as
// AnyPick-managed, or nil when no marker exists.
func geminiClientManagedEnvKeys(settingsPath string) []string {
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil
	}
	var doc struct {
		Managed struct {
			Keys []string `json:"keys"`
		} `json:"_anypickManaged"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	return doc.Managed.Keys
}

// clearGeminiClientManagedMarker drops the client's marker after Restore has
// reconciled .env: without it the client's RestoreNative would strip the
// account key this restore just wrote (both list GEMINI_API_KEY).
func clearGeminiClientManagedMarker(settingsPath string) {
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		return
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return
	}
	if _, ok := doc[geminiClientManagedKey]; !ok {
		return
	}
	delete(doc, geminiClientManagedKey)
	out, err := json.MarshalIndent(map[string]json.RawMessage(doc), "", "  ")
	if err != nil {
		return
	}
	_ = atomicfile.Write(settingsPath, append(out, '\n'), 0o600)
}

func (p *gemini) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	info := SnapshotInfo{}
	for _, name := range geminiSnapshotFiles {
		if _, err := os.Stat(filepath.Join(srcDir, name)); err == nil {
			info.CredentialKind = "native"
			break
		}
	}
	for _, name := range geminiAllCredentialFiles() {
		raw, err := os.ReadFile(filepath.Join(srcDir, name))
		if err != nil {
			continue
		}
		if email := geminiEmailFromCredentials(raw); email != "" {
			info.Identity = email
			break
		}
	}
	if info.Identity == "" {
		if raw, err := os.ReadFile(filepath.Join(srcDir, "google_accounts.json")); err == nil {
			var accounts []struct {
				Email string `json:"email"`
			}
			if json.Unmarshal(raw, &accounts) == nil && len(accounts) > 0 &&
				strings.Contains(accounts[0].Email, "@") {
				info.Identity = accounts[0].Email
			}
		}
	}
	return info, nil
}

func (gemini *gemini) ShortName() string { return "Gemini" }

// GatewayInfo makes Gemini's gateway eligibility and endpoint metadata
// provider-owned. The desktop host should not branch on the provider id.
func (p *gemini) GatewayInfo() GatewayInfo {
	return GatewayInfo{
		ProvidesEndpoint:    true,
		RequiresAPIKey:      true,
		DefaultEndpoint:     "https://generativelanguage.googleapis.com/v1beta",
		FirstPartyClientIDs: []string{"gemini"},
		Kind:                "hosted",
	}
}

// ResolveUpstream points the engine's shared proxy at Google Gemini: API-key
// or OAuth/Code Assist, both translated through serveGemini
// (OpenAI/Anthropic/Responses → generateContent → back).
func (p *gemini) ResolveUpstream(snapshotDir string) (*proxy.Upstream, error) {
	return geminiUpstream(snapshotDir)
}

// GatewayUpstreamWithKey resolves the upstream for a Gemini gateway from a
// profile API key held in memory.
//
// A gateway has no account snapshot: the credential lives in the profile store,
// which owns it (invariant #6). It must therefore never be copied into a
// snapshot .env. ResolveUpstream runs once per request, so writing it to disk
// there is not just a redundant copy — it races any concurrent `anypick backup`
// with a half-written file, and a stale copy keeps resolving after the profile
// key is rotated or deleted (invariant #4). Passing the key through memory
// removes the write entirely.
func (p *gemini) GatewayUpstreamWithKey(apiKey string) (*proxy.Upstream, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, anyerr.Newf("No Gemini API key in this gateway profile.", "NO_CREDENTIAL")
	}
	return geminiKeyUpstream(apiKey)
}
