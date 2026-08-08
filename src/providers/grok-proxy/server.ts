/**
 * Dual-protocol reverse proxy for Grok CLI OIDC sessions.
 *
 * Compatibility (same base URL for both clients):
 *   • OpenAI   — Codex / OpenAI SDK  →  /v1/chat/completions, /v1/responses, /v1/models
 *   • Anthropic — Claude Code         →  /v1/messages
 *
 * Upstream cli-chat-proxy.grok.com already speaks both shapes; we inject the
 * CLI OIDC Bearer and forward. Model IDs and /v1/models are deliberately
 * passed through without a local catalog, so newly released models work
 * without a AnyPick update. Optional translate mode
 * (GROK_PROXY_TRANSLATE_ANTHROPIC=1) rewrites Anthropic → chat/completions
 * for OpenAI-only upstreams.
 *
 * Clients point BASE_URL here with any dummy API key / auth token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GROK_MODELS } from '../../catalog/providers';
import { ensureAccessToken, type GrokSession } from './auth';
import {
  anthropicToOpenAI,
  estimateAnthropicInputTokens,
  openAIToAnthropic,
  pipeOpenAIStreamToAnthropic,
  sanitizeInferenceToolSchemas,
  type AnthropicMessageRequest,
  type OpenAIChatResponse,
} from '../protocol/anthropic';
import { HOP_BY_HOP, normalizeLocalApiUrl, readBody, requireProxyAuth } from '../proxy-shared';
import { assertLoopbackHost } from '../../utils/network';
import { classifyUpstreamFailure, CooldownRegistry } from '../upstream-policy';

export interface GrokProxyServerOptions {
  host: string;
  port: number;
  authPath: string;
  upstream?: string;
  clientVersion?: string;
  /**
   * When true, POST /v1/messages is translated to OpenAI chat/completions
   * instead of passed through. Default: false (native Anthropic upstream).
   * Also enabled by env GROK_PROXY_TRANSLATE_ANTHROPIC=1.
   */
  translateAnthropic?: boolean;
  /** Per-instance high-entropy secret (PROXY-01) required on credentialed routes. */
  token?: string;
  /** Append request traces to this logger. */
  log?: (line: string) => void;
  quiet?: boolean;
}

const DEFAULT_UPSTREAM = 'https://cli-chat-proxy.grok.com';
const DEFAULT_CLIENT_VERSION = '0.2.101';

const COMPAT_LABEL = 'OpenAI + Anthropic API';

