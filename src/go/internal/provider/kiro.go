package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/browserlogin"
	"github.com/outof0/anypick/go/internal/db"
	"github.com/outof0/anypick/go/internal/transport"
)

// kiro-cli 2.x keeps the login in the OS keychain, mirrored into an auth_kv
// table in its own SQLite database — and reads the keychain FIRST. Switching
// an account therefore has to write both tiers: restoring only the database
// would be silently ignored while a stale keychain item is still readable.
var kiroSecretKeys = []string{
	"kirocli:social:token",
	"kirocli:odic:token",
	"kirocli:odic:device-registration",
	"kirocli:external-idp:token",
}

const (
	kiroSecretsFile = "kiro-secret-store.json"
	kiroAPIKeyFile  = "kiro-api-key.json"

	kiroLoginMethodID = "builder-id"
)

type kiro struct {
	home           string
	findExecutable func() string // test seam; nil → live discovery
}

func newKiro(home string) *kiro { return &kiro{home: home} }

func (p *kiro) ID() string          { return "kiro" }
func (p *kiro) Name() string        { return "Kiro" }
func (p *kiro) Description() string { return "Manages kiro-cli secret store + ~/.aws/sso/cache" }

// CanProxy reports false for the builtin proxy: Kiro is served by the external
// kirolink bridge, so pools use managed_external_proxy.
func (p *kiro) CanProxy() bool { return false }

func (p *kiro) AccountAdapter(accountName string, _ bool) transport.Adapter {
	return transport.KiroAccountAdapter(p.ID(), accountName, p.proxyCommand)
}

// PoolAdapter is the external bridge, never builtin.
type poolAdapterProvider interface{ PoolAdapter() transport.Adapter }

func (p *kiro) PoolAdapter() transport.Adapter {
	return transport.PoolAdapterFor(p.ID(), transport.ProviderInfo{
		ID: p.ID(), CanProxy: true, HasAdapter: true,
	}, transport.ManagedExternalProxy)
}

func (p *kiro) proxyCommand() string {
	if p.findExecutable != nil {
		return p.findExecutable()
	}
	return discoverKiroProxyCommand()
}

func (p *kiro) loginCommand() browserlogin.Command {
	names := []string{"kiro-cli", "kiro"}
	if env := os.Getenv("KIRO_BINARY"); env != "" {
		names = []string{env, "kiro-cli", "kiro"}
	}
	return browserlogin.Command{
		Names: names,
		ExtraPaths: []string{
			filepath.Join(expandHome(p.home), ".local", "bin", "kiro-cli"),
			"/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
		},
		Args: []string{"login", "--license", "free"},
	}
}

func (p *kiro) LoginMethods() []LoginMethod {
	return []LoginMethod{
		browserlogin.Availability(LoginMethod{
			ID:          kiroLoginMethodID,
			Label:       "Builder ID or social login",
			Description: "Kiro browser sign-in",
			Provenance:  "official",
			Preferred:   true,
			Source:      "kiro",
		}, p.loginCommand()),
	}
}

func (p *kiro) Login(ctx context.Context, methodID, source string) error {
	if methodID != kiroLoginMethodID || (source != "" && source != "kiro") {
		return anyerr.Newf("Unknown Kiro sign-in method.", "PROVIDER_LOGIN_METHOD_UNKNOWN")
	}
	return browserlogin.Run(ctx, p.loginCommand(), expandHome(p.home))
}

func (p *kiro) secretDbPath() string {
	if env := os.Getenv("ANYPICK_KIRO_SECRET_DB"); env != "" {
		return expandHome(env)
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(expandHome(p.home), "Library", "Application Support",
			"kiro-cli", "data.sqlite3")
	default:
		xdg := os.Getenv("XDG_DATA_HOME")
		if xdg == "" {
			xdg = filepath.Join(expandHome(p.home), ".local", "share")
		}
		return filepath.Join(xdg, "kiro-cli", "data.sqlite3")
	}
}

