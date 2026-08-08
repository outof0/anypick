import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  type AnthropicMessageRequest,
  type OpenAIChatResponse,
} from '../protocol/anthropic';
import {
  anthropicToGemini,
  geminiToAnthropic,
  type GeminiGenerateResponse,
} from '../protocol/gemini/translate';
import { json, buildUpstreamHeaders } from './http';
import {
  anthropicRequestBreakdown,
  compactBytes,
  estimateAnthropicInputTokens,
  jsonByteLength,
} from './body';
import { formatUpstreamModelError, safeUpstreamErrorForLog } from './errors';
import { pipeTranslatedStream } from './translate-stream';
import { anthropicToResponses, responsesToAnthropic, sendAnthropicResult } from './translate';
import type { OpenAIResponsesResult } from './types';
import type { OpenCodeRuntime } from './runtime';
import {
  CONTEXT_WINDOW_ERROR_CODE,
  isContextWindowError,
  anthropicContextWindowErrorBody,
} from './context-budget';

export async function forwardAnthropicAsGoogle(
  runtime: OpenCodeRuntime,
  body: AnthropicMessageRequest,
  cred: Awaited<ReturnType<OpenCodeRuntime['credential']>>,
  base: string,
  res: ServerResponse,
  req: IncomingMessage,
  signal: AbortSignal,
): Promise<void> {
  const inputTokens = estimateAnthropicInputTokens(body);
  const converted = anthropicToGemini(body, body.model);
  const payload = Buffer.from(JSON.stringify(converted.gemini), 'utf8');
  const upstreamRes = await runtime.inferenceFetch(
    `${base}/models/${encodeURIComponent(body.model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'hotplug-opencode-proxy/0.8',
        'x-goog-api-key': cred.apiKey,
        'x-opencode-client': 'desktop',
        'x-opencode-session': runtime.sessionId,
        ...(req.headers['x-opencode-request']
          ? { 'x-opencode-request': String(req.headers['x-opencode-request']) }
          : {}),
      },
      body: new Uint8Array(payload),
      signal,
    },
    body.model,
    cred,
  );
  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    const contextError = isContextWindowError(text);
    if (contextError) {
      sendAnthropicContextWindowError(
        res,
        text,
        upstreamRes.headers.get('request-id') ?? undefined,
      );
      return;
    }
    json(res, upstreamRes.status, {
      type: 'error',
      error: {
        type: 'api_error',
        message: formatUpstreamModelError(text, body.model),
      },
    });
    return;
  }
  try {
    sendAnthropicResult(
      res,
      geminiToAnthropic(JSON.parse(text) as GeminiGenerateResponse, body.model, inputTokens),
      Boolean(body.stream),
    );
  } catch {
    json(res, 502, {
      type: 'error',
      error: { type: 'api_error', message: `Upstream non-JSON: ${text.slice(0, 200)}` },
    });
  }
}

export async function forwardAnthropicAsResponses(
  runtime: OpenCodeRuntime,
  body: AnthropicMessageRequest,
  cred: Awaited<ReturnType<OpenCodeRuntime['credential']>>,
  base: string,
  res: ServerResponse,
  req: IncomingMessage,
  signal: AbortSignal,
): Promise<void> {
  const inputTokens = estimateAnthropicInputTokens(body);
  const payload = Buffer.from(JSON.stringify(anthropicToResponses(body)), 'utf8');
  const upstreamRes = await runtime.inferenceFetch(
    `${base}/responses`,
    {
      method: 'POST',
      headers: {
        ...buildUpstreamHeaders(req, cred.apiKey, {
          contentLength: payload.byteLength,
          sessionId: runtime.sessionId,
        }),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: new Uint8Array(payload),
      signal,
    },
    body.model,
    cred,
  );
  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    const contextError = isContextWindowError(text);
    if (contextError) {
      sendAnthropicContextWindowError(
        res,
        text,
        upstreamRes.headers.get('request-id') ?? undefined,
      );
      return;
    }
    json(res, upstreamRes.status, {
      type: 'error',
      error: {
        type: 'api_error',
        message: formatUpstreamModelError(text, body.model),
      },
    });
    return;
  }
  try {
    sendAnthropicResult(
      res,
      responsesToAnthropic(JSON.parse(text) as OpenAIResponsesResult, body.model, inputTokens),
      Boolean(body.stream),
    );
  } catch {
    json(res, 502, {
      type: 'error',
      error: { type: 'api_error', message: `Upstream non-JSON: ${text.slice(0, 200)}` },
    });
  }
}

export async function forwardAnthropicAsOpenAI(
  runtime: OpenCodeRuntime,
  body: AnthropicMessageRequest,
  cred: Awaited<ReturnType<OpenCodeRuntime['credential']>>,
  base: string,
  res: ServerResponse,
  req: IncomingMessage,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<void> {
  const openaiBody = anthropicToOpenAI(body, { agentHints: false });
  const stream = Boolean(body.stream);
  openaiBody.stream = stream;
  const inputTokens = estimateAnthropicInputTokens(body);
  if (stream) {
    // OpenCode's OpenAI adapter requests the terminal usage chunk explicitly;
    // without it Claude Code receives input_tokens=0 and cannot auto-compact.
    openaiBody.stream_options = {
      ...(typeof openaiBody.stream_options === 'object' && openaiBody.stream_options
        ? openaiBody.stream_options
        : {}),
      include_usage: true,
    };
  }
  const model = String(body.model ?? '');
  const translatedBytes = jsonByteLength(openaiBody);
  log(
    `POST /v1/messages → ${base.includes('/go/') ? 'go' : 'zen'} /chat/completions (${model}) stream=${stream} body=${compactBytes(translatedBytes)} · ${anthropicRequestBreakdown(body)}`,
  );
  const doUpstream = async (asStream: boolean): Promise<Response> => {
    const payload = Buffer.from(JSON.stringify({ ...openaiBody, stream: asStream }), 'utf8');
    return runtime.inferenceFetch(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...buildUpstreamHeaders(req, cred.apiKey, {
            contentLength: payload.byteLength,
            sessionId: runtime.sessionId,
          }),
          'content-type': 'application/json',
          accept: asStream ? 'text/event-stream' : 'application/json',
          'x-opencode-client': 'desktop',
        },
        body: new Uint8Array(payload),
        signal,
      },
      model,
      cred,
    );
  };

  if (stream) {
    const upstreamRes = await doUpstream(true);
    const outcome = await pipeTranslatedStream(
      upstreamRes,
      res,
      body.model,
      signal,
      log,
      inputTokens,
    );
    if (outcome === 'empty' && !res.writableEnded) {
      const message = `OpenCode model "${body.model}" returned an empty stream. Try again or pick another model.`;
      if (!res.headersSent) {
        json(res, 502, { type: 'error', error: { type: 'api_error', message } });
      } else {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`,
        );
        res.end();
      }
    }
    return;
  }

  const upstreamRes = await doUpstream(false);
  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    const contextError = isContextWindowError(text);
    const parsedError = tryParseChatResponse(text);
    log(
      `✗ upstream ${upstreamRes.status} chat/completions (${body.model}): ${safeUpstreamErrorForLog(text)}`,
    );
    if (contextError) {
      sendAnthropicContextWindowError(
        res,
        text,
        upstreamRes.headers.get('request-id') ?? undefined,
      );
      return;
    }
    json(res, upstreamRes.status, {
      type: 'error',
      error: {
        type: 'api_error',
        message: parsedError?.error?.message ?? formatUpstreamModelError(text, body.model),
      },
    });
    return;
  }
  let parsed: OpenAIChatResponse;
  try {
    parsed = JSON.parse(text) as OpenAIChatResponse;
  } catch {
    json(res, 502, {
      type: 'error',
      error: { type: 'api_error', message: `Upstream non-JSON: ${text.slice(0, 200)}` },
    });
    return;
  }
  const converted = openAIToAnthropic(parsed, body.model ?? 'unknown', inputTokens);
  if ('type' in converted && converted.type === 'error') {
    if (converted.error.code === CONTEXT_WINDOW_ERROR_CODE) {
      sendAnthropicContextWindowError(res, JSON.stringify(converted));
    } else {
      json(res, 502, converted);
    }
    return;
  }
  if ('model' in converted && typeof converted.model === 'string') {
    converted.model = body.model ?? converted.model;
  }
  json(res, 200, converted);
}

function sendAnthropicContextWindowError(
  res: ServerResponse,
  raw: string,
  requestId?: string,
): void {
  const body = anthropicContextWindowErrorBody(raw, requestId);
  res.setHeader('request-id', body.request_id);
  json(res, 400, body);
}

function tryParseChatResponse(raw: string): OpenAIChatResponse | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as OpenAIChatResponse) : undefined;
  } catch {
    return undefined;
  }
}
