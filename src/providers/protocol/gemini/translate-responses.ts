import type { OpenAIMessage, OpenAIChatRequest, OpenAITool } from '../anthropic';
import type {
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIResponseOutputItem,
} from './translate-types';
import { openAIToGemini } from './translate-chat';
import { flattenResponsesText, randomId } from './translate-shared';
import { isRecord } from './translate-schema';

/** Convert the OpenAI Responses wire format used by modern Codex to Gemini. */
export function openAIResponsesToGemini(
  req: OpenAIResponsesRequest,
  resolvedModel: string,
): GeminiGenerateRequest {
  const messages: OpenAIMessage[] = [];
  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  let pendingReasoning = '';
  let pendingSignature: string | undefined;
  const attachReasoning = (message: OpenAIMessage): OpenAIMessage => {
    if (pendingReasoning) {
      message.reasoning_content = pendingReasoning;
    }
    if (pendingSignature) {
      message.reasoning_signature = pendingSignature;
    }
    pendingReasoning = '';
    pendingSignature = undefined;
    return message;
  };

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
  } else {
    for (const item of req.input ?? []) {
      const type = typeof item.type === 'string' ? item.type : undefined;
      if (type === 'reasoning') {
        pendingReasoning = flattenResponsesText(item.summary ?? item.content);
        pendingSignature =
          typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined;
        continue;
      }
      if (type === 'function_call') {
        messages.push(
          attachReasoning({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id:
                  typeof item.call_id === 'string'
                    ? item.call_id
                    : typeof item.id === 'string'
                      ? item.id
                      : `call_${randomId()}`,
                type: 'function',
                function: {
                  name: typeof item.name === 'string' ? item.name : 'tool',
                  arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
                },
              },
            ],
          }),
        );
        continue;
      }
      if (type === 'function_call_output') {
        if (pendingReasoning) {
          messages.push(attachReasoning({ role: 'assistant', content: null }));
        }
        messages.push({
          role: 'tool',
          tool_call_id:
            typeof item.call_id === 'string'
              ? item.call_id
              : typeof item.id === 'string'
                ? item.id
                : `call_${randomId()}`,
          content: flattenResponsesText(item.output),
        });
        continue;
      }
      const rawRole = typeof item.role === 'string' ? item.role : 'user';
      const role: OpenAIMessage['role'] =
        rawRole === 'assistant'
          ? 'assistant'
          : rawRole === 'system' || rawRole === 'developer'
            ? 'system'
            : 'user';
      const message: OpenAIMessage = {
        role,
        content: flattenResponsesText(item.content),
      };
      messages.push(role === 'assistant' ? attachReasoning(message) : message);
    }
  }
  if (pendingReasoning) {
    messages.push(attachReasoning({ role: 'assistant', content: null }));
  }
  if (messages.every((message) => message.role === 'system')) {
    messages.push({ role: 'user', content: '' });
  }

  const chat: OpenAIChatRequest = {
    model: resolvedModel,
    messages,
    ...(req.max_output_tokens != null ? { max_tokens: req.max_output_tokens } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.top_p != null ? { top_p: req.top_p } : {}),
    ...(req.reasoning ? { reasoning: req.reasoning } : {}),
  };
  const functionTools = (req.tools ?? []).flatMap((tool): OpenAITool[] => {
    if (tool.type !== 'function' || typeof tool.name !== 'string') {
      return [];
    }
    return [
      {
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: isRecord(tool.parameters)
            ? tool.parameters
            : { type: 'object', properties: {} },
        },
      },
    ];
  });
  if (functionTools.length) {
    chat.tools = functionTools;
  }
  if (req.tool_choice != null) {
    chat.tool_choice = req.tool_choice;
  }
  return openAIToGemini(chat, resolvedModel);
}

/** Convert a Gemini result to a complete OpenAI Responses object. */
export function geminiToOpenAIResponses(
  res: GeminiGenerateResponse,
  model: string,
): OpenAIResponsesResponse {
  const responseId = `resp_${randomId()}`;
  const output: OpenAIResponseOutputItem[] = [];
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const reasoningText = parts
    .filter((part) => part.thought && part.text)
    .map((part) => part.text ?? '')
    .join('');
  const reasoningSignature = parts.find(
    (part) => part.thought && part.thoughtSignature,
  )?.thoughtSignature;
  if (reasoningText || reasoningSignature) {
    output.push({
      id: `rs_${randomId()}`,
      type: 'reasoning',
      status: 'completed',
      summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
      encrypted_content: reasoningSignature ?? null,
    });
  }
  const text = parts
    .filter((part) => !part.thought && part.text != null)
    .map((part) => part.text ?? '')
    .join('');
  if (text) {
    output.push({
      id: `msg_${randomId()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    });
  }
  for (const part of parts) {
    if (!part.functionCall?.name) {
      continue;
    }
    if (part.thoughtSignature) {
      // Responses has no Gemini-specific field on a function_call. A
      // signature-only reasoning item immediately before it survives Codex's
      // stateless history and is reattached to this exact call on input.
      output.push({
        id: `rs_fc_${randomId()}`,
        type: 'reasoning',
        status: 'completed',
        summary: [],
        encrypted_content: part.thoughtSignature,
      });
    }
    output.push({
      id: `fc_${randomId()}`,
      type: 'function_call',
      status: 'completed',
      call_id: `call_${randomId()}`,
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
    });
  }
  if (output.length === 0) {
    output.push({
      id: `msg_${randomId()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }],
    });
  }
  const maxTokens = res.candidates?.[0]?.finishReason === 'MAX_TOKENS';
  const inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = res.usageMetadata?.candidatesTokenCount ?? 0;
  const reasoningTokens = res.usageMetadata?.thoughtsTokenCount ?? 0;
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: maxTokens ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: maxTokens ? { reason: 'max_output_tokens' } : null,
    model,
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: res.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
    },
  };
}
