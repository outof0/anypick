import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppReady, type AnyPickApp } from '../src/core/app';
import { ProxyHubServer } from '../src/core/proxy-hub-server';
import { ProviderRegistry } from '../src/core/registry';
import type { ProxyHubSourceRef } from '../src/types';
import { FakeProvider } from './helpers';

describe('Proxy Hub streaming', () => {
  let root: string | undefined;
  let app: AnyPickApp | undefined;
  let hub: ProxyHubServer | undefined;
  let backend: Server | undefined;
  const logs: string[] = [];

  afterEach(async () => {
    await hub?.close();
    hub = undefined;
    await new Promise<void>((resolve) => {
      if (!backend) {
        resolve();
        return;
      }
      backend.close(() => resolve());
    });
    backend = undefined;
    app?.close();
    app = undefined;
    logs.length = 0;
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function startHubWithStreamingBackend(opts: {
    chunkDelayMs?: number;
    chunks?: string[];
  }): Promise<{ endpoint: string; token: string; backendHits: () => number }> {
    root = await mkdtemp(join(tmpdir(), 'anypick-hub-stream-'));
    const providers = new ProviderRegistry();
    const source = new FakeProvider('stream-src', join(root, 'live', 'stream-src'), {
      withProxy: true,
      defaultProxyPort: 0,
    });

    const chunks = opts.chunks ?? ['data: {"type":"ping"}\n\n', 'data: {"type":"done"}\n\n'];
    const chunkDelayMs = opts.chunkDelayMs ?? 40;
    let hits = 0;

    backend = createServer((req, res) => {
      hits += 1;
      if (req.method === 'POST' && (req.url === '/v1/messages' || req.url?.startsWith('/v1/'))) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let i = 0;
        const tick = () => {
          if (i >= chunks.length) {
            res.end();
            return;
          }
          res.write(chunks[i]);
          i += 1;
          setTimeout(tick, chunkDelayMs);
        };
        tick();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      backend!.once('error', reject);
      backend!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = backend.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('backend bind failed');
    }
    const backendEndpoint = `http://127.0.0.1:${addr.port}`;

    source.createProxyHubBackend = async () => ({
      endpoint: backendEndpoint,
      close: async () => {},
    });
    providers.register(source);

    app = await createAppReady({
      root,
      bare: true,
      skipMigrate: true,
      accountRegistry: providers,
    });
    await source.setLive({ email: 'stream@test.local', token: 'secret' });
    await app.accounts.save('stream-src', 'work');

    const sourceRef: ProxyHubSourceRef = {
      kind: 'account',
      provider: 'stream-src',
      name: 'work',
    };
    const config = await app.hub.get();
    await app.hub.save({
      ...config,
      enabled: true,
      sources: [{ ref: sourceRef, enabled: true }],
    });

    const route = app.hubStore.attachRoute('test-route', {
      version: 1,
      hub: 'default',
      revision: 1,
      client: 'claude',
      protocol: 'anthropic',
      routes: [{ model: 'test-model', source: sourceRef, upstreamModel: 'test-model' }],
    });

    hub = new ProxyHubServer(
      {
        hubs: app.hubStore,
        accounts: app.accounts,
        pools: app.pools,
        accountRegistry: app.accountRegistry,
      },
      {
        name: 'default',
        host: '127.0.0.1',
        port: 0,
        log: (line) => logs.push(line),
      },
    );
    const listening = await hub.listen();
    return {
      endpoint: listening.endpoint,
      token: route.token,
      backendHits: () => hits,
    };
  }

  it('completes a streamed response without Premature close', async () => {
    const { endpoint, token } = await startHubWithStreamingBackend({
      chunkDelayMs: 15,
      chunks: ['chunk-a', 'chunk-b', 'chunk-c'],
    });

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('chunk-achunk-bchunk-c');
    expect(logs.some((line) => /Premature close/i.test(line))).toBe(false);
    expect(logs.some((line) => /route test-model -> stream-src\/work failed/i.test(line))).toBe(
      false,
    );
    expect(logs.some((line) => /route test-model -> stream-src\/work 200 \d+ms/.test(line))).toBe(
      true,
    );
  });

  it('answers count_tokens locally without opening a provider backend', async () => {
    const { endpoint, token, backendHits } = await startHubWithStreamingBackend({});
    const res = await fetch(`${endpoint}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'test-model',
        system: 'budget context carefully for the coding agent',
        messages: [{ role: 'user', content: 'how many tokens is this request roughly?' }],
        tools: [
          {
            name: 'Read',
            description: 'read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { input_tokens: number };
    expect(data.input_tokens).toBeGreaterThan(10);
    expect(backendHits()).toBe(0);
    expect(logs.some((line) => /count_tokens test-model → \d+ \(local estimate\)/.test(line))).toBe(
      true,
    );
    expect(logs.some((line) => /route test-model -> stream-src\/work/.test(line))).toBe(false);
  });

  it('treats mid-stream client abort as disconnect, not a hard failure', async () => {
    const { endpoint, token } = await startHubWithStreamingBackend({
      chunkDelayMs: 80,
      chunks: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'],
    });

    const controller = new AbortController();
    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    // Abort while the hub is still piping chunks — fetch headers already landed.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toThrow();

    // Let the hub finish handling the disconnect.
    await new Promise((r) => setTimeout(r, 200));

    expect(logs.some((line) => /Premature close/i.test(line))).toBe(false);
    expect(logs.some((line) => /route test-model -> stream-src\/work failed/i.test(line))).toBe(
      false,
    );
    expect(
      logs.some((line) =>
        /route test-model -> stream-src\/work client disconnect \d+ms/.test(line),
      ),
    ).toBe(true);
  });
});
