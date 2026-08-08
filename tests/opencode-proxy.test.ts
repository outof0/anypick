import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOpenCodeCredential,
  listZenGoCredentials,
  resolveOpenCodeCredentials,
} from '../src/providers/opencode-proxy/auth';
import { listenOpenCodeProxy } from '../src/providers/opencode-proxy/server';
import {
  parseOpenCodeModelDescriptors,
  protocolFromProviderPackage,
  resolveOpenCodeModel,
  usesAnthropicMessagesProtocol,
} from '../src/providers/opencode-proxy/models';
import { modelObject } from '../src/providers/opencode-proxy/types';
import { anthropicContextWindowMessage } from '../src/providers/opencode-proxy/context-budget';

let servers: Server[] = [];

/** Per-test proxy secret (PROXY-01): sent on every credentialed request. */
const TEST_TOKEN = 'test-proxy-token-oc-123';
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

describe('opencode-proxy context budget', () => {
  it('canonicalizes arithmetic context overflow counts for Claude Code', () => {
    const message = anthropicContextWindowMessage(
      JSON.stringify({
        error: {
          message: 'input length and max_tokens exceed context limit: 131841 + 32000 > 163840',
        },
      }),
    );
    expect(message).toBe('prompt is too long: 163841 tokens > 163840 maximum');
  });
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function writeAuth(dir: string, body: Record<string, unknown>): Promise<string> {
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

/**
 * Dual mock: path prefix decides catalog.
 *   /zen/...  and /go/...  so we can set upstream to mock root and map catalogs.
 * Actually server uses full upstream URLs — for unit tests we pass forced
 * single upstream (opts.upstream) which merges into one catalog.
 */
async function mockUpstream(
  handler: (
    reqUrl: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
  ) => { status: number; body: string; headers?: Record<string, string> },
): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const result = handler(req.url ?? '/', req.headers, body);
      res.writeHead(result.status, {
        'content-type': 'application/json',
        ...result.headers,
      });
      res.end(result.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('bind failed');
  }
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

/** Split mock: /zen/v1/* and /go/v1/* on same host. */
async function mockDualCatalog(opts: {
  zenModels: Array<string | { id: string; provider?: { npm: string } }>;
  goModels: Array<string | { id: string; provider?: { npm: string } }>;
  onRequest?: (catalog: string, path: string, body: string) => void;
}): Promise<{ zenBase: string; goBase: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      const isGo = url.startsWith('/go/');
      const catalog = isGo ? 'go' : 'zen';
      const path = url.replace(/^\/(zen|go)/, '') || '/';
      opts.onRequest?.(catalog, path, body);

      if (path.startsWith('/v1/models') || path === '/v1/models') {
        const ids = isGo ? opts.goModels : opts.zenModels;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: ids.map((model) => (typeof model === 'string' ? { id: model } : model)),
          }),
        );
        return;
      }

      if (path.includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            choices: [
              {
                message: { role: 'assistant', content: `from-${catalog}` },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }

      if (path.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `from-${catalog}` }],
            stop_reason: 'end_turn',
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('bind failed');
  }
  const root = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    zenBase: `${root}/zen/v1`,
    goBase: `${root}/go/v1`,
  };
}

describe('opencode-proxy models', () => {
  it('detects protocol from provider metadata, independent of model names', () => {
    expect(protocolFromProviderPackage('@ai-sdk/anthropic')).toBe('anthropic');
    expect(protocolFromProviderPackage('@ai-sdk/openai')).toBe('openai-responses');
    expect(protocolFromProviderPackage('@ai-sdk/google')).toBe('google');
    expect(protocolFromProviderPackage('@ai-sdk/openai-compatible')).toBe('openai-chat');
    expect(usesAnthropicMessagesProtocol({ protocol: 'anthropic' })).toBe(true);
    expect(usesAnthropicMessagesProtocol({ protocol: 'openai-chat' })).toBe(false);
  });

  it('retains protocol metadata returned with a future model id', () => {
    expect(
      parseOpenCodeModelDescriptors({
        data: [{ id: 'future-reasoner-v1', provider: { npm: '@ai-sdk/anthropic' } }],
      }),
    ).toEqual([
      {
        id: 'future-reasoner-v1',
        protocol: 'anthropic',
        providerPackage: '@ai-sdk/anthropic',
        created: undefined,
        ownedBy: undefined,
      },
    ]);
  });

  it('does not silently map a missing id to an unrelated model', () => {
    const result = resolveOpenCodeModel('future-model', ['some-other-model']);
    expect(result).toEqual({ id: 'future-model', remapped: false });
  });

  it('publishes OpenCode usable input limits for client-side compaction', () => {
    expect(
      modelObject('split-limit-model', {
        id: 'split-limit-model',
        catalog: 'zen',
        limits: { context: 400_000, input: 272_000, output: 128_000 },
      }),
    ).toMatchObject({
      context_window: 400_000,
      max_input_tokens: 272_000,
      max_output_tokens: 128_000,
      // OpenCode reserves min(20k, capped output) below a separate input limit.
      auto_compact_token_limit: 252_000,
    });
  });
});

