package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/outof0/anypick/go/internal/egress"
	"github.com/outof0/anypick/go/internal/protocol/gemini"
)

// serveOpenAIResponsesWith bridges current Responses-only clients (Codex) to
// subscription upstreams that expose only Chat Completions (WorkBuddy and
// similar services). The public proxy remains Responses-shaped, so client
// configuration does not need a provider-specific wire_api exception.
func serveOpenAIResponsesWith(w http.ResponseWriter, r *http.Request, up *Upstream) {
	body, err := ReadCappedBody(r, MaxBodyBytes)
	if errors.Is(err, ErrBodyTooLarge) {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "invalid_request_error",
			fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes))
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "unreadable body")
		return
	}

	var responsesReq gemini.OpenAIResponsesRequest
	if err := json.Unmarshal(body, &responsesReq); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "invalid Responses request")
		return
	}
	targetModel := responsesReq.Model
	if up.MapModel != nil {
		targetModel = up.MapModel(targetModel)
	}
	chatReq := gemini.OpenAIResponsesToChat(responsesReq, targetModel)
	// Several subscription gateways, including WorkBuddy, expose only the
	// streaming form of Chat Completions.  The public Responses endpoint may be
	// non-streaming, so always stream upstream and collapse the events below
	// when the caller asked for a JSON response.
	chatReq.Stream = true
	// Without include_usage a spec-following chat vendor omits the usage
	// object entirely and the translated Responses body has no token
	// accounting. Vendors that do not implement it ignore the field.
	chatReq.StreamOptions = json.RawMessage(`{"include_usage":true}`)
	chatBody, err := json.Marshal(chatReq)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "invalid translated request")
		return
	}
	if up.SanitizeOpenAIBody != nil {
		chatBody = up.SanitizeOpenAIBody(chatBody)
	}

	target := *up.BaseURL
	if up.OpenAIPath != "" {
		target.Path = strings.TrimSuffix(target.Path, "/") + up.OpenAIPath
		target.RawPath = ""
	} else {
		target.Path = joinUpstreamPath(target.Path, "/v1/chat/completions")
	}
	outReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target.String(),
		bytes.NewReader(chatBody))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "upstream unavailable")
		return
	}
	outReq.Header = r.Header.Clone()
	outReq.Header.Del("Authorization")
	outReq.Header.Del("x-api-key")
	outReq.Header.Del("api-key")
	// Never forward the caller's Accept-Encoding: Go only transparently
	// decompresses when it added that header itself, so a caller asking for
	// gzip would hand the compressed bytes to the SSE/JSON parser and every
	// request would fail as "invalid upstream stream".
	outReq.Header.Del("Accept-Encoding")
	outReq.Header.Set("Content-Type", "application/json")
	outReq.ContentLength = int64(len(chatBody))
	if err := injectUpstreamAuthFields(r.Context(), outReq, up); err != nil {
		proxyLogf("responses credential refresh failed: %s", redactAuthError(err))
		writeJSONError(w, http.StatusBadGateway, "proxy_error", "credential refresh failed")
		return
	}

	resp, err := egress.StreamClient().Do(outReq)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "upstream unavailable")
		return
	}
	defer resp.Body.Close()
	writeOpenAIResponsesResult(w, resp, responsesReq, chatBody)
}

func writeOpenAIResponsesResult(w http.ResponseWriter, resp *http.Response,
	request gemini.OpenAIResponsesRequest, requestBody []byte) {
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if (resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusRequestEntityTooLarge) &&
			IsContextWindowError(string(raw)) {
			// Translate the vendor's context-length rejection into the
			// Responses-native compaction signal. Codex cannot recover from
			// the raw chat-completions error shape.
			if request.Stream {
				w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
				w.Header().Set("Cache-Control", "no-cache, no-transform")
				w.Header().Set("Connection", "keep-alive")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(openAIResponsesContextWindowSSE())
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write(openAIContextWindowErrorBody())
			return
		}
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			proxyLogf("responses upstream %d; vendor says: %s", resp.StatusCode,
				describeVendorError(string(raw), resp.StatusCode))
			proxyLogf("responses upstream %d; failed shape: %s", resp.StatusCode,
				describeSanitizedOpenAI(requestBody))
		}
		// The body below is re-read and possibly truncated by the 1 MiB cap:
		// the upstream's own framing headers no longer describe it.
		copyResponseHeaders(w, resp.Header)
		w.Header().Del("Content-Length")
		w.Header().Del("Content-Encoding")
		for _, hopByHop := range []string{"Connection", "Keep-Alive", "Proxy-Authenticate",
			"Proxy-Authorization", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
			w.Header().Del(hopByHop)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		return
	}

	chatResp, streamErr := collectOpenAIChatStream(resp.Body, request.Model)
	if streamErr != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "invalid upstream stream")
		return
	}
	if request.Stream {
		writeOpenAIResponsesStream(w, gemini.OpenAIChatToResponses(chatResp, request.Model))
		return
	}

	responseBody, err := json.Marshal(gemini.OpenAIChatToResponses(chatResp, request.Model))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_error", "invalid translated response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(responseBody)
}

