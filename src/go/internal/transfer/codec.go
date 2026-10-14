// Package transfer provides versioned import/export envelopes and
// multi-account backup packages.
//
// Imports arrive as untrusted bytes. The codec validates the ENTIRE payload —
// shape, provider ownership, every file key (traversal/absolute/separators/
// NUL/duplicates/file-vs-dir collisions), base64, count, per-file and total
// size — before any caller mutates state. Decoding never performs I/O
// (SEC-01).
package transfer

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/store"
)

// Envelope version/kind are fixed so artifacts on disk stay interchangeable.
const (
	EnvelopeVersion = 1
	EnvelopeKind    = "anypick-account"

	MaxImportFiles        = 4096
	MaxImportFileBytes    = 16 << 20
	MaxImportTotalBytes   = 128 << 20
	MaxImportEnvelopeSize = 192 << 20
	MaxAccountNameLen     = 128
	MaxFieldLen           = 4096
)

// DecodedEnvelope is the validated import payload.
type DecodedEnvelope struct {
	Version int
	Kind    string
	Meta    store.Meta
	Proxy   *store.ProxyConfig
	// Files maps validated relative keys to base64 content.
	Files map[string]string
}

func importFormat(format string, args ...interface{}) error {
	return anyerr.Newf(fmt.Sprintf(format, args...), "IMPORT_FORMAT",
		anyerr.WithExitCode(anyerr.ImportFormat), anyerr.WithMutated(false))
}

func importLimit(format string, args ...interface{}) error {
	return anyerr.Newf(fmt.Sprintf(format, args...), "IMPORT_LIMIT",
		anyerr.WithExitCode(anyerr.ImportLimit), anyerr.WithMutated(false))
}

