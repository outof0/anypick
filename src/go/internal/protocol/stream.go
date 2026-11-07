package protocol

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	w       http.ResponseWriter
	flusher http.Flusher
	started bool
	// open is the one content block that is open, or nil. Anthropic blocks
	// are sequential: start, deltas, stop, then the next. A client that
	// checks the lifecycle rejects a block that starts while another is open.
	open *streamBlock
	// nextIndex is the index the next block takes when it starts. OpenAI
	// numbers tool calls apart from text, so a block index derived from the
	// tool index let text after a tool call reuse that tool's index.
	nextIndex int
	// tools holds each OpenAI tool index's call, in order of first appearance.
	tools       map[int]*streamTool
	toolOrder   []int
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
	// LateToolDeltas counts tool arguments that resumed after text had closed
	// their block, the one case a sequential stream cannot deliver.
	LateToolDeltas int
}

// streamBlock is an open Anthropic content block.
type streamBlock struct {
	index int
	tool  *streamTool // nil for a text block
}

// streamTool is one OpenAI tool call. Its arguments wait in pending until its
// block is open: before its name arrives, because the block's start carries
// the name and a client cannot dispatch a tool_use it cannot name; and while
// another tool's block is open, because closing that block early would drop
// the rest of its arguments when upstream interleaves parallel calls.
type streamTool struct {
	index    int
	id, name string
	pending  strings.Builder
	started  bool
	closed   bool
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
		tools: map[int]*streamTool{},
		trace: trace,
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
		if t.open == nil || t.open.tool != nil {
			t.closeOpenBlock()
			t.open = &streamBlock{index: t.nextIndex}
			t.nextIndex++
			t.sendJSON("content_block_start", map[string]interface{}{
				"type": "content_block_start", "index": t.open.index,
				"content_block": map[string]interface{}{"type": "text", "text": ""},
			})
		}
		t.sendJSON("content_block_delta", map[string]interface{}{
			"type":  "content_block_delta",
			"index": t.open.index,
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
		tool := t.tools[call.Index]
		if tool == nil {
			tool = &streamTool{index: call.Index}
			t.tools[call.Index] = tool
			t.toolOrder = append(t.toolOrder, call.Index)
		}
		if tool.closed {
			if call.Function.Arguments != "" {
				t.trace.LateToolDeltas++
			}
			continue
		}
		if tool.id == "" {
			tool.id = call.ID
		}
		if tool.name == "" {
			tool.name = call.Function.Name
		}
		tool.pending.WriteString(call.Function.Arguments)
		if !tool.started {
			if tool.name == "" || (t.open != nil && t.open.tool != nil) {
				continue
			}
			t.startTool(tool)
		}
		t.flushToolArguments(tool)
	}
}

// startTool closes whatever block is open and starts the tool's block. Some
// OpenAI-compatible servers send no call id; the client answers a tool_use by
// its id, so one is made up. The tool index alone repeats in every turn, and a
// conversation holding two tool_use blocks with one id can pair a result with
// the wrong call, so a random part keeps it unique across the conversation.
func (t *streamTranslator) startTool(tool *streamTool) {
	t.closeOpenBlock()
	tool.started = true
	if tool.id == "" {
		var nonce [8]byte
		_, _ = rand.Read(nonce[:])
		tool.id = fmt.Sprintf("toolu_anypick_%s_%d", hex.EncodeToString(nonce[:]), tool.index)
	}
	t.open = &streamBlock{index: t.nextIndex, tool: tool}
	t.nextIndex++
	t.sendJSON("content_block_start", map[string]interface{}{
		"type": "content_block_start", "index": t.open.index,
		"content_block": map[string]interface{}{
			"type": "tool_use", "id": tool.id,
			"name": tool.name, "input": map[string]interface{}{},
		},
	})
}

// flushToolArguments sends the tool's waiting arguments into its open block.
func (t *streamTranslator) flushToolArguments(tool *streamTool) {
	if tool.pending.Len() == 0 || t.open == nil || t.open.tool != tool {
		return
	}
	t.sendJSON("content_block_delta", map[string]interface{}{
		"type": "content_block_delta", "index": t.open.index,
		"delta": map[string]string{
			"type": "input_json_delta", "partial_json": tool.pending.String(),
		},
	})
	tool.pending.Reset()
}

func (t *streamTranslator) closeOpenBlock() {
	if t.open == nil {
		return
	}
	if t.open.tool != nil {
		t.open.tool.closed = true
	}
	t.sendJSON("content_block_stop", map[string]interface{}{
		"type": "content_block_stop", "index": t.open.index,
	})
	t.open = nil
}

func (t *streamTranslator) finish() {
	// Every content_block_start needs its own content_block_stop before
	// message_stop, or DeepSeek Harness aborts the turn: "message_stop without
	// settled blocks".
	t.closeOpenBlock()
	// Calls that waited behind another tool's block go out now, in the order
	// upstream began them, after any text that closed that block; clients act
	// on tool calls only after message_stop. An entry that carried nothing is
	// not a call. One
	// that never got a name is still sent, so its arguments are not lost.
	for _, idx := range t.toolOrder {
		tool := t.tools[idx]
		if tool.started || (tool.name == "" && tool.id == "" && tool.pending.Len() == 0) {
			continue
		}
		t.startTool(tool)
		t.flushToolArguments(tool)
		t.closeOpenBlock()
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
