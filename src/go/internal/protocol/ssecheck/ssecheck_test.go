package ssecheck

import (
	"fmt"
	"strings"
	"testing"
)

// fatalTB records the first Fatalf and stops the check there.
type fatalTB struct {
	testing.TB
	msg string
}

type stopped struct{}

func (f *fatalTB) Helper() {}
func (f *fatalTB) Fatalf(format string, args ...any) {
	f.msg = fmt.Sprintf(format, args...)
	panic(stopped{})
}

func check(t *testing.T, body string) (msg string) {
	t.Helper()
	tb := &fatalTB{TB: t}
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(stopped); !ok {
				panic(r)
			}
			msg = tb.msg
		}
	}()
	AnthropicStream(tb, body)
	return ""
}

func ev(name, data string) string { return "event: " + name + "\ndata: " + data + "\n\n" }

func stream(blocks ...string) string {
	return ev("message_start", `{"type":"message_start"}`) + strings.Join(blocks, "") +
		ev("message_delta", `{"type":"message_delta"}`) + ev("message_stop", `{"type":"message_stop"}`)
}

func start(i int, block string) string {
	return ev("content_block_start", fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":%s}`, i, block))
}
func delta(i int) string {
	return ev("content_block_delta", fmt.Sprintf(`{"type":"content_block_delta","index":%d,"delta":{"type":"text_delta","text":"x"}}`, i))
}
func stop(i int) string {
	return ev("content_block_stop", fmt.Sprintf(`{"type":"content_block_stop","index":%d}`, i))
}

const text = `{"type":"text","text":""}`
const tool = `{"type":"tool_use","id":"t1","name":"bash","input":{}}`

func TestAcceptsAWellFormedStream(t *testing.T) {
	body := stream(start(0, text), delta(0), stop(0), ev("ping", `{"type":"ping"}`), start(1, tool), delta(1), stop(1))
	if msg := check(t, body); msg != "" {
		t.Fatalf("rejected a well-formed stream: %s", msg)
	}
}

// Each shape below is one the translator has emitted, or could emit after a
// careless change. The check must reject every one.
func TestRejectsEachMalformedShape(t *testing.T) {
	cases := []struct{ name, body, rule string }{
		{"block left open", stream(start(0, text), delta(0)), "never stopped"},
		{"overlapping blocks", stream(start(0, text), start(1, tool), stop(1), stop(0)), "while block 0 is open"},
		{"index gap", stream(start(0, text), stop(0), start(2, tool), stop(2)), "want 1"},
		{"reused index", stream(start(0, text), stop(0), start(0, tool), stop(0)), "want 1"},
		{"delta for another block", stream(start(0, text), delta(1), stop(0)), "the open block is 0"},
		{"stop for another block", stream(start(0, text), stop(1)), "the open block is 0"},
		{"delta with nothing open", stream(delta(0)), "the open block is -1"},
		{"unnamed tool", stream(start(0, `{"type":"tool_use","id":"t1","name":"","input":{}}`), stop(0)), "has no name"},
		{"tool without id", stream(start(0, `{"type":"tool_use","id":"","name":"bash","input":{}}`), stop(0)), "has no id"},
		{"no message_stop", ev("message_start", `{}`) + start(0, text) + stop(0) + ev("message_delta", `{}`) + ev("x", `{}`), "end with message_stop"},
		{"stop before delta", ev("message_start", `{}`) + ev("message_stop", `{}`) + ev("message_delta", `{}`), "end with message_stop"},
		{"stray event", stream(start(0, text), ev("x", `{}`), stop(0)), "unexpected event"},
	}
	for _, c := range cases {
		msg := check(t, c.body)
		if !strings.Contains(msg, c.rule) {
			t.Errorf("%s: got %q, want the %q rule\n%s", c.name, msg, c.rule, c.body)
		}
	}
}
