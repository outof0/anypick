package gemini

import (
	"encoding/json"
	"strings"
	"time"
)

// OpenAIResponsesToGemini translates an OpenAI /v1/responses request into a
// Gemini generateContent request. Ports openAIResponsesToGemini
// (translate-responses.ts).
func OpenAIResponsesToGemini(req OpenAIResponsesRequest, resolvedModel string) *GeminiGenerateRequest {
	return OpenAIToGemini(OpenAIResponsesToChat(req, resolvedModel), resolvedModel)
}

// OpenAIResponsesToChat converts the Responses request into the common Chat
// Completions shape. It is shared by Gemini and OpenAI-compatible subscription
// upstreams whose public surface is chat/completions.
func OpenAIResponsesToChat(req OpenAIResponsesRequest, resolvedModel string) OpenAIChatRequest {
	chat := OpenAIChatRequest{
		Model:    resolvedModel,
		Messages: openAIResponsesMessages(req.Instructions, req.Input),
	}
	if req.MaxOutputTokens != nil {
		chat.MaxTokens = req.MaxOutputTokens
	}
	if req.Temperature != nil {
		chat.Temperature = req.Temperature
	}
	if req.TopP != nil {
		chat.TopP = req.TopP
	}
	if len(req.Reasoning) > 0 {
		chat.Reasoning = req.Reasoning
	}
	functionTools := openAIResponsesTools(req.Tools)
	if len(functionTools) > 0 {
		chat.Tools = functionTools
	}
	if len(req.ToolChoice) > 0 {
		chat.ToolChoice = req.ToolChoice
	}
	return chat
}

type responsesMessageBuilder struct {
	messages         []OpenAIMessage
	pendingReasoning string
	pendingSignature string
}

func openAIResponsesMessages(instructions string, input json.RawMessage) []OpenAIMessage {
	b := &responsesMessageBuilder{}
	if instructions != "" {
		b.messages = append(b.messages, OpenAIMessage{Role: "system", Content: jsonRaw(instructions)})
	}
	b.addInput(input)
	if b.pendingReasoning != "" {
		b.messages = append(b.messages, b.attachReasoning(OpenAIMessage{Role: "assistant"}))
	}
	if allSystem(b.messages) {
		b.messages = append(b.messages, OpenAIMessage{Role: "user", Content: jsonRaw("")})
	}
	return b.messages
}

func (b *responsesMessageBuilder) attachReasoning(message OpenAIMessage) OpenAIMessage {
	message.ReasoningContent = b.pendingReasoning
	message.ReasoningSignature = b.pendingSignature
	b.pendingReasoning, b.pendingSignature = "", ""
	return message
}

func (b *responsesMessageBuilder) addInput(input json.RawMessage) {
	if input == nil {
		return
	}
	var text string
	if json.Unmarshal(input, &text) == nil {
		b.messages = append(b.messages, OpenAIMessage{Role: "user", Content: jsonRaw(text)})
		return
	}
	var items []map[string]interface{}
	if json.Unmarshal(input, &items) != nil {
		return
	}
	for _, item := range items {
		b.addItem(item)
	}
}

func (b *responsesMessageBuilder) addItem(item map[string]interface{}) {
	switch typ, _ := item["type"].(string); typ {
	case "reasoning":
		b.pendingReasoning = FlattenResponsesText(item["summary"])
		if signature, ok := item["encrypted_content"].(string); ok {
			b.pendingSignature = signature
		}
	case "function_call":
		id := asString(item["call_id"], asString(item["id"], "call_"+RandomID()))
		call := OpenAIToolCall{ID: id, Type: "function"}
		call.Function.Name = asString(item["name"], "tool")
		call.Function.Arguments = asString(item["arguments"], "{}")
		b.messages = append(b.messages, b.attachReasoning(OpenAIMessage{
			Role: "assistant", ToolCalls: []OpenAIToolCall{call},
		}))
	case "function_call_output":
		if b.pendingReasoning != "" {
			b.messages = append(b.messages, b.attachReasoning(OpenAIMessage{Role: "assistant"}))
		}
		b.messages = append(b.messages, OpenAIMessage{
			Role: "tool", ToolCallID: asString(item["call_id"], asString(item["id"], "call_"+RandomID())),
			Content: jsonRaw(FlattenResponsesText(item["output"])),
		})
	default:
		role := "user"
		switch rawRole, _ := item["role"].(string); rawRole {
		case "assistant":
			role = "assistant"
		case "system", "developer":
			role = "system"
		}
		content := jsonRaw(FlattenResponsesText(item["content"]))
		if role == "user" {
			// Chat carries images only on user messages.
			content = responsesUserContent(item["content"])
		}
		message := OpenAIMessage{Role: role, Content: content}
		if role == "assistant" {
			message = b.attachReasoning(message)
		}
		b.messages = append(b.messages, message)
	}
}

