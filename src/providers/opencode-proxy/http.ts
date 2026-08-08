import type { IncomingMessage, ServerResponse } from 'node:http';
import { HOP_BY_HOP } from '../proxy-shared';
import { USER_AGENT } from './constants';

export function withUpstreamCredential(init: RequestInit, apiKey: string): RequestInit {
  const headers = new Headers(init.headers);
  if (headers.has('x-goog-api-key')) {
    headers.set('x-goog-api-key', apiKey);
  } else if (headers.has('x-api-key')) {
    headers.set('x-api-key', apiKey);
  } else {
    headers.set('authorization', `Bearer ${apiKey}`);
  }
  return { ...init, headers };
}

export function buildUpstreamHeaders(
  req: IncomingMessage,
  apiKey: string,
  opts: { contentLength?: number; anthropic?: boolean; sessionId?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: req.headers.accept ?? 'application/json',
  };
  if (opts.anthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = String(req.headers['anthropic-version'] ?? '2023-06-01');
    if (req.headers['anthropic-beta']) {
      headers['anthropic-beta'] = String(req.headers['anthropic-beta']);
    }
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  headers['x-opencode-client'] = 'desktop';
  if (opts.sessionId) {
    headers['x-opencode-session'] = opts.sessionId;
  }
  for (const name of [
    'x-opencode-session',
    'x-opencode-request',
    'x-opencode-client',
    'x-opencode-project',
  ] as const) {
    const value = req.headers[name];
    if (value) {
      headers[name] = String(value);
    }
  }
  if (req.headers['content-type']) {
    headers['content-type'] = String(req.headers['content-type']);
  } else if (opts.contentLength && opts.contentLength > 0) {
    headers['content-type'] = 'application/json';
  }
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP.has(key.toLowerCase())) {
      continue;
    }
    const lower = key.toLowerCase();
    if (['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'].includes(lower)) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

export function checkCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      const loopback =
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        (url.protocol === 'http:' || url.protocol === 'https:');
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
      json(res, 403, { error: { type: 'forbidden_origin', message: 'Invalid browser origin.' } });
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
    ].join(', '),
  );
  return true;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

export function stripTrailingSlash(url: string | undefined): string | undefined {
  return url ? url.replace(/\/$/, '') : undefined;
}
