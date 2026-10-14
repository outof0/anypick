package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeFileInfo struct{ name string }

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() os.FileMode  { return 0o755 }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return true }
func (f fakeFileInfo) Sys() any           { return nil }

type memFS struct {
	dirs    map[string]bool
	env     MapEnv
	look    map[string]string
	outputs map[string]string // "cmd\x00arg..." → stdout
	errOut  map[string]error
}

func (m *memFS) Stat(name string) (os.FileInfo, error) {
	if m.dirs[filepath.Clean(name)] || m.dirs[name] {
		return fakeFileInfo{name: filepath.Base(name)}, nil
	}
	return nil, os.ErrNotExist
}
func (m *memFS) EvalSymlinks(path string) (string, error) { return path, nil }
func (m *memFS) Getenv(key string) string                 { return m.env.Getenv(key) }
func (m *memFS) LookPath(file string) (string, error) {
	if p, ok := m.look[file]; ok {
		return p, nil
	}
	return "", fmt.Errorf("not found")
}
func (m *memFS) Output(name string, args ...string) ([]byte, error) {
	key := name + "\x00" + strings.Join(args, "\x00")
	if err, ok := m.errOut[key]; ok {
		return nil, err
	}
	if out, ok := m.outputs[key]; ok {
		return []byte(out), nil
	}
	return nil, fmt.Errorf("exit 1")
}

func TestDetectChannelBrewCaskroom(t *testing.T) {
	fs := &memFS{
		dirs: map[string]bool{"/opt/homebrew/Caskroom/anypick": true},
		env:  MapEnv{},
	}
	ch := DetectChannel(DetectOpts{
		Exe:  "/Applications/AnyPick.app/Contents/MacOS/AnyPick",
		GOOS: "darwin", FS: fs, Env: MapEnv{},
	})
	if ch != ChannelBrew {
		t.Fatalf("got %q", ch)
	}
}

func TestDetectChannelBrewByPath(t *testing.T) {
	fs := &memFS{dirs: map[string]bool{}, env: MapEnv{}}
	ch := DetectChannel(DetectOpts{
		Exe:  "/usr/local/Caskroom/anypick/1.1.0/AnyPick.app/Contents/MacOS/AnyPick",
		GOOS: "darwin", FS: fs, Env: MapEnv{},
	})
	if ch != ChannelBrew {
		t.Fatalf("got %q", ch)
	}
}

func TestDetectChannelDarwinDirect(t *testing.T) {
	fs := &memFS{dirs: map[string]bool{}, env: MapEnv{}}
	ch := DetectChannel(DetectOpts{
		Exe:  "/Applications/AnyPick.app/Contents/MacOS/AnyPick",
		GOOS: "darwin", FS: fs, Env: MapEnv{},
	})
	if ch != ChannelDirect {
		t.Fatalf("got %q", ch)
	}
}

func TestDetectChannelLinux(t *testing.T) {
	t.Run("appimage", func(t *testing.T) {
		env := MapEnv{"APPIMAGE": "/tmp/AnyPick.AppImage"}
		fs := &memFS{env: env}
		ch := DetectChannel(DetectOpts{Exe: "/tmp/AnyPick.AppImage", GOOS: "linux", FS: fs, Env: env})
		if ch != ChannelAppImage {
			t.Fatalf("got %q", ch)
		}
	})
	t.Run("deb", func(t *testing.T) {
		fs := &memFS{
			env:     MapEnv{},
			look:    map[string]string{"dpkg": "/usr/bin/dpkg"},
			outputs: map[string]string{"dpkg\x00-S\x00/usr/bin/anypick": "anypick: /usr/bin/anypick"},
		}
		ch := DetectChannel(DetectOpts{Exe: "/usr/bin/anypick", GOOS: "linux", FS: fs, Env: MapEnv{}})
		if ch != ChannelDeb {
			t.Fatalf("got %q", ch)
		}
	})
	t.Run("rpm", func(t *testing.T) {
		fs := &memFS{
			env:     MapEnv{},
			look:    map[string]string{"rpm": "/usr/bin/rpm"},
			outputs: map[string]string{"rpm\x00-qf\x00/usr/bin/anypick": "anypick-1.1.0"},
			errOut:  map[string]error{"dpkg\x00-S\x00/usr/bin/anypick": fmt.Errorf("no dpkg")},
		}
		ch := DetectChannel(DetectOpts{Exe: "/usr/bin/anypick", GOOS: "linux", FS: fs, Env: MapEnv{}})
		if ch != ChannelRPM {
			t.Fatalf("got %q", ch)
		}
	})
}

