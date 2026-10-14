// Package plugins owns the persisted JavaScript plugin registry and its trust
// boundary. JavaScript execution lives in the isolated plugin host; this
// package only parses inert manifests, pins package bytes, and exposes verified
// candidates.
package plugins

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
)

const (
	// APIVersion is the plugin API generation understood by this build.
	APIVersion = 1
	// ManifestFile is the fixed manifest name at a plugin package root.
	ManifestFile = "anypick.plugin.json"
)

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)

// Manifest is the inert package metadata read from anypick.plugin.json.
type Manifest struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description,omitempty"`
	APIVersion  int    `json:"apiVersion"`
	Main        string `json:"main"`
}

func invalid(message string, suggestions ...string) error {
	opts := []anyerr.Option{anyerr.WithExitCode(anyerr.Operational)}
	if len(suggestions) > 0 {
		opts = append(opts, anyerr.WithSuggestions(suggestions...))
	}
	return anyerr.Newf(message, "PLUGIN_INVALID", opts...)
}

// ParseManifest parses and validates a plugin manifest. Unknown keys are
// ignored, while every executable identity field is validated before it can
// enter the registry.
func ParseManifest(raw []byte, source string) (Manifest, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return Manifest{}, invalid(source + " is not valid JSON.")
	}

	object, ok := value.(map[string]any)
	if !ok {
		// JSON.parse considers arrays objects, then rejects their absent name.
		// Preserve that observable result while giving scalars the not-an-object message.
		if _, array := value.([]any); array {
			return Manifest{}, invalidName(source)
		}
		return Manifest{}, invalid(source + " must contain a JSON object.")
	}

	name, ok := object["name"].(string)
	if !ok || !namePattern.MatchString(name) {
		return Manifest{}, invalidName(source)
	}
	version, ok := object["version"].(string)
	if !ok || version == "" {
		return Manifest{}, invalid(source + ` is missing a "version" string.`)
	}
	main, ok := object["main"].(string)
	if !ok || main == "" {
		return Manifest{}, invalid(source + ` is missing a "main" entry module path.`)
	}
	api, ok := object["apiVersion"].(float64)
	if !ok || api != float64(APIVersion) {
		got, exists := object["apiVersion"]
		if !exists {
			got = undefinedValue{}
		}
		return Manifest{}, invalid(
			fmt.Sprintf(
				"Plugin %s targets AnyPick plugin API %s; this build supports %d.",
				name, jsString(got), APIVersion,
			),
			fmt.Sprintf(
				"Update the plugin, or use a AnyPick release that supports API %s.",
				jsString(got),
			),
		)
	}

	description, _ := object["description"].(string)
	return Manifest{
		Name: name, Version: version, Description: description,
		APIVersion: APIVersion, Main: main,
	}, nil
}

func invalidName(source string) error {
	return invalid(
		source +
			` has an invalid "name". Use lowercase letters, digits, and hyphens (2-64 characters).`,
	)
}

type undefinedValue struct{}

func jsString(value any) string {
	switch v := value.(type) {
	case undefinedValue:
		return "undefined"
	case nil:
		return "null"
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(v)
	case []any:
		// String(array) delegates to Array#join: null/undefined elements are
		// empty, nested arrays recurse, and objects become [object Object].
		parts := make([]string, len(v))
		for i, item := range v {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(v)
	}
}

// jsNumberString covers the finite JSON-number subset of ECMAScript String.
// Go and JavaScript both use shortest-round-trip formatting, but JavaScript
// switches to exponent notation only below 1e-6 or at 1e21 and omits a leading
// zero in negative exponents.
func jsNumberString(value float64) string {
	if value == 0 {
		return "0" // JavaScript String(-0) is also "0".
	}
	abs := math.Abs(value)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	out := strconv.FormatFloat(value, 'e', -1, 64)
	out = strings.Replace(out, "e-0", "e-", 1)
	out = strings.Replace(out, "e+0", "e+", 1)
	return out
}

// ReadManifest reads and parses the fixed manifest at root.
func ReadManifest(root string) (Manifest, error) {
	path := filepath.Join(root, ManifestFile)
	raw, err := os.ReadFile(path)
	if err == nil {
		return ParseManifest(raw, path)
	}
	if os.IsNotExist(err) {
		return Manifest{}, invalid(
			fmt.Sprintf("No %s found in %s.", ManifestFile, root),
			fmt.Sprintf("A AnyPick plugin is a directory containing %s.", ManifestFile),
		)
	}
	return Manifest{}, anyerr.Wrapf(err, "read "+path, "PLUGIN_INVALID")
}

// ResolveEntry resolves main inside root without following symlinks. This is
// deliberately the same lexical containment boundary as Node's path.resolve /
// path.relative check; the package digest separately pins symlink targets.
func ResolveEntry(root, main string) (string, error) {
	slashMain := strings.ReplaceAll(main, `\`, "/")
	driveAbsolute := len(main) >= 3 && ((main[0] >= 'a' && main[0] <= 'z') ||
		(main[0] >= 'A' && main[0] <= 'Z')) && main[1] == ':' &&
		(main[2] == '/' || main[2] == '\\')
	if filepath.IsAbs(main) || path.IsAbs(slashMain) || strings.HasPrefix(main, `\\`) || driveAbsolute {
		return "", invalid(fmt.Sprintf(
			`Plugin entry %q must be a path relative to the plugin directory.`, main,
		))
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", invalid("Could not resolve plugin directory " + root + ".")
	}
	entry := filepath.Clean(filepath.Join(absRoot, main))
	rel, err := filepath.Rel(absRoot, entry)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", invalid(fmt.Sprintf(
			`Plugin entry %q resolves outside the plugin directory.`, main,
		))
	}
	return entry, nil
}
