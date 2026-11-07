package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/protocol/gemini"
	"github.com/outof0/anypick/go/internal/protocol/ssecheck"
)

// The Gemini writer is the module's other Anthropic stream emitter, and is held
// to the same lifecycle check as the OpenAI translator.
func TestGeminiAnthropicStreamIsWellFormed(t *testing.T) {
	msg := &gemini.AnthropicMessageResponse{}
	if err := json.Unmarshal([]byte(`{
	  "id": "msg_1", "stop_reason": "tool_use",
	  "content": [
	    {"type": "thinking", "thinking": "hmm", "signature": "sig"},
	    {"type": "text", "text": "answer"},
	    {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Hanoi"}},
	    {"type": "text", "text": "after"}
	  ],
	  "usage": {"input_tokens": 1, "output_tokens": 2}
	}`), msg); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	writeAnthropicStream(rec, msg, "gemini-2.5-pro")
	body := rec.Body.String()
	ssecheck.AnthropicStream(t, body)
	if got := strings.Count(body, "event: content_block_start"); got != 4 {
		t.Fatalf("content_block_start count = %d, want 4\n%s", got, body)
	}
}
