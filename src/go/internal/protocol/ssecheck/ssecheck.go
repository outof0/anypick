// Package ssecheck holds the one well-formedness check for an Anthropic
// Messages stream. Both emitters in this module (the OpenAI translator in
// internal/protocol and the Gemini writer in internal/proxy) are held to it,
// because two fixes in a row repaired the same family of bug, a malformed
// block lifecycle, one shape at a time (CODE_REVIEW.md §5).
package ssecheck

import (
	"encoding/json"
	"strings"
	"testing"
)

// Event is one parsed server-sent event.
type Event struct {
	Name string
	Data map[string]any
}

// Parse splits a raw SSE body into events. A data line that is not a JSON
// object fails the test: every Anthropic event carries one.
func Parse(t testing.TB, body string) []Event {
	t.Helper()
	var events []Event
	for _, frame := range strings.Split(body, "\n\n") {
		frame = strings.TrimSpace(frame)
		if frame == "" {
			continue
		}
		var ev Event
		for _, line := range strings.Split(frame, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				ev.Name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev.Data); err != nil {
					t.Fatalf("event %q has a data line that is not a JSON object: %v\n%s", ev.Name, err, frame)
				}
			}
		}
		events = append(events, ev)
	}
	return events
}

// AnthropicStream fails the test unless body is a well-formed Anthropic
// Messages stream:
//   - message_start comes first and message_stop last, with message_delta
//     right before it;
//   - content blocks are sequential: each starts only when none is open, and
//     takes the next index from 0;
//   - every delta and stop targets the open block, and every block stops
//     before message_delta;
//   - a tool_use block names its tool and carries an id at its start, since
//     a client cannot dispatch a call it cannot name or answer.
//
// ping events may appear anywhere.
func AnthropicStream(t testing.TB, body string) {
	t.Helper()
	var events []Event
	for _, ev := range Parse(t, body) {
		if ev.Name != "ping" {
			events = append(events, ev)
		}
	}
	fail := func(i int, format string, args ...any) {
		t.Helper()
		t.Fatalf("event %d (%s): "+format+"\n%s", append([]any{i, events[i].Name}, args...)...)
	}
	if len(events) < 3 {
		t.Fatalf("stream has %d events; want at least message_start, message_delta, message_stop\n%s", len(events), body)
	}
	if events[0].Name != "message_start" {
		fail(0, "stream must open with message_start", body)
	}
	last := len(events) - 1
	if events[last].Name != "message_stop" {
		fail(last, "stream must end with message_stop", body)
	}
	if events[last-1].Name != "message_delta" {
		fail(last-1, "message_delta must come right before message_stop", body)
	}
	open, next := -1, 0
	for i := 1; i < last-1; i++ {
		ev := events[i]
		index, hasIndex := ev.Data["index"].(float64)
		switch ev.Name {
		case "content_block_start":
			if open >= 0 {
				fail(i, "block %v starts while block %d is open", ev.Data["index"], open, body)
			}
			if !hasIndex || int(index) != next {
				fail(i, "block index %v; want %d", ev.Data["index"], next, body)
			}
			block, _ := ev.Data["content_block"].(map[string]any)
			if block["type"] == "tool_use" {
				if name, _ := block["name"].(string); name == "" {
					fail(i, "tool_use block has no name", body)
				}
				if id, _ := block["id"].(string); id == "" {
					fail(i, "tool_use block has no id", body)
				}
			}
			open = next
			next++
		case "content_block_delta", "content_block_stop":
			if open < 0 || !hasIndex || int(index) != open {
				fail(i, "targets block %v; the open block is %d", ev.Data["index"], open, body)
			}
			if ev.Name == "content_block_stop" {
				open = -1
			}
		default:
			fail(i, "unexpected event between message_start and message_delta", body)
		}
	}
	if open >= 0 {
		t.Fatalf("block %d never stopped before message_delta\n%s", open, body)
	}
}
