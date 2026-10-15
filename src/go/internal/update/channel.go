package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// FS abstracts filesystem probes used by channel detection.
type FS interface {
	Stat(name string) (os.FileInfo, error)
	EvalSymlinks(path string) (string, error)
	Getenv(key string) string
	LookPath(file string) (string, error)
	Output(name string, args ...string) ([]byte, error)
}

// RealFS uses the real OS.
type RealFS struct {
	Env Env
}

func (f RealFS) env() Env {
	if f.Env != nil {
		return f.Env
	}
	return OSEnv{}
}
func (f RealFS) Stat(name string) (os.FileInfo, error) { return os.Stat(name) }
func (f RealFS) EvalSymlinks(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
func (f RealFS) Getenv(key string) string             { return f.env().Getenv(key) }
func (f RealFS) LookPath(file string) (string, error) { return exec.LookPath(file) }
func (f RealFS) Output(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).Output()
}

// DetectOpts controls channel detection.
type DetectOpts struct {
	Exe     string // absolute path of the running executable
	GOOS    string // override runtime.GOOS in tests
	GOARCH  string // override runtime.GOARCH in tests
	FS      FS
	Env     Env
	HomeDir string // override $HOME / USERPROFILE
}

// DetectChannel decides how the binary was installed. First match wins.
// A testing-hook channel override wins over all probes when the gate is open.
//
// Windows heuristics (documented):
//   - Path under scoop apps dirs → scoop (CLI only).
//   - Path under %LOCALAPPDATA%\AnyPick (typical NSIS per-user) → nsis.
//   - Path under Program Files \AnyPick or containing winget\packages → winget/msi.
//   - Otherwise on windows → nsis (self-update default for desktop) when the
//     path looks like a desktop install; else unknown.
//
// macOS: Caskroom/anypick presence (or resolved path under it) → brew; else direct.
// Linux: $APPIMAGE → appimage; dpkg -S → deb; rpm -qf → rpm; else unknown.
// npm: path under npm global prefix or containing node_modules/anypick → npm.
func DetectChannel(opts DetectOpts) InstallChannel {
	env := opts.Env
	if env == nil {
		env = OSEnv{}
	}
	if ch, ok := HookChannel(env); ok {
		return ch
	}
	fs := opts.FS
	if fs == nil {
		fs = RealFS{Env: env}
	}
	goos := opts.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	exe := opts.Exe
	if exe == "" {
		if self, err := os.Executable(); err == nil {
			exe = self
		}
	}
	resolved := exe
	if exe != "" {
		if r, err := fs.EvalSymlinks(exe); err == nil {
			resolved = r
		}
	}
	resolvedLower := slashLower(resolved)

	// npm (CLI only) — checked early because a global npm bin can sit on any OS.
	if isNPM(fs, resolvedLower) {
		return ChannelNPM
	}

	switch goos {
	case "darwin":
		return detectDarwin(fs, resolved, resolvedLower)
	case "windows":
		return detectWindows(fs, env, opts.HomeDir, resolved, resolvedLower)
	case "linux":
		return detectLinux(fs, env, resolved)
	default:
		return ChannelUnknown
	}
}

func detectDarwin(fs FS, resolved, resolvedLower string) InstallChannel {
	caskrooms := []string{
		"/opt/homebrew/Caskroom/anypick",
		"/usr/local/Caskroom/anypick",
	}
	for _, dir := range caskrooms {
		if _, err := fs.Stat(dir); err == nil {
			// Cask moves the app into /Applications; path alone is insufficient,
			// so presence of the Caskroom tree counts as brew.
			return ChannelBrew
		}
	}
	for _, prefix := range []string{
		"/opt/homebrew/Caskroom/anypick/",
		"/usr/local/Caskroom/anypick/",
	} {
		if strings.Contains(resolvedLower, slashLower(prefix)) {
			return ChannelBrew
		}
	}
	_ = resolved
	return ChannelDirect
}