// responsesUserContent converts a user message's Responses content to Chat
// content, keeping each input_image as an image_url part. Content with no
// image stays a plain string, the shape every Chat upstream accepts.
func responsesUserContent(value interface{}) json.RawMessage {
	items, ok := value.([]interface{})
	if !ok {
		return jsonRaw(FlattenResponsesText(value))
	}
	parts := make([]map[string]interface{}, 0, len(items))
	hasImage := false
	for _, item := range items {
		entry, _ := item.(map[string]interface{})
		if url := responsesImageURL(entry); url != "" {
			hasImage = true
			image := map[string]interface{}{"url": url}
			if detail, ok := entry["detail"].(string); ok && detail != "" {
				image["detail"] = detail
			}
			parts = append(parts, map[string]interface{}{"type": "image_url", "image_url": image})
			continue
		}
		if text := FlattenResponsesText(item); text != "" {
			parts = append(parts, map[string]interface{}{"type": "text", "text": text})
		}
	}
	if !hasImage {
		return jsonRaw(FlattenResponsesText(value))
	}
	raw, err := json.Marshal(parts)
	if err != nil {
		return jsonRaw(FlattenResponsesText(value))
	}
	return raw
}

// responsesImageURL is the URL of an input_image that Chat can carry: a data
// URL or a fetchable URL. A file_id reference has no Chat equivalent.
func responsesImageURL(item map[string]interface{}) string {
	if item == nil || item["type"] != "input_image" {
		return ""
	}
	switch url := item["image_url"].(type) {
	case string:
		return strings.TrimSpace(url)
	case map[string]interface{}:
		s, _ := url["url"].(string)
		return strings.TrimSpace(s)
	}
	return ""
}

func openAIResponsesTools(rawTools []json.RawMessage) []OpenAITool {
	tools := make([]OpenAITool, 0, len(rawTools))
	for _, raw := range rawTools {
		var tool map[string]interface{}
		if json.Unmarshal(raw, &tool) != nil || tool["type"] != "function" {
			continue
		}
		name, _ := tool["name"].(string)
		if name == "" {
			continue
		}
		decl := OpenAITool{Type: "function"}
		decl.Function.Name = name
		decl.Function.Description, _ = tool["description"].(string)
		params, ok := tool["parameters"].(map[string]interface{})
		if !ok {
			params = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
		}
		decl.Function.Parameters, _ = json.Marshal(params)
		tools = append(tools, decl)
	}
	return tools
}

