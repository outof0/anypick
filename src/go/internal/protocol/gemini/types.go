// Package gemini implements the Gemini translation layer: OpenAI Chat
// Completions, Anthropic Messages, and OpenAI Responses become Gemini
// generateContent / streamGenerateContent requests, and Gemini responses
// become any of the three wire formats on the way back.
//
// Scope: text + basic function/tool calls — enough for Claude Code / Codex
// via AnyPick. Every converter is a pure function over decoded JSON so it can
// be unit-tested without a live upstream.
package gemini

import "encoding/json"

// Carriers round-trip Gemini thought signatures through a channel that does
// not have a native signature field (OpenAI tool_calls, Anthropic thinking
// blocks). They are invisible zero-width characters; the thinking converter
// documents the carrier scheme.
const (
	// ToolSignatureCarrier is an invisible standard thinking block used to
	// carry a function-call signature through Claude.
	ToolSignatureCarrier = "\u200b"
	// EmptyThoughtCarrier distinguishes a signature-only thought from a
	// signature belonging to the next tool call.
	EmptyThoughtCarrier = "\u200c"
)

// GeminiPart is one content part of a Gemini generateContent request/response.
type GeminiPart struct {
	Text             string                  `json:"text,omitempty"`
	Thought          bool                    `json:"thought,omitempty"`
	ThoughtSignature string                  `json:"thoughtSignature,omitempty"`
	FunctionCall     *GeminiFunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *GeminiFunctionResponse `json:"functionResponse,omitempty"`
}

// GeminiFunctionCall is a Gemini tool invocation.
type GeminiFunctionCall struct {
	Name string                 `json:"name"`
	Args map[string]interface{} `json:"args,omitempty"`
}

// GeminiFunctionResponse is a Gemini tool result.
type GeminiFunctionResponse struct {
	Name     string      `json:"name"`
	Response interface{} `json:"response,omitempty"`
}

// GeminiContent is one turn of a Gemini conversation.
type GeminiContent struct {
	Role  string       `json:"role,omitempty"` // "user" | "model"
	Parts []GeminiPart `json:"parts"`
}

// GeminiThinkingConfig controls Gemini 2.5 (token budget) vs 3+ (level).
type GeminiThinkingConfig struct {
	IncludeThoughts bool   `json:"includeThoughts,omitempty"`
	ThinkingBudget  *int   `json:"thinkingBudget,omitempty"`
	ThinkingLevel   string `json:"thinkingLevel,omitempty"` // MINIMAL|LOW|MEDIUM|HIGH
}

// GeminiGenerationConfig is the generationConfig block.
type GeminiGenerationConfig struct {
	MaxOutputTokens *int                  `json:"maxOutputTokens,omitempty"`
	Temperature     *float64              `json:"temperature,omitempty"`
	TopP            *float64              `json:"topP,omitempty"`
	StopSequences   []string              `json:"stopSequences,omitempty"`
	ThinkingConfig  *GeminiThinkingConfig `json:"thinkingConfig,omitempty"`
}

// GeminiGenerateRequest is a Gemini generateContent body.
type GeminiGenerateRequest struct {
	Contents          []GeminiContent         `json:"contents"`
	SystemInstruction *GeminiContent          `json:"systemInstruction,omitempty"`
	GenerationConfig  *GeminiGenerationConfig `json:"generationConfig,omitempty"`
	Tools             []GeminiTool            `json:"tools,omitempty"`
	// SessionID is the Code Assist session id; only emitted inside the OAuth
	// envelope (GeminiCodeAssistEnvelope.Request), never in API-key mode.
	SessionID string `json:"session_id,omitempty"`
}

// GeminiCodeAssistEnvelope wraps a generateContent body for the OAuth/Code
// Assist upstream (cloudcode-pa / antigravity): { model, project,
// user_prompt_id, request: { ...generateContent, session_id } }.
type GeminiCodeAssistEnvelope struct {
	Model        string                 `json:"model"`
	Project      string                 `json:"project"`
	UserPromptID string                 `json:"user_prompt_id"`
	Request      *GeminiGenerateRequest `json:"request"`
}

// GeminiTool wraps function declarations.
type GeminiTool struct {
	FunctionDeclarations []GeminiFunctionDeclaration `json:"functionDeclarations"`
}

// GeminiFunctionDeclaration is one tool schema (already Gemini-sanitized).
type GeminiFunctionDeclaration struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
}

// GeminiGenerateResponse is a Gemini generateContent response.
type GeminiGenerateResponse struct {
	Candidates    []GeminiCandidate    `json:"candidates,omitempty"`
	UsageMetadata *GeminiUsageMetadata `json:"usageMetadata,omitempty"`
	Error         *GeminiError         `json:"error,omitempty"`
}

// GeminiCandidate is one response candidate.
type GeminiCandidate struct {
	Content      *GeminiContent `json:"content,omitempty"`
	FinishReason string         `json:"finishReason,omitempty"`
}

