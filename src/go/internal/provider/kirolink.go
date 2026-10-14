package provider

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/outof0/anypick/go/internal/browserlogin"
)

// discoverKiroProxyCommand mirrors resolveKiroProxyCommand: classification and
// the launcher share ONE resolver so the gate and the spawn can never disagree
// on a binary name or env override.
func discoverKiroProxyCommand() string {
	if bin := os.Getenv("KIROLINK_BIN"); bin != "" {
		if resolved := browserlogin.ResolveBinary([]string{bin}, nil); resolved != "" {
			return resolved
		}
	}
	// KIROLINK_JS points at a node entry; a node runtime plus that file counts
	// as an available bridge for classification purposes.
	if js := os.Getenv("KIROLINK_JS"); js != "" && isExecutableFile(js) {
		return js
	}

	names := []string{"kirolink", "kiro-proxy", "kiro-link"}
	var candidates []string
	for _, dir := range PATHDirectories() {
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			if runtime.GOOS == "windows" {
				candidate += ".exe"
			}
			candidates = append(candidates, candidate)
		}
	}
	return browserlogin.ResolveBinary(names, candidates)
}

func PATHDirectories() []string {
	var out []string
	if path := os.Getenv("PATH"); path != "" {
		out = append(out, strings.Split(path, string(os.PathListSeparator))...)
	}
	home, _ := os.UserHomeDir()
	out = append(out,
		filepath.Join(home, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	)
	return out
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		ext := strings.ToLower(filepath.Ext(path))
		return ext == ".exe" || ext == ".com" || ext == ".js"
	}
	return info.Mode().Perm()&0o111 != 0
}
