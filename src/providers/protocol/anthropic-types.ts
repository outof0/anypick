export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  metadata?: { user_id?: string };
  thinking?: {
    type: 'enabled' | 'adaptive' | 'disabled';
    budget_tokens?: number;
    display?: 'summarized' | 'omitted';
    [k: string]: unknown;
  };
  output_config?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
      [k: string]: unknown;
    }
  | { type: 'redacted_thinking'; data?: string; [k: string]: unknown }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      [k: string]: unknown;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?: string | AnthropicContentBlock[];
      is_error?: boolean;
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  reasoning?: { effort?: string; summary?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<{ type: string; text?: string; [k: string]: unknown }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
  reasoning_signature?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Gemini stateless reasoning state associated with this exact call. */
  thought_signature?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatResponse {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_signature?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
  [k: string]: unknown;
}

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'redacted_thinking'; data?: string }
    | { type: 'text'; text: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: unknown;
        /** Opaque Gemini metadata; ignored by native Anthropic clients. */
        thought_signature?: string;
      }
  >;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicToOpenAIOptions {
  /**
   * Inject extra agent/edit system hints (Grok proxy defaults).
   * OpenCode free models thrash tools under these prompts — disable there.
   * @default true
   */
  agentHints?: boolean;
}

/** Convert Anthropic /v1/messages body → OpenAI /v1/chat/completions body. */

export interface PipeOpenAIStreamOptions {
  /** Abort if no meaningful content for this many ms (OpenCode free models stall). */
  idleMs?: number;
  /** External abort (client disconnect). */
  signal?: AbortSignal;
  /**
   * If true (default), a finished stream with zero text and zero tool_use throws
   * with code EMPTY_STREAM so the proxy can retry instead of Claude "stopping".
   */
  rejectEmpty?: boolean;
  /**
   * Best-effort input-token count to publish before an OpenAI-compatible
   * stream emits its terminal usage chunk. OpenAI Chat providers commonly
   * send usage only in the final chunk, while Anthropic clients need the
   * count in `message_start` to drive their context accounting.
   */
  inputTokens?: number;
  /** Normalize provider-specific SSE errors for the downstream protocol. */
  mapError?: (error: AnthropicStreamError) => AnthropicStreamError;
}

export interface AnthropicStreamError {
  type: string;
  message: string;
  code?: string;
}

export interface PipeOpenAIStreamResult {
  hadText: boolean;
  hadThinking: boolean;
  hadTools: boolean;
  empty: boolean;
  stopReason: AnthropicMessageResponse['stop_reason'];
  /** Token usage observed while translating the stream. */
  usage?: { input_tokens: number; output_tokens: number };
  /** A provider error delivered inside an otherwise-HTTP-200 SSE stream. */
  error?: AnthropicStreamError;
}
