package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/update"
)

// The macOS Updates pane decodes these lines; pin the contract it relies on.
func TestUpdateCheckJSONFixtureLines(t *testing.T) {
	isolateEnv(t)
	t.Setenv("ANYPICK_UPDATE_TESTING", "1")
	for _, name := range update.FixtureNames() {
		t.Setenv("ANYPICK_UPDATE_FIXTURE", name)
		restore := resetGlobals()
		out := captureStdout(t, func() { run([]string{"update", "check", "--json", "--current", "1.1.0"}) })
		restore()
		lines := strings.Split(strings.TrimSpace(out), "\n")
		var d update.StatusDTO
		if err := json.Unmarshal([]byte(lines[len(lines)-1]), &d); err != nil {
			t.Fatalf("%s: %v in %q", name, err, out)
		}
		if d.Kind != name || d.Current != "1.1.0" || d.Schema != update.StatusSchema {
			t.Errorf("%s: got %+v", name, d)
		}
	}
}

func TestUpdateCoreExitStatus(t *testing.T) {
	isolateEnv(t)
	t.Setenv("ANYPICK_UPDATE_TESTING", "1")
	for _, verb := range []string{"check", "download"} {
		for _, kind := range update.FixtureNames() {
			t.Run(verb+"/"+kind, func(t *testing.T) {
				t.Setenv("ANYPICK_UPDATE_FIXTURE", kind)
				restore := resetGlobals()
				defer restore()
				var code int
				out := captureStdout(t, func() { code = run([]string{"update", verb, "--json", "--current", "1.1.0"}) })
				var d update.StatusDTO
				if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &d); err != nil {
					t.Fatal(err)
				}
				want := int(anyerr.Operational)
				switch kind {
				case "upToDate", "availableDirect", "availablePackageManager", "ready":
					want = int(anyerr.Success)
				}
				if code != want || d.Kind != kind {
					t.Fatalf("exit=%d, kind=%q; want exit=%d, kind=%q", code, d.Kind, want, kind)
				}
			})
		}
	}
}

func TestUpdateCoreRejectsUnknownFlag(t *testing.T) {
	restore := resetGlobals()
	defer restore()
	if code := run([]string{"update", "check", "--bogus"}); code == 0 {
		t.Fatal("unknown flag accepted")
	}
}