func (p *kiro) cacheDir() string {
	if env := os.Getenv("KIRO_SSO_CACHE_DIR"); env != "" {
		return expandHome(env)
	}
	return filepath.Join(expandHome(p.home), ".aws", "sso", "cache")
}

func kiroKeychainEnabled() bool {
	return runtime.GOOS == "darwin" && os.Getenv("ANYPICK_KIRO_NO_KEYCHAIN") != "1"
}

func kiroKeychainRead(key string) string {
	out, err := runSecurity(fmt.Sprintf(
		"find-generic-password -s %s -a %s -w",
		quoteSecurity(key), quoteSecurity(currentUsername())))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func kiroKeychainReadAll() map[string]string {
	out := map[string]string{}
	for _, key := range kiroSecretKeys {
		if v := kiroKeychainRead(key); v != "" {
			out[key] = v
		}
	}
	return out
}

func kiroKeychainWrite(secrets map[string]string) error {
	for _, key := range kiroSecretKeys {
		value, present := secrets[key]
		if !present || value == "" {
			_, _ = runSecurity(fmt.Sprintf(
				"delete-generic-password -s %s -a %s",
				quoteSecurity(key), quoteSecurity(currentUsername())))
			continue
		}
		if err := writeGenericPassword(key, currentUsername(), value); err != nil {
			return err
		}
	}
	return nil
}

func readAuthKv(dbPath string) map[string]string {
	rows := map[string]string{}
	d, err := db.OpenForeign(dbPath, true)
	if err != nil {
		return rows // no kiro-cli database yet, or unreadable
	}
	defer d.Close()
	r, err := d.Query(`SELECT key, value FROM auth_kv`)
	if err != nil {
		return rows // older schema without auth_kv
	}
	defer r.Close()
	for r.Next() {
		var k, v string
		if r.Scan(&k, &v) == nil {
			rows[k] = v
		}
	}
	return rows
}

func writeAuthKv(dbPath string, secrets map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return err
	}
	d, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		return err
	}
	defer d.Close()
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS auth_kv (
	   key TEXT PRIMARY KEY NOT NULL,
	   value TEXT NOT NULL
	)`); err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	for _, key := range kiroSecretKeys {
		value, present := secrets[key]
		if !present || value == "" {
			if _, err := tx.Exec(`DELETE FROM auth_kv WHERE key = ?`, key); err != nil {
				_ = tx.Rollback()
				return err
			}
			continue
		}
		if _, err := tx.Exec(
			`INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)`,
			key, value); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (p *kiro) readSecrets() map[string]string {
	secrets := map[string]string{}
	if kiroKeychainEnabled() {
		for k, v := range kiroKeychainReadAll() {
			secrets[k] = v
		}
	}
	// Not an else: the keychain can hold a subset and kiro-cli falls back to
	// the database per key rather than per store.
	for k, v := range readAuthKv(p.secretDbPath()) {
		if _, ok := secrets[k]; !ok && v != "" {
			secrets[k] = v
		}
	}
	return secrets
}

func (p *kiro) writeSecrets(secrets map[string]string) error {
	if !kiroKeychainEnabled() {
		return writeAuthKv(p.secretDbPath(), secrets)
	}
	before := kiroKeychainReadAll()
	if err := kiroKeychainWrite(secrets); err != nil {
		_ = kiroKeychainWrite(before)
		return err
	}
	effective := kiroKeychainReadAll()
	if !sameStringMap(effective, secrets) {
		_ = kiroKeychainWrite(before)
		return anyerr.Newf(
			"Kiro Keychain did not retain the selected credentials.",
			"KIRO_KEYCHAIN_WRITE_FAILED")
	}
	return writeAuthKv(p.secretDbPath(), secrets)
}

type tokenFile struct {
	name string
	path string
	modT int64
}

func looksLikeToken(data map[string]json.RawMessage) bool {
	for _, key := range []string{"accessToken", "access_token"} {
		if v := stringField(data, key); v != "" {
			return true
		}
	}
	return false
}

func (p *kiro) liveTokenFiles() []tokenFile {
	entries, err := os.ReadDir(p.cacheDir())
	if err != nil {
		return nil
	}
	var found []tokenFile
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(p.cacheDir(), entry.Name()))
		if err != nil {
			continue
		}
		var data map[string]json.RawMessage
		if json.Unmarshal(raw, &data) != nil || !looksLikeToken(data) {
			continue
		}
		found = append(found, tokenFile{name: entry.Name(),
			path: filepath.Join(p.cacheDir(), entry.Name()), modT: info.ModTime().UnixNano()})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].modT > found[j].modT })
	return found
}

func kiroIdentity(secrets map[string]string) string {
	for _, key := range kiroSecretKeys {
		raw := secrets[key]
		if raw == "" {
			continue
		}
		var record struct {
			ProfileArn  string `json:"profile_arn"`
			ProfileArn2 string `json:"profileArn"`
			Provider    string `json:"provider"`
		}
		if json.Unmarshal([]byte(raw), &record) != nil {
			continue
		}
		arn := record.ProfileArn
		if arn == "" {
			arn = record.ProfileArn2
		}
		if arn == "" {
			continue
		}
		parts := strings.Split(arn, "/")
		profile := parts[len(parts)-1]
		if profile == "" {
			continue
		}
		if record.Provider != "" {
			return record.Provider + ":" + profile
		}
		return profile
	}
	return ""
}

func (p *kiro) DetectLive() (LiveAuthStatus, error) {
	secrets := p.readSecrets()
	files := p.liveTokenFiles()

	var where []string
	if len(secrets) > 0 {
		where = append(where, "kiro-cli secret store")
	}
	for _, f := range files {
		where = append(where, f.name)
	}
	if len(where) == 0 {
		return LiveAuthStatus{}, nil
	}
	identity := kiroIdentity(secrets)
	if identity == "" && len(files) > 0 {
		identity = identityFromTokenFile(files[0].path)
	}
	return LiveAuthStatus{Present: true, Identity: identity,
		Details: strings.Join(where, ", ")}, nil
}

func identityFromTokenFile(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var record struct {
		ProfileArn  string `json:"profile_arn"`
		ProfileArn2 string `json:"profileArn"`
		Provider    string `json:"provider"`
	}
	if json.Unmarshal(raw, &record) != nil {
		return ""
	}
	arn := record.ProfileArn
	if arn == "" {
		arn = record.ProfileArn2
	}
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, "/")
	profile := parts[len(parts)-1]
	if record.Provider != "" {
		return record.Provider + ":" + profile
	}
	return profile
}

func (p *kiro) Backup(destDir string) (SnapshotInfo, error) {
	secrets := p.readSecrets()
	saved := 0

	if len(secrets) > 0 {
		data, _ := json.MarshalIndent(secrets, "", "  ")
		if err := os.WriteFile(filepath.Join(destDir, kiroSecretsFile), data, 0o600); err != nil {
			return SnapshotInfo{}, err
		}
		saved++
	}
	for _, f := range p.liveTokenFiles() {
		data, err := os.ReadFile(f.path)
		if err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(destDir, f.name), data, 0o600); err != nil {
			return SnapshotInfo{}, err
		}
		saved++
	}
	if saved == 0 {
		return SnapshotInfo{}, anyerr.Newf(
			"No Kiro login found in the kiro-cli secret store or "+p.cacheDir()+
				". Run kiro-cli login first.",
			"NO_LIVE_AUTH")
	}
	return SnapshotInfo{Identity: kiroIdentity(secrets)}, nil
}

func (p *kiro) Restore(srcDir string) error {
	// Proxy-only API-key accounts hold nothing native; restoring them would
	// wipe a real login.
	if _, err := os.Stat(filepath.Join(srcDir, kiroAPIKeyFile)); err == nil {
		return nil
	}

	var secrets map[string]string
	if raw, err := os.ReadFile(filepath.Join(srcDir, kiroSecretsFile)); err == nil {
		if err := json.Unmarshal(raw, &secrets); err != nil {
			return fmt.Errorf("invalid %s in %s", kiroSecretsFile, srcDir)
		}
	}
	names, err := snapshotTokenFileNames(srcDir)
	if err != nil {
		return err
	}
	if secrets == nil && len(names) == 0 {
		return anyerr.Newf(
			"Kiro snapshot has no credentials in "+srcDir+".", "EMPTY_SNAPSHOT")
	}

	previous := p.readSecrets()
	if secrets == nil {
		secrets = map[string]string{}
	}
	if err := p.writeSecrets(secrets); err != nil {
		return err
	}
	if err := func() error {
		restoredSet := map[string]bool{}
		for _, name := range names {
			data, err := os.ReadFile(filepath.Join(srcDir, name))
			if err != nil {
				return err
			}
			dest := filepath.Join(p.cacheDir(), name)
			if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
				return err
			}
			// dest is a live SSO cache file (ADR 0004): rename, not truncate.
			if err := atomicfile.Write(dest, data, 0o600); err != nil {
				return err
			}
			restoredSet[name] = true
		}
		// Another account's cache file left in place would still be picked up
		// — remove what is not being restored rather than only overwriting.
		for _, f := range p.liveTokenFiles() {
			if !restoredSet[f.name] {
				_ = os.Remove(f.path)
			}
		}
		return nil
	}(); err != nil {
		// Compensation keeps a partial switch from silently persisting.
		_ = p.writeSecrets(previous)
		return err
	}
	return nil
}

func snapshotTokenFileNames(srcDir string) ([]string, error) {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || name == kiroSecretsFile || name == kiroAPIKeyFile ||
			!strings.HasSuffix(name, ".json") {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

// ClearLive forgets the local login without calling Kiro/AWS logout.
func (p *kiro) ClearLive() error {
	if err := p.writeSecrets(map[string]string{}); err != nil {
		return err
	}
	for _, f := range p.liveTokenFiles() {
		_ = os.Remove(f.path)
	}
	return nil
}

func (p *kiro) DescribeSnapshot(srcDir string) (SnapshotInfo, error) {
	raw, err := os.ReadFile(filepath.Join(srcDir, kiroSecretsFile))
	if err != nil {
		if os.IsNotExist(err) {
			return SnapshotInfo{}, nil
		}
		return SnapshotInfo{}, err
	}
	var secrets map[string]string
	if json.Unmarshal(raw, &secrets) != nil {
		return SnapshotInfo{}, nil
	}
	return SnapshotInfo{Identity: kiroIdentity(secrets)}, nil
}

// SnapshotMatchesLive compares stored secrets against the live two-tier store.
func (p *kiro) SnapshotMatchesLive(srcDir string) (bool, bool, error) {
	return p.SnapshotFilesMatchLive(snapshotFilesAt(srcDir))
}

func (p *kiro) SnapshotFilesMatchLive(file SnapshotFileReader) (bool, bool, error) {
	storedRaw, err := file(kiroSecretsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return false, false, nil // cache-file-only snapshots are heuristic
		}
		return false, false, err
	}
	var stored map[string]string
	if json.Unmarshal(storedRaw, &stored) != nil {
		return false, true, nil
	}
	live := p.readSecrets()
	if len(stored) == 0 {
		return len(live) == 0, true, nil
	}
	for key, want := range stored {
		if live[key] != want {
			return false, true, nil
		}
	}
	return true, true, nil
}

func sameStringMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func (kiro *kiro) ShortName() string { return "Kiro" }