// GeminiUsageMetadata is token accounting.
type GeminiUsageMetadata struct {
	PromptTokenCount     *int `json:"promptTokenCount,omitempty"`
	CandidatesTokenCount *int `json:"candidatesTokenCount,omitempty"`
	TotalTokenCount      *int `json:"totalTokenCount,omitempty"`
	ThoughtsTokenCount   *int `json:"thoughtsTokenCount,omitempty"`
}

// GeminiError is a Gemini error payload.
type GeminiError struct {
	Message string `json:"message,omitempty"`
	Status  string `json:"status,omitempty"`
	Code    *int   `json:"code,omitempty"`
}

// ---- OpenAI Chat Completions shapes (subset we translate) ----

// OpenAIMessage is one chat message.
type OpenAIMessage struct {
	Role               string           `json:"role"`
	Content            json.RawMessage  `json:"content,omitempty"`
	Name               string           `json:"name,omitempty"`
	ToolCalls          []OpenAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID         string           `json:"tool_call_id,omitempty"`
	ReasoningContent   string           `json:"reasoning_content,omitempty"`
	ReasoningSignature string           `json:"reasoning_signature,omitempty"`
}

// OpenAIToolCall is one assistant tool invocation.
type OpenAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
	// ThoughtSignature carries a Gemini thought signature that belongs to this
	// tool call (restored from the invisible carrier on the way in).
	ThoughtSignature string `json:"thought_signature,omitempty"`
}

// OpenAITool is one chat tool declaration.
type OpenAITool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters,omitempty"`
	} `json:"function"`
}

// OpenAIChatRequest is a /v1/chat/completions body (subset we translate).
type OpenAIChatRequest struct {
	Model           string          `json:"model"`
	Messages        []OpenAIMessage `json:"messages"`
	MaxTokens       *int            `json:"max_tokens,omitempty"`
	Temperature     *float64        `json:"temperature,omitempty"`
	TopP            *float64        `json:"top_p,omitempty"`
	Stop            json.RawMessage `json:"stop,omitempty"` // string | []string
	Tools           []OpenAITool    `json:"tools,omitempty"`
	ToolChoice      json.RawMessage `json:"tool_choice,omitempty"`
	Stream          bool            `json:"stream,omitempty"`
	StreamOptions   json.RawMessage `json:"stream_options,omitempty"`
	ReasoningEffort string          `json:"reasoning_effort,omitempty"`
	Reasoning       json.RawMessage `json:"reasoning,omitempty"`
	Effort          string          `json:"effort,omitempty"`
}

// OpenAIChatResponse is a /v1/chat/completions response (subset we emit).
type OpenAIChatResponse struct {
	ID      string             `json:"id,omitempty"`
	Object  string             `json:"object,omitempty"`
	Model   string             `json:"model,omitempty"`
	Choices []OpenAIChatChoice `json:"choices,omitempty"`
	Usage   *OpenAIUsage       `json:"usage,omitempty"`
	Error   *OpenAIError       `json:"error,omitempty"`
}

// OpenAIChatChoice is one chat completion choice.
type OpenAIChatChoice struct {
	Index        int           `json:"index"`
	Message      OpenAIMessage `json:"message"`
	FinishReason string        `json:"finish_reason,omitempty"`
}

// OpenAIUsage is token accounting.
type OpenAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// OpenAIError is an error payload.
type OpenAIError struct {
	Message string `json:"message"`
	Type    string `json:"type,omitempty"`
	Code    string `json:"code,omitempty"`
}

// ---- Anthropic Messages shapes (subset we translate) ----

// AnthropicMessageRequest is a /v1/messages body (subset we translate).
type AnthropicMessageRequest struct {
	Model         string             `json:"model"`
	MaxTokens     *int               `json:"max_tokens,omitempty"`
	System        json.RawMessage    `json:"system,omitempty"`
	Messages      []AnthropicMessage `json:"messages"`
	StopSequences []string           `json:"stop_sequences,omitempty"`
	Temperature   *float64           `json:"temperature,omitempty"`
	TopP          *float64           `json:"top_p,omitempty"`
	Stream        bool               `json:"stream,omitempty"`
	Tools         []AnthropicTool    `json:"tools,omitempty"`
	ToolChoice    json.RawMessage    `json:"tool_choice,omitempty"`
	Thinking      json.RawMessage    `json:"thinking,omitempty"`
	OutputConfig  json.RawMessage    `json:"output_config,omitempty"`
}

// AnthropicMessage is one messages turn.
type AnthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// AnthropicTool is one messages tool declaration.
type AnthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// AnthropicContentBlock is one content block (decoded from Content).
type AnthropicContentBlock struct {
	Type             string          `json:"type"`
	Text             string          `json:"text,omitempty"`
	ID               string          `json:"id,omitempty"`
	Name             string          `json:"name,omitempty"`
	Input            json.RawMessage `json:"input,omitempty"`
	ToolUseID        string          `json:"tool_use_id,omitempty"`
	Thinking         string          `json:"thinking,omitempty"`
	Signature        string          `json:"signature,omitempty"`
	ThoughtSignature string          `json:"thought_signature,omitempty"`
}

