import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProxyHubBackendHandle, ProxyHubSourceRef } from '../types';
import { sanitizeInferenceToolSchemas } from '../providers/protocol/json-schema';
import { normalizeLocalApiUrl } from '../providers/proxy-shared';
import { estimateAnthropicInputTokens } from '../providers/protocol/token-estimate';
import { assertLoopbackHost } from '../utils/network';
import { displayRef, serializeRef } from './refs';
import type { AccountService } from './service';
import type { PoolStore } from './pool-store';
import type { ProviderRegistry } from './registry';
import type { ProxyHubRouteSecret, ProxyHubStore } from './proxy-hub-store';

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Never forward these on the hub→client leg: fetch may have already
  // decompressed the backend body, and Node will re-chunk the stream.
  'content-encoding',
  'content-length',
]);

export interface ProxyHubServerDeps {
  hubs: ProxyHubStore;
  accounts: AccountService;
  pools: PoolStore;
  accountRegistry: ProviderRegistry;
}

export interface ProxyHubServerOptions {
  name: string;
  host: string;
  port: number;
  instanceId?: string;
  log?: (line: string) => void;
}

export interface ProxyHubBackendSession {
  token: string;
  handle: ProxyHubBackendHandle;
}

/** Shared provider-owned backend cache for the Hub runtime and catalog refresh. */
export class ProxyHubBackendRegistry {
  private readonly backends = new Map<string, ProxyHubBackendSession>();

  constructor(
    private readonly deps: ProxyHubServerDeps,
    private readonly log: (line: string) => void,
  ) {}

  async open(source: ProxyHubSourceRef): Promise<ProxyHubBackendSession> {
    const sourceId = serializeRef(source);
    const existing = this.backends.get(sourceId);
    if (existing) {
      return existing;
    }
    const accounts = await this.accountsFor(source);
    const provider = this.deps.accountRegistry.get(source.provider);
    if (!provider.createProxyHubBackend) {
      throw new Error(`${provider.name} does not support Proxy Hub`);
    }
    const token = randomBytes(32).toString('hex');
    const handle = await provider.createProxyHubBackend({
      source,
      accounts,
      token,
      log: (line) => this.log(`[${displayRef(source)}] ${line}`),
    });
    const entry: ProxyHubBackendSession = { token, handle };
    this.backends.set(sourceId, entry);
    return entry;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.backends.values()].map((entry) => entry.handle.close()));
    this.backends.clear();
  }

  private async accountsFor(source: ProxyHubSourceRef) {
    if (source.kind === 'account') {
      const account = await this.deps.accounts.get(source.provider, source.name);
      if (!account) {
        throw new Error(`Proxy Hub source ${displayRef(source)} does not exist`);
      }
      return [{ name: account.meta.name, snapshotDir: account.snapshotDir, proxy: account.proxy }];
    }
    const pool = await this.deps.pools.get(source.provider);
    if (!pool || pool.mode !== 'multi') {
      throw new Error(
        `Proxy Hub source ${displayRef(source)} is not an enabled multi-account pool`,
      );
    }
    const accounts = await Promise.all(
      pool.members
        .filter((member) => member.enabled)
        .map((member) => this.deps.accounts.get(source.provider, member.account)),
    );
    const resolved = accounts.filter(
      (account): account is NonNullable<typeof account> => account != null,
    );
    if (resolved.length === 0) {
      throw new Error(`Proxy Hub source ${displayRef(source)} has no saved accounts`);
    }
    return resolved.map((account) => ({
      name: account.meta.name,
      snapshotDir: account.snapshotDir,
      proxy: account.proxy,
    }));
  }
}

/**
 * The single public listener. Provider servers run as private loopback
 * backends in this same process; their per-backend token is never exposed to a
 * client. This keeps provider protocol code provider-owned while eliminating
 * the user-visible endpoint/process fan-out.
 */
export class ProxyHubServer {
  readonly instanceId: string;
  private readonly backends: ProxyHubBackendRegistry;
  private closed = false;
  private readonly log: (line: string) => void;
  private readonly server: Server;