describe('opencode-proxy auth', () => {
  it('loads any platform key (label only — not a plan)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-auth-'));
    const path = await writeAuth(dir, {
      deepseek: { type: 'api', key: 'sk-ds' },
      'opencode-go': { type: 'api', key: 'sk-go' },
      opencode: { type: 'api', key: 'sk-zen' },
    });
    const cred = await loadOpenCodeCredential(path);
    expect(cred.service).toBe('opencode-go');
    expect(cred.apiKey).toBe('sk-go');
  });

  it('lists platform keys only', async () => {
    const list = listZenGoCredentials({
      deepseek: { type: 'api', key: 'x' },
      'opencode-go': { type: 'api', key: 'g' },
    });
    expect(list.map((c) => c.service)).toEqual(['opencode-go']);
  });

  it('keeps pool auth files ordered for credential failover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-auth-pool-'));
    const first = await writeAuth(dir, {
      'opencode-go': { type: 'api', key: 'sk-first' },
    });
    const secondDir = await mkdtemp(join(tmpdir(), 'oc-auth-pool-'));
    const second = await writeAuth(secondDir, {
      opencode: { type: 'api', key: 'sk-second' },
    });
    const ring = await resolveOpenCodeCredentials([first, second], 'api');
    expect(ring.map((credential) => credential.apiKey)).toEqual(['sk-first', 'sk-second']);
  });
});

