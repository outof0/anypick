import { randomBytes } from 'node:crypto';

/**
 * OpenAI Responses clients (including Codex) classify this exact error code as
 * a context-window overflow and use it to enter their compaction flow.
 */
export const CONTEXT_WINDOW_ERROR_CODE = 'context_length_exceeded';

export const OPENAI_CONTEXT_WINDOW_MESSAGE =
  'Your input exceeds the context window of this model. Please adjust your input and try again.';

/** Return true for provider error variants that mean the prompt is too large. */
export function isContextWindowError(raw: string): boolean {
  const payload = parseErrorPayload(raw);
  const error = jsonRecord(payload?.error);
  const response = jsonRecord(payload?.response);
  const responseError = jsonRecord(response?.error);
  if (
    error?.code === CONTEXT_WINDOW_ERROR_CODE ||
    error?.type === CONTEXT_WINDOW_ERROR_CODE ||
    payload?.code === CONTEXT_WINDOW_ERROR_CODE ||
    payload?.type === CONTEXT_WINDOW_ERROR_CODE ||
    responseError?.code === CONTEXT_WINDOW_ERROR_CODE ||
    responseError?.type === CONTEXT_WINDOW_ERROR_CODE
  ) {
    return true;
  }
  const message = errorMessage(payload, raw);
  return [
    // Keep this list in lockstep with OpenCode's provider overflow classifier.
    /prompt is too long/i,
    /input is too long for requested model/i,
    /exceeds the context window/i,
    /input token count.*exceeds the maximum/i,
    /tokens in request more than max tokens allowed/i,
    /maximum prompt length is \d+/i,
    /reduce the length of (?:the )?messages/i,
    /maximum context length is \d+ tokens/i,
    /exceeds the limit of \d+/i,
    /exceeds the available context size/i,
    /greater than the context length/i,
    /context window exceeds limit/i,
    /exceeded model token limit/i,
    /context[_ ]length[_ ]exceeded/i,
    /request entity too large/i,
    /context length is only \d+ tokens/i,
    /input length.*exceeds.*context length/i,
    /input length and max_tokens exceed context limit/i,
    /prompt too long; exceeded (?:max )?context length/i,
    /too large for model with \d+ maximum context length/i,
    /model_context_window_exceeded/i,
  ].some((pattern) => pattern.test(message));
}

/**
 * Convert a context overflow into the error envelope expected by the selected
 * compatibility protocol. The original upstream body is deliberately kept
 * out of the OpenAI message so Codex can match the stable error code/message.
 */
export async function normalizeContextWindowError(
  response: Response,
  protocol: 'openai' | 'anthropic',
): Promise<Response> {
  if (response.status !== 400 && response.status !== 413) {
    return response;
  }
  const raw = await response.clone().text();
  if (!isContextWindowError(raw)) {
    return response;
  }
  const body =
    protocol === 'openai'
      ? {
          error: {
            message: OPENAI_CONTEXT_WINDOW_MESSAGE,
            type: 'invalid_request_error',
            param: 'input',
            code: CONTEXT_WINDOW_ERROR_CODE,
          },
        }
      : anthropicContextWindowErrorBody(raw, response.headers.get('request-id') ?? undefined);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  if ('request_id' in body) {
    headers.set('request-id', body.request_id);
  }
  return new Response(JSON.stringify(body), {
    // Context overflow is an invalid request in both compatibility APIs. A
    // provider may use 413 for it, but Claude Code's reactive compactor and
    // OpenAI clients expect the canonical 400 contract.
    status: 400,
    headers,
  });
}

/**
 * Codex's Responses SSE parser maps `response.failed` with this code to its
 * ContextWindowExceeded error, which is the signal that triggers compaction.
 */