func detectWindows(fs FS, env Env, home, resolved, resolvedLower string) InstallChannel {
	if home == "" {
		home = env.Getenv("USERPROFILE")
		if home == "" {
			home = env.Getenv("HOME")
		}
	}
	scoopDirs := []string{}
	if home != "" {
		scoopDirs = append(scoopDirs, filepath.Join(home, "scoop", "apps"))
	}
	if s := env.Getenv("SCOOP"); s != "" {
		scoopDirs = append(scoopDirs, filepath.Join(s, "apps"))
	}
	if s := env.Getenv("SCOOP_GLOBAL"); s != "" {
		scoopDirs = append(scoopDirs, filepath.Join(s, "apps"))
	}
	for _, dir := range scoopDirs {
		prefix := slashLower(dir)
		if prefix != "" && strings.Contains(resolvedLower, prefix) {
			return ChannelScoop
		}
	}

	localApp := env.Getenv("LOCALAPPDATA")
	if localApp != "" {
		nsisPrefix := slashLower(filepath.Join(localApp, "AnyPick"))
		if strings.HasPrefix(resolvedLower, nsisPrefix) {
			return ChannelNSIS
		}
	}
	// winget Links / packages tree.
	if strings.Contains(resolvedLower, "/winget/") || strings.Contains(resolvedLower, "/microsoft/winget/") {
		return ChannelWinget
	}
	progFiles := []string{env.Getenv("ProgramFiles"), env.Getenv("ProgramFiles(x86)")}
	for _, pf := range progFiles {
		if pf == "" {
			continue
		}
		prefix := slashLower(filepath.Join(pf, "AnyPick"))
		if strings.HasPrefix(resolvedLower, prefix) {
			// MSI / WiX typically lands under Program Files.
			return ChannelMSI
		}
	}
	// Desktop-looking path without a stronger signal: prefer NSIS self-update.
	if strings.Contains(resolvedLower, "anypick") {
		return ChannelNSIS
	}
	_ = fs
	_ = resolved
	return ChannelUnknown
}

func detectLinux(fs FS, env Env, resolved string) InstallChannel {
	if env.Getenv("APPIMAGE") != "" {
		return ChannelAppImage
	}
	if resolved != "" {
		if _, err := fs.LookPath("dpkg"); err == nil {
			if _, err := fs.Output("dpkg", "-S", resolved); err == nil {
				return ChannelDeb
			}
		}
		if _, err := fs.LookPath("rpm"); err == nil {
			if _, err := fs.Output("rpm", "-qf", resolved); err == nil {
				return ChannelRPM
			}
		}
	}
	return ChannelUnknown
}

func isNPM(fs FS, resolvedLower string) bool {
	if strings.Contains(resolvedLower, "/node_modules/anypick") ||
		strings.Contains(resolvedLower, `/node_modules\anypick`) ||
		strings.Contains(resolvedLower, "/node_modules/anypick/") {
		return true
	}
	// npm prefix -g
	if _, err := fs.LookPath("npm"); err == nil {
		out, err := fs.Output("npm", "prefix", "-g")
		if err == nil {
			prefix := slashLower(strings.TrimSpace(string(out)))
			if prefix != "" && strings.HasPrefix(resolvedLower, prefix) {
				return true
			}
		}
	}
	return false
}

// IsCLIOnly reports channels that never show a desktop Updates row.
func IsCLIOnly(ch InstallChannel) bool {
	return ch == ChannelScoop || ch == ChannelNPM
}

// IsSelfUpdate reports channels that can download+replace in place.
func IsSelfUpdate(ch InstallChannel) bool {
	switch ch {
	case ChannelDirect, ChannelNSIS, ChannelAppImage:
		return true
	default:
		return false
	}
}

// IsPackageManager reports channels whose UI shows a command / download, not Update Now.
func IsPackageManager(ch InstallChannel) bool {
	switch ch {
	case ChannelBrew, ChannelScoop, ChannelNPM, ChannelDeb, ChannelRPM, ChannelMSI, ChannelWinget:
		return true
	default:
		return false
	}
}

// slashLower lowercases and forces forward slashes so Windows paths compare
// correctly even when this package's tests run on Unix (filepath.ToSlash is a
// no-op there and Join mixes separators).
func slashLower(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	return strings.ToLower(p)
}