describe('opencode-proxy server', () => {
  it('logs a redacted upstream error detail for failed Claude requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-error-log-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const logs: string[] = [];
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'mimo-v2.5-free' }] }),
        };
      }
      return {
        status: 500,
        body: JSON.stringify({
          error: {
            type: 'upstream_error',
            message: 'backend overloaded for sk-super-secret-value',
          },
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: false,
      log: (line) => logs.push(line),
      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'mimo-v2.5-free',
        stream: false,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(500);
    const output = logs.join('\n');
    expect(output).toContain(
      'upstream 500 chat/completions (mimo-v2.5-free): upstream_error: backend overloaded',
    );
    expect(output).toContain('<redacted>');
    expect(output).not.toContain('sk-super-secret-value');
  });

  it('forwards a model-specific context overflow without changing the output budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-context-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const logs: string[] = [];
    const inferenceBodies: Array<{ model?: string; max_output_tokens?: number }> = [];
    const up = await mockUpstream((url, _headers, rawBody) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'tight-model' }, { id: 'wide-model' }] }),
        };
      }

      const body = JSON.parse(rawBody) as { model?: string; max_output_tokens?: number };
      inferenceBodies.push(body);
      if (body.model === 'tight-model' && body.max_output_tokens === 32_000) {
        return {
          status: 400,
          body: JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message:
                "Error from provider: This model's maximum context length is 163840 tokens. " +
                'However, you requested 32000 output tokens and your prompt contains at least ' +
                '131841 input tokens, for a total of at least 163841 tokens.',
            },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({ id: 'resp-ok', model: body.model, output: [] }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: false,
      log: (line) => logs.push(line),
      token: TEST_TOKEN,
    });
    servers.push(server);

    const request = (model: string) =>
      fetch(`${endpoint}/responses`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: 'hi', max_output_tokens: 32_000 }),
      });

    const tight = await request('tight-model');
    expect(tight.status).toBe(400);
    expect(await tight.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    });
    expect((await request('wide-model')).status).toBe(200);
    expect(inferenceBodies).toEqual([
      { model: 'tight-model', input: 'hi', max_output_tokens: 32_000 },
      { model: 'wide-model', input: 'hi', max_output_tokens: 32_000 },
    ]);
    expect(logs.some((line) => line.includes('context budget'))).toBe(false);
  });

  it('exposes model limits without mutating the first provider request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-context-preflight-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const logs: string[] = [];
    const inferenceBodies: Array<{ model?: string; input?: string; max_output_tokens?: number }> =
      [];
    const up = await mockUpstream((url, _headers, rawBody) => {
      if (url.startsWith('/metadata')) {
        return {
          status: 200,
          body: JSON.stringify({
            opencode: {
              models: {
                'tight-model': {
                  id: 'tight-model',
                  limit: { context: 163_840, output: 32_768 },
                },
              },
            },
          }),
        };
      }
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'tight-model' }] }),
        };
      }
      const body = JSON.parse(rawBody) as {
        model?: string;
        input?: string;
        max_output_tokens?: number;
      };
      inferenceBodies.push(body);
      return {
        status: 200,
        body: JSON.stringify({ id: 'resp-preflight-ok', model: body.model, output: [] }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      modelMetadataUrl: `${up.url}/metadata`,
      quiet: false,
      log: (line) => logs.push(line),
      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tight-model',
        input: 'x'.repeat(527_332),
        max_output_tokens: 32_000,
      }),
    });

    expect(res.status).toBe(200);
    expect(inferenceBodies).toHaveLength(1);
    expect(inferenceBodies[0]).toMatchObject({
      model: 'tight-model',
      max_output_tokens: 32_000,
    });
    expect(logs.some((line) => line.includes('context optimize'))).toBe(false);

    const modelList = (await (await fetch(`${endpoint}/v1/models`, { headers: AUTH })).json()) as {
      data: Array<{
        id?: string;
        context_window?: number;
        auto_compact_token_limit?: number;
      }>;
    };
    expect(modelList.data).toContainEqual(
      expect.objectContaining({
        id: 'tight-model',
        context_window: 163_840,
        auto_compact_token_limit: 131_840,
      }),
    );
  });

  it('returns a canonical Chat Completions context error without retrying', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-context-chat-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const inferenceBodies: Array<{ model?: string; max_tokens?: number }> = [];
    const up = await mockUpstream((url, _headers, rawBody) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'chat-tight-model' }] }),
        };
      }
      const body = JSON.parse(rawBody) as { model?: string; max_tokens?: number };
      inferenceBodies.push(body);
      if (body.max_tokens === 32_000) {
        return {
          status: 400,
          body: JSON.stringify({
            error: {
              message:
                "Error from provider: This model's maximum context length is 163840 tokens. " +
                'However, you requested 32000 output tokens and your prompt contains at least ' +
                '131841 input tokens, for a total of at least 163841 tokens.',
            },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chat-context-ok',
          object: 'chat.completion',
          choices: [
            {
              message: { role: 'assistant', content: 'recovered after context optimization' },
              finish_reason: 'stop',
            },
          ],
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-tight-model',
        max_tokens: 32_000,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(400);
    expect(inferenceBodies.map((body) => body.max_tokens)).toEqual([32_000]);
    expect(await res.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    });
  });

  it('emits Codex-compatible Responses SSE when context overflow remains after retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-context-codex-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'codex-tight-model' }] }),
        };
      }
      return {
        status: 400,
        body: JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message:
              "Error from provider: This model's maximum context length is 163840 tokens. " +
              'However, you requested 32000 output tokens and your prompt contains at least ' +
              '131841 input tokens, for a total of at least 163841 tokens.',
          },
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'codex-tight-model',
        stream: true,
        input: 'hi',
        max_output_tokens: 32_000,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: response.failed');
    expect(text).toContain('"code":"context_length_exceeded"');
    expect(text).toContain('Your input exceeds the context window');

    const nonStreaming = await fetch(`${endpoint}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex-tight-model',
        stream: false,
        input: 'hi',
        max_output_tokens: 32_000,
      }),
    });
    expect(nonStreaming.status).toBe(400);
    expect(await nonStreaming.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        param: 'input',
        code: 'context_length_exceeded',
      },
    });
  });

  it('returns Claude-compatible invalid_request_error for an unresolvable context overflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-context-claude-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [{ id: 'claude-tight-model', protocol: 'anthropic' }],
          }),
        };
      }
      return {
        status: 400,
        body: JSON.stringify({
          request_id: 'req_claude_context_test',
          error: {
            message:
              "Error from provider: This model's maximum context length is 163840 tokens. " +
              'However, you requested 32000 output tokens and your prompt contains at least ' +
              '131841 input tokens, for a total of at least 163841 tokens.',
          },
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-tight-model',
        stream: true,
        max_tokens: 32_000,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const error = (await res.json()) as {
      type?: string;
      error?: { type?: string; code?: string; message?: string };
      request_id?: string;
    };
    expect(error).toMatchObject({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'prompt is too long: 163841 tokens > 163840 maximum',
      },
      request_id: 'req_claude_context_test',
    });
    expect(res.headers.get('request-id')).toBe(error.request_id);
  });

  it('absorbs transient upstream 500s before Claude starts its own fallback retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-transient-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-upstream-key' },
    });
    const logs: string[] = [];
    let inferenceAttempts = 0;
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'mimo-v2.5-free' }] }),
        };
      }
      inferenceAttempts++;
      if (inferenceAttempts < 3) {
        return {
          status: 500,
          body: JSON.stringify({ error: { message: 'Internal server error' } }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chat-transient-ok',
          object: 'chat.completion',
          choices: [
            {
              message: { role: 'assistant', content: 'recovered' },
              finish_reason: 'stop',
            },
          ],
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: false,
      log: (line) => logs.push(line),
      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'mimo-v2.5-free',
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'large_mcp_tool',
            description: 'x'.repeat(200_500),
            input_schema: { type: 'object', properties: {} },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const responseText = await res.text();
    expect(inferenceAttempts).toBe(3);
    expect(logs.filter((line) => line.includes('retrying in'))).toHaveLength(2);
    expect(logs.some((line) => /tools=1\/\d+kb/.test(line))).toBe(true);
    expect(responseText).toContain('recovered');
  });

  it('accepts a Codex-style root API path and proxies it with Bearer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      'opencode-go': { type: 'api', key: 'sk-secret-go' },
    });

    let sawAuth = '';
    let sawUrl = '';
    const up = await mockUpstream((url, headers, body) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }),
        };
      }
      sawUrl = url;
      sawAuth = String(headers.authorization ?? '');
      expect(body).toContain('hi');
      return {
        status: 200,
        body: JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          choices: [
            {
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url, // single override for this test
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(data.choices[0].message.content).toBe('hello');
    expect(sawAuth).toBe('Bearer sk-secret-go');
    expect(sawUrl).toBe('/chat/completions');
  });

  it('fails over a credential whose balance is exhausted and sticks to the healthy key', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'oc-proxy-pool-'));
    const firstAuth = await writeAuth(firstDir, {
      'opencode-go': { type: 'api', key: 'sk-exhausted' },
    });
    const secondDir = await mkdtemp(join(tmpdir(), 'oc-proxy-pool-'));
    const secondAuth = await writeAuth(secondDir, {
      opencode: { type: 'api', key: 'sk-healthy' },
    });
    const seenAuth: string[] = [];
    const up = await mockUpstream((url, headers) => {
      if (url.startsWith('/models')) {
        return { status: 200, body: JSON.stringify({ data: [{ id: 'pool-model' }] }) };
      }
      const auth = String(headers.authorization ?? '');
      seenAuth.push(auth);
      if (auth === 'Bearer sk-exhausted') {
        return {
          status: 403,
          body: JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Sorry, your account balance is insufficient' },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          choices: [
            {
              message: { role: 'assistant', content: 'served by healthy account' },
              finish_reason: 'stop',
            },
          ],
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath: firstAuth,
      authPaths: [secondAuth],
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const request = () =>
      fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'pool-model', messages: [{ role: 'user', content: 'hi' }] }),
      });

    const first = await request();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(firstBody.choices[0].message.content).toBe('served by healthy account');
    const second = await request();
    expect(second.status).toBe(200);
    expect(seenAuth).toEqual(['Bearer sk-exhausted', 'Bearer sk-healthy', 'Bearer sk-healthy']);
    const health = (await (await fetch(`${endpoint}/health`)).json()) as {
      credential: { service: string; poolSize: number; exhausted: number };
    };
    expect(health.credential).toMatchObject({ service: 'opencode', poolSize: 2, exhausted: 1 });
  });

  it('treats free-model balance errors as an IP quota, not exhausted credentials', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'oc-proxy-free-'));
    const firstAuth = await writeAuth(firstDir, {
      'opencode-go': { type: 'api', key: 'sk-free-first' },
    });
    const secondDir = await mkdtemp(join(tmpdir(), 'oc-proxy-free-'));
    const secondAuth = await writeAuth(secondDir, {
      opencode: { type: 'api', key: 'sk-free-second' },
    });
    let inferenceCalls = 0;
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return { status: 200, body: JSON.stringify({ data: [{ id: 'hy3-free' }] }) };
      }
      inferenceCalls += 1;
      return {
        status: 403,
        body: JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Sorry, your account balance is insufficient' },
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath: firstAuth,
      authPaths: [secondAuth],
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const request = () =>
      fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'hy3-free', messages: [{ role: 'user', content: 'hi' }] }),
      });

    const first = await request();
    expect(first.status).toBe(429);
    expect(first.headers.get('retry-after')).toBeTruthy();
    const firstBody = (await first.json()) as { error: { type: string } };
    expect(firstBody.error.type).toBe('rate_limit_error');
    const second = await request();
    expect(second.status).toBe(429);
    expect(inferenceCalls).toBe(1);
    const health = (await (await fetch(`${endpoint}/health`)).json()) as {
      credential: { poolSize: number; exhausted: number };
    };
    expect(health.credential).toMatchObject({ poolSize: 2, exhausted: 0 });
  });

  it('routes future models by live protocol metadata, not by model-name families', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-secret-zen' },
    });

    let sawUrl = '';
    let sawModel = '';
    const up = await mockUpstream((url, _headers, body) => {
      if (url.startsWith('/metadata')) {
        return {
          status: 200,
          body: JSON.stringify({
            opencode: {
              models: {
                'future-native-v1': {
                  id: 'future-native-v1',
                  provider: { npm: '@ai-sdk/anthropic' },
                },
                'future-chat-v1': {
                  id: 'future-chat-v1',
                  provider: { npm: '@ai-sdk/openai-compatible' },
                },
              },
            },
          }),
        };
      }
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [{ id: 'future-native-v1' }, { id: 'future-chat-v1' }],
          }),
        };
      }
      sawUrl = url;
      try {
        sawModel = (JSON.parse(body) as { model?: string }).model ?? '';
      } catch {
        sawModel = '';
      }
      if (url.includes('chat/completions')) {
        return {
          status: 200,
          body: JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            choices: [
              {
                message: { role: 'assistant', content: 'from-hy3' },
                finish_reason: 'stop',
              },
            ],
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
          stop_reason: 'end_turn',
        }),
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      modelMetadataUrl: `${up.url}/metadata`,
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    // Arbitrarily named native model → /messages
    const r1 = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'x',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'future-native-v1',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(r1.status).toBe(200);
    expect(sawUrl).toBe('/messages');
    expect(sawModel).toBe('future-native-v1');

    // Arbitrarily named chat model → /chat/completions
    const r2 = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'x',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'future-chat-v1',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(r2.status).toBe(200);
    expect(sawUrl).toBe('/chat/completions');
    const data = (await r2.json()) as { content: { text?: string }[] };
    expect(data.content?.[0]?.text).toBe('from-hy3');
  });

  it('adapts dynamically discovered Google and Responses protocols for Claude clients', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-secret-zen' },
    });

    const paths: string[] = [];
    const requestBodies = new Map<string, Record<string, unknown>>();
    const up = await mockUpstream((url, _headers, rawBody) => {
      paths.push(url);
      if (rawBody) {
        requestBodies.set(url, JSON.parse(rawBody) as Record<string, unknown>);
      }
      if (url.startsWith('/models') && !url.includes(':generateContent')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              { id: 'future-google-v1', provider: { npm: '@ai-sdk/google' } },
              { id: 'future-responses-v1', provider: { npm: '@ai-sdk/openai' } },
            ],
          }),
        };
      }
      if (url.includes(':generateContent')) {
        return {
          status: 200,
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'google thinking', thought: true }, { text: 'from-google' }],
                },
                finishReason: 'STOP',
              },
            ],
          }),
        };
      }
      if (url === '/responses') {
        return {
          status: 200,
          body: JSON.stringify({
            id: 'resp_1',
            model: 'future-responses-v1',
            output: [
              {
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'responses thinking' }],
              },
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'from-responses' }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        };
      }
      return { status: 404, body: '{}' };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    const request = (model: string) =>
      fetch(`${endpoint}/v1/messages`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hello' }],
          thinking: { type: 'adaptive' },
          output_config: { effort: 'max' },
        }),
      });

    const google = await request('future-google-v1');
    expect(google.status).toBe(200);
    const googleBody = (await google.json()) as {
      content: Array<{ type: string; text?: string; thinking?: string }>;
    };
    expect(googleBody.content).toMatchObject([
      { type: 'thinking', thinking: 'google thinking' },
      { type: 'text', text: 'from-google' },
    ]);

    const responses = await request('future-responses-v1');
    expect(responses.status).toBe(200);
    const responsesBody = (await responses.json()) as {
      content: Array<{ type: string; text?: string; thinking?: string }>;
    };
    expect(responsesBody.content).toMatchObject([
      { type: 'thinking', thinking: 'responses thinking' },
      { type: 'text', text: 'from-responses' },
    ]);
    expect(paths.some((path) => path.includes('future-google-v1:generateContent'))).toBe(true);
    expect(paths).toContain('/responses');
    expect(
      requestBodies.get('/models/future-google-v1:generateContent')?.generationConfig,
    ).toMatchObject({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(requestBodies.get('/responses')?.reasoning).toEqual({
      effort: 'xhigh',
      summary: 'auto',
    });
  });

  it('requests and forwards authoritative stream usage to Claude Code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-usage-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-secret-zen' },
    });
    let chatRequest: Record<string, unknown> | undefined;
    const up = await mockUpstream((url, _headers, rawBody) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [{ id: 'usage-chat-v1', provider: { npm: '@ai-sdk/openai-compatible' } }],
          }),
        };
      }
      if (!url.includes('/chat/completions')) {
        return { status: 404, body: '{}' };
      }
      chatRequest = JSON.parse(rawBody) as Record<string, unknown>;
      const sse = [
        'data: ' +
          JSON.stringify({
            id: 'chat-usage-1',
            choices: [{ delta: { role: 'assistant' }, finish_reason: null }],
          }),
        'data: ' +
          JSON.stringify({
            id: 'chat-usage-1',
            choices: [{ delta: { content: 'hello' } }],
          }),
        'data: ' +
          JSON.stringify({
            id: 'chat-usage-1',
            choices: [{ delta: {}, finish_reason: 'stop' }],
          }),
        'data: ' +
          JSON.stringify({
            id: 'chat-usage-1',
            choices: [],
            usage: { prompt_tokens: 169355, completion_tokens: 42, total_tokens: 169397 },
          }),
        'data: [DONE]',
        '',
      ].join('\n');
      return {
        status: 200,
        body: sse,
        headers: { 'content-type': 'text/event-stream' },
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'usage-chat-v1',
        stream: true,
        max_tokens: 32_000,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(chatRequest?.stream_options).toMatchObject({ include_usage: true });
    const text = await response.text();
    const messageStart = text.match(/event: message_start\ndata: (.+)\n\n/)?.[1];
    const messageDelta = text.match(/event: message_delta\ndata: (.+)\n\n/)?.[1];
    expect(messageStart ? JSON.parse(messageStart).message.usage.input_tokens : 0).toBeGreaterThan(
      0,
    );
    expect(messageDelta ? JSON.parse(messageDelta).usage : undefined).toMatchObject({
      input_tokens: 169355,
      output_tokens: 42,
    });
  });

  it('normalizes a context error embedded in an HTTP 200 stream for Claude Code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-stream-context-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-secret-zen' },
    });
    let inferenceCalls = 0;
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [{ id: 'stream-context-v1', provider: { npm: '@ai-sdk/openai-compatible' } }],
          }),
        };
      }
      inferenceCalls += 1;
      return {
        status: 200,
        body:
          'data: ' +
          JSON.stringify({
            error: {
              type: 'api_error',
              message:
                "This model's maximum context length is 163840 tokens. " +
                'However, you requested 32000 output tokens and your prompt contains at least ' +
                '131841 input tokens, for a total of at least 163841 tokens.',
            },
          }) +
          '\n\n',
        headers: { 'content-type': 'text/event-stream' },
      };
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
      token: TEST_TOKEN,
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'stream-context-v1',
        stream: true,
        max_tokens: 32_000,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(inferenceCalls).toBe(1);
    const text = await response.text();
    const errorEvent = text.match(/event: error\ndata: (.+)\n\n/)?.[1];
    expect(errorEvent ? JSON.parse(errorEvent) : undefined).toMatchObject({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'prompt is too long: 163841 tokens > 163840 maximum',
      },
    });
  });

  it('health has no plan/translate knobs — dual catalogs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      'opencode-go': { type: 'api', key: 'sk-x' },
    });
    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      // force single mock so health works offline
      upstream: 'http://127.0.0.1:1', // will fail model fetch — ok
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    const h = (await (await fetch(`${endpoint}/health`)).json()) as {
      compatibility: string;
      plan?: string;
      translateAnthropic?: unknown;
      clients: { claude: string };
      credential: { service: string };
    };
    expect(h.compatibility).toContain('Anthropic');
    expect(h.clients.claude).toContain('/v1/messages');
    expect(h.plan).toBeUndefined();
    expect(h.translateAnthropic).toBeUndefined();
    expect(h.credential.service).toBe('opencode-go');
  });

  it('serves GET /v1/models/{id} locally (Claude Code model probe)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      opencode: { type: 'api', key: 'sk-x' },
    });
    const up = await mockUpstream((url) => {
      if (url.startsWith('/models')) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: 'hy3-free' }, { id: 'kimi-k3' }] }),
        };
      }
      return { status: 404, body: '{}' };
    });
    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/models/hy3-free`, {
      headers: { ...AUTH, 'x-api-key': 'x', 'anthropic-version': '2023-06-01' },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; object: string };
    expect(data.object).toBe('model');
    expect(data.id).toBe('hy3-free');
  });

  it('serves /v1/messages/count_tokens locally (Claude Code context sizing)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      'opencode-go': { type: 'api', key: 'sk-x' },
    });
    // Force a dead upstream so we prove count_tokens never hits OpenCode.
    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: 'http://127.0.0.1:1',
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'x',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'hy3-free',
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'hello world, please count these tokens' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
          },
        ],
        tools: [
          {
            name: 'Bash',
            description: 'run shell',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { input_tokens: number };
    expect(data.input_tokens).toBeGreaterThan(20);
    // Must be JSON, never the OpenCode HTML 404 page.
    expect(res.headers.get('content-type')).toMatch(/json/);
  });

  it('merges zen+go catalogs and routes hy3-preview to go, claude to zen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    const authPath = await writeAuth(dir, {
      'opencode-go': { type: 'api', key: 'sk-key' },
    });

    const dual = await mockDualCatalog({
      zenModels: [
        { id: 'claude-sonnet-5', provider: { npm: '@ai-sdk/anthropic' } },
        'hy3-free',
        'big-pickle',
      ],
      goModels: ['hy3-preview', 'kimi-k3', 'glm-5.2'],
    });

    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath,
      zenUpstream: dual.zenBase,
      goUpstream: dual.goBase,
      quiet: true,

      token: TEST_TOKEN,
    });
    servers.push(server);

    const list = (await (await fetch(`${endpoint}/v1/models`, { headers: AUTH })).json()) as {
      data: Array<{ id: string; owned_by?: string }>;
    };
    const ids = list.data.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('hy3-preview');
    expect(ids).toContain('hy3-free');
    // go-only model tagged
    expect(list.data.find((m) => m.id === 'hy3-preview')?.owned_by).toBe('opencode-go');

    // Claude → zen /messages
    const claude = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'x',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(claude.status).toBe(200);
    expect(((await claude.json()) as { content: { text: string }[] }).content[0].text).toBe(
      'from-zen',
    );

    // hy3-preview only on go → go /chat/completions
    const hy3 = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'x',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'hy3-preview',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(hy3.status).toBe(200);
    expect(((await hy3.json()) as { content: { text: string }[] }).content[0].text).toBe('from-go');
  });
});