export function createGrokProxyServer(opts: GrokProxyServerOptions): Server {
  assertLoopbackHost(opts.host);
  const upstream = (opts.upstream ?? DEFAULT_UPSTREAM).replace(/\/$/, '');
  const clientVersion = opts.clientVersion ?? DEFAULT_CLIENT_VERSION;
  const translateAnthropic =
    opts.translateAnthropic ?? process.env.GROK_PROXY_TRANSLATE_ANTHROPIC === '1';
  const proxyToken = opts.token ?? process.env.ANYPICK_PROXY_TOKEN ?? '';
  const log =
    opts.log ?? (opts.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`));

  let cached: GrokSession | undefined;
  const cooldowns = new CooldownRegistry();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      json(res, 200, {
        ok: true,
        service: 'anypick-grok-proxy',
        compatibility: COMPAT_LABEL,
        instanceId: process.env.ANYPICK_INSTANCE_ID ?? null,
        clients: {
          codex: 'OPENAI_BASE_URL → /v1/chat/completions',
          claude: 'ANTHROPIC_BASE_URL → /v1/messages',
        },
        endpoints: {
          openai: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
          anthropic: ['/v1/messages', '/v1/messages/count_tokens'],
        },
        translateAnthropic,
        upstream,
      });
      return;
    }

    // Only /v1/* (OpenAI + Anthropic share this prefix)
    if (!path.startsWith('/v1/') && path !== '/v1') {
      json(res, 404, {
        error: {
          message: `Not found: ${path}. Codex/OpenAI: /v1/chat/completions · Claude: /v1/messages · models: /v1/models`,
          type: 'not_found_error',
        },
      });
      return;
    }

    // Every /v1/* route exercises upstream credential authority (PROXY-01).
    if (!requireProxyAuth(req, res, proxyToken)) {
      return;
    }

    // Claude Code polls this for context sizing. xAI does not implement it;
    // answer locally so we never spam cli-chat-proxy with 404 traffic.
    if (method === 'POST' && path === '/v1/messages/count_tokens') {
      await handleCountTokens(req, res);
      return;
    }

    // Optional Anthropic → OpenAI translation for OpenAI-only upstreams
    if (translateAnthropic && method === 'POST' && path === '/v1/messages') {
      await handleAnthropicTranslated(req, res);
      return;
    }

    // Hub catalog discovery needs a usable OpenAI-shaped list even when
    // cli-chat-proxy.grok.com returns 404/empty for /v1/models.
    if ((method === 'GET' || method === 'HEAD') && path === '/v1/models') {
      await handleListModels(req, res, url, method);
      return;
    }

    log(`${method} ${path}`);
    await proxyPassThrough(req, res, url, method);
  }

  async function handleCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      let body: {
        model?: string;
        system?: unknown;
        messages?: unknown;
        tools?: unknown;
        [key: string]: unknown;
      };
      try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as typeof body;
      } catch {
        json(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
        });
        return;
      }
      const inputTokens = estimateAnthropicInputTokens(body);
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : '?';
      log(`POST /v1/messages/count_tokens → ${inputTokens} (local · ${model})`);
      json(res, 200, { input_tokens: inputTokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  ✗ count_tokens ${message}`);
      if (!res.headersSent) {
        json(res, 502, {
          type: 'error',
          error: { type: 'proxy_error', message },
        });
      }
    }
  }

  /**
   * Prefer the live upstream catalog. If it is missing or empty, fall back to
   * the static GROK_MODELS map so Proxy Hub can still publish routes.
   */
  async function handleListModels(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    try {
      const { token, session } = await ensureAccessToken(opts.authPath, cached);
      cached = session;
      const target = `${upstream}${url}`;
      const headers = buildUpstreamHeaders(req, token, clientVersion);
      let upstreamRes = await fetchGrok(
        target,
        {
          method,
          headers,
          signal: AbortSignal.timeout(12_000),
          redirect: 'manual',
        },
        `${method}:${url}`,
      );

      if (upstreamRes.status === 401 && cached?.refreshToken) {
        log('  → 401 on /v1/models, refreshing OIDC token…');
        const refreshed = await ensureAccessToken(opts.authPath);
        cached = refreshed.session;
        const retryHeaders = buildUpstreamHeaders(req, refreshed.token, clientVersion);
        upstreamRes = await fetchGrok(
          target,
          {
            method,
            headers: retryHeaders,
            signal: AbortSignal.timeout(12_000),
            redirect: 'manual',
          },
          `${method}:${url}`,
        );
      }

      if (upstreamRes.ok) {
        const text = await upstreamRes.text();
        const models = modelIdsFromCatalogBody(text);
        if (models.length > 0) {
          log(`  list models ← ${models.length} (upstream)`);
          // Re-emit a normalized OpenAI list so Hub parsing stays strict.
          json(res, 200, {
            object: 'list',
            data: models.map((id) => ({ id, object: 'model', owned_by: 'xai' })),
          });
          return;
        }
        log('  list models ← empty upstream; using static GROK_MODELS');
      } else {
        log(`  list models ← ${upstreamRes.status}; using static GROK_MODELS`);
      }
    } catch (err) {
      log(
        `  list models ✗ ${err instanceof Error ? err.message : String(err)}; using static GROK_MODELS`,
      );
    }

    const models = staticGrokModelIds();
    log(`  list models ← ${models.length} (fallback)`);
    json(res, 200, {
      object: 'list',
      data: models.map((id) => ({ id, object: 'model', owned_by: 'xai' })),
    });
  }

  /**
   * Native pass-through (default): inject OIDC Bearer, forward with only the
   * tool-schema hygiene needed for strict xAI validation.
   */
  async function proxyPassThrough(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    try {
      const { token, session } = await ensureAccessToken(opts.authPath, cached);
      cached = session;

      const target = `${upstream}${url}`;
      const rawBody =
        method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
          ? undefined
          : await readBody(req);
      const body = rawBody ? sanitizePassThroughBody(pathOf(url), rawBody) : undefined;

      // content-length must match the body we actually send — schema sanitize can
      // shrink the payload when stripping null tool-schema keywords.
      const headers = buildUpstreamHeaders(req, token, clientVersion, body?.byteLength);
      if (body) {
        headers['content-length'] = String(body.byteLength);
      }

      const upstreamRes = await fetchGrok(
        target,
        {
          method,
          headers,
          body: body && body.length > 0 ? new Uint8Array(body) : undefined,
          signal: AbortSignal.timeout(600_000),
          redirect: 'manual',
        },
        `${method}:${url}`,
      );

      if (upstreamRes.status === 401 && cached?.refreshToken) {
        log('  → 401, refreshing OIDC token…');
        const refreshed = await ensureAccessToken(opts.authPath);
        cached = refreshed.session;
        const retryHeaders = buildUpstreamHeaders(
          req,
          refreshed.token,
          clientVersion,
          body?.byteLength,
        );
        if (body) {
          retryHeaders['content-length'] = String(body.byteLength);
        }
        const retry = await fetchGrok(
          target,
          {
            method,
            headers: retryHeaders,
            body: body && body.length > 0 ? new Uint8Array(body) : undefined,
            signal: AbortSignal.timeout(600_000),
            redirect: 'manual',
          },
          `${method}:${url}`,
        );
        await pipeResponse(retry, res, log);
        return;
      }

      await pipeResponse(upstreamRes, res, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ ${msg}`);
      if (!res.headersSent) {
        json(res, 502, {
          error: { message: msg, type: 'proxy_error' },
        });
      } else {
        res.end();
      }
    }
  }

  /**
   * Translate Anthropic Messages → OpenAI chat/completions (optional mode).
   */
  async function handleAnthropicTranslated(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    log('POST /v1/messages (translate → chat/completions)');
    try {
      const raw = await readBody(req);
      let body: AnthropicMessageRequest;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') as AnthropicMessageRequest;
      } catch {
        json(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Invalid JSON body',
          },
        });
        return;
      }

      if (!body.model) {
        json(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'model is required',
          },
        });
        return;
      }
      if (body.max_tokens == null) {
        body.max_tokens = 4096;
      }

      const openaiBody = anthropicToOpenAI(body);
      const stream = Boolean(body.stream);
      openaiBody.stream = stream;

      const payload = Buffer.from(JSON.stringify(openaiBody), 'utf8');
      const { token, session } = await ensureAccessToken(opts.authPath, cached);
      cached = session;

      const target = `${upstream}/v1/chat/completions`;
      let upstreamRes = await fetchUpstream(target, token, payload);

      if (upstreamRes.status === 401 && cached?.refreshToken) {
        log('  → 401, refreshing OIDC token…');
        const refreshed = await ensureAccessToken(opts.authPath);
        cached = refreshed.session;
        upstreamRes = await fetchUpstream(target, refreshed.token, payload);
      }

      log(`  ← ${upstreamRes.status} (via chat/completions)`);

      if (stream) {
        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          let message = errText;
          try {
            const parsed = JSON.parse(errText) as {
              error?: { message?: string };
            };
            message = parsed.error?.message ?? errText;
          } catch {
            // keep raw
          }
          res.writeHead(upstreamRes.status, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message },
            }),
          );
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });

        await pipeOpenAIStreamToAnthropic(
          upstreamRes,
          (chunk) => {
            res.write(chunk);
          },
          body.model,
        );
        res.end();
        return;
      }

      const text = await upstreamRes.text();
      let parsed: OpenAIChatResponse;
      try {
        parsed = JSON.parse(text) as OpenAIChatResponse;
      } catch {
        json(res, 502, {
          type: 'error',
          error: {
            type: 'api_error',
            message: `Upstream returned non-JSON: ${text.slice(0, 200)}`,
          },
        });
        return;
      }

      const converted = openAIToAnthropic(parsed, body.model);
      if ('type' in converted && converted.type === 'error') {
        json(res, upstreamRes.status >= 400 ? upstreamRes.status : 502, converted);
        return;
      }
      json(res, upstreamRes.ok ? 200 : upstreamRes.status, converted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ anthropic ${msg}`);
      if (!res.headersSent) {
        json(res, 502, {
          type: 'error',
          error: { type: 'proxy_error', message: msg },
        });
      } else {
        res.end();
      }
    }
  }

  async function fetchUpstream(target: string, token: string, payload: Buffer): Promise<Response> {
    return fetchGrok(
      target,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-grok-client-version': clientVersion,
          'x-grok-client-identifier': 'anypick-grok-proxy',
          'user-agent': `anypick-grok-proxy/${clientVersion}`,
        },
        body: new Uint8Array(payload),
        signal: AbortSignal.timeout(600_000),
        redirect: 'manual',
      },
      `POST:${target}`,
    );
  }

  async function fetchGrok(target: string, init: RequestInit, route: string): Promise<Response> {
    const isInference = init.method === 'POST';
    const key = `grok:${route}`;
    if (isInference) {
      const remaining = cooldowns.remainingMs(key);
      if (remaining > 0) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'rate_limit_error',
              message: 'Grok route is cooling down.',
            },
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': String(Math.ceil(remaining / 1000)),
            },
          },
        );
      }
    }
    const response = await fetch(target, init);
    if (!isInference || response.status !== 429) {
      return response;
    }
    const body = await response.arrayBuffer();
    const failure = classifyUpstreamFailure(
      response.status,
      response.headers,
      new TextDecoder().decode(body),
    );
    if (failure.retryAfterMs) {
      cooldowns.set(key, failure.retryAfterMs);
    }
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }

  return server;
}