// AnthropicMessageResponse is a /v1/messages response (subset we emit). When
// Type == "error", the error fields below carry the translated Gemini error and
// the caller should emit {"type":"error","error":{...}} instead of content.
type AnthropicMessageResponse struct {
	ID           string                  `json:"id,omitempty"`
	Type         string                  `json:"type,omitempty"`
	Role         string                  `json:"role,omitempty"`
	Model        string                  `json:"model,omitempty"`
	Content      []AnthropicContentBlock `json:"content,omitempty"`
	StopReason   string                  `json:"stop_reason,omitempty"`
	StopSequence *string                 `json:"stop_sequence,omitempty"`
	Usage        *AnthropicUsage         `json:"usage,omitempty"`

	errorType    string `json:"-"`
	errorMessage string `json:"-"`
	errorCode    string `json:"-"`
}

// AnthropicUsage is token accounting.
type AnthropicUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// ---- OpenAI Responses shapes (subset we translate) ----

// OpenAIResponsesRequest is a /v1/responses body (subset we translate).
type OpenAIResponsesRequest struct {
	Model           string            `json:"model,omitempty"`
	Input           json.RawMessage   `json:"input,omitempty"` // string | []item
	Instructions    string            `json:"instructions,omitempty"`
	MaxOutputTokens *int              `json:"max_output_tokens,omitempty"`
	Stream          bool              `json:"stream,omitempty"`
	Temperature     *float64          `json:"temperature,omitempty"`
	TopP            *float64          `json:"top_p,omitempty"`
	Tools           []json.RawMessage `json:"tools,omitempty"`
	ToolChoice      json.RawMessage   `json:"tool_choice,omitempty"`
	Reasoning       json.RawMessage   `json:"reasoning,omitempty"`
}

// OpenAIResponseOutputItem is one output item.
type OpenAIResponseOutputItem struct {
	ID               string                  `json:"id"`
	Type             string                  `json:"type"` // reasoning|message|function_call|function_call_output
	Status           string                  `json:"status,omitempty"`
	Summary          []OpenAIResponseSummary `json:"summary,omitempty"`
	EncryptedContent string                  `json:"encrypted_content,omitempty"`
	Role             string                  `json:"role,omitempty"`
	Content          []OpenAIResponseContent `json:"content,omitempty"`
	CallID           string                  `json:"call_id,omitempty"`
	Name             string                  `json:"name,omitempty"`
	Arguments        string                  `json:"arguments,omitempty"`
	Output           json.RawMessage         `json:"output,omitempty"`
}

// MarshalJSON always writes summary on a reasoning item. Codex requires the
// field and drops a reasoning item without it, and the item that carries a
// tool call's thought signature has no summary text: with the field omitted
// the signature never came back, and Gemini rejected the next tool turn for a
// functionCall missing its thought_signature.
func (item OpenAIResponseOutputItem) MarshalJSON() ([]byte, error) {
	type plain OpenAIResponseOutputItem
	if item.Type != "reasoning" {
		return json.Marshal(plain(item))
	}
	summary := item.Summary
	if summary == nil {
		summary = []OpenAIResponseSummary{}
	}
	return json.Marshal(struct {
		plain
		Summary []OpenAIResponseSummary `json:"summary"`
	}{plain(item), summary})
}

// OpenAIResponseSummary is a reasoning summary entry.
type OpenAIResponseSummary struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// OpenAIResponseContent is a message content entry.
type OpenAIResponseContent struct {
	Type        string        `json:"type"`
	Text        string        `json:"text,omitempty"`
	Annotations []interface{} `json:"annotations,omitempty"`
	Logprobs    []interface{} `json:"logprobs,omitempty"`
}

// OpenAIResponsesResponse is a /v1/responses response (subset we emit).
type OpenAIResponsesResponse struct {
	ID                string                     `json:"id"`
	Object            string                     `json:"object"`
	CreatedAt         int64                      `json:"created_at"`
	Status            string                     `json:"status"`
	Error             interface{}                `json:"error"`
	IncompleteDetails interface{}                `json:"incomplete_details"`
	Model             string                     `json:"model"`
	Output            []OpenAIResponseOutputItem `json:"output"`
	ParallelToolCalls bool                       `json:"parallel_tool_calls"`
	Usage             *OpenAIResponsesUsage      `json:"usage"`
}

// OpenAIResponsesUsage is token accounting.
type OpenAIResponsesUsage struct {
	InputTokens         int            `json:"input_tokens"`
	InputTokensDetails  map[string]int `json:"input_tokens_details"`
	OutputTokens        int            `json:"output_tokens"`
	OutputTokensDetails map[string]int `json:"output_tokens_details"`
	TotalTokens         int            `json:"total_tokens"`
}
