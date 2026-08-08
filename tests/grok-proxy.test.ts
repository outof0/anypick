import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrokSession, isExpired } from '../src/providers/grok-proxy/auth';
import { listenGrokProxy } from '../src/providers/grok-proxy/server';

let servers: Server[] = [];
const TEST_TOKEN = 'test-proxy-token-grok-123';
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function mockUpstream(
  handler: (
    reqUrl: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
  ) => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  },
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

async function writeAuth(dir: string): Promise<string> {
  const path = join(dir, 'auth.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        'https://auth.x.ai::test-client': {
          key: 'access-token-abc',
          refresh_token: 'refresh-xyz',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          email: 'user@test.local',
          oidc_issuer: 'https://auth.x.ai',
          oidc_client_id: 'test-client',
          auth_mode: 'oidc',
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return path;
}

describe('grok-proxy auth', () => {
  it('loads session from auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-auth-'));
    const path = await writeAuth(dir);
    const session = await loadGrokSession(path);
    expect(session.accessToken).toBe('access-token-abc');
    expect(session.email).toBe('user@test.local');
    expect(session.oidcClientId).toBe('test-client');
    expect(isExpired(session)).toBe(false);
  });

  it('detects expired sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-auth-'));
    const path = join(dir, 'auth.json');
    await writeFile(
      path,
      JSON.stringify({
        'https://auth.x.ai::c': {
          key: 't',
          refresh_token: 'r',
          expires_at: new Date(Date.now() - 10_000).toISOString(),
          oidc_issuer: 'https://auth.x.ai',
          oidc_client_id: 'c',
        },
      }),
    );
    const session = await loadGrokSession(path);
    expect(isExpired(session)).toBe(true);
  });
});

describe('grok-proxy server', () => {
  it('proxies /v1/chat/completions with injected Bearer + version header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-proxy-'));
    const authPath = await writeAuth(dir);

    let sawAuth = '';
    let sawVersion = '';
    let sawBody = '';

    const up = await mockUpstream((url, headers, body) => {
      sawAuth = String(headers.authorization ?? '');
      sawVersion = String(headers['x-grok-client-version'] ?? '');
      sawBody = body;
      expect(url).toBe('/v1/chat/completions');
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
        }),
      };
    });

    const { server, endpoint } = await listenGrokProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      clientVersion: '0.2.101',
      quiet: true,
    });
    servers.push(server);

    const futureModel = 'grok-future-release-2030';
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: futureModel,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(data.choices[0].message.content).toBe('hello');
    expect(sawAuth).toBe('Bearer access-token-abc');
    expect(sawVersion).toBe('0.2.101');
    expect(JSON.parse(sawBody)).toMatchObject({ model: futureModel });
  });

  it('serves /health and rejects non-v1 paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-proxy-'));
    const authPath = await writeAuth(dir);
    const { server, endpoint } = await listenGrokProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: 'http://127.0.0.1:9',
      quiet: true,
    });
    servers.push(server);

    const health = await fetch(`${endpoint}/health`);
    expect(health.status).toBe(200);
    const h = (await health.json()) as {
      ok: boolean;
      compatibility: string;
      clients?: { codex?: string; claude?: string };
    };
    expect(h.ok).toBe(true);
    expect(h.compatibility).toContain('Anthropic');
    expect(h.compatibility).toContain('OpenAI');
    expect(h.clients?.claude).toContain('/v1/messages');
    expect(h.clients?.codex).toContain('/v1/chat/completions');

    const bad = await fetch(`${endpoint}/secret`);
    expect(bad.status).toBe(404);
  });

  it('pass-through Anthropic /v1/messages (Claude native)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-proxy-'));
    const authPath = await writeAuth(dir);

    let sawUrl = '';
    let sawVersion = '';
    let sawAuth = '';

    const up = await mockUpstream((url, headers, body) => {
      sawUrl = url;
      sawVersion = String(headers['anthropic-version'] ?? '');
      sawAuth = String(headers.authorization ?? '');
      expect(url).toBe('/v1/messages');
      expect(body).toContain('hello');
      return {
        status: 200,
        body: JSON.stringify({
          id: 'msg_native',
          type: 'message',
          role: 'assistant',
          model: 'grok-4.5',
          content: [{ type: 'text', text: 'hi from native' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      };
    });

    const { server, endpoint } = await listenGrokProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'dummy',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'grok-4.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      type: string;
      content: { text: string }[];
    };
    expect(data.type).toBe('message');
    expect(data.content[0].text).toBe('hi from native');
    expect(sawUrl).toBe('/v1/messages');
    expect(sawVersion).toBe('2023-06-01');
    expect(sawAuth).toBe('Bearer access-token-abc');
  });

  it('translates Anthropic when translateAnthropic=true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-proxy-'));
    const authPath = await writeAuth(dir);

    let sawUrl = '';

    const up = await mockUpstream((url, _headers, body) => {
      sawUrl = url;
      expect(url).toBe('/v1/chat/completions');
      const parsed = JSON.parse(body) as {
        messages: { role: string }[];
        reasoning_effort?: string;
      };
      expect(parsed.messages.some((m) => m.role === 'system')).toBe(true);
      expect(parsed.reasoning_effort).toBe('xhigh');
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chatcmpl-a1',
          object: 'chat.completion',
          model: 'grok-4.5',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                reasoning_content: 'brief reasoning',
                content: 'hi from translate',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      };
    });

    const { server, endpoint } = await listenGrokProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
      translateAnthropic: true,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'x-api-key': 'dummy',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'grok-4.5',
        max_tokens: 256,
        system: 'be brief',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      type: string;
      content: { type: string; text: string }[];
    };
    expect(data.type).toBe('message');
    expect(data.content[0]).toEqual({
      type: 'thinking',
      thinking: 'brief reasoning',
      signature: '',
    });
    expect(data.content[1]).toEqual({
      type: 'text',
      text: 'hi from translate',
    });
    expect(sawUrl).toBe('/v1/chat/completions');
  });

  it('proxies /v1/models', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-proxy-'));
    const authPath = await writeAuth(dir);
    const futureModel = 'grok-future-release-2030';
    const up = await mockUpstream(() => ({
      status: 200,
      body: JSON.stringify({
        object: 'list',
        data: [{ id: futureModel, object: 'model' }],
      }),
    }));

    const { server, endpoint } = await listenGrokProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authPath,
      upstream: up.url,
      quiet: true,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/models`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { id: string }[] };
    expect(data.data[0].id).toBe(futureModel);
  });
});