  constructor(
    private readonly deps: ProxyHubServerDeps,
    private readonly opts: ProxyHubServerOptions,
  ) {
    assertLoopbackHost(opts.host);
    this.instanceId = opts.instanceId ?? randomUUID();
    this.log = opts.log ?? (() => {});
    this.backends = new ProxyHubBackendRegistry(deps, this.log);
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => this.fail(res, error));
    });
  }

  async listen(): Promise<{ endpoint: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Proxy Hub did not bind a TCP listener');
    }
    return { endpoint: `http://${this.opts.host}:${address.port}`, port: address.port };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Drop keep-alive / mid-stream clients so close() does not hang under
    // `tsx watch` reloads (tsx force-kills after 5s if we stall on open SSE).
    this.server.closeIdleConnections?.();
    await Promise.allSettled([this.backends.close()]);
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        this.server.closeAllConnections?.();
        resolve();
      }, 1_500);
      force.unref?.();
      this.server.close((error) => {
        clearTimeout(force);
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          // Still resolve — caller is shutting down.
        }
        resolve();
      });
    });
    this.server.closeAllConnections?.();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Codex treats a model-provider `base_url` as a prefix and calls
    // `/responses`; OpenAI SDKs call `/v1/responses`. Canonicalize to `/v1/*`
    // before routing so both spellings reach the same backend.
    const url = new URL(normalizeLocalApiUrl(req.url ?? '/'), `http://${this.opts.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/health')) {
      this.json(res, 200, {
        ok: true,
        service: 'anypick-proxy-hub',
        instanceId: this.instanceId,
        hub: this.opts.name,
      });
      return;
    }
    if (!path.startsWith('/v1/')) {
      this.json(res, 404, { error: { type: 'not_found_error', message: `Not found: ${path}` } });
      return;
    }

    const route = await this.authenticate(req);
    if (!route) {
      this.json(res, 401, {
        error: { type: 'authentication_error', message: 'Invalid proxy token' },
      });
      return;
    }
    if (route.manifest.hub !== this.opts.name) {
      this.json(res, 403, {
        error: { type: 'permission_error', message: 'Route is not valid for this hub' },
      });
      return;
    }

    if (method === 'GET' && path === '/v1/models') {
      this.json(res, 200, {
        object: 'list',
        data: route.manifest.routes.map((target) => ({
          id: target.model,
          object: 'model',
          owned_by: 'anypick',
        })),
      });
      return;
    }

    if (method !== 'POST') {
      this.json(res, 405, { error: { type: 'invalid_request_error', message: 'POST required' } });
      return;
    }

    const body = await readBody(req);
    const request = parseRequest(body);
    if (!request || typeof request.model !== 'string' || !request.model.trim()) {
      this.json(res, 400, {
        error: { type: 'invalid_request_error', message: 'model is required' },
      });
      return;
    }
    const target = route.manifest.routes.find((candidate) => candidate.model === request.model);
    if (!target) {
      this.json(res, 400, {
        error: {
          type: 'invalid_request_error',
          message: `Model ${request.model} is not available for this proxy route`,
        },
      });
      return;
    }

    // Claude Code polls this for context budgeting. Many provider backends
    // (xAI Grok, etc.) do not implement it and return 404 — never forward, or
    // the upstream may treat the spam as abuse.
    if (path === '/v1/messages/count_tokens') {
      const inputTokens = estimateAnthropicInputTokens(request);
      this.log(`count_tokens ${safeLogField(target.model)} → ${inputTokens} (local estimate)`);
      this.json(res, 200, { input_tokens: inputTokens });
      return;
    }

    request.model = target.upstreamModel;
    // Claude Code emits `"required": null` on tool schemas; strict backends
    // (xAI) reject that. Sanitize here so every provider backend benefits.
    const sanitized = sanitizeInferenceToolSchemas(url.pathname, request);
    const backend = await this.backends.open(target.source);
    const startedAt = Date.now();
    const model = safeLogField(target.model);
    const source = safeLogField(displayRef(target.source));
    try {
      const outcome = await this.forward(
        req,
        res,
        url,
        Buffer.from(JSON.stringify(sanitized.body)),
        backend,
      );
      const elapsed = Date.now() - startedAt;
      if (outcome === 'client-disconnect') {
        // Claude (and other clients) cancel in-flight tool rounds often; this is
        // not a backend failure. Log quietly so real errors stay visible.
        this.log(`route ${model} -> ${source} client disconnect ${elapsed}ms`);
      } else {
        this.log(`route ${model} -> ${source} ${res.statusCode} ${elapsed}ms`);
      }
    } catch (error) {
      this.log(`route ${model} -> ${source} failed ${Date.now() - startedAt}ms`);
      throw error;
    }
  }

  private async authenticate(req: IncomingMessage): Promise<ProxyHubRouteSecret | null> {
    const raw = requestToken(req);
    if (!raw) {
      return null;
    }
    const routes = this.deps.hubs.listRouteSecrets(this.opts.name);
    let authenticated: ProxyHubRouteSecret | null = null;
    for (const candidate of routes) {
      if (sameSecret(raw, candidate.token)) {
        authenticated = candidate;
      }
    }
    return authenticated;
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: Buffer,
    backend: ProxyHubBackendSession,
  ): Promise<'ok' | 'client-disconnect'> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      const normalized = key.toLowerCase();
      if (
        value === undefined ||
        HOP_BY_HOP.has(normalized) ||
        normalized === 'host' ||
        normalized === 'authorization' ||
        // Request content-length is set from the rewritten body below.
        normalized === 'content-length'
      ) {
        continue;
      }
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('authorization', `Bearer ${backend.token}`);
    headers.set('content-length', String(body.byteLength));

    const abort = new AbortController();
    const markClientGone = () => {
      if (!abort.signal.aborted) {
        abort.abort(new Error('client disconnected'));
      }
    };
    const onRequestAbort = () => markClientGone();
    // Successful completion also emits 'close'. Only cancel upstream when the
    // client hung up before we finished writing.
    const onResponseClose = () => {
      if (!res.writableFinished) {
        markClientGone();
      }
    };
    req.once('aborted', onRequestAbort);
    res.once('close', onResponseClose);
    try {
      const upstream = await fetch(`${backend.handle.endpoint}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: new Uint8Array(body),
        signal: abort.signal,
        redirect: 'manual',
      });
      for (const [key, value] of upstream.headers.entries()) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      res.statusCode = upstream.status;
      if (!upstream.body) {
        res.end();
        return 'ok';
      }
      // Manual pipe (not stream.pipeline): Claude cancels tool rounds constantly.
      // pipeline() rejects with "Premature close" on those disconnects; the
      // reader loop treats them as a normal client-disconnect outcome instead.
      return await pipeWebStreamToResponse(upstream.body, res, abort);
    } catch (error) {
      if (isBenignClientClose(error, res, abort.signal)) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return 'client-disconnect';
      }
      throw error;
    } finally {
      req.removeListener('aborted', onRequestAbort);
      res.removeListener('close', onResponseClose);
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(raw),
    });
    res.end(raw);
  }

  private fail(res: ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // Client cancel after headers is common with Claude tool loops; do not
    // spam hub logs or invent a 502 body the client will never read.
    if (isBenignClientClose(error, res, undefined)) {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      return;
    }
    this.log(`error ${message}`);
    if (!res.headersSent) {
      this.json(res, 502, { error: { type: 'proxy_error', message: 'Proxy Hub backend failed' } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * Copy a fetch body onto the client response with backpressure. Returns
 * `client-disconnect` when Claude (or another client) cancels mid-stream —
 * never throws "Premature close" for that case.
 */
async function pipeWebStreamToResponse(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  abort: AbortController,
): Promise<'ok' | 'client-disconnect'> {
  let clientGone = abort.signal.aborted;
  const onAbort = () => {
    clientGone = true;
    void body.cancel().catch(() => {});
  };
  abort.signal.addEventListener('abort', onAbort, { once: true });
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    while (!clientGone && !res.writableEnded && !res.destroyed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }
      if (!res.write(Buffer.from(value))) {
        if (!(await waitForDrain(res))) {
          clientGone = true;
          if (!abort.signal.aborted) {
            abort.abort(new Error('client disconnected'));
          }
          void reader.cancel().catch(() => {});
          break;
        }
      }
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    return clientGone || abort.signal.aborted ? 'client-disconnect' : 'ok';
  } catch (error) {
    if (clientGone || isBenignClientClose(error, res, abort.signal)) {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      return 'client-disconnect';
    }
    throw error;
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // already released / cancelled
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

/**
 * fetch throws AbortError when we cancel for a client hang-up. Residual
 * stream errors after the client is gone are also not hub failures.
 */
function isBenignClientClose(
  error: unknown,
  res: ServerResponse,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const value = error as {
    name?: string;
    code?: string;
    message?: string;
    cause?: unknown;
    errors?: unknown[];
  };
  if (value.name === 'AbortError' || value.code === 'ABORT_ERR') {
    return true;
  }
  if (value.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return true;
  }
  if (
    typeof value.message === 'string' &&
    (/premature close/i.test(value.message) ||
      /aborted|client disconnected|this operation was aborted|terminated|other side closed/i.test(
        value.message,
      ))
  ) {
    return true;
  }
  // AggregateError from multi-stream cleanup — inspect nested errors.
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors) {
      if (isBenignClientClose(nested, res, signal)) {
        return true;
      }
    }
  }
  // Client already gone / response fully written — any residual stream error is
  // not actionable for the user.
  if (res.destroyed || res.writableFinished || res.writableEnded) {
    return (
      typeof value.message === 'string' &&
      (/ECONNRESET|EPIPE|socket hang up|write after end|terminated/i.test(value.message) ||
        value.code === 'ECONNRESET' ||
        value.code === 'EPIPE' ||
        value.code === 'UND_ERR_SOCKET')
    );
  }
  return value.cause ? isBenignClientClose(value.cause, res, signal) : false;
}

function safeLogField(value: string): string {
  return value.replaceAll(/[\r\n\t]/gu, ' ').slice(0, 256);
}

function requestToken(req: IncomingMessage): string | null {
  if (typeof req.headers.authorization !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(req.headers.authorization.trim());
  return match?.[1]?.trim() || null;
}

function sameSecret(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<unknown>) {
    const next =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : chunk instanceof Uint8Array
          ? new Uint8Array(chunk)
          : undefined;
    if (!next) {
      throw new Error('Proxy Hub received an invalid request body chunk');
    }
    size += next.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('Request body exceeds Proxy Hub limit');
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

function parseRequest(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