func TestDetectChannelWindows(t *testing.T) {
	t.Run("scoop", func(t *testing.T) {
		env := MapEnv{"USERPROFILE": `C:\Users\dev`}
		fs := &memFS{env: env}
		ch := DetectChannel(DetectOpts{
			Exe:  `C:\Users\dev\scoop\apps\anypick\current\anypick.exe`,
			GOOS: "windows", FS: fs, Env: env, HomeDir: `C:\Users\dev`,
		})
		if ch != ChannelScoop {
			t.Fatalf("got %q", ch)
		}
	})
	t.Run("nsis", func(t *testing.T) {
		env := MapEnv{"LOCALAPPDATA": `C:\Users\dev\AppData\Local`}
		fs := &memFS{env: env}
		ch := DetectChannel(DetectOpts{
			Exe:  `C:\Users\dev\AppData\Local\AnyPick\AnyPick.exe`,
			GOOS: "windows", FS: fs, Env: env,
		})
		if ch != ChannelNSIS {
			t.Fatalf("got %q", ch)
		}
	})
	t.Run("msi", func(t *testing.T) {
		env := MapEnv{"ProgramFiles": `C:\Program Files`}
		fs := &memFS{env: env}
		ch := DetectChannel(DetectOpts{
			Exe:  `C:\Program Files\AnyPick\AnyPick.exe`,
			GOOS: "windows", FS: fs, Env: env,
		})
		if ch != ChannelMSI {
			t.Fatalf("got %q", ch)
		}
	})
}

func TestDetectChannelNPM(t *testing.T) {
	fs := &memFS{dirs: map[string]bool{}, env: MapEnv{}}
	ch := DetectChannel(DetectOpts{
		Exe:  "/usr/local/lib/node_modules/anypick/bin/anypick",
		GOOS: "linux", FS: fs, Env: MapEnv{},
	})
	if ch != ChannelNPM {
		t.Fatalf("got %q", ch)
	}
}

func TestDetectChannelHookOverride(t *testing.T) {
	env := MapEnv{EnvTesting: "1", EnvChannel: "deb"}
	fs := &memFS{dirs: map[string]bool{"/opt/homebrew/Caskroom/anypick": true}, env: env}
	ch := DetectChannel(DetectOpts{
		Exe:  "/Applications/AnyPick.app/Contents/MacOS/AnyPick",
		GOOS: "darwin", FS: fs, Env: env,
	})
	if ch != ChannelDeb {
		t.Fatalf("hook should win, got %q", ch)
	}
}

func TestDetectChannelWinget(t *testing.T) {
	env := MapEnv{"LOCALAPPDATA": `C:\Users\dev\AppData\Local`}
	fs := &memFS{env: env}
	ch := DetectChannel(DetectOpts{
		Exe:  `C:\Users\dev\AppData\Local\Microsoft\WinGet\Packages\AnyPick\AnyPick.exe`,
		GOOS: "windows", FS: fs, Env: env,
	})
	if ch != ChannelWinget {
		t.Fatalf("got %q", ch)
	}
}

func TestIsCLIOnly(t *testing.T) {
	if !IsCLIOnly(ChannelScoop) || !IsCLIOnly(ChannelNPM) {
		t.Fatal("scoop and npm must be CLI-only")
	}
	for _, ch := range []InstallChannel{
		ChannelDirect, ChannelBrew, ChannelNSIS, ChannelMSI, ChannelWinget,
		ChannelDeb, ChannelRPM, ChannelAppImage, ChannelUnknown,
	} {
		if IsCLIOnly(ch) {
			t.Fatalf("%s must not be CLI-only", ch)
		}
	}
}
