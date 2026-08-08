import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageResponse,
  OpenAIMessage,
  OpenAIToolCall,
} from './anthropic-types';

export function fixMissingToolResponses(messages: OpenAIMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      continue;
    }
    const needed = new Set(msg.tool_calls.map((tc) => tc.id).filter(Boolean));
    if (needed.size === 0) {
      continue;
    }
    const found = new Set<string>();
    let insertAt = i + 1;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role === 'tool' && next.tool_call_id) {
        found.add(next.tool_call_id);
        insertAt = j + 1;
        continue;
      }
      break;
    }
    const missing = [...needed].filter((id) => !found.has(id));
    if (missing.length === 0) {
      continue;
    }
    const stubs: OpenAIMessage[] = missing.map((id) => ({
      role: 'tool',
      tool_call_id: id,
      content: '[No response received]',
    }));
    messages.splice(insertAt, 0, ...stubs);
    i = insertAt + stubs.length - 1;
  }
}

export function anthropicMessageToOpenAI(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }];
  }

  const blocks = msg.content ?? [];
  const out: OpenAIMessage[] = [];

  if (msg.role === 'assistant') {
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && 'text' in b) {
        textParts.push(String(b.text ?? ''));
      } else if (b.type === 'tool_use' && 'id' in b && 'name' in b) {
        toolCalls.push({
          id: String(b.id),
          type: 'function',
          function: {
            name: String(b.name),
            arguments: JSON.stringify(b.input ?? {}),
          },
        });
      }
    }
    const m: OpenAIMessage = {
      role: 'assistant',
      content: textParts.length ? textParts.join('\n') : null,
    };
    if (toolCalls.length) {
      m.tool_calls = toolCalls;
    }
    out.push(m);
    return out;
  }

  // user: text + tool_result blocks
  const textParts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && 'text' in b) {
      textParts.push(String(b.text ?? ''));
    } else if (b.type === 'tool_result' && 'tool_use_id' in b) {
      // OpenAI wants separate tool messages
      if (textParts.length) {
        out.push({ role: 'user', content: textParts.join('\n') });
        textParts.length = 0;
      }
      out.push({
        role: 'tool',
        tool_call_id: String(b.tool_use_id),
        content: flattenToolResultContent(
          (b as { content?: string | AnthropicContentBlock[] }).content,
        ),
      });
    }
  }
  if (textParts.length) {
    out.push({ role: 'user', content: textParts.join('\n') });
  }
  if (out.length === 0) {
    out.push({ role: 'user', content: '' });
  }
  return out;
}

export function flattenSystem(
  system: string | AnthropicContentBlock[] | undefined,
): string | undefined {
  if (!system) {
    return undefined;
  }
  if (typeof system === 'string') {
    return system;
  }
  return system
    .filter((b) => b.type === 'text' && 'text' in b)
    .map((b) => String((b as { text?: string }).text ?? ''))
    .join('\n');
}

export function flattenToolResultContent(
  content: string | AnthropicContentBlock[] | undefined,
): string {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((b) => {
      if (b.type === 'text' && 'text' in b) {
        return String(b.text ?? '');
      }
      return JSON.stringify(b);
    })
    .join('\n');
}

export function mapToolChoice(choice: unknown): unknown {
  if (choice == null || typeof choice !== 'object') {
    return choice;
  }
  const c = choice as { type?: string; name?: string };
  if (c.type === 'auto') {
    return 'auto';
  }
  if (c.type === 'any') {
    return 'required';
  }
  if (c.type === 'tool' && c.name) {
    return { type: 'function', function: { name: c.name } };
  }
  if (c.type === 'none') {
    return 'none';
  }
  return choice;
}

export function mapFinishReason(
  reason: string | null | undefined,
  hasTools: boolean,
): AnthropicMessageResponse['stop_reason'] {
  if (hasTools || reason === 'tool_calls') {
    return 'tool_use';
  }
  if (reason === 'length') {
    return 'max_tokens';
  }
  if (reason === 'stop' || reason === 'end_turn') {
    return 'end_turn';
  }
  if (reason == null) {
    return 'end_turn';
  }
  return 'end_turn';
}

export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { raw };
  }
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

/** Format one Anthropic SSE event. */
export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
