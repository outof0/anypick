import type { ServerResponse } from 'node:http';
import {
  openAIToAnthropic,
  pipeOpenAIStreamToAnthropic,
  type OpenAIChatResponse,
} from '../protocol/anthropic';
import { STREAM_IDLE_MS } from './constants';
import { describeAbort, isAbortError } from './abort';
import { formatUpstreamModelError, safeUpstreamErrorForLog } from './errors';
import { json } from './http';
import {
  CONTEXT_WINDOW_ERROR_CODE,
  anthropicContextWindowErrorBody,
  isContextWindowError,
} from './context-budget';

export async function pipeTranslatedStream(
  upstreamRes: Response,
  res: ServerResponse,
  model: string | undefined,
  signal: AbortSignal,
  log: (line: string) => void,
  inputTokens = 0,
): Promise<'ok' | 'empty' | 'error'> {
  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    const contextError = isContextWindowError(errText);
    log(
      `✗ upstream ${upstreamRes.status} chat/completions (${model ?? '?'}): ${safeUpstreamErrorForLog(errText)}`,
    );
    const errorBody = contextError
      ? anthropicContextWindowErrorBody(errText, upstreamRes.headers.get('request-id') ?? undefined)
      : {
          type: 'error',
          error: {
            type: 'api_error',
            message: formatUpstreamModelError(errText, model),
          },
        };
    if (!res.headersSent) {
      res.writeHead(contextError ? 400 : upstreamRes.status, {
        'content-type': 'application/json; charset=utf-8',
        ...(contextError && 'request_id' in errorBody && typeof errorBody.request_id === 'string'
          ? { 'request-id': errorBody.request_id }
          : {}),
      });
      res.end(JSON.stringify(errorBody));
    } else if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify(errorBody)}\n\n`);
      res.end();
    }
    return 'error';
  }

  const contentType = (upstreamRes.headers.get('content-type') ?? '').toLowerCase();
  const looksSse = ['text/event-stream', 'text/plain', 'stream'].some((value) =>
    contentType.includes(value),
  );
  if (!looksSse && contentType.includes('application/json')) {
    const text = await upstreamRes.text();
    try {
      const converted = openAIToAnthropic(
        JSON.parse(text) as OpenAIChatResponse,
        model ?? 'unknown',
        inputTokens,
      );
      if ('type' in converted && converted.type === 'error') {
        const contextError = converted.error.code === CONTEXT_WINDOW_ERROR_CODE;
        const errorBody = contextError
          ? anthropicContextWindowErrorBody(JSON.stringify(converted))
          : converted;
        const status = contextError ? 400 : 502;
        if (!res.headersSent) {
          if (
            contextError &&
            'request_id' in errorBody &&
            typeof errorBody.request_id === 'string'
          ) {
            res.setHeader('request-id', errorBody.request_id);
          }
          json(res, status, errorBody);
        } else if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify(errorBody)}\n\n`);
          res.end();
        }
        return 'error';
      }
      const content =
        'content' in converted && Array.isArray(converted.content) ? converted.content : [];
      const textOut = content.find((block) => block.type === 'text' && 'text' in block)?.text;
      const hasTools = content.some((block) => block.type === 'tool_use');
      if (!textOut && !hasTools) {
        return 'empty';
      }
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      writeConvertedSse(res, converted, model, textOut);
      return 'ok';
    } catch {
      const message = `Upstream non-JSON stream body: ${text.slice(0, 200)}`;
      if (!res.headersSent) {
        json(res, 502, { type: 'error', error: { type: 'api_error', message } });
      } else if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`,
        );
        res.end();
      }
      return 'error';
    }
  }

  const started = Date.now();
  let bytes = 0;
  try {
    const result = await pipeOpenAIStreamToAnthropic(
      upstreamRes,
      (chunk) => {
        if (res.writableEnded || res.destroyed || signal.aborted) {
          return;
        }
        if (!res.headersSent) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
        }
        bytes += Buffer.byteLength(chunk);
        res.write(chunk);
      },
      model ?? 'unknown',
      undefined,
      {
        idleMs: STREAM_IDLE_MS,
        signal,
        rejectEmpty: false,
        // The request-side estimate is only a fallback; provider usage, when
        // present in the terminal chunk, replaces it in message_delta.
        inputTokens,
        // A provider may emit an error inside an otherwise-successful SSE
        // response. Claude Code must see the same canonical overflow signal
        // in that event as it would in an HTTP 400 response.
        mapError: (error) => {
          const raw = JSON.stringify({ error });
          return error.code === CONTEXT_WINDOW_ERROR_CODE || isContextWindowError(raw)
            ? anthropicContextWindowErrorBody(raw).error
            : error;
        },
      },
    );
    if (result.error) {
      log(`✗ anthropic-stream ${model}: ${result.error.message} · ${bytes} bytes`);
      if (!res.writableEnded) {
        res.end();
      }
      return 'error';
    }
    if (result.empty) {
      log(
        `↻ anthropic-stream ${model} empty · ${bytes}b · ${Date.now() - started}ms (will retry if attempts left)`,
      );
      return 'empty';
    }
    log(`✓ anthropic-stream ${model} · ${bytes} bytes · ${Date.now() - started}ms`);
    if (!res.writableEnded) {
      res.end();
    }
    return 'ok';
  } catch (err) {
    const idle =
      err && typeof err === 'object' && (err as { code?: string }).code === 'STREAM_IDLE';
    if (isAbortError(err) || signal.aborted) {
      log(`✗ anthropic-stream ${model}: ${describeAbort(signal, err)} after ${bytes} bytes`);
    } else if (idle) {
      log(
        `✗ anthropic-stream ${model}: upstream idle ${STREAM_IDLE_MS}ms after ${bytes} bytes · ${Date.now() - started}ms (free-tier stall?)`,
      );
    } else {
      log(
        `✗ anthropic-stream ${model}: ${err instanceof Error ? err.message : String(err)} after ${bytes} bytes`,
      );
    }
    if (!res.writableEnded && !res.destroyed && bytes > 0) {
      const message = idle
        ? `Upstream stream stalled for ${STREAM_IDLE_MS / 1000}s. Retry or pick another model.`
        : isAbortError(err)
          ? 'aborted'
          : err instanceof Error
            ? err.message
            : String(err);
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: idle ? 'timeout_error' : 'api_error', message } })}\n\n`,
        );
      } catch {
        // ignore disconnected clients
      }
      res.end();
    }
    return bytes === 0 && !signal.aborted ? 'empty' : 'error';
  }
}

function writeConvertedSse(
  res: ServerResponse,
  converted: unknown,
  model: string | undefined,
  textOut: string | undefined,
): void {
  const message = converted as {
    id?: string;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const id = message.id ?? `msg_${Date.now().toString(36)}`;
  const inputTokenUsage = message.usage?.input_tokens ?? 0;
  const outputTokenUsage = message.usage?.output_tokens ?? 0;
  res.write(
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: model ?? 'unknown', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokenUsage, output_tokens: 0 } } })}\n\n`,
  );
  if (textOut) {
    res.write(
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    );
    res.write(
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: textOut } })}\n\n`,
    );
    res.write(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    );
  }
  res.write(
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: message.stop_reason ?? 'end_turn', stop_sequence: null }, usage: { input_tokens: inputTokenUsage, output_tokens: outputTokenUsage } })}\n\n`,
  );
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  res.end();
}