// OpenAIChatToResponses converts a chat-completion response back to the
// Responses shape expected by Codex. Subscription endpoints such as
// WorkBuddy expose only chat/completions, while current Codex requires
// wire_api = "responses".
func OpenAIChatToResponses(res *OpenAIChatResponse, model string) *OpenAIResponsesResponse {
	if res == nil {
		return &OpenAIResponsesResponse{
			ID: "resp_" + RandomID(), Object: "response", CreatedAt: time.Now().Unix(),
			Status: "failed", Model: model, Output: []OpenAIResponseOutputItem{},
			ParallelToolCalls: true,
			Error:             map[string]string{"type": "server_error", "message": "empty upstream response"},
		}
	}
	if res.Error != nil {
		return &OpenAIResponsesResponse{
			ID: "resp_" + RandomID(), Object: "response", CreatedAt: time.Now().Unix(),
			Status: "failed", Model: model, Output: []OpenAIResponseOutputItem{},
			ParallelToolCalls: true, Error: res.Error,
		}
	}
	if model == "" {
		model = res.Model
	}
	out := &OpenAIResponsesResponse{
		ID:                "resp_" + res.ID,
		Object:            "response",
		CreatedAt:         time.Now().Unix(),
		Status:            "completed",
		Model:             model,
		Output:            []OpenAIResponseOutputItem{},
		ParallelToolCalls: true,
	}
	if out.ID == "resp_" {
		out.ID = "resp_" + RandomID()
	}

	if len(res.Choices) > 0 {
		items, status, details := openAIChatChoiceToResponses(res.Choices[0])
		out.Output = append(out.Output, items...)
		out.Status, out.IncompleteDetails = status, details
	}
	if len(out.Output) == 0 {
		out.Output = append(out.Output, OpenAIResponseOutputItem{
			ID: "msg_" + RandomID(), Type: "message", Status: "completed", Role: "assistant",
			Content: []OpenAIResponseContent{{
				Type: "output_text", Text: "", Annotations: []interface{}{}, Logprobs: []interface{}{},
			}},
		})
	}
	if res.Usage != nil {
		out.Usage = &OpenAIResponsesUsage{
			InputTokens:         res.Usage.PromptTokens,
			InputTokensDetails:  map[string]int{"cached_tokens": 0},
			OutputTokens:        res.Usage.CompletionTokens,
			OutputTokensDetails: map[string]int{"reasoning_tokens": 0},
			TotalTokens:         res.Usage.TotalTokens,
		}
	}
	return out
}

func openAIChatChoiceToResponses(choice OpenAIChatChoice) ([]OpenAIResponseOutputItem, string, map[string]string) {
	message := choice.Message
	output := make([]OpenAIResponseOutputItem, 0, 2+len(message.ToolCalls))
	if message.ReasoningContent != "" || message.ReasoningSignature != "" {
		item := OpenAIResponseOutputItem{
			ID: "rs_" + RandomID(), Type: "reasoning", Status: "completed",
		}
		if message.ReasoningContent != "" {
			item.Summary = []OpenAIResponseSummary{{Type: "summary_text", Text: message.ReasoningContent}}
		}
		item.EncryptedContent = message.ReasoningSignature
		output = append(output, item)
	}
	if text := MessageText(message); text != "" {
		output = append(output, OpenAIResponseOutputItem{
			ID: "msg_" + RandomID(), Type: "message", Status: "completed", Role: "assistant",
			Content: []OpenAIResponseContent{{
				Type: "output_text", Text: text,
				Annotations: []interface{}{}, Logprobs: []interface{}{},
			}},
		})
	}
	for _, call := range message.ToolCalls {
		output = append(output, OpenAIResponseOutputItem{
			ID: "fc_" + RandomID(), Type: "function_call", Status: "completed",
			CallID: call.ID, Name: call.Function.Name, Arguments: call.Function.Arguments,
		})
	}
	status := "completed"
	var details map[string]string
	if choice.FinishReason == "length" {
		status = "incomplete"
		details = map[string]string{"reason": "max_output_tokens"}
	}
	return output, status, details
}

