/**
 * Shared plumbing for the built-in compatibility proxies (grok / gemini /
 * opencode). These helpers are intentionally protocol-agnostic: each proxy
 * server still owns its *request-translation* and *header-forwarding* rules
 * (they differ per upstream protocol), but the low-level HTTP mechanics —
 * body buffering and the hop-by-hop header set — are identical and live here so
 * they are not copied across three servers.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** Headers that must never be forwarded to/from an upstream (RFC 7230 §6.1). */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** True when `name` is a hop-by-hop header (case-insensitive). */
export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name.toLowerCase());
}

/**
 * Codex model-provider `base_url` is a prefix and calls `/responses`, while
 * OpenAI SDK base URLs commonly call `/v1/responses`. Accept both spellings at
 * the local boundary and keep one canonical `/v1/*` path internally.
 */
export function normalizeLocalApiUrl(url: string): string {
  const queryIndex = url.indexOf('?');
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const query = queryIndex >= 0 ? url.slice(queryIndex) : '';
  const rootApiPath =
    path === '/responses' ||
    path.startsWith('/responses/') ||
    path === '/chat/completions' ||
    path === '/models' ||
    path.startsWith('/models/') ||
    path === '/messages' ||
    path.startsWith('/messages/');
  return rootApiPath ? `/v1${path}${query}` : url;
}

/**
 * Buffer a request body into a single Buffer. Enforces a 32 MiB cap so a
 * malicious or runaway client cannot exhaust memory in a long-lived proxy.
 */
export function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Install one idempotent graceful-shutdown path for a detached HTTP proxy.
 * New requests stop immediately, idle keep-alive sockets are closed, and only
 * genuinely stuck connections are destroyed after the grace period.
 */
export function installProxyShutdown(server: Server, graceMs = 2500): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.closeIdleConnections?.();
    server.close(() => {
      process.exitCode = 0;
    });
    const force = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, graceMs);
    force.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * Constant-time compare of two secrets. Lengths are not equalized, but the
 * comparison short-circuits only after the shorter buffer is exhausted, so a
 * fixed expected token removes most timing signal. Rejects empty expected.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still run a compare so timing does not reveal length mismatch early.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Require the per-instance proxy secret on a credentialed route (PROXY-01).
 *
 * Accepts the secret via the client protocols' normal credential headers
 * (`Authorization: Bearer <token>` or `x-api-key: <token>`), normalizes it to
 * local authentication, and compares in constant time. On any mismatch the
 * response is a `401` and the caller must NOT contact upstream. When
 * `expectedToken` is empty/unset the proxy is misconfigured — fail closed.
 *
 * Returns `true` when the request is authenticated (caller may proceed).
 */
export function requireProxyAuth(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken?: string,
): boolean {
  if (!expectedToken) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: { type: 'unauthorized', message: 'Proxy authentication is not configured.' },
      }),
    );
    return false;
  }
  const auth = req.headers['authorization'];
  const xApiKey = req.headers['x-api-key'];
  const provided =
    (typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : typeof auth === 'string'
        ? auth.trim()
        : '') || (typeof xApiKey === 'string' ? xApiKey.trim() : '');
  if (!provided || !safeEqual(provided, expectedToken)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: { type: 'unauthorized', message: 'Missing or invalid proxy token.' },
      }),
    );
    return false;
  }
  return true;
}
