import type {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicToOpenAIOptions,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
} from './anthropic-types';
import { anthropicToOpenAIEffort } from '../reasoning';
import {
  anthropicMessageToOpenAI,
  fixMissingToolResponses,
  flattenSystem,
  mapFinishReason,
  mapToolChoice,
  randomId,
  safeJsonParse,
} from './anthropic-helpers';
import { sanitizeJsonSchema } from './json-schema';

export function anthropicToOpenAI(
  req: AnthropicMessageRequest,
  options: AnthropicToOpenAIOptions = {},
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];
  const agentHints = options.agentHints !== false;

  const toolsArr = Array.isArray(req.tools) ? req.tools : [];
  const hasTools = toolsArr.length > 0;
  const toolNames = hasTools ? toolsArr.map((t) => t.name).filter(Boolean) : [];
  const hasEditTools = toolNames.some((n) => /^(Edit|Update|MultiEdit|Write)$/i.test(n));
  const editHint =
    agentHints && hasEditTools
      ? 'Proxy note for file edits: before using Edit, Update, or MultiEdit, copy old_string exactly from the latest file content, including whitespace and punctuation. Prefer one small replacement per tool call. If the exact old_string is uncertain, read or search the file again instead of guessing.'
      : '';
  const progressHint =
    agentHints && hasTools
      ? 'Proxy note for agent progress: do not end the turn while any visible task is still open or in_progress. Continue using tools until every task is completed, or explicitly report a concrete blocker. After a failed edit, read the file again and retry with a smaller exact replacement.'
      : '';

  const systemText = flattenSystem(req.system);
  if (systemText || editHint || progressHint) {
    messages.push({
      role: 'system',
      content: [systemText, editHint, progressHint].filter(Boolean).join('\n\n'),
    });
  }

  for (const msg of req.messages ?? []) {
    messages.push(...anthropicMessageToOpenAI(msg));
  }

  // OpenAI-compatible gateways reject or empty-complete when an assistant
  // tool_calls turn is missing matching tool messages.
  fixMissingToolResponses(messages);

  const out: OpenAIChatRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: Boolean(req.stream),
  };

  if (req.temperature != null) {
    out.temperature = req.temperature;
  }
  if (req.top_p != null) {
    out.top_p = req.top_p;
  }
  if (req.stop_sequences?.length) {
    out.stop = req.stop_sequences.length === 1 ? req.stop_sequences[0] : req.stop_sequences;
  }

  if (req.tools?.length) {
    // Drop null JSON-Schema keywords (esp. required:null) — strict OpenAI
    // gateways reject them even though Anthropic accepts the loose shape.
    out.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: sanitizeJsonSchema(t.input_schema ?? { type: 'object', properties: {} }),
      },
    }));
  }

  if (req.tool_choice != null) {
    out.tool_choice = mapToolChoice(req.tool_choice);
  }

  const reasoningEffort = anthropicToOpenAIEffort(req);
  if (reasoningEffort) {
    out.reasoning_effort = reasoningEffort;
  }

  return out;
}

/** Convert OpenAI chat completion → Anthropic message. */
export function openAIToAnthropic(
  res: OpenAIChatResponse,
  fallbackModel: string,
  inputTokensFallback = 0,
):
  | AnthropicMessageResponse
  | {
      type: 'error';
      error: { type: string; message: string; code?: string };
    } {
  if (res.error) {
    return {
      type: 'error',
      error: {
        type:
          res.error.code === 'context_length_exceeded'
            ? 'invalid_request_error'
            : (res.error.type ?? 'api_error'),
        message: res.error.message ?? 'Upstream error',
        ...(res.error.code ? { code: res.error.code } : {}),
      },
    };
  }

  const choice = res.choices?.[0];
  const message = choice?.message;
  const content: AnthropicMessageResponse['content'] = [];

  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }

  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (message?.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const outputFallback = estimateOutputTokens(content);

  return {
    id: res.id?.startsWith('msg_') ? res.id : `msg_${res.id ?? randomId()}`,
    type: 'message',
    role: 'assistant',
    model: res.model ?? fallbackModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason, Boolean(message?.tool_calls?.length)),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokenCountOrFallback(res.usage?.prompt_tokens, inputTokensFallback),
      output_tokens: tokenCountOrFallback(res.usage?.completion_tokens, outputFallback),
    },
  };
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
