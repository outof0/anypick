import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnthropicMessageRequest } from '../protocol/anthropic';
import { resolveOpenCodeModel, usesAnthropicMessagesProtocol } from './models';
import { buildUpstreamHeaders, json } from './http';
import { linkClientAbort, isAbortError, describeAbort } from './abort';
import { readBody } from './body';
import type { OpenCodeRuntime } from './runtime';
import {
  forwardAnthropicAsGoogle,
  forwardAnthropicAsOpenAI,
  forwardAnthropicAsResponses,
} from './forwarders';
import { pipeResponse } from './stream';
import { normalizeContextWindowError } from './context-budget';

export async function handleAnthropicMessages(
  runtime: OpenCodeRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  log: (line: string) => void,
): Promise<void> {
  let modelId = '?';
  const abort = linkClientAbort(req, res);
  try {
    let body: AnthropicMessageRequest;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as AnthropicMessageRequest;
    } catch {
      json(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
      });
      return;
    }
    const cred = await runtime.credential();
    const catalogState = await runtime.catalog.live();
    const resolved = resolveOpenCodeModel(body.model, catalogState.ids);
    if (!resolved.id) {
      json(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'model is required' },
      });
      return;
    }
    if (catalogState.ids.length > 0 && !catalogState.byModel.has(resolved.id)) {
      json(res, 404, {
        type: 'error',
        error: {
          type: 'not_found_error',
          message: `Model "${resolved.id}" is not present in the live OpenCode catalog.`,
        },
      });
      return;
    }
    modelId = resolved.id;
    if (resolved.remapped) {
      log(
        `model ${body.model ?? '(empty)'} → ${resolved.id}${resolved.reason ? ` (${resolved.reason})` : ''}`,
      );
    }
    body.model = resolved.id;
    if (body.max_tokens == null) {
      body.max_tokens = 4096;
    }
    const { catalog, base } = await runtime.catalog.route(resolved.id);
    const model = catalogState.byModel.get(resolved.id);
    if (model?.protocol === 'google') {
      await forwardAnthropicAsGoogle(runtime, body, cred, base, res, req, abort.signal);
      return;
    }
    if (model?.protocol === 'openai-responses') {
      await forwardAnthropicAsResponses(runtime, body, cred, base, res, req, abort.signal);
      return;
    }
    if (!usesAnthropicMessagesProtocol(model)) {
      await forwardAnthropicAsOpenAI(runtime, body, cred, base, res, req, abort.signal, log);
      return;
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    log(`POST /v1/messages → ${catalog} /messages (${resolved.id})`);
    const upstreamRes = await runtime.inferenceFetch(
      `${base}/messages`,
      {
        method: 'POST',
        headers: {
          ...buildUpstreamHeaders(req, cred.apiKey, {
            contentLength: payload.byteLength,
            anthropic: true,
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
    const normalized = await normalizeContextWindowError(upstreamRes, 'anthropic');
    await pipeResponse(normalized, res, log, `anthropic ${modelId}`);
  } catch (err) {
    if (isAbortError(err)) {
      log(`✗ messages ${modelId}: ${describeAbort(abort.signal, err)}`);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(499);
        res.end();
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`✗ messages ${modelId}: ${message}`);
    if (!res.headersSent) {
      json(res, 502, { type: 'error', error: { type: 'proxy_error', message } });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    abort.dispose();
  }
}
