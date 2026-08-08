import type {
  AnthropicMessageResponse,
  OpenAIChatResponse,
  PipeOpenAIStreamOptions,
  PipeOpenAIStreamResult,
} from './anthropic-types';
import { mapFinishReason, randomId, sse } from './anthropic-helpers';
import { createIdleStreamReader } from './anthropic-stream-reader';

export async function pipeOpenAIStreamToAnthropic(
  upstream: Response,
  write: (chunk: string) => void,
  model: string,
  messageId = `msg_${randomId()}`,
  options: PipeOpenAIStreamOptions = {},
): Promise<PipeOpenAIStreamResult> {
  let inputTokens = nonNegativeTokenCount(options.inputTokens) ?? 0;
  const emptyResult = (): PipeOpenAIStreamResult => ({
    hadText: false,
    hadThinking: false,
    hadTools: false,
    empty: true,
    stopReason: 'end_turn',
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  });

  if (!upstream.body) {
    return emptyResult();
  }

  let blockOpen = false;
  let thinkingBlockOpen = false;
  let blockIndex = 0;
  const toolBlocks = new Map<
    number,
    { id: string; name: string; args: string; anthropicIndex: number }
  >();
  // Buffer tool args until finish — free models emit bad partial JSON mid-stream;
  // emit once at end to avoid incomplete tool_use.
  const toolArgBuffers = new Map<number, string>();
  let stopReason: AnthropicMessageResponse['stop_reason'] = 'end_turn';
  let outputTokens = 0;
  let providerOutputUsage = false;
  let outputChars = 0;
  let streamError: PipeOpenAIStreamResult['error'];
  let hadText = false;
  let hadThinking = false;
  let messageStarted = false;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const idleReader = createIdleStreamReader(reader, options);

  const ensureMessageStart = () => {
    if (messageStarted) {
      return;
    }
    messageStarted = true;
    write(
      sse('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    );
  };

  const ensureTextBlock = () => {
    ensureMessageStart();
    if (thinkingBlockOpen) {
      write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
      thinkingBlockOpen = false;
      blockIndex += 1;
    }
    if (blockOpen) {
      return;
    }
    write(
      sse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      }),
    );
    blockOpen = true;
  };

  const ensureThinkingBlock = () => {
    ensureMessageStart();
    if (thinkingBlockOpen) {
      return;
    }
    if (blockOpen) {
      write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
      blockOpen = false;
      blockIndex += 1;
    }
    write(
      sse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
    );
    thinkingBlockOpen = true;
  };

  try {
    streamLoop: while (true) {
      const { done, value } = await idleReader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {
          continue;
        }
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          idleReader.markProgress();
          continue;
        }

        let chunk: OpenAIChatResponse;
        try {
          chunk = JSON.parse(data) as OpenAIChatResponse;
        } catch {
          continue;
        }

        if (chunk.error) {
          idleReader.markProgress();
          ensureMessageStart();
          const providerError = {
            type:
              chunk.error.code === 'context_length_exceeded'
                ? 'invalid_request_error'
                : (chunk.error.type ?? 'api_error'),
            message: chunk.error.message ?? 'Upstream error',
            ...(chunk.error.code ? { code: chunk.error.code } : {}),
          };
          streamError = options.mapError?.(providerError) ?? providerError;
          write(
            sse('error', {
              type: 'error',
              error: streamError,
            }),
          );
          break streamLoop;
        }

        if (chunk.usage) {
          const promptTokens = nonNegativeTokenCount(chunk.usage.prompt_tokens);
          if (promptTokens != null && promptTokens > 0) {
            inputTokens = promptTokens;
          }
          const completionTokens = nonNegativeTokenCount(chunk.usage.completion_tokens);
          if (completionTokens != null) {
            outputTokens = completionTokens;
            providerOutputUsage = true;
          }
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        const hasContent = Boolean(delta?.content);
        const hasThinking = Boolean(reasoning);
        const hasTools = Boolean(delta?.tool_calls?.length);
        const hasFinish = Boolean(choice?.finish_reason);
        if (hasContent || hasThinking || hasTools || hasFinish) {
          idleReader.markProgress();
        }

        if (choice?.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason, toolBlocks.size > 0 || hasTools);
        }

        if (reasoning) {
          outputChars += reasoning.length;
          hadThinking = true;
          ensureThinkingBlock();
          write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: reasoning },
            }),
          );
        }

        if (delta?.content) {
          outputChars += delta.content.length;
          hadText = true;
          ensureTextBlock();
          write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }),
          );
        }

        if (delta?.tool_calls?.length) {
          ensureMessageStart();
          if (thinkingBlockOpen) {
            write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
            thinkingBlockOpen = false;
            blockIndex += 1;
          }
          if (blockOpen) {
            write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
            blockOpen = false;
            blockIndex += 1;
          }

          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let state = toolBlocks.get(idx);
            if (!state && (tc.id || tc.function?.name || tc.function?.arguments)) {
              state = {
                id: tc.id ?? `toolu_${randomId()}`,
                name: tc.function?.name ?? '',
                args: '',
                anthropicIndex: blockIndex,
              };
              toolBlocks.set(idx, state);
              write(
                sse('content_block_start', {
                  type: 'content_block_start',
                  index: state.anthropicIndex,
                  content_block: {
                    type: 'tool_use',
                    id: state.id,
                    name: state.name,
                    input: {},
                  },
                }),
              );
              blockIndex += 1;
            }
            if (!state) {
              continue;
            }
            if (tc.id && state.id.startsWith('toolu_')) {
              state.id = tc.id;
            }
            if (tc.function?.name) {
              state.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              outputChars += tc.function.arguments.length;
              state.args += tc.function.arguments;
              toolArgBuffers.set(idx, (toolArgBuffers.get(idx) ?? '') + tc.function.arguments);
            }
          }
        }
      }
    }
  } catch (err) {
    // Cancel silent incomplete message — no clean message_stop.
    void reader.cancel().catch(() => {});
    throw err;
  }

  const hadTools = toolBlocks.size > 0;
  const empty = !hadText && !hadThinking && !hadTools;

  if (streamError) {
    void reader.cancel().catch(() => {});
    return {
      hadText,
      hadThinking,
      hadTools,
      empty: false,
      stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      error: streamError,
    };
  }

  // Empty free-tier completion: write nothing (no message_start) so caller can retry.
  if (empty) {
    void reader.cancel().catch(() => {});
    return emptyResult();
  }

  // Some OpenAI-compatible providers omit the terminal usage chunk. Keep the
  // estimate explicitly best-effort; a real prompt_tokens/completion_tokens
  // pair always wins when the provider supplied it.
  if (!providerOutputUsage) {
    outputTokens = Math.max(outputTokens, Math.ceil(outputChars / 4));
  }

  // Close blocks + finish message (only when we actually streamed content).
  if (blockOpen) {
    write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }
  if (thinkingBlockOpen) {
    write(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }
  for (const [idx, state] of toolBlocks) {
    const buffered = toolArgBuffers.get(idx) ?? state.args;
    if (buffered) {
      write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: state.anthropicIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: buffered,
          },
        }),
      );
    }
    write(sse('content_block_stop', { type: 'content_block_stop', index: state.anthropicIndex }));
  }
  write(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  );
  write(sse('message_stop', { type: 'message_stop' }));

  return {
    hadText,
    hadThinking,
    hadTools,
    empty: false,
    stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function nonNegativeTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Insert stub tool replies for any assistant tool_calls that lack a following
 * tool message. Without this, OpenCode free backends often return empty SSE.
 */
