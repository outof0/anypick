package protocol

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/protocol/ssecheck"
)

func TestVendorStreamWithReasoningFields(t *testing.T) {
	raw := "data: {\"id\":\"cmb-1\",\"model\":\"glm-5.2\",\"object\":\"chat.completion.chunk\",\"created\":1788446408,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"OK\",\"reasoning_content\":\"\",\"function_call\":null,\"refusal\":\"\",\"tool_calls\":null},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n"
	up := &http.Response{Body: io.NopCloser(strings.NewReader(raw)),
		Header: http.Header{"Content-Type": []string{"text/event-stream"}}}
	rec := httptest.NewRecorder()
	if err := TranslateStreamingResponse(up, rec); err != nil {
		t.Fatalf("err: %v", err)
	}
	out := rec.Body.String()
	ssecheck.AnthropicStream(t, out)
	t.Logf("OUT %d bytes:\n%s", len(out), out)
	if !strings.Contains(out, "OK") {
		t.Fatalf("missing content in %d bytes", len(out))
	}
}
