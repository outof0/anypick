/**
 * OpenAI Chat Completions + Anthropic Messages → Google Gemini generateContent.
 *
 * Scope: text + basic function/tool calls. Enough for Claude Code / Codex via Hotplug.
 */

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: unknown };
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
    thinkingConfig?: {
      includeThoughts?: boolean;
      thinkingBudget?: number;
      thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
    };
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
}

export interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { message?: string; status?: string; code?: number };
}

export interface OpenAIResponsesRequest {
  model?: string;
  input?: string | Array<Record<string, unknown>> | OpenAIResponseOutputItem[];
  instructions?: string;
  max_output_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  reasoning?: { effort?: string; summary?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface OpenAIResponseOutputItem {
  id: string;
  type: 'reasoning' | 'message' | 'function_call' | 'function_call_output';
  status?: 'completed';
  summary?: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string | null;
  role?: 'assistant';
  content?: Array<{
    type: 'output_text';
    text: string;
    annotations: unknown[];
    logprobs: unknown[];
  }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
}

export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete';
  error: null;
  incomplete_details: { reason: 'max_output_tokens' } | null;
  model: string;
  output: OpenAIResponseOutputItem[];
  parallel_tool_calls: boolean;
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  };
}

/** Invisible standard thinking block used to carry a function-call signature through Claude. */
export const TOOL_SIGNATURE_CARRIER = '\u200B';
/** Distinguishes a signature-only thought from a signature belonging to the next tool call. */
export const EMPTY_THOUGHT_CARRIER = '\u200C';