// ValidateImportFileKey rejects empty/NUL/absolute/mixed-separator/traversal
// keys purely, before any staging root exists. Also called at write time as
// defense-in-depth.
func ValidateImportFileKey(key string) error {
	if key == "" || strings.ContainsRune(key, '\x00') {
		return importFormat("Invalid import file path: %q.", key)
	}
	// Import keys use slash-separated archive paths. path.IsAbs keeps this
	// validation platform-independent, while filepath.IsAbs also catches the
	// current host's native form.
	slashKey := strings.ReplaceAll(key, `\`, "/")
	if path.IsAbs(slashKey) || filepath.IsAbs(key) {
		return importFormat("Import file path must be relative: %s.", key)
	}
	// Windows-style absolute paths on every host; IsAbs only knows this platform.
	if driveAbs.MatchString(key) || strings.HasPrefix(key, `\\`) {
		return importFormat("Import file path must be relative: %s.", key)
	}
	if strings.Contains(key, `\`) && strings.Contains(key, "/") {
		return importFormat("Import file path mixes path separators: %s.", key)
	}
	normalized := normalizeKey(key)
	if normalized == "." || normalized == ".." ||
		strings.HasPrefix(normalized, "../") ||
		strings.Contains(normalized, "/../") ||
		strings.HasSuffix(normalized, "/..") {
		return importFormat("Import file path escapes the staging root: %s.", key)
	}
	return nil
}

var driveAbs = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// normalizeKey converts backslashes to slashes then cleans the result.
func normalizeKey(key string) string {
	slash := strings.ReplaceAll(key, `\`, "/")
	return filepath.ToSlash(filepath.Clean(slash))
}

// StagedFilePath resolves a validated relative key under stagingRoot,
// re-running the pure check so a bad key can never escape (SEC-01).
func StagedFilePath(stagingRoot, relKey string) (string, error) {
	if err := ValidateImportFileKey(relKey); err != nil {
		return "", err
	}
	clean := filepath.Join(stagingRoot, filepath.FromSlash(normalizeKey(relKey)))
	rootAbs, err := filepath.Abs(stagingRoot)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(clean)
	if err != nil {
		return "", err
	}
	rel, rerr := filepath.Rel(rootAbs, abs)
	if rerr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", importFormat("Import file path escapes the staging root: %s.", relKey)
	}
	return abs, nil
}

// DecodeEnvelope decodes + validates a raw JSON payload for expectedProvider.
func DecodeEnvelope(raw []byte, expectedProviderID string) (*DecodedEnvelope, error) {
	var obj struct {
		Kind    *string                    `json:"kind"`
		Version *int                       `json:"version"`
		Meta    json.RawMessage            `json:"meta"`
		Proxy   json.RawMessage            `json:"proxy"`
		Files   map[string]json.RawMessage `json:"files"`
	}
	var probe interface{}
	if json.Unmarshal(raw, &probe) != nil {
		return nil, importFormat("Import payload is not a JSON object.")
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, importFormat("Import payload is not a JSON object.")
	}
	if obj.Kind == nil || *obj.Kind != EnvelopeKind {
		return nil, importFormat("Unrecognized export format (kind mismatch).")
	}
	if obj.Version == nil || *obj.Version != EnvelopeVersion {
		v := "missing"
		if obj.Version != nil {
			v = fmt.Sprint(*obj.Version)
		}
		return nil, importFormat("Unsupported export version: %s.", v)
	}
	if len(obj.Meta) == 0 || string(obj.Meta) == "null" {
		return nil, importFormat("Import envelope is missing a meta object.")
	}

	meta, err := decodeMeta(obj.Meta)
	if err != nil {
		return nil, err
	}
	if meta.Provider != expectedProviderID {
		return nil, importFormat(
			"Import envelope provider %q does not match the requested provider %q.",
			meta.Provider, expectedProviderID)
	}

	env := &DecodedEnvelope{Version: EnvelopeVersion, Kind: EnvelopeKind, Meta: meta}
	if len(obj.Proxy) > 0 && string(obj.Proxy) != "null" {
		proxy, perr := decodeProxy(obj.Proxy)
		if perr != nil {
			return nil, perr
		}
		env.Proxy = proxy
	}

	files, ferr := decodeFiles(obj.Files)
	if ferr != nil {
		return nil, ferr
	}
	env.Files = files
	return env, nil
}

type rawMeta struct {
	Name            string `json:"name"`
	Provider        string `json:"provider"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	Label           string `json:"label"`
	Identity        string `json:"identity"`
	Notes           string `json:"notes"`
	CredentialKind  string `json:"credentialKind"`
	CredentialClass string `json:"credentialClass"`
}

func decodeMeta(raw json.RawMessage) (store.Meta, error) {
	var m rawMeta
	var probe interface{}
	if json.Unmarshal(raw, &probe) != nil || probe == nil {
		return store.Meta{}, importFormat("Account meta is not an object.")
	}
	if json.Unmarshal(raw, &m) != nil {
		return store.Meta{}, importFormat("Account meta is not an object.")
	}
	name, err := safeText(m.Name, MaxAccountNameLen, "name")
	if err != nil {
		return store.Meta{}, err
	}
	if name == "" {
		return store.Meta{}, importFormat("Account meta name is missing or too long.")
	}
	provider, err := safeText(m.Provider, MaxFieldLen, "provider")
	if err != nil {
		return store.Meta{}, err
	}
	if provider == "" {
		return store.Meta{}, importFormat("Account meta provider is missing.")
	}
	createdAt, err := safeText(m.CreatedAt, MaxFieldLen, "createdAt")
	if err != nil {
		return store.Meta{}, err
	}
	updatedAt, err := safeText(m.UpdatedAt, MaxFieldLen, "updatedAt")
	if err != nil {
		return store.Meta{}, err
	}
	label, err := optionalText(m.Label, MaxFieldLen, "label")
	if err != nil {
		return store.Meta{}, err
	}
	identity, err := optionalText(m.Identity, MaxFieldLen, "identity")
	if err != nil {
		return store.Meta{}, err
	}
	notes, err := optionalText(m.Notes, MaxFieldLen, "notes")
	if err != nil {
		return store.Meta{}, err
	}
	out := store.Meta{
		Name: name, Provider: provider,
		CreatedAt: orNow(createdAt), UpdatedAt: orNow(updatedAt),
		Label: label, Identity: identity, Notes: notes,
	}
	switch m.CredentialKind {
	case "proxy-only":
		out.CredentialKind = m.CredentialKind
	case "":
	default:
		// Losing credentialKind would turn a user-supplied credential back
		// into a native one; unknown values are dropped.
	}
	switch store.CredentialClass(m.CredentialClass) {
	case store.CredentialNativeSubscription, store.CredentialProviderAPIKey,
		store.CredentialCodingPlanKey, store.CredentialExternalOAuth, store.CredentialProxyOnly:
		out.CredentialClass = store.CredentialClass(m.CredentialClass)
	}
	return out, nil
}

// safeText rejects terminal control/bidi characters in imported metadata.
func safeText(value string, maxLength int, field string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len([]rune(value)) > maxLength {
		return "", nil
	}
	for _, r := range value {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
			return "", importFormat(
				"Import meta field %q contains terminal control characters.", field)
		}
	}
	return value, nil
}