// GeminiToOpenAIResponses translates a Gemini generateContent response into an
// OpenAI /v1/responses object. Ports geminiToOpenAIResponses
// (translate-responses.ts).
func GeminiToOpenAIResponses(res *GeminiGenerateResponse, model string) *OpenAIResponsesResponse {
	responseID := "resp_" + RandomID()
	output := make([]OpenAIResponseOutputItem, 0)
	parts := candidateParts(firstCandidate(res))
	reasoningText := ""
	reasoningSignature := ""
	for _, part := range parts {
		if part.Thought && part.Text != "" {
			reasoningText += part.Text
			if reasoningSignature == "" {
				reasoningSignature = part.ThoughtSignature
			}
		}
	}
	if reasoningText != "" || reasoningSignature != "" {
		item := OpenAIResponseOutputItem{
			ID:     "rs_" + RandomID(),
			Type:   "reasoning",
			Status: "completed",
		}
		if reasoningText != "" {
			item.Summary = []OpenAIResponseSummary{{Type: "summary_text", Text: reasoningText}}
		}
		item.EncryptedContent = reasoningSignature
		output = append(output, item)
	}
	text := ""
	for _, part := range parts {
		if !part.Thought && part.Text != "" {
			text += part.Text
		}
	}
	if text != "" {
		output = append(output, OpenAIResponseOutputItem{
			ID:     "msg_" + RandomID(),
			Type:   "message",
			Status: "completed",
			Role:   "assistant",
			Content: []OpenAIResponseContent{{
				Type: "output_text", Text: text, Annotations: []interface{}{}, Logprobs: []interface{}{},
			}},
		})
	}
	for _, part := range parts {
		if part.FunctionCall == nil || part.FunctionCall.Name == "" {
			continue
		}
		if part.ThoughtSignature != "" {
			output = append(output, OpenAIResponseOutputItem{
				ID:               "rs_fc_" + RandomID(),
				Type:             "reasoning",
				Status:           "completed",
				EncryptedContent: part.ThoughtSignature,
			})
		}
		args, _ := json.Marshal(orEmptyMap(part.FunctionCall.Args))
		output = append(output, OpenAIResponseOutputItem{
			ID:        "fc_" + RandomID(),
			Type:      "function_call",
			Status:    "completed",
			CallID:    "call_" + RandomID(),
			Name:      part.FunctionCall.Name,
			Arguments: string(args),
		})
	}
	if len(output) == 0 {
		output = append(output, OpenAIResponseOutputItem{
			ID:     "msg_" + RandomID(),
			Type:   "message",
			Status: "completed",
			Role:   "assistant",
			Content: []OpenAIResponseContent{{
				Type: "output_text", Text: "", Annotations: []interface{}{}, Logprobs: []interface{}{},
			}},
		})
	}
	maxTokens := firstCandidate(res) != nil && firstCandidate(res).FinishReason == "MAX_TOKENS"
	inputTokens := 0
	outputTokens := 0
	reasoningTokens := 0
	totalTokens := 0
	if res.UsageMetadata != nil {
		inputTokens = derefInt(res.UsageMetadata.PromptTokenCount)
		outputTokens = derefInt(res.UsageMetadata.CandidatesTokenCount)
		reasoningTokens = derefInt(res.UsageMetadata.ThoughtsTokenCount)
		totalTokens = derefInt(res.UsageMetadata.TotalTokenCount)
		if totalTokens == 0 {
			totalTokens = inputTokens + outputTokens
		}
	}
	status := "completed"
	var incompleteDetails interface{}
	if maxTokens {
		status = "incomplete"
		incompleteDetails = map[string]string{"reason": "max_output_tokens"}
	}
	return &OpenAIResponsesResponse{
		ID:                responseID,
		Object:            "response",
		CreatedAt:         time.Now().Unix(),
		Status:            status,
		Error:             nil,
		IncompleteDetails: incompleteDetails,
		Model:             model,
		Output:            output,
		ParallelToolCalls: true,
		Usage: &OpenAIResponsesUsage{
			InputTokens:         inputTokens,
			InputTokensDetails:  map[string]int{"cached_tokens": 0},
			OutputTokens:        outputTokens,
			OutputTokensDetails: map[string]int{"reasoning_tokens": reasoningTokens},
			TotalTokens:         totalTokens,
		},
	}
}

func allSystem(messages []OpenAIMessage) bool {
	if len(messages) == 0 {
		return false
	}
	for _, m := range messages {
		if m.Role != "system" {
			return false
		}
	}
	return true
}

func asString(v interface{}, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

func jsonRaw(s string) json.RawMessage {
	raw, _ := json.Marshal(s)
	return raw
}
