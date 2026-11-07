package protocol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/protocol/ssecheck"
)

func TestTranslateRequestBasic(t *testing.T) {
	in := `{
	  "model": "deepseek-chat", "max_tokens": 512, "stream": false,
	  "temperature": 0.2,
	  "system": "be brief",
	  "messages": [
	    {"role":"user","content":"hello"},
	    {"role":"assistant","content":[{"type":"text","text":"hi"}]},
	    {"role":"user","content":[
	      {"type":"text","text":"look"},
	      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}
	    ]}
	  ]
	}`
	out, err := TranslateRequest([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var req struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
		Temperature float64 `json:"temperature"`
	}
	if json.Unmarshal(out, &req) != nil {
		t.Fatalf("out = %s", out)
	}
	if req.Model != "deepseek-chat" || req.Temperature != 0.2 {
		t.Errorf("model/temp = %s/%v", req.Model, req.Temperature)
	}
	if len(req.Messages) != 4 { // system + user + assistant + user
		t.Fatalf("messages = %d: %s", len(req.Messages), out)
	}
	var sys string
	json.Unmarshal(req.Messages[0].Content, &sys)
	if req.Messages[0].Role != "system" || sys != "be brief" {
		t.Errorf("system = %s %s", req.Messages[0].Role, sys)
	}
}

func TestTranslateRequestToolsAndResults(t *testing.T) {
	in := `{
	  "model":"m","max_tokens":100,
	  "tools":[{"name":"get_weather","description":"weather","input_schema":{"type":"object"}}],
	  "tool_choice":{"type":"any"},
	  "messages":[
	    {"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"get_weather","input":{"city":"HN"}}]},
	    {"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"22C"}]}
	  ]
	}`
	out, err := TranslateRequest([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var req struct {
		ToolChoice json.RawMessage `json:"tool_choice"`
		Messages   []openAIMessage `json:"messages"`
		Tools      []struct {
			Type     string `json:"type"`
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tools"`
	}
	if json.Unmarshal(out, &req) != nil {
		t.Fatalf("%s", out)
	}
	if len(req.Tools) != 1 || req.Tools[0].Function.Name != "get_weather" {
		t.Errorf("tools = %s", out)
	}
	if string(req.ToolChoice) != `"required"` {
		t.Errorf("tool_choice = %s", req.ToolChoice)
	}
	// No system message: [assistant tool_use, tool result].
	assistant := req.Messages[0]
	if len(assistant.ToolCalls) != 1 || assistant.ToolCalls[0].ID != "tu_1" ||
		assistant.ToolCalls[0].Function.Name != "get_weather" ||
		!strings.Contains(assistant.ToolCalls[0].Function.Arguments, "HN") {
		t.Errorf("assistant = %+v", assistant)
	}
	tool := req.Messages[1]
	if tool.Role != "tool" || tool.ToolCallID != "tu_1" {
		t.Errorf("tool msg = %+v", tool)
	}
}

func TestTranslateRequestAcceptsSystemMessagesInMessagesArray(t *testing.T) {
	out, err := TranslateRequest([]byte(`{
		"model":"m",
		"messages":[
			{"role":"system","content":[{"type":"text","text":"in-band rules"}]},
			{"role":"user","content":"hello"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var req struct {
		Messages []openAIMessage `json:"messages"`
	}
	if err := json.Unmarshal(out, &req); err != nil {
		t.Fatal(err)
	}
	if len(req.Messages) != 2 || req.Messages[0].Role != "system" {
		t.Fatalf("messages = %+v", req.Messages)
	}
	var text string
	if err := json.Unmarshal(req.Messages[0].Content, &text); err != nil || text != "in-band rules" {
		t.Fatalf("system content = %s", req.Messages[0].Content)
	}
}

func TestTranslateResponseTextAndUsage(t *testing.T) {
	in := `{
	  "id":"cmpl-1","model":"m",
	  "choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"hi there"}}],
	  "usage":{"prompt_tokens":10,"completion_tokens":5}
	}`
	out, err := TranslateResponse([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var resp anthropicResponse
	if json.Unmarshal(out, &resp) != nil {
		t.Fatalf("%s", out)
	}
	if resp.Type != "message" || resp.Role != "assistant" || resp.StopReason == nil ||
		*resp.StopReason != "end_turn" {
		t.Errorf("resp = %s", out)
	}
	if resp.Usage.InputTokens != 10 || resp.Usage.OutputTokens != 5 {
		t.Errorf("usage = %+v", resp.Usage)
	}
	if len(resp.Content) != 1 || resp.Content[0].Type != "text" || resp.Content[0].Text != "hi there" {
		t.Errorf("content = %+v", resp.Content)
	}
}

func TestTranslateResponseToolUseStopReason(t *testing.T) {
	in := `{
	  "id":"c2","model":"m",
	  "choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
	    "tool_calls":[{"id":"call_9","type":"function","function":{"name":"f","arguments":"{\"x\":1}"}}]}}],
	  "usage":{"prompt_tokens":3,"completion_tokens":7}
	}`
	out, err := TranslateResponse([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var resp anthropicResponse
	json.Unmarshal(out, &resp)
	if *resp.StopReason != "tool_use" {
		t.Fatalf("stop_reason = %v (%s)", resp.StopReason, out)
	}
	found := false
	for _, b := range resp.Content {
		if b.Type == "tool_use" && b.ID == "call_9" && b.Name == "f" &&
			strings.Contains(string(b.Input), "\"x\"") {
			found = true
		}
	}
	if !found {
		t.Errorf("tool_use block missing: %s", out)
	}
}

// ---- streaming ----

func sseLine(t *testing.T, v interface{}) string {
	t.Helper()
	raw, _ := json.Marshal(v)
	return "data: " + string(raw) + "\n\n"
}

func TestStreamTranslationEmitsAnthropicEvents(t *testing.T) {
	// Build a fake upstream SSE body.
	chunks := []string{
		sseLine(t, map[string]interface{}{
			"id": "c1", "model": "m",
			"choices": []map[string]interface{}{{
				"delta": map[string]interface{}{"role": "assistant"},
			}},
		}),
		sseLine(t, map[string]interface{}{
			"id": "c1",
			"choices": []map[string]interface{}{{
				"delta": map[string]interface{}{"content": "he"},
			}},
		}),
		sseLine(t, map[string]interface{}{
			"id": "c1",
			"choices": []map[string]interface{}{{
				"delta": map[string]interface{}{
					"tool_calls": []map[string]interface{}{{
						"index": 0, "id": "call_1", "type": "function",
						"function": map[string]string{"name": "lookup", "arguments": "{\"q\":"},
					}},
				},
			}},
		}),
		sseLine(t, map[string]interface{}{
			"id": "c1",
			"choices": []map[string]interface{}{{
				"delta": map[string]interface{}{
					"tool_calls": []map[string]interface{}{{
						"index":    0,
						"function": map[string]string{"arguments": "\"x\"}"},
					}},
				},
				"finish_reason": "tool_calls",
			}},
		}),
		sseLine(t, map[string]interface{}{
			"id": "c1", "choices": []map[string]interface{}{},
			"usage": map[string]int{"prompt_tokens": 4, "completion_tokens": 9},
		}),
		"data: [DONE]\n\n",
	}
	upstreamBody := strings.Join(chunks, "")

	recorder := newSSERecorder()
	resp := newFakeSSEResponse(upstreamBody)
	if err := TranslateStreamingResponse(resp, recorder); err != nil {
		t.Fatal(err)
	}
	ssecheck.AnthropicStream(t, recorder.buf.String())

	events := recorder.events()
	wantOrder := []string{
		"message_start",
		"content_block_start", // text
		"content_block_delta", // text
		"content_block_stop",  // text closed before tool block
		"content_block_start", // tool_use
		"content_block_delta", // input_json_delta (first fragment)
		"content_block_delta", // input_json_delta (second fragment)
		"content_block_stop",  // tool block
		"message_delta",
		"message_stop",
	}
	if len(events) < len(wantOrder) {
		t.Fatalf("events = %d:\n%s", len(events), strings.Join(recorder.rawLines(), "\n"))
	}
	for i, want := range wantOrder {
		if events[i] != want {
			t.Fatalf("event[%d] = %s, want %s\nall:\n%s", i, events[i], want,
				strings.Join(recorder.rawLines(), "\n"))
		}
	}
	joined := strings.Join(recorder.rawLines(), "\n")
	if !strings.Contains(joined, `"input_json_delta"`) ||
		!strings.Contains(joined, `"tool_use"`) ||
		!strings.Contains(joined, `"stop_reason":"tool_use"`) ||
		!strings.Contains(joined, `"output_tokens":9`) {
		t.Errorf("missing expected payloads:\n%s", joined)
	}
	if !strings.Contains(joined, `"partial_json"`) ||
		!strings.Contains(joined, `q`) {
		t.Errorf("arguments streamed verbatim?\n%s", joined)
	}
}

// Two parallel tool calls must each receive content_block_stop. A single stop
// for the highest index leaves the earlier tool_use block open, which DeepSeek
// Harness rejects when message_stop arrives.
func TestStreamTranslationClosesEveryToolBlock(t *testing.T) {
	chunks := []string{
		sseLine(t, map[string]interface{}{
			"id": "c1", "model": "m",
			"choices": []map[string]interface{}{{
				"delta": map[string]interface{}{"content": "ok"},
			}},
		}),
		sseLine(t, map[string]interface{}{
			"id": "c1",
			"choices": []map[string]interface{}{{
				"delta": map[string]interface{}{
					"tool_calls": []map[string]interface{}{
						{
							"index": 0, "id": "call_a", "type": "function",
							"function": map[string]string{"name": "bash", "arguments": "{\"cmd\":\"pwd\"}"},
						},
						{
							"index": 1, "id": "call_b", "type": "function",
							"function": map[string]string{"name": "read", "arguments": "{\"path\":\"a\"}"},
						},
					},
				},
				"finish_reason": "tool_calls",
			}},
		}),
		"data: [DONE]\n\n",
	}
	recorder := newSSERecorder()
	if err := TranslateStreamingResponse(newFakeSSEResponse(strings.Join(chunks, "")), recorder); err != nil {
		t.Fatal(err)
	}
	ssecheck.AnthropicStream(t, recorder.buf.String())
	var stops []int
	for _, block := range recorder.rawLines() {
		block = strings.TrimSpace(block)
		if !strings.Contains(block, "event: content_block_stop") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev struct {
				Index int `json:"index"`
			}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
				t.Fatal(err)
			}
			stops = append(stops, ev.Index)
		}
	}
	// Text is index 0. The two tool_use blocks are 1 and 2.
	if len(stops) != 3 || stops[0] != 0 || stops[1] != 1 || stops[2] != 2 {
		t.Fatalf("content_block_stop indexes = %v, want [0 1 2]\n%s", stops, recorder.buf.String())
	}
	events := recorder.events()
	if len(events) == 0 || events[len(events)-1] != "message_stop" {
		t.Fatalf("stream did not end on message_stop: %v", events)
	}
	stopAt := map[string]int{}
	for i, ev := range events {
		if _, seen := stopAt[ev]; !seen && (ev == "message_delta" || ev == "message_stop") {
			stopAt[ev] = i
		}
	}
	lastBlockStop := -1
	for i, ev := range events {
		if ev == "content_block_stop" {
			lastBlockStop = i
		}
	}
	if lastBlockStop < 0 || stopAt["message_delta"] < lastBlockStop || stopAt["message_stop"] < stopAt["message_delta"] {
		t.Fatalf("stops must settle before message_delta and message_stop: %v", events)
	}
}

// streamOf translates OpenAI chunks and returns the Anthropic stream, after
// checking it is well formed.
func streamOf(t *testing.T, chunks ...string) (string, StreamTrace) {
	t.Helper()
	recorder := newSSERecorder()
	body := strings.Join(append(chunks, "data: [DONE]\n\n"), "")
	trace, err := TranslateStreamingResponseWithTrace(newFakeSSEResponse(body), recorder)
	if err != nil {
		t.Fatal(err)
	}
	ssecheck.AnthropicStream(t, recorder.buf.String())
	return recorder.buf.String(), trace
}

func textChunk(t *testing.T, text string) string {
	return sseLine(t, map[string]interface{}{
		"id": "c1", "model": "m",
		"choices": []map[string]interface{}{{"delta": map[string]interface{}{"content": text}}},
	})
}

func toolChunk(t *testing.T, calls ...map[string]interface{}) string {
	return sseLine(t, map[string]interface{}{
		"id": "c1", "model": "m",
		"choices": []map[string]interface{}{{"delta": map[string]interface{}{"tool_calls": calls}}},
	})
}

// blockStarts returns each content_block_start's content_block, in order.
func blockStarts(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, ev := range ssecheck.Parse(t, body) {
		if ev.Name == "content_block_start" {
			block, _ := ev.Data["content_block"].(map[string]any)
			out = append(out, block)
		}
	}
	return out
}

// Text that follows a tool call opens a new block after the tool block has
// stopped. Deriving block indexes from OpenAI's tool index gave that text the
// tool block's index, and a sparse tool index left a gap in the numbering.
func TestStreamTranslationGivesEveryBlockItsOwnIndex(t *testing.T) {
	body, _ := streamOf(t,
		textChunk(t, "first"),
		toolChunk(t, map[string]interface{}{
			"index": 2, "id": "call_a", "type": "function",
			"function": map[string]string{"name": "bash", "arguments": "{}"},
		}),
		textChunk(t, "after"),
	)
	starts := blockStarts(t, body)
	if len(starts) != 3 || starts[0]["type"] != "text" || starts[1]["type"] != "tool_use" || starts[2]["type"] != "text" {
		t.Fatalf("blocks = %v\n%s", starts, body)
	}
}

// Arguments that arrive before the call's id and name wait for them: the
// block starts once, named, and carries every argument fragment in order.
func TestStreamTranslationHoldsArgumentsUntilTheToolIsNamed(t *testing.T) {
	body, _ := streamOf(t,
		toolChunk(t, map[string]interface{}{"index": 0, "function": map[string]string{"arguments": "{\"a\":"}}),
		toolChunk(t, map[string]interface{}{
			"index": 0, "id": "call_x", "type": "function",
			"function": map[string]string{"name": "bash", "arguments": "1}"},
		}),
	)
	starts := blockStarts(t, body)
	if len(starts) != 1 || starts[0]["id"] != "call_x" || starts[0]["name"] != "bash" {
		t.Fatalf("blocks = %v\n%s", starts, body)
	}
	var args strings.Builder
	for _, ev := range ssecheck.Parse(t, body) {
		if delta, _ := ev.Data["delta"].(map[string]any); ev.Name == "content_block_delta" && delta["type"] == "input_json_delta" {
			args.WriteString(delta["partial_json"].(string))
		}
	}
	if args.String() != "{\"a\":1}" {
		t.Fatalf("arguments = %q\n%s", args.String(), body)
	}
}

// A call upstream never names is still sent at the end with its arguments,
// rather than silently dropped. It is exempt from ssecheck on purpose: the
// tool_use has no name because upstream gave none, and losing the arguments
// as well would be worse.
func TestStreamTranslationSendsAnUnnamedCallAtTheEnd(t *testing.T) {
	recorder := newSSERecorder()
	body := toolChunk(t, map[string]interface{}{"index": 0, "function": map[string]string{"arguments": "{}"}}) + "data: [DONE]\n\n"
	if err := TranslateStreamingResponse(newFakeSSEResponse(body), recorder); err != nil {
		t.Fatal(err)
	}
	out := recorder.buf.String()
	if !strings.Contains(out, `"partial_json":"{}"`) || strings.Count(out, "event: content_block_start") != 1 ||
		strings.Count(out, "event: content_block_stop") != 1 {
		t.Fatalf("the unnamed call was not sent once:\n%s", out)
	}
}

// Parallel calls whose fragments interleave keep every argument: the first
// call's block stays open, and the second waits and goes out after it.
func TestStreamTranslationDeliversInterleavedToolArguments(t *testing.T) {
	body, trace := streamOf(t,
		toolChunk(t, map[string]interface{}{
			"index": 0, "id": "call_a", "type": "function",
			"function": map[string]string{"name": "bash", "arguments": "{\"a\":"},
		}),
		toolChunk(t, map[string]interface{}{
			"index": 1, "id": "call_b", "type": "function",
			"function": map[string]string{"name": "read", "arguments": "{}"},
		}),
		toolChunk(t, map[string]interface{}{"index": 0, "function": map[string]string{"arguments": "1}"}}),
	)
	args := map[string]string{}
	current := ""
	for _, ev := range ssecheck.Parse(t, body) {
		switch ev.Name {
		case "content_block_start":
			block, _ := ev.Data["content_block"].(map[string]any)
			current, _ = block["id"].(string)
		case "content_block_delta":
			if delta, _ := ev.Data["delta"].(map[string]any); delta["type"] == "input_json_delta" {
				args[current] += delta["partial_json"].(string)
			}
		}
	}
	if args["call_a"] != "{\"a\":1}" || args["call_b"] != "{}" || trace.LateToolDeltas != 0 {
		t.Fatalf("arguments = %v, late = %d\n%s", args, trace.LateToolDeltas, body)
	}
}

// Arguments that resume after text has closed their block are the one case a
// sequential stream cannot deliver; they are counted for the proxy log.
func TestStreamTranslationCountsArgumentsAfterText(t *testing.T) {
	_, trace := streamOf(t,
		toolChunk(t, map[string]interface{}{
			"index": 0, "id": "call_a", "type": "function",
			"function": map[string]string{"name": "bash", "arguments": "{"},
		}),
		textChunk(t, "between"),
		toolChunk(t, map[string]interface{}{"index": 0, "function": map[string]string{"arguments": "}"}}),
	)
	if trace.LateToolDeltas != 1 {
		t.Fatalf("LateToolDeltas = %d, want 1", trace.LateToolDeltas)
	}
}

// An entry with no id, name or arguments is not a call and opens no block.
func TestStreamTranslationIgnoresAnEmptyToolEntry(t *testing.T) {
	body, _ := streamOf(t,
		toolChunk(t, map[string]interface{}{"index": 0, "type": "function"}),
		textChunk(t, "hi"),
	)
	if starts := blockStarts(t, body); len(starts) != 1 || starts[0]["type"] != "text" {
		t.Fatalf("blocks = %v\n%s", starts, body)
	}
}

// A call with a name but no id streams live, under an id made up for it.
// The id must differ between turns: the tool index alone repeats in each one.
func TestStreamTranslationGivesAnIdlessCallAnID(t *testing.T) {
	idOf := func() string {
		body, _ := streamOf(t,
			toolChunk(t, map[string]interface{}{"index": 3, "function": map[string]string{"name": "bash", "arguments": "{}"}}),
		)
		starts := blockStarts(t, body)
		if len(starts) != 1 {
			t.Fatalf("blocks = %v\n%s", starts, body)
		}
		id, _ := starts[0]["id"].(string)
		if !strings.HasPrefix(id, "toolu_anypick_") || !strings.HasSuffix(id, "_3") {
			t.Fatalf("id = %q\n%s", id, body)
		}
		return id
	}
	if first, second := idOf(), idOf(); first == second {
		t.Fatalf("two turns made the same tool id %q", first)
	}
}