func copyResponseHeaders(dst http.ResponseWriter, src http.Header) {
	for key, values := range src {
		for _, value := range values {
			dst.Header().Add(key, value)
		}
	}
}

type openAIStreamToolCall struct {
	ID   string
	Type string
	// Index is the vendor's tool-call position. Parallel calls are streamed as
	// interleaved deltas that each carry their own index, so keying state by
	// position within a chunk merges them into one corrupted call.
	Index    *int
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIStreamChunk struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content   json.RawMessage        `json:"content"`
			Reasoning string                 `json:"reasoning_content"`
			ToolCalls []openAIStreamToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

type openAIStreamState struct {
	id, model, reasoning, text, finish string
	usage                              *gemini.OpenAIUsage
	toolCalls                          map[int]openAIStreamToolCall
}

// maxResponsesBridgeBytes bounds the buffered bridge. Every sibling egress
// path caps its body; this one used to accumulate the whole upstream stream,
// so a hostile or stuck upstream could drive the proxy process out of memory.
const maxResponsesBridgeBytes = 32 << 20

// collectOpenAIChatStream buffers a chat SSE response before emitting a
// Responses stream. This keeps the converter lossless for text and tool-call
// deltas while the upstream contract is still being normalized; the caller
// still receives a valid Responses event stream and Codex can process it.
func collectOpenAIChatStream(body io.Reader, requestedModel string) (*gemini.OpenAIChatResponse, error) {
	state := openAIStreamState{toolCalls: map[int]openAIStreamToolCall{}}
	reader := bufio.NewReader(body)
	seenSSE := false
	var nonStream bytes.Buffer
	var total int64
	for {
		raw, readErr := reader.ReadString('\n')
		total += int64(len(raw))
		if total > maxResponsesBridgeBytes {
			return nil, fmt.Errorf("upstream stream exceeds %d bytes", maxResponsesBridgeBytes)
		}
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "data:") {
			seenSSE = true
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "[DONE]" {
				break
			}
			var chunk openAIStreamChunk
			if json.Unmarshal([]byte(payload), &chunk) == nil {
				consumeOpenAIStreamChunk(&state, chunk)
			}
		} else if !seenSSE {
			_, _ = nonStream.WriteString(raw)
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, readErr
		}
	}
	if !seenSSE {
		var response gemini.OpenAIChatResponse
		if err := json.Unmarshal(nonStream.Bytes(), &response); err != nil {
			return nil, err
		}
		return &response, nil
	}
	return openAIChatResponse(state, requestedModel), nil
}

func consumeOpenAIStreamChunk(state *openAIStreamState, chunk openAIStreamChunk) {
	if state.id == "" {
		state.id = chunk.ID
	}
	if state.model == "" {
		state.model = chunk.Model
	}
	if len(chunk.Choices) > 0 {
		delta := chunk.Choices[0].Delta
		var part string
		_ = json.Unmarshal(delta.Content, &part)
		state.text += part
		state.reasoning += delta.Reasoning
		for position, call := range delta.ToolCalls {
			// Prefer the vendor's index (parallel calls); fall back to the
			// chunk position for vendors that omit it.
			key := position
			if call.Index != nil {
				key = *call.Index
			}
			current := state.toolCalls[key]
			if call.ID != "" {
				current.ID = call.ID
			}
			if call.Type != "" {
				current.Type = call.Type
			}
			current.Function.Name += call.Function.Name
			current.Function.Arguments += call.Function.Arguments
			state.toolCalls[key] = current
		}
		if chunk.Choices[0].FinishReason != nil {
			state.finish = *chunk.Choices[0].FinishReason
		}
	}
	if chunk.Usage != nil {
		state.usage = &gemini.OpenAIUsage{
			PromptTokens: chunk.Usage.PromptTokens, CompletionTokens: chunk.Usage.CompletionTokens,
			TotalTokens: chunk.Usage.TotalTokens,
		}
	}
}

func openAIChatResponse(state openAIStreamState, requestedModel string) *gemini.OpenAIChatResponse {
	model := state.model
	if model == "" {
		model = requestedModel
	}
	id := state.id
	if id == "" {
		id = "chatcmpl_" + gemini.RandomID()
	}
	message := gemini.OpenAIMessage{Role: "assistant", ReasoningContent: state.reasoning}
	if state.text != "" {
		message.Content, _ = json.Marshal(state.text)
	}
	keys := make([]int, 0, len(state.toolCalls))
	for key := range state.toolCalls {
		keys = append(keys, key)
	}
	sort.Ints(keys)
	for _, key := range keys {
		call := state.toolCalls[key]
		var tool gemini.OpenAIToolCall
		tool.ID, tool.Type = call.ID, call.Type
		tool.Function.Name, tool.Function.Arguments = call.Function.Name, call.Function.Arguments
		message.ToolCalls = append(message.ToolCalls, tool)
	}
	return &gemini.OpenAIChatResponse{
		ID: id, Object: "chat.completion", Model: model,
		Choices: []gemini.OpenAIChatChoice{{Index: 0, Message: message, FinishReason: state.finish}},
		Usage:   state.usage,
	}
}
