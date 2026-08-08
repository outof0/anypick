import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveOpenCodeModel } from './models';
import { json, buildUpstreamHeaders } from './http';
import { linkClientAbort, isAbortError } from './abort';
import { readBody } from './body';
import { pipeResponse } from './stream';
import {
  isContextWindowError,
  normalizeContextWindowError,
  openAIResponsesContextWindowError,
} from './context-budget';
import type { OpenCodeRuntime } from './runtime';

export async function handleOpenAIChat(
  runtime: OpenCodeRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  log: (line: string) => void,
): Promise<void> {
  let modelId = '?';
  const abort = linkClientAbort(req, res);
  try {
    let body: { model?: string; [key: string]: unknown };
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as typeof body;
    } catch {
      json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
      return;
    }
    const cred = await runtime.credential();
    const catalogState = await runtime.catalog.live();
    const resolved = resolveOpenCodeModel(body.model, catalogState.ids);
    if (!resolved.id) {
      json(res, 400, { error: { type: 'invalid_request_error', message: 'model is required' } });
      return;
    }
    if (catalogState.ids.length > 0 && !catalogState.byModel.has(resolved.id)) {
      json(res, 404, {
        error: {
          type: 'model_not_found',
          message: `Model "${resolved.id}" is not present in the live OpenCode catalog.`,
        },
      });
      return;
    }
    modelId = resolved.id;
    if (resolved.remapped || resolved.id !== body.model) {
      log(
        `model ${body.model ?? '(empty)'} → ${resolved.id}${resolved.reason ? ` (${resolved.reason})` : ''}`,
      );
    }
    body.model = resolved.id;
    const { catalog, base } = await runtime.catalog.route(resolved.id);
    const suffix = path === '/v1' ? '' : path.slice('/v1'.length);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    log(`POST ${path} → ${catalog} ${suffix} (${resolved.id})`);
    const upstreamRes = await runtime.inferenceFetch(
      `${base}${suffix}`,
      {
        method: 'POST',
        headers: {
          ...buildUpstreamHeaders(req, cred.apiKey, {
            contentLength: payload.byteLength,
            sessionId: runtime.sessionId,
          }),
          'content-type': 'application/json',
        },
        body: new Uint8Array(payload),
        signal: abort.signal,
      },
      modelId,
      cred,
    );
    // Codex always consumes Responses as SSE. Its parser enters compaction
    // only when it receives a `response.failed` event with the canonical
    // context_length_exceeded code, so turn an upstream HTTP 400 into that
    // protocol-level event for streaming Responses requests.
    if (
      path === '/v1/responses' &&
      body.stream === true &&
      (upstreamRes.status === 400 || upstreamRes.status === 413)
    ) {
      const raw = await upstreamRes.clone().text();
      if (isContextWindowError(raw)) {
        await pipeResponse(
          openAIResponsesContextWindowError(),
          res,
          log,
          `openai ${modelId} context overflow`,
        );
        return;
      }
    }
    const normalized = await normalizeContextWindowError(upstreamRes, 'openai');
    await pipeResponse(normalized, res, log, `openai ${modelId}`);
  } catch (err) {
    if (isAbortError(err)) {
      log(`✗ openai ${modelId}: aborted`);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(499);
        res.end();
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`✗ openai ${modelId}: ${message}`);
    if (!res.headersSent) {
      json(res, 502, { error: { message, type: 'proxy_error' } });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    abort.dispose();
  }
}

export async function proxyPassThrough(
  runtime: OpenCodeRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  path: string,
  log: (line: string) => void,
): Promise<void> {
  const abort = linkClientAbort(req, res);
  try {
    const cred = await runtime.credential();
    const suffix = path === '/v1' ? '' : path.slice('/v1'.length);
    const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const body =
      method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
        ? undefined
        : await readBody(req);
    const upstreamRes = await runtime.inferenceFetch(
      `${runtime.baseFor('zen')}${suffix}${query}`,
      {
        method,
        headers: buildUpstreamHeaders(req, cred.apiKey, {
          contentLength: body?.byteLength,
          sessionId: runtime.sessionId,
        }),
        body: body?.length ? new Uint8Array(body) : undefined,
        signal: abort.signal,
      },
      path,
      cred,
    );
    await pipeResponse(upstreamRes, res, log, `${method} ${path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      json(res, 502, { error: { message, type: 'proxy_error' } });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    abort.dispose();
  }
}
