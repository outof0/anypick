import {
  anthropicToOpenAI,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
} from '../anthropic';
import { reasoningFromAnthropic } from '../../reasoning';
import { mapToGeminiModel } from './translate-models';
import { openAIToGemini } from './translate-chat';
import { applyGeminiThinkingConfig, restoreAnthropicThinkingHistory } from './translate-thinking';
import {
  TOOL_SIGNATURE_CARRIER,
  EMPTY_THOUGHT_CARRIER,
  type GeminiGenerateRequest,
  type GeminiGenerateResponse,
} from './translate-types';
import { mapGeminiFinishToAnthropic, randomId } from './translate-shared';

export function anthropicToGemini(
  req: AnthropicMessageRequest,
  resolvedModel?: string,
): {
  gemini: GeminiGenerateRequest;
  model: string;
} {
  const openai = anthropicToOpenAI(req);
  const gemini = openAIToGemini(openai, resolvedModel ?? req.model);
  applyGeminiThinkingConfig(gemini, reasoningFromAnthropic(req), resolvedModel ?? req.model);
  restoreAnthropicThinkingHistory(gemini, req);
  return {
    gemini,
    model: resolvedModel ?? mapToGeminiModel(req.model),
  };
}

export function geminiToAnthropic(
  res: GeminiGenerateResponse,
  model: string,
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
        type: res.error.status ?? 'api_error',
        message: res.error.message ?? 'Gemini error',
        ...(res.error.code != null ? { code: String(res.error.code) } : {}),
      },
    };
  }
  const candidate = res.candidates?.[0];
  const content: AnthropicMessageResponse['content'] = [];
  const parts = candidate?.content?.parts ?? [];
  for (const part of parts) {
    if (part.text != null) {
      if (part.thought) {
        content.push({
          type: 'thinking',
          thinking: part.text || (part.thoughtSignature ? EMPTY_THOUGHT_CARRIER : ''),
          signature: part.thoughtSignature ?? '',
        });
      } else {
        content.push({ type: 'text', text: part.text });
      }
    } else if (part.thought && part.thoughtSignature) {
      content.push({
        type: 'thinking',
        thinking: EMPTY_THOUGHT_CARRIER,
        signature: part.thoughtSignature,
      });
    }
    if (part.functionCall?.name) {
      if (part.thoughtSignature) {
        // Claude has a standard opaque-signature channel only on thinking
        // blocks. This invisible carrier is restored onto the immediately
        // following Gemini functionCall part on the next stateless turn.
        content.push({
          type: 'thinking',
          thinking: TOOL_SIGNATURE_CARRIER,
          signature: part.thoughtSignature,
        });
      }
      content.push({
        type: 'tool_use',
        id: `call_${randomId()}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  const hasTools = content.some((block) => block.type === 'tool_use');
  return {
    id: `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapGeminiFinishToAnthropic(candidate?.finishReason, hasTools),
    stop_sequence: null,
    usage: {
      input_tokens: tokenCountOrFallback(res.usageMetadata?.promptTokenCount, inputTokensFallback),
      output_tokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function tokenCountOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Math.max(0, Math.floor(fallback));
}
