package update

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The macOS pane embeds each fixture line verbatim (UpdateStatusFixtures in
// src/macos/UpdatesPane.swift) so renders work without the helper. Fail when
// Go copy or fields change and the Swift copy was not regenerated.
func TestSwiftUpdateFixturesMatchGo(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "macos", "UpdatesPane.swift"))
	if err != nil {
		t.Skipf("macOS sources not present: %v", err)
	}
	swift := string(raw)
	for _, name := range FixtureNames() {
		var b strings.Builder
		r := &Runner{
			Checker:  &Checker{GOOS: "darwin"},
			Env:      MapEnv{EnvTesting: "1", EnvFixture: name},
			CacheDir: "/Users/qa/Library/Caches/AnyPick/update",
			Emit:     func(d StatusDTO) { _ = WriteStatusLine(&b, d) },
		}
		r.Check(context.Background(), "1.1.0", ChannelDirect)
		line := strings.TrimSuffix(b.String(), "\n")
		// The fixture models macOS output, so compare its Darwin path form even
		// when this test runs on Windows, where filepath.Join uses backslashes.
		var status StatusDTO
		if err := json.Unmarshal([]byte(line), &status); err != nil {
			t.Fatalf("decode Go fixture %q: %v", name, err)
		}
		status.FilePath = filepath.ToSlash(status.FilePath)
		b.Reset()
		if err := WriteStatusLine(&b, status); err != nil {
			t.Fatalf("encode normalized Go fixture %q: %v", name, err)
		}
		line = strings.TrimSuffix(b.String(), "\n")
		if !strings.Contains(swift, `"`+name+`": ###"`+line+`"###`) {
			t.Errorf("UpdatesPane.swift fixture %q drifted from Go; regenerate it.\nwant: %s", name, line)
		}
	}
}
