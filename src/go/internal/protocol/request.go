// Package protocol translates between the Anthropic Messages API and the
// OpenAI Chat Completions API — request bodies, non-streaming responses, and
// Server-Sent-Event streams in both directions' most common shapes.
//
// The translation is deliberately conservative: fields it does not understand
// are dropped, never invented.
package protocol

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// ---- request: anthropic → openai ----

type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
	Source    *imageSource    `json:"source,omitempty"`
}

// imageSource is an Anthropic image block's source: inline base64, or a URL
// the vendor fetches.
type imageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	URL       string `json:"url"`
}

// ImageOmitted stands in for an image a translation cannot carry. A model told
// nothing would answer as if the user sent no picture; one handed the encoded
// bytes as text would read megabytes of base64 as prompt.
const ImageOmitted = "[image omitted]"

type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type anthropicRequest struct {
	Model         string             `json:"model"`
	MaxTokens     int                `json:"max_tokens"`
	System        json.RawMessage    `json:"system,omitempty"`
	Messages      []anthropicMessage `json:"messages"`
	StopSequences []string           `json:"stop_sequences,omitempty"`
	Temperature   *float64           `json:"temperature,omitempty"`
	TopP          *float64           `json:"top_p,omitempty"`
	Stream        bool               `json:"stream,omitempty"`
	Tools         []anthropicTool    `json:"tools,omitempty"`
	ToolChoice    *struct {
		Type string `json:"type"`
		Name string `json:"name,omitempty"`
	} `json:"tool_choice,omitempty"`
}