function buildUpstreamHeaders(
  req: IncomingMessage,
  token: string,
  clientVersion: string,
  contentLength?: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'x-grok-client-version': clientVersion,
    'x-grok-client-identifier': 'anypick-grok-proxy',
    'user-agent': `anypick-grok-proxy/${clientVersion}`,
    accept: req.headers.accept ?? 'application/json',
  };

  if (req.headers['content-type']) {
    headers['content-type'] = String(req.headers['content-type']);
  } else if (contentLength && contentLength > 0) {
    headers['content-type'] = 'application/json';
  }

  // Claude sends anthropic-version; forward it for native Anthropic upstream
  if (req.headers['anthropic-version']) {
    headers['anthropic-version'] = String(req.headers['anthropic-version']);
  }
  if (req.headers['anthropic-beta']) {
    headers['anthropic-beta'] = String(req.headers['anthropic-beta']);
  }

  // Forward select client headers but never client Authorization / x-api-key
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v || HOP_BY_HOP.has(k.toLowerCase())) {
      continue;
    }
    if (k.toLowerCase() === 'authorization') {
      continue;
    }
    if (k.toLowerCase().startsWith('x-grok-')) {
      continue;
    }
    if (k.toLowerCase() === 'x-api-key') {
      continue;
    }
    if (k.toLowerCase() === 'anthropic-version') {
      continue;
    }
    if (k.toLowerCase() === 'anthropic-beta') {
      continue;
    }
    if (Array.isArray(v)) {
      headers[k] = v.join(', ');
    } else {
      headers[k] = v;
    }
  }

  return headers;
}

