package protocol

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// ---- streaming: openai SSE → anthropic SSE ----

type openAIStreamChunk struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content   json.RawMessage       `json:"content"`
			ToolCalls []openAIToolCallDelta `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

// openAIToolCallDelta is one OpenAI tool_call fragment inside a stream chunk.
type openAIToolCallDelta struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// streamTranslator accumulates per-request block state while converting
// OpenAI deltas into Anthropic stream events.
type streamTranslator struct {
	w           http.ResponseWriter
	flusher     http.Flusher
	started     bool
	textOpen    bool
	toolBlocks  map[int]bool // openai tool index → anthropic block started
	blockIndex  int
	stopReason  *string
	inputTokens int
	outTokens   int
	trace       StreamTrace
}

// StreamTrace contains metadata about the upstream SSE lifecycle. It never
// includes event payloads, prompts, response text, or headers.
type StreamTrace struct {
	ReadEnd          string
	UpstreamBytes    int64
	DataFrames       int
	MalformedFrames  int
	DoneMarker       bool
	ErrorEvent       bool
	FinishReason     string
	FirstDataSeen    bool
	FirstDataAfterMS int64
	ClientWriteError bool
}

func (t *streamTranslator) send(event, data string) {
	if _, err := fmt.Fprintf(t.w, "event: %s\ndata: %s\n\n", event, data); err != nil {
		t.trace.ClientWriteError = true
	}
	t.flusher.Flush()
}

func (t *streamTranslator) sendJSON(event string, v interface{}) {
	raw, _ := json.Marshal(v)
	t.send(event, string(raw))
}

// TranslateStreamingResponse consumes an OpenAI chat-completions SSE body and
// writes an Anthropic message stream. Returns the first error observed in the
// upstream stream, if any.
func TranslateStreamingResponse(upstream *http.Response, w http.ResponseWriter) error {
	_, err := TranslateStreamingResponseWithTrace(upstream, w)
	return err
}

// TranslateStreamingResponseWithTrace translates an OpenAI SSE response and
// reports terminal markers and read/write failures without retaining payloads.
func TranslateStreamingResponseWithTrace(upstream *http.Response, w http.ResponseWriter) (StreamTrace, error) {
	trace := StreamTrace{ReadEnd: "unknown", FinishReason: "missing"}
	flusher, ok := w.(http.Flusher)
	if !ok {
		trace.ReadEnd = "writer_error"
		return trace, fmt.Errorf("response writer does not support flushing")
	}
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	t := &streamTranslator{
		w: w, flusher: flusher,
		toolBlocks: map[int]bool{},
		trace:      trace,
	}
	// Use bufio.Reader instead of Scanner to avoid the 1 MiB token limit
	// truncating large tool-call deltas.
	reader := bufio.NewReader(upstream.Body)
	startedAt := time.Now()
	for {
		raw, err := reader.ReadString('\n')
		t.trace.UpstreamBytes += int64(len(raw))
		line := strings.TrimSpace(raw)
		if line != "" && strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "[DONE]" {
				t.trace.DoneMarker = true
				t.trace.ReadEnd = "done"
				break
			}
			t.trace.DataFrames++
			if !t.trace.FirstDataSeen {
				t.trace.FirstDataSeen = true
				t.trace.FirstDataAfterMS = time.Since(startedAt).Milliseconds()
			}
			var envelope struct {
				Error json.RawMessage `json:"error"`
			}
			if json.Unmarshal([]byte(payload), &envelope) == nil &&
				len(envelope.Error) > 0 && string(envelope.Error) != "null" {
				t.trace.ErrorEvent = true
			}
			var chunk openAIStreamChunk
			if jsonErr := json.Unmarshal([]byte(payload), &chunk); jsonErr == nil {
				t.handleChunk(chunk)
			} else {
				t.trace.MalformedFrames++
			}
		}
		if err != nil {
			// Ensure the message is finalized even when upstream closes without [DONE].
			t.finish()
			if err == io.EOF {
				t.trace.ReadEnd = "eof"
				return t.trace, nil
			}
			t.trace.ReadEnd = "read_error"
			return t.trace, err
		}
	}
	t.finish()
	return t.trace, nil
}

func (t *streamTranslator) handleChunk(chunk openAIStreamChunk) {
	if !t.started {
		t.started = true
		model := chunk.Model
		in := 0
		if chunk.Usage != nil {
			in = chunk.Usage.PromptTokens
		}
		t.inputTokens = in
		id := "msg_" + chunk.ID
		t.sendJSON("message_start", map[string]interface{}{
			"type": "message_start",
			"message": map[string]interface{}{
				"id": id, "type": "message", "role": "assistant",
				"model":   model,
				"content": []interface{}{},
				"usage":   map[string]int{"input_tokens": in, "output_tokens": 0},
			},
		})
	}
	if len(chunk.Choices) == 0 {
		if chunk.Usage != nil {
			t.outTokens = chunk.Usage.CompletionTokens
		}
		return
	}
	delta := chunk.Choices[0].Delta
	if chunk.Usage != nil {
		t.outTokens = chunk.Usage.CompletionTokens
	}

	var text string
	if len(delta.Content) > 0 && string(delta.Content) != "null" {
		_ = json.Unmarshal(delta.Content, &text)
	}
	if text != "" {
		if !t.textOpen {
			idx := t.blockIndex
			t.blockIndex++
			t.textOpen = true
			t.sendJSON("content_block_start", map[string]interface{}{
				"type": "content_block_start", "index": idx,
				"content_block": map[string]interface{}{"type": "text", "text": ""},
			})
		}
		t.sendJSON("content_block_delta", map[string]interface{}{
			"type":  "content_block_delta",
			"index": t.blockIndex - 1,
			"delta": map[string]string{"type": "text_delta", "text": text},
		})
	}

	t.emitToolCallDeltas(delta.ToolCalls)

	if chunk.Choices[0].FinishReason != nil && *chunk.Choices[0].FinishReason != "" {
		finish := *chunk.Choices[0].FinishReason
		t.stopReason = mapFinishReason(finish)
		t.trace.FinishReason = streamFinishReasonClass(finish)
	}
}

func streamFinishReasonClass(finish string) string {
	switch finish {
	case "stop":
		return "stop"
	case "length":
		return "length"
	case "tool_calls":
		return "tool_calls"
	case "function_call":
		return "function_call"
	case "content_filter":
		return "content_filter"
	default:
		return "other"
	}
}

func (t *streamTranslator) emitToolCallDeltas(calls []openAIToolCallDelta) {
	for _, call := range calls {
		if call.ID != "" || call.Function.Name != "" {
			if !t.toolBlocks[call.Index] {
				t.closeTextBlock()
				idx := t.blockIndex + call.Index
				t.toolBlocks[call.Index] = true
				t.sendJSON("content_block_start", map[string]interface{}{
					"type": "content_block_start", "index": idx,
					"content_block": map[string]interface{}{
						"type": "tool_use", "id": call.ID,
						"name": call.Function.Name, "input": map[string]interface{}{},
					},
				})
			}
		}
		if call.Function.Arguments != "" {
			idx := t.blockIndex + call.Index
			t.sendJSON("content_block_delta", map[string]interface{}{
				"type": "content_block_delta", "index": idx,
				"delta": map[string]string{
					"type": "input_json_delta", "partial_json": call.Function.Arguments,
				},
			})
		}
	}
}

func (t *streamTranslator) closeTextBlock() {
	if !t.textOpen {
		return
	}
	t.textOpen = false
	t.sendJSON("content_block_stop", map[string]interface{}{
		"type": "content_block_stop", "index": t.blockIndex - 1,
	})
}

func (t *streamTranslator) finish() {
	t.closeTextBlock()
	// Each content_block_start needs its own content_block_stop before
	// message_stop. Closing only the highest tool index leaves earlier
	// tool_use blocks open. DeepSeek Harness then aborts the turn:
	// "message_stop without settled blocks".
	toolIdx := make([]int, 0, len(t.toolBlocks))
	for idx := range t.toolBlocks {
		toolIdx = append(toolIdx, idx)
	}
	sort.Ints(toolIdx)
	for _, idx := range toolIdx {
		t.sendJSON("content_block_stop", map[string]interface{}{
			"type": "content_block_stop", "index": t.blockIndex + idx,
		})
	}
	if !t.started {
		// Upstream produced nothing usable; still emit a valid empty message.
		t.started = true
		t.sendJSON("message_start", map[string]interface{}{
			"type": "message_start",
			"message": map[string]interface{}{
				"id": "msg_empty", "type": "message", "role": "assistant",
				"model": "", "content": []interface{}{},
				"usage": map[string]int{"input_tokens": 0, "output_tokens": 0},
			},
		})
	}
	stop := t.stopReason
	if stop == nil {
		s := "end_turn"
		stop = &s
	}
	t.sendJSON("message_delta", map[string]interface{}{
		"type":  "message_delta",
		"delta": map[string]interface{}{"stop_reason": stop, "stop_sequence": nil},
		"usage": map[string]int{"output_tokens": t.outTokens},
	})
	t.send("message_stop", `{"type":"message_stop"}`)
}
