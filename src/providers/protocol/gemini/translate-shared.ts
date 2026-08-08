import type { OpenAIMessage, AnthropicMessageResponse } from '../anthropic';
import { isRecord } from './translate-schema';

export function messageText(msg: OpenAIMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function flattenResponsesText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenResponsesText).filter(Boolean).join('\n');
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') {
      return value.text;
    }
    if (value.content !== undefined) {
      return flattenResponsesText(value.content);
    }
    if (value.output !== undefined) {
      return flattenResponsesText(value.output);
    }
    return JSON.stringify(value);
  }
  return value == null ? '' : String(value);
}

export function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { raw };
  }
}

export function mapGeminiFinish(reason: string | undefined, hasTools: boolean): string {
  if (hasTools) {
    return 'tool_calls';
  }
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

export function mapGeminiFinishToAnthropic(
  reason: string | undefined,
  hasTools: boolean,
): AnthropicMessageResponse['stop_reason'] {
  if (hasTools) {
    return 'tool_use';
  }
  return reason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}