async function pipeResponse(
  upstreamRes: Response,
  res: ServerResponse,
  log: (line: string) => void,
): Promise<void> {
  // Buffer small error bodies so the hub log shows the real upstream reason
  // (e.g. xAI schema validation) without replaying multi-MB success streams.
  if (upstreamRes.status >= 400) {
    const errText = await upstreamRes.text();
    const snippet = errText.replaceAll(/[\r\n\t]+/gu, ' ').slice(0, 400);
    log(`  ← ${upstreamRes.status} ${snippet}`);
    const outHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'content-encoding') {
        return;
      }
      if (key.toLowerCase() === 'content-length') {
        return;
      }
      outHeaders[key] = value;
    });
    const payload = Buffer.from(errText, 'utf8');
    outHeaders['content-length'] = String(payload.byteLength);
    res.writeHead(upstreamRes.status, outHeaders);
    res.end(payload);
    return;
  }

  log(`  ← ${upstreamRes.status}`);
  const outHeaders: Record<string, string> = {};
  upstreamRes.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) {
      return;
    }
    if (key.toLowerCase() === 'content-encoding') {
      return;
    }
    outHeaders[key] = value;
  });

  res.writeHead(upstreamRes.status, outHeaders);

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  // Mirror opencode-proxy/stream.ts: honor backpressure and cancel xAI when the
  // hub/client hangs up. Without this, concurrent Claude tool rounds leave
  // half-open upstream streams and the hub logs "Premature close".
  let bytes = 0;
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    void upstreamRes.body?.cancel().catch(() => {});
  };
  res.once('close', onClose);
  const reader = upstreamRes.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    while (!clientGone && !res.writableEnded && !res.destroyed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }
      bytes += value.byteLength;
      if (!res.write(Buffer.from(value))) {
        if (!(await waitForDrain(res))) {
          clientGone = true;
          void reader.cancel().catch(() => {});
          break;
        }
      }
    }
    if (clientGone) {
      log(`  ✗ client disconnected after ${bytes} bytes`);
    }
  } catch (err) {
    if (!clientGone && !isBenignStreamError(err)) {
      log(
        `  ✗ stream interrupted after ${bytes} bytes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    res.removeListener('close', onClose);
    try {
      reader.releaseLock();
    } catch {
      // already released / cancelled
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
}

function waitForDrain(res: ServerResponse): Promise<boolean> {
  if (res.writableEnded || res.destroyed || res.socket?.destroyed) {
    return Promise.resolve(false);
  }
  if (!res.writableNeedDrain) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onFail);
      res.removeListener('error', onFail);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onFail = () => done(false);
    res.once('drain', onDrain);
    res.once('close', onFail);
    res.once('error', onFail);
  });
}

function isBenignStreamError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const value = err as { name?: string; code?: string; message?: string };
  if (value.name === 'AbortError' || value.code === 'ABORT_ERR') {
    return true;
  }
  if (value.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return true;
  }
  return (
    typeof value.message === 'string' &&
    /aborted|premature close|ECONNRESET|EPIPE|socket hang up/i.test(value.message)
  );
}

function checkCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const loopback =
        (parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === '[::1]') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:');
      if (!loopback) {
        json(res, 403, {
          error: {
            type: 'forbidden_origin',
            message: 'Only loopback browser origins are allowed.',
          },
        });
        return false;
      }
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    } catch {
      json(res, 403, {
        error: { type: 'forbidden_origin', message: 'Invalid browser origin.' },
      });
      return false;
    }
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS,HEAD');
  res.setHeader(
    'access-control-allow-headers',
    [
      'authorization',
      'content-type',
      'x-api-key',
      'openai-beta',
      'openai-organization',
      'anthropic-version',
      'anthropic-beta',
    ].join(','),
  );
  return true;
}

/** Canonical ids from the static map (unique, stable order). */
export function staticGrokModelIds(): string[] {
  return [...new Set(Object.values(GROK_MODELS).filter((id) => id.trim().length > 0))];
}

/** Accept OpenAI `{ data:[{id}] }`, `{ models:[] }`, or a bare string array. */
export function modelIdsFromCatalogBody(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object'
            ? (entry as { id?: unknown }).id
            : undefined,
      )
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as { data?: unknown; models?: unknown };
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!list) {
    return [];
  }
  return list
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? (entry as { id?: unknown }).id
          : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

/**
 * Claude Code (and some MCP tool packs) put `"required": null` on tool
 * input_schema. xAI schema validation rejects that; strip null keywords
 * before the body leaves the loopback proxy.
 */
function sanitizePassThroughBody(path: string, body: Buffer): Buffer {
  if (body.length === 0) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return body;
  }
  const { body: next, changed } = sanitizeInferenceToolSchemas(
    path,
    parsed as Record<string, unknown>,
  );
  return changed ? Buffer.from(JSON.stringify(next), 'utf8') : body;
}

export function listenGrokProxy(
  opts: GrokProxyServerOptions,
): Promise<{ server: Server; endpoint: string; port: number }> {
  const server = createGrokProxyServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind Grok proxy'));
        return;
      }
      const endpoint = `http://${opts.host}:${addr.port}`;
      resolve({ server, endpoint, port: addr.port });
    });
  });
}
