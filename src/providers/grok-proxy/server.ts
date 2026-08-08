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
 * without a Hotplug update. Optional translate mode
 * (GROK_PROXY_TRANSLATE_ANTHROPIC=1) rewrites Anthropic → chat/completions
 * for OpenAI-only upstreams.
 *
 * Clients point BASE_URL here with any dummy API key / auth token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ensureAccessToken, type GrokSession } from './auth';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  pipeOpenAIStreamToAnthropic,
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
  const proxyToken = opts.token ?? process.env.HOTPLUG_PROXY_TOKEN ?? '';
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
        service: 'hotplug-grok-proxy',
        compatibility: COMPAT_LABEL,
        instanceId: process.env.HOTPLUG_INSTANCE_ID ?? null,
        clients: {
          codex: 'OPENAI_BASE_URL → /v1/chat/completions',
          claude: 'ANTHROPIC_BASE_URL → /v1/messages',
        },
        endpoints: {
          openai: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
          anthropic: ['/v1/messages'],
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

    // Optional Anthropic → OpenAI translation for OpenAI-only upstreams
    if (translateAnthropic && method === 'POST' && path === '/v1/messages') {
      await handleAnthropicTranslated(req, res);
      return;
    }

    log(`${method} ${path}`);
    await proxyPassThrough(req, res, url, method);
  }

  /** Native pass-through (default): inject OIDC Bearer, forward as-is. */
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
      const body =
        method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
          ? undefined
          : await readBody(req);

      const headers = buildUpstreamHeaders(req, token, clientVersion, body?.byteLength);

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
          'x-grok-client-identifier': 'hotplug-grok-proxy',
          'user-agent': `hotplug-grok-proxy/${clientVersion}`,
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
    'x-grok-client-identifier': 'hotplug-grok-proxy',
    'user-agent': `hotplug-grok-proxy/${clientVersion}`,
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

  const reader = upstreamRes.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    res.end();
  }
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
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