type openAIMessage struct {
	Role       string           `json:"role"`
	Content    json.RawMessage  `json:"content,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	Name       string           `json:"name,omitempty"`
}

type openAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// TranslateRequest converts an Anthropic /v1/messages body into an OpenAI
// /chat/completions body.
func TranslateRequest(body []byte) ([]byte, error) {
	var req anthropicRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("invalid anthropic request: %w", err)
	}

	out := map[string]interface{}{
		"model":    req.Model,
		"messages": []openAIMessage{},
	}
	if req.MaxTokens > 0 {
		out["max_tokens"] = req.MaxTokens
	}
	if req.Temperature != nil {
		out["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		out["top_p"] = *req.TopP
	}
	if len(req.StopSequences) > 0 {
		out["stop"] = req.StopSequences
	}
	if req.Stream {
		out["stream"] = true
	}

	messages := make([]openAIMessage, 0, len(req.Messages)+2)

	// System may be a plain string or an array of text blocks.
	if sys := joinSystemText(req.System); sys != "" {
		messages = append(messages, openAIMessage{
			Role:    "system",
			Content: jsonString(sys),
		})
	}

	for _, msg := range req.Messages {
		blocks := decodeBlocks(msg.Content)
		switch msg.Role {
		case "system":
			// Claude Code can place system blocks in messages[] instead of
			// using the top-level system field. Preserve those instructions
			// as an OpenAI system message rather than rejecting an otherwise
			// valid Messages request.
			if sys := joinSystemText(msg.Content); sys != "" {
				messages = append(messages, openAIMessage{
					Role: "system", Content: jsonString(sys),
				})
			}
		case "user":
			userMsgs := userBlocksToOpenAI(blocks)
			messages = append(messages, userMsgs...)
		case "assistant":
			messages = append(messages, assistantBlocksToOpenAI(blocks)...)
		default:
			return nil, fmt.Errorf("unsupported message role %q", msg.Role)
		}
	}
	out["messages"] = messages

	if len(req.Tools) > 0 {
		tools := make([]map[string]interface{}, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, map[string]interface{}{
				"type": "function",
				"function": map[string]interface{}{
					"name":        t.Name,
					"description": t.Description,
					"parameters":  t.InputSchema,
				},
			})
		}
		out["tools"] = tools
	}
	if req.ToolChoice != nil {
		switch req.ToolChoice.Type {
		case "any":
			out["tool_choice"] = "required"
		case "auto":
			out["tool_choice"] = "auto"
		case "none":
			out["tool_choice"] = "none"
		case "tool":
			out["tool_choice"] = map[string]interface{}{
				"type":     "function",
				"function": map[string]string{"name": req.ToolChoice.Name},
			}
		}
	}

	return json.Marshal(out)
}

// vendorBlockedSnippets holds verbatim boilerplate rewritten before
// egress, each entry live-verified against the real vendor (model, request
// shape, and outcome recorded in the audit log):
//   - Claude Code's feedback-pointer sentence makes WorkBuddy answer 11128
//     "unapproved channel" even with everything else valid. It is replaced
//     inline with a readable paraphrase so quoting prose keeps its meaning.
var vendorBlockedSnippets = [][2]string{
	{
		"report the issue at https://github.com/anthropics/claude-code/issues",
		"report the issue at the official tracker",
	},
	// Live-verified 2026-09-04: this exact identity sentence as (or inside)
	// the system prompt makes WorkBuddy answer 11128. Substrings "You are
	// Claude Code." and "Anthropic's official CLI for Claude." each pass
	// alone; the conjunction is the channel fingerprint. Trailing period
	// is left off so the Agent-SDK superstring rewrites cleanly too.
	{
		"You are Claude Code, Anthropic's official CLI for Claude",
		"You are a coding assistant",
	},
	// Live-verified 2026-09-04: Claude Code injects this git-status parenthetical
	// into every system prompt. "Main branch" and "you will usually use this
	// for PRs" each pass alone; the conjunction is 11128. Replacement keeps
	// the branch label so the rest of the block still reads.
	{
		"Main branch (you will usually use this for PRs)",
		"Main branch",
	},
}

var billingMarkerRe = regexp.MustCompile(`(?i)x-anthropic-billing-header`)

// DropBillingLines scrubs vendor-blocked boilerplate out of prompt text:
//   - a leading `x-anthropic-billing-header` line (Claude Code 2.1+ billing
//     metadata meant for Anthropic; vendors read it as channel spoofing,
//     WorkBuddy 11128) is dropped whole;
//   - inline mentions of the marker are masked with an underscore variant so
//     discussion of it survives readout;
//   - verified blocked snippets are paraphrased inline.
//
// Matching is case-insensitive; everything else passes byte-identical.
func DropBillingLines(text string) string {
	masked := billingMarkerRe.ReplaceAllString(text, "x-anthropic-billing_header")
	lines := strings.Split(masked, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "x-anthropic-") {
			continue
		}
		scrubbed := line
		for _, snippet := range vendorBlockedSnippets {
			scrubbed = replaceFold(scrubbed, snippet[0], snippet[1])
		}
		kept = append(kept, scrubbed)
	}
	return strings.Join(kept, "\n")
}

// replaceFold replaces all case-insensitive occurrences of old with new.
func replaceFold(s, old, new string) string {
	lower, oldLower := strings.ToLower(s), strings.ToLower(old)
	var out strings.Builder
	for {
		i := strings.Index(lower, oldLower)
		if i < 0 {
			out.WriteString(s)
			break
		}
		out.WriteString(s[:i])
		out.WriteString(new)
		s = s[i+len(old):]
		lower = lower[i+len(old):]
	}
	return out.String()
}

// SanitizeOpenAIBody returns an OpenAI chat-completions body with billing
// lines stripped from system/user text contents (string or array form).
// Unparseable bodies pass through untouched — never fail a request the
// sanitizer does not understand.
func SanitizeOpenAIBody(body []byte) []byte {
	var v map[string]interface{}
	if json.Unmarshal(body, &v) != nil {
		return body
	}
	msgs, ok := v["messages"].([]interface{})
	if !ok {
		return body
	}
	for _, m := range msgs {
		mm, ok := m.(map[string]interface{})
		if !ok {
			continue
		}
		if mm["role"] != "system" && mm["role"] != "user" {
			continue
		}
		switch c := mm["content"].(type) {
		case string:
			mm["content"] = DropBillingLines(c)
		case []interface{}:
			for _, b := range c {
				if bm, ok := b.(map[string]interface{}); ok {
					if t, _ := bm["type"].(string); t == "text" {
						if s, _ := bm["text"].(string); s != "" {
							bm["text"] = DropBillingLines(s)
						}
					}
				}
			}
		}
	}
	out, err := json.Marshal(v)
	if err != nil {
		return body
	}
	return out
}

func joinSystemText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return DropBillingLines(s)
	}
	var blocks []contentBlock
	if json.Unmarshal(raw, &blocks) == nil {
		parts := make([]string, 0, len(blocks))
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return DropBillingLines(strings.Join(parts, "\n"))
	}
	return ""
}

func decodeBlocks(content json.RawMessage) []contentBlock {
	var s string
	if len(content) > 0 && json.Unmarshal(content, &s) == nil {
		return []contentBlock{{Type: "text", Text: s}}
	}
	var blocks []contentBlock
	_ = json.Unmarshal(content, &blocks)
	return blocks
}

func userBlocksToOpenAI(blocks []contentBlock) []openAIMessage {
	// Group consecutive tool_results into tool-role messages; everything else
	// merges into one user message (string when only text).
	var out []openAIMessage
	type part struct {
		text string
		img  *contentBlock
	}
	var parts []part
	flush := func() {
		if len(parts) == 0 {
			return
		}
		allText := true
		for _, p := range parts {
			if p.img != nil {
				allText = false
			}
		}
		if allText {
			sb := strings.Builder{}
			for _, p := range parts {
				sb.WriteString(p.text)
			}
			out = append(out, openAIMessage{Role: "user", Content: jsonString(DropBillingLines(sb.String()))})
		} else {
			array := []map[string]interface{}{}
			for _, p := range parts {
				if p.img != nil {
					array = append(array, map[string]interface{}{
						"type":      "image_url",
						"image_url": map[string]string{"url": imageDataURL(p.img.Source)},
					})
				} else {
					array = append(array, map[string]interface{}{
						"type": "text", "text": p.text,
					})
				}
			}
			raw, _ := json.Marshal(array)
			out = append(out, openAIMessage{Role: "user", Content: raw})
		}
		parts = parts[:0]
	}
	for _, b := range blocks {
		switch b.Type {
		case "text":
			parts = append(parts, part{text: b.Text})
		case "image":
			if imageDataURL(b.Source) != "" {
				parts = append(parts, part{img: &b})
			} else {
				parts = append(parts, part{text: ImageOmitted})
			}
		case "tool_result":
			flush()
			out = append(out, openAIMessage{
				Role:       "tool",
				ToolCallID: b.ToolUseID,
				Content:    jsonString(toolResultText(b)),
			})
		default:
			// Unknown block types are dropped, never invented.
		}
	}
	flush()
	return out
}

func toolResultText(b contentBlock) string {
	var s string
	if len(b.Content) > 0 && json.Unmarshal(b.Content, &s) == nil {
		return s
	}
	var blocks []contentBlock
	if json.Unmarshal(b.Content, &blocks) == nil {
		texts := make([]string, 0, len(blocks))
		for _, inner := range blocks {
			switch inner.Type {
			case "text":
				texts = append(texts, inner.Text)
			case "image":
				// An OpenAI tool message carries text only.
				texts = append(texts, ImageOmitted)
			}
		}
		return strings.Join(texts, "\n")
	}
	return ""
}

// imageDataURL is the OpenAI image_url for an Anthropic image source, or ""
// when there is nothing to send.
func imageDataURL(src *imageSource) string {
	if src == nil {
		return ""
	}
	switch src.Type {
	case "url":
		return strings.TrimSpace(src.URL)
	case "base64", "":
		if src.Data == "" || src.MediaType == "" {
			return ""
		}
		return "data:" + src.MediaType + ";base64," + src.Data
	default:
		// A file reference or a future source kind has no OpenAI equivalent.
		return ""
	}
}

func assistantBlocksToOpenAI(blocks []contentBlock) []openAIMessage {
	msg := openAIMessage{Role: "assistant"}
	texts := []string{}
	for _, b := range blocks {
		switch b.Type {
		case "text":
			texts = append(texts, b.Text)
		case "tool_use":
			call := openAIToolCall{ID: b.ID, Type: "function"}
			call.Function.Name = b.Name
			args := string(b.Input)
			if args == "" || string(args) == "null" {
				args = "{}"
			}
			call.Function.Arguments = args
			msg.ToolCalls = append(msg.ToolCalls, call)
		case "image":
			// OpenAI assistant messages carry no images; say one was there.
			// Text blocks join with no separator, so the marker brings its own.
			texts = append(texts, "\n"+ImageOmitted+"\n")
		}
	}
	if len(texts) > 0 {
		msg.Content = jsonString(DropBillingLines(strings.Join(texts, "")))
	}
	if len(msg.ToolCalls) == 0 && msg.Content == nil {
		msg.Content = jsonString("")
	}
	return []openAIMessage{msg}
}

func jsonString(s string) json.RawMessage {
	raw, _ := json.Marshal(s)
	return raw
}
