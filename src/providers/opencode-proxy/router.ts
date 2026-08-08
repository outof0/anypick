import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeLocalApiUrl, requireProxyAuth } from '../proxy-shared';
import { checkCors, json } from './http';
import {
  handleHealth,
  handleListModels,
  handleGetModel,
  handleCountTokens,
} from './catalog-handlers';
import { handleAnthropicMessages } from './anthropic-handler';
import { handleOpenAIChat, proxyPassThrough } from './openai-handler';
import type { OpenCodeRuntime } from './runtime';

export async function routeRequest(
  runtime: OpenCodeRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  proxyToken: string,
  log: (line: string) => void,
): Promise<void> {
  const url = normalizeLocalApiUrl(req.url ?? '/');
  const path = url.split('?')[0] ?? '/';
  const method = req.method ?? 'GET';
  if (!checkCors(req, res)) {
    return;
  }
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/health')) {
    await handleHealth(runtime, res);
    return;
  }
  if (!requireProxyAuth(req, res, proxyToken)) {
    return;
  }
  if (!path.startsWith('/v1/') && path !== '/v1') {
    json(res, 404, {
      error: {
        message: `Not found: ${path}. Codex: /v1/responses · Claude: /v1/messages · models: /v1/models`,
        type: 'not_found_error',
      },
    });
    return;
  }
  if (method === 'GET' && path === '/v1/models') {
    await handleListModels(runtime, req, res);
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/v1/models/')) {
    await handleGetModel(runtime, path.slice('/v1/models/'.length), req, res);
    return;
  }
  if (method === 'POST' && path === '/v1/messages/count_tokens') {
    await handleCountTokens(runtime, req, res, log);
    return;
  }
  if (method === 'POST' && path === '/v1/messages') {
    await handleAnthropicMessages(runtime, req, res, log);
    return;
  }
  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/responses')) {
    await handleOpenAIChat(runtime, req, res, path, log);
    return;
  }
  if (path.startsWith('/v1/messages/') || path === '/v1/complete') {
    json(res, 404, {
      type: 'error',
      error: {
        type: 'not_found_error',
        message: `Unsupported endpoint ${path} on anypick-opencode-proxy`,
      },
    });
    return;
  }
  log(`${method} ${path}`);
  await proxyPassThrough(runtime, req, res, url, method, path, log);
}
