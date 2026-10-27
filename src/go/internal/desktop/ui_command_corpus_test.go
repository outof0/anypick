package desktop

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// uiCommandEntry is one line of testdata/parity/ui-commands.json, which the
// Tauri UI writes from the same builders its panes call
// (src/tauri/ui/test/command-corpus.ts).
type uiCommandEntry struct {
	Case    string          `json:"case"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

// notSentByTauri names each mutation operation the Tauri UI has no control
// for, and why. An operation absent from both this map and the corpus fails
// the test: either the UI is missing a feature or the corpus is missing a case.
var notSentByTauri = map[string]string{
	"account-save-current": "macOS only (ProductionModel.swift); the Tauri sheet saves the live login through account-save",
	"account-import":       "no host sends it; single-account files were superseded by account-backup-import",
	"account-export":       "no host sends it; single-account files were superseded by account-backup-export",
}

func loadUICommands(t *testing.T) []uiCommandEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "parity", "ui-commands.json"))
	if err != nil {
		t.Fatal(err)
	}
	var entries []uiCommandEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	// An empty corpus would pass every check below for the wrong reason.
	if len(entries) < 50 {
		t.Fatalf("ui-commands.json has %d entries; expected the full UI corpus", len(entries))
	}
	return entries
}

// TestUICommandCorpusDecodes is the engine half of the UI → engine contract:
// every command the Tauri UI can build must pass DecodeLine, or the user gets
// "command frame was rejected" for a button that looks fine in every UI test.
// That is how Add Login's Detect shipped without the name account-detect
// requires.
func TestUICommandCorpusDecodes(t *testing.T) {
	for _, entry := range loadUICommands(t) {
		line := entry.Kind + "\t" + base64.StdEncoding.EncodeToString(entry.Payload)
		cmd, err := DecodeLine(line)
		if err != nil {
			t.Errorf("%s: engine rejects the UI's command: %v\n  %s", entry.Case, err, entry.Payload)
			continue
		}
		if cmd.Kind != entry.Kind {
			t.Errorf("%s: decoded as %q, want %q", entry.Case, cmd.Kind, entry.Kind)
		}
	}
}

func TestUICommandCorpusCoversEveryMutation(t *testing.T) {
	sent := map[string]bool{}
	for _, entry := range loadUICommands(t) {
		if entry.Kind != "mutate" {
			continue
		}
		var probe struct {
			Operation string `json:"operation"`
		}
		if err := json.Unmarshal(entry.Payload, &probe); err != nil {
			t.Fatalf("%s: %v", entry.Case, err)
		}
		sent[probe.Operation] = true
	}
	var missing []string
	for operation := range mutationOperations {
		_, exempt := notSentByTauri[operation]
		if sent[operation] && exempt {
			t.Errorf("%s is in the UI corpus and also listed as not sent by Tauri; drop the exemption", operation)
		}
		if !sent[operation] && !exempt {
			missing = append(missing, operation)
		}
	}
	sort.Strings(missing)
	for _, operation := range missing {
		t.Errorf("no UI corpus case sends %s; add one to command-corpus.ts or explain it in notSentByTauri", operation)
	}
	for operation := range notSentByTauri {
		if !mutationOperations[operation] {
			t.Errorf("notSentByTauri names %s, which the engine no longer accepts", operation)
		}
	}
}
