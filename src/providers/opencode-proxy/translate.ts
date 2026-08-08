import type { ServerResponse } from 'node:http';
import {
  anthropicToOpenAI,
  sanitizeJsonSchema,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
} from '../protocol/anthropic';
import { reasoningFromAnthropic } from '../reasoning';
import { CONTEXT_WINDOW_ERROR_CODE, anthropicContextWindowErrorBody } from './context-budget';
import { json } from './http';
import type { AnthropicResult, OpenAIResponsesResult } from './types';

export function anthropicToResponses(req: AnthropicMessageRequest): Record<string, unknown> {
  const chat = anthropicToOpenAI(req, { agentHints: false });
  const reasoningIntent = reasoningFromAnthropic(req);
  const input: Array<Record<string, unknown>> = [];
  let instructions = '';
  for (const message of chat.messages) {
    const content = flattenOpenAIContent(message.content);
    if (message.role === 'system') {
      instructions = [instructions, content].filter(Boolean).join('\n\n');
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: content });
      continue;
    }
    // The Responses API requires reasoning from previous assistant turns to be
    // passed back verbatim; omitting it triggers an invalid_request_error.
    if (message.role === 'assistant' && message.reasoning_content) {
      input.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: message.reasoning_content }],
        ...(message.reasoning_signature ? { signature: message.reasoning_signature } : {}),
      });
    }
    if (content) {
      input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return {
    model: req.model,
    input,
    ...(instructions ? { instructions } : {}),
    max_output_tokens: req.max_tokens,
    stream: false,
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.top_p != null ? { top_p: req.top_p } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: sanitizeJsonSchema(tool.input_schema ?? { type: 'object', properties: {} }),
          })),
        }
      : {}),
    ...(chat.tool_choice != null ? { tool_choice: chat.tool_choice } : {}),
    ...(chat.reasoning_effort
      ? {
          reasoning: {
            effort: chat.reasoning_effort,
            ...(reasoningIntent.includeSummary ? { summary: 'auto' } : {}),
          },
        }
      : {}),
  };
}

export function responsesToAnthropic(
  response: OpenAIResponsesResult,
  fallbackModel: string,
  inputTokensFallback = 0,
): AnthropicResult {
  if (response.error) {
    return {
      type: 'error',
      error: {
        type:
          response.error.code === 'context_length_exceeded'
            ? 'invalid_request_error'
            : (response.error.type ?? 'api_error'),
        message: response.error.message ?? 'OpenAI Responses upstream error',
        ...(response.error.code ? { code: response.error.code } : {}),
      },
    };
  }
  const content: AnthropicMessageResponse['content'] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'reasoning') {
      const thinking = (item.summary ?? item.content ?? []).map((part) => part.text ?? '').join('');
      if (thinking) {
        content.push({ type: 'thinking', thinking, signature: '' });
      }
      continue;
    }
    if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? `call_${Date.now().toString(36)}`,
        name: item.name ?? 'tool',
        input: safeJsonValue(item.arguments),
      });
      continue;
    }
    const text = (item.content ?? [])
      .filter((part) => part.type === 'output_text' || part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    if (text) {
      content.push({ type: 'text', text });
    }
  }
  if (content.length === 0 && response.output_text) {
    content.push({ type: 'text', text: response.output_text });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  const hasTools = content.some((block) => block.type === 'tool_use');
  const outputFallback = estimateOutputTokens(content);
  return {
    id: response.id?.startsWith('msg_')
      ? response.id
      : `msg_${response.id ?? Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: response.model ?? fallbackModel,
    content,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokenCountOrFallback(response.usage?.input_tokens, inputTokensFallback),
      output_tokens: tokenCountOrFallback(response.usage?.output_tokens, outputFallback),
    },
  };
}

export function sendAnthropicResult(
  res: ServerResponse,
  result: AnthropicResult,
  stream: boolean,
): void {
  if (result.type === 'error') {
    if (result.error.code === CONTEXT_WINDOW_ERROR_CODE) {
      const body = anthropicContextWindowErrorBody(JSON.stringify(result));
      res.setHeader('request-id', body.request_id);
      json(res, 400, body);
    } else {
      json(res, 502, result);
    }
    return;
  }
  if (!stream) {
    json(res, 200, result);
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  writeAnthropicSse(res, 'message_start', {
    type: 'message_start',
    message: {
      ...result,
      content: [],
      stop_reason: null,
      usage: { ...result.usage, output_tokens: 0 },
    },
  });
  result.content.forEach((block, index) => {
    const contentBlock =
      block.type === 'tool_use'
        ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
        : block.type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: block.signature ?? '' }
          : block.type === 'redacted_thinking'
            ? block
            : { type: 'text', text: '' };
    writeAnthropicSse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    });
    if (block.type === 'tool_use') {
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else if (block.type === 'thinking' && block.thinking) {
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
    } else if (block.type === 'text' && block.text) {
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    }
    writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  writeAnthropicSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: result.stop_reason, stop_sequence: result.stop_sequence },
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  });
  writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function tokenCountOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : Math.max(0, Math.floor(fallback));
}

function inputTokenCountOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Math.max(0, Math.floor(fallback));
}

function estimateOutputTokens(content: AnthropicMessageResponse['content']): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text') {
      chars += block.text.length;
    } else if (block.type === 'thinking') {
      chars += block.thinking.length;
    } else if (block.type === 'tool_use') {
      chars += block.name.length + JSON.stringify(block.input ?? {}).length;
    }
  }
  return Math.ceil(chars / 4);
}

function writeAnthropicSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function flattenOpenAIContent(
  content: string | null | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
}

function safeJsonValue(value: string | undefined): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { value };
  }
}