func optionalText(value string, maxLength int, field string) (string, error) {
	if value == "" {
		return "", nil
	}
	return safeText(value, maxLength, field)
}

func orNow(v string) string {
	if v != "" {
		return v
	}
	return nowISO()
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func decodeProxy(raw json.RawMessage) (*store.ProxyConfig, error) {
	var p struct {
		Port *int   `json:"port"`
		Host string `json:"host"`
	}
	var probe interface{}
	if json.Unmarshal(raw, &probe) != nil || probe == nil {
		return nil, importFormat("Account proxy config is not an object.")
	}
	if json.Unmarshal(raw, &p) != nil {
		return nil, importFormat("Account proxy config is not an object.")
	}
	// An imported envelope is untrusted: activation state and provider-specific
	// options are dropped; proxies stay disabled until explicitly enabled.
	cfg := &store.ProxyConfig{Enabled: false}
	if p.Port != nil && *p.Port >= 0 && *p.Port <= 65535 {
		cfg.Port = *p.Port
	}
	host, err := safeText(p.Host, MaxFieldLen, "proxy.host")
	if err != nil {
		return nil, err
	}
	cfg.Host = host
	return cfg, nil
}

func decodeFiles(files map[string]json.RawMessage) (map[string]string, error) {
	if len(files) == 0 {
		return nil, importFormat("Import envelope contains no files.")
	}
	if len(files) > MaxImportFiles {
		return nil, importLimit("Import contains %d files (max %d).", len(files), MaxImportFiles)
	}
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sortStrings(keys)

	out := make(map[string]string, len(files))
	var seen []string
	total := 0
	for _, key := range keys {
		if key == "" {
			return nil, importFormat("Import file map contains an invalid key.")
		}
		if err := ValidateImportFileKey(key); err != nil {
			return nil, err
		}
		var content string
		if json.Unmarshal(files[key], &content) != nil {
			return nil, importFormat("Import file %q content is not a base64 string.", key)
		}
		if !base64Pattern.MatchString(content) {
			return nil, importFormat("Import file %q is not valid base64.", key)
		}
		decoded, derr := base64.StdEncoding.DecodeString(content)
		if derr != nil {
			return nil, importFormat("Import file %q failed to decode as base64.", key)
		}
		if len(decoded) > MaxImportFileBytes {
			return nil, importLimit("Import file %q exceeds %d bytes.", key, MaxImportFileBytes)
		}
		total += len(decoded)
		if total > MaxImportTotalBytes {
			return nil, importLimit("Import total payload exceeds %d bytes.", MaxImportTotalBytes)
		}
		norm := normalizeKey(key)
		for _, existing := range seen {
			if existing == norm ||
				strings.HasPrefix(norm, existing+"/") || strings.HasPrefix(existing, norm+"/") {
				return nil, importFormat("Import file path collides with another entry: %s.", key)
			}
		}
		seen = append(seen, norm)
		out[key] = content
	}
	return out, nil
}

var base64Pattern = regexp.MustCompile(`^[A-Za-z0-9+/=]+$`)

func sortStrings(in []string) {
	for i := 1; i < len(in); i++ {
		for j := i; j > 0 && in[j] < in[j-1]; j-- {
			in[j], in[j-1] = in[j-1], in[j]
		}
	}
}