export function openAIResponsesContextWindowError(): Response {
  const data = {
    type: 'response.failed',
    sequence_number: 0,
    response: {
      id: `resp_context_${Date.now().toString(36)}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'failed',
      background: false,
      error: {
        code: CONTEXT_WINDOW_ERROR_CODE,
        message: OPENAI_CONTEXT_WINDOW_MESSAGE,
      },
      usage: null,
      user: null,
      metadata: {},
    },
  };
  return new Response(`event: response.failed\ndata: ${JSON.stringify(data)}\n\n`, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

interface ContextBudgetCounts {
  contextWindow: number;
  requestedOutputTokens?: number;
  inputTokens: number;
  totalTokens?: number;
}

function parseContextBudgetError(raw: string): ContextBudgetCounts | undefined {
  const parsed = parseErrorPayload(raw);
  const message = errorMessage(parsed, raw);
  const normalized = message.replace(/,/g, '');
  const arithmetic = normalized.match(
    /(?:context (?:limit|length)[^:]*:\s*)?(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i,
  );
  const contextWindow =
    arithmetic?.[3] ??
    normalized.match(/maximum context length is\s+(\d+)\s+tokens/i)?.[1] ??
    normalized.match(/maximum number of tokens allowed\s*\(?\s*(\d+)\s*\)?/i)?.[1] ??
    normalized.match(/context length is only\s+(\d+)\s+tokens/i)?.[1] ??
    normalized.match(/context (?:limit|length)[^\d]*(\d+)\s*(?:tokens?)?/i)?.[1];
  const requestedOutputTokens =
    arithmetic?.[2] ??
    normalized.match(/requested\s+(\d+)\s+output tokens/i)?.[1] ??
    normalized.match(/requested\s+output tokens?\s*[:=]?\s*(\d+)/i)?.[1] ??
    normalized.match(/max_tokens\s*[:=]?\s*(\d+)/i)?.[1];
  const inputTokens =
    arithmetic?.[1] ??
    normalized.match(/prompt contains(?:\s+at least)?\s+(\d+)\s+input tokens/i)?.[1] ??
    normalized.match(/input token count\s*\(?\s*(\d+)\s*\)?/i)?.[1] ??
    normalized.match(/(?:input tokens?|input length|input)\s*[:=]?\s*(\d+)/i)?.[1];
  const totalTokens =
    normalized.match(/total of(?:\s+at least)?\s+(\d+)\s+tokens/i)?.[1] ??
    (arithmetic ? String(Number(arithmetic[1]) + Number(arithmetic[2])) : undefined);
  const derivedInput =
    inputTokens ??
    (totalTokens && requestedOutputTokens
      ? String(Number(totalTokens) - Number(requestedOutputTokens))
      : undefined);
  if (!contextWindow || !derivedInput) {
    return undefined;
  }
  return {
    contextWindow: Number(contextWindow),
    inputTokens: Number(derivedInput),
    ...(requestedOutputTokens ? { requestedOutputTokens: Number(requestedOutputTokens) } : {}),
    ...(totalTokens ? { totalTokens: Number(totalTokens) } : {}),
  };
}

function parseErrorPayload(raw: string): Record<string, unknown> | undefined {
  try {
    return jsonRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function errorMessage(payload: Record<string, unknown> | undefined, fallback: string): string {
  const error = jsonRecord(payload?.error);
  if (typeof error?.message === 'string') {
    return error.message;
  }
  const response = jsonRecord(payload?.response);
  const responseError = jsonRecord(response?.error);
  if (typeof responseError?.message === 'string') {
    return responseError.message;
  }
  if (typeof payload?.message === 'string') {
    return payload.message;
  }
  return fallback;
}

export function anthropicContextWindowMessage(raw: string): string {
  const detail = errorMessage(parseErrorPayload(raw), raw).trim();
  const canonical = detail.match(/prompt is too long:\s*(\d+)\s+tokens\s*>\s*(\d+)\s+maximum/i);
  if (canonical) {
    return `prompt is too long: ${canonical[1]} tokens > ${canonical[2]} maximum`;
  }
  const counts = parseContextBudgetError(raw);
  if (counts) {
    // Claude Code parses the left-hand count as the *total request size*
    // (input plus the requested output budget), not input tokens alone. When
    // a provider gives us an explicit total, prefer it; otherwise derive the
    // same value from the two components before emitting Claude's canonical
    // form. This numeric gap seeds Claude's reactive-compaction strategy.
    const totalTokens =
      counts.totalTokens ??
      (counts.requestedOutputTokens != null
        ? counts.inputTokens + counts.requestedOutputTokens
        : counts.inputTokens);
    if (Number.isSafeInteger(totalTokens) && totalTokens > 0) {
      return `prompt is too long: ${totalTokens} tokens > ${counts.contextWindow} maximum`;
    }
  }
  if (detail && detail.length <= 800) {
    // Keep the phrase Claude Code recognizes, while preserving a short
    // provider hint for humans. Never echo arbitrarily large upstream bodies.
    return `prompt is too long: input exceeds this model's context window maximum. ${detail}`;
  }
  return "prompt is too long: input exceeds this model's context window maximum. Please use /compact or reduce the input and try again.";
}

/** Build the standard Anthropic HTTP error envelope used by Claude Code. */
export function anthropicContextWindowErrorBody(
  raw: string,
  requestId?: string,
): {
  type: 'error';
  error: {
    type: 'invalid_request_error';
    code: typeof CONTEXT_WINDOW_ERROR_CODE;
    message: string;
  };
  request_id: string;
} {
  const payload = parseErrorPayload(raw);
  const upstreamRequestId =
    typeof payload?.request_id === 'string' && payload.request_id.trim()
      ? payload.request_id.trim()
      : undefined;
  const resolvedRequestId = requestId?.trim() || upstreamRequestId || newAnthropicRequestId();
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: CONTEXT_WINDOW_ERROR_CODE,
      message: anthropicContextWindowMessage(raw),
    },
    request_id: resolvedRequestId,
  };
}

function newAnthropicRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
