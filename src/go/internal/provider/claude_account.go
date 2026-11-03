package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/outof0/anypick/go/internal/atomicfile"
)

// claudeAccountKey is Claude Code's record of who is signed in: email,
// organization, plan and rate-limit tier. It lives in ~/.claude.json, not in
// the credential, so a switch that left it in place ran the new login under the
// previous account's record. Claude Code 2.1.302 re-fetches it at startup when
// claudeFetchedAtKey is missing or more than a day old, provided the credential
// has the profile scope. A switch therefore drops that one field rather than
// the record: nothing in the credential says which account a record belongs to,
// so AnyPick cannot carry the right one, and a running Claude Code reads a
// missing record as damage to its file, then refuses to save or writes its
// cached copy back.
const (
	claudeAccountKey   = "oauthAccount"
	claudeFetchedAtKey = "profileFetchedAt"
)

const (
	// claudeConfigAttempts bounds the retries when Claude Code writes the file
	// while AnyPick is rewriting it.
	claudeConfigAttempts = 3
	// claudeConfigLockWait is how long AnyPick waits for Claude Code's lock
	// before it leaves the record alone.
	claudeConfigLockWait = time.Second
)

// configPath is the default location only. Claude Code reads
// $CLAUDE_CONFIG_DIR/.claude.json, or a legacy ~/.claude/.config.json, instead
// when they apply; there this marks a file it does not use, as the credential
// path ignores them too.
func (p *claude) configPath() string {
	return filepath.Join(expandHome(p.home), ".claude.json")
}

// markAccountRecordStale makes Claude Code fetch the new account's record at
// its next start. It is best effort and never fails a switch: the credential,
// which is what authenticates, is already written. Everything else in the file
// belongs to Claude Code (projects, history, settings), so the other keys keep
// their order and values, and a file AnyPick cannot read as JSON is left as it
// is. The write takes Claude Code's own lock, ~/.claude.json.lock, which it
// creates as a directory (proper-lockfile).
func (p *claude) markAccountRecordStale() {
	path := p.configPath()
	release, ok := acquireClaudeConfigLock(path + ".lock")
	if !ok {
		return
	}
	defer release()
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		// Renaming over a dotfile manager's symlink would replace the link.
		path = resolved
	}
	for attempt := 0; attempt < claudeConfigAttempts; attempt++ {
		if done := markAccountRecordStaleOnce(path); done {
			return
		}
	}
}

// acquireClaudeConfigLock takes the lock directory, waiting for a holder. A
// lock it cannot take in time is never broken: Claude Code may be mid-write.
func acquireClaudeConfigLock(lock string) (func(), bool) {
	deadline := time.Now().Add(claudeConfigLockWait)
	for {
		err := os.Mkdir(lock, 0o700)
		if err == nil {
			return func() { _ = os.Remove(lock) }, true
		}
		if errors.Is(err, os.ErrNotExist) {
			// No home directory to lock in: there is no config either.
			return nil, false
		}
		if !errors.Is(err, os.ErrExist) || time.Now().After(deadline) {
			return nil, false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// markAccountRecordStaleOnce reports false when the file changed under it,
// which would otherwise discard what a writer outside the lock just wrote.
func markAccountRecordStaleOnce(path string) bool {
	before, err := os.Stat(path)
	if err != nil {
		return true
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return true
	}
	fields, err := decodeOrderedObject(raw)
	if err != nil {
		return true
	}
	changed := false
	for i, f := range fields {
		if f.key != claudeAccountKey {
			continue
		}
		record, err := decodeOrderedObject(f.value)
		if err != nil {
			return true
		}
		kept := make([]orderedField, 0, len(record))
		for _, r := range record {
			if r.key != claudeFetchedAtKey {
				kept = append(kept, r)
			}
		}
		if len(kept) == len(record) {
			return true
		}
		value, err := encodeClaudeConfig(kept)
		if err != nil {
			return true
		}
		fields[i].value = value
		changed = true
	}
	if !changed {
		return true
	}
	data, err := encodeClaudeConfig(fields)
	if err != nil {
		return true
	}
	if beforeWriteHook != nil {
		beforeWriteHook()
	}
	if now, err := os.Stat(path); err != nil || !now.ModTime().Equal(before.ModTime()) || now.Size() != before.Size() {
		return false
	}
	// The user's live config: replace by rename, never truncate (ADR 0004).
	_ = atomicfile.Write(path, data, before.Mode().Perm())
	return true
}

// beforeWriteHook lets a test write the file between the read and the rename.
var beforeWriteHook func()

type orderedField struct {
	key   string
	value json.RawMessage
}

// decodeOrderedObject reads a top-level JSON object keeping its key order,
// which a Go map would lose.
func decodeOrderedObject(raw []byte) ([]orderedField, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("not a JSON object")
	}
	var fields []orderedField
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errors.New("not a JSON object")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		fields = append(fields, orderedField{key: key, value: value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON object")
	}
	return fields, nil
}

// encodeClaudeConfig writes the shape Claude Code writes itself,
// JSON.stringify(config, null, 2) with no trailing newline, so a switch shows
// up in a file Claude Code wrote as the one field it removed. A file in another
// layout is re-indented.
func encodeClaudeConfig(fields []orderedField) ([]byte, error) {
	var out bytes.Buffer
	out.WriteString("{")
	for i, f := range fields {
		if i > 0 {
			out.WriteString(",")
		}
		out.WriteString("\n  ")
		var key bytes.Buffer
		enc := json.NewEncoder(&key)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(f.key); err != nil {
			return nil, err
		}
		out.Write(bytes.TrimRight(key.Bytes(), "\n"))
		out.WriteString(": ")
		if err := json.Indent(&out, f.value, "  ", "  "); err != nil {
			return nil, err
		}
	}
	if len(fields) > 0 {
		out.WriteString("\n")
	}
	out.WriteString("}")
	return out.Bytes(), nil
}
