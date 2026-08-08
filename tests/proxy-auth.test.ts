import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listenGeminiProxy } from '../src/providers/gemini-proxy/server';
import { listenGrokProxy } from '../src/providers/grok-proxy/server';
import { listenOpenCodeProxy } from '../src/providers/opencode-proxy/server';

// PROXY-01 regression: every local credentialed proxy must authenticate the
// caller before exercising upstream credential authority. A local process that
// reaches the loopback port without the per-instance token must get a 401 and
// the upstream must never be contacted.

const SECRET = 'regression-proxy-secret-abc123';
const AUTH = { authorization: `Bearer ${SECRET}` };

let servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

/** A mock upstream that records whether it was ever contacted. */
async function recordingUpstream(): Promise<{ url: string; hit: () => boolean }> {
  let contacted = false;
  const server = createServer((_req, res) => {
    contacted = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    // Minimal shapes accepted by each proxy's model listing.
    res.end(JSON.stringify({ models: [], data: [] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, hit: () => contacted };
}

async function geminiDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-auth-gemini-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.env'), 'GEMINI_API_KEY=test-key\n', { mode: 0o600 });
  return dir;
}

async function grokDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-auth-grok-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({
      'https://auth.x.ai::c': {
        key: 'access-token-abc',
        refresh_token: 'r',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        oidc_issuer: 'https://auth.x.ai',
        oidc_client_id: 'c',
      },
    }),
    { mode: 0o600 },
  );
  return join(dir, 'auth.json');
}

async function openCodeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-auth-oc-'));
  dirs.push(dir);
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ opencode: { type: 'api', key: 'sk-secret' } }), {
    mode: 0o600,
  });
  return path;
}

type ProxyName = 'gemini' | 'grok' | 'opencode';

async function startProxy(name: ProxyName, upstream: string): Promise<string> {
  if (name === 'gemini') {
    const { endpoint, server } = await listenGeminiProxy({
      host: '127.0.0.1',
      port: 0,
      authDir: await geminiDir(),
      apiKey: 'test-key',
      upstream,
      token: SECRET,
      quiet: true,
    });
    servers.push(server);
    return endpoint;
  }
  if (name === 'grok') {
    const { endpoint, server } = await listenGrokProxy({
      host: '127.0.0.1',
      port: 0,
      authPath: await grokDir(),
      upstream,
      token: SECRET,
      quiet: true,
    });
    servers.push(server);
    return endpoint;
  }
  const { endpoint, server } = await listenOpenCodeProxy({
    host: '127.0.0.1',
    port: 0,
    authPath: await openCodeDir(),
    upstream,
    token: SECRET,
    quiet: true,
  });
  servers.push(server);
  return endpoint;
}

for (const name of ['gemini', 'grok', 'opencode'] as ProxyName[]) {
  describe(`proxy authentication — ${name}`, () => {
    it('rejects missing credentials with 401 and never contacts upstream', async () => {
      const up = await recordingUpstream();
      const endpoint = await startProxy(name, up.url);
      const res = await fetch(`${endpoint}/v1/models`, { headers: {} });
      expect(res.status).toBe(401);
      expect(up.hit()).toBe(false);
    });

    it('rejects an incorrect/foreign token with 401 and never contacts upstream', async () => {
      const up = await recordingUpstream();
      const endpoint = await startProxy(name, up.url);
      const res = await fetch(`${endpoint}/v1/models`, {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
      expect(up.hit()).toBe(false);
    });

    it('accepts a valid token and proceeds to exercise upstream authority', async () => {
      const up = await recordingUpstream();
      const endpoint = await startProxy(name, up.url);
      const res = await fetch(`${endpoint}/v1/models`, { headers: AUTH });
      // Authentication passed: the request is NOT a 401 and the proxy went on
      // to contact upstream (which is exactly the credential authority we gate).
      expect(res.status).not.toBe(401);
      expect(up.hit()).toBe(true);
    });

    it('authenticates without an Origin header (loopback + token, no CSRF handshake)', async () => {
      const up = await recordingUpstream();
      const endpoint = await startProxy(name, up.url);
      const res = await fetch(`${endpoint}/v1/models`, { headers: { ...AUTH } });
      expect(res.status).not.toBe(401);
    });

    it('exposes instanceId on /health but never the secret token', async () => {
      const up = await recordingUpstream();
      const endpoint = await startProxy(name, up.url);
      const res = await fetch(`${endpoint}/health`);
      expect(res.status).toBe(200);
      const health = (await res.json()) as Record<string, unknown>;
      expect('instanceId' in health).toBe(true);
      const serialized = JSON.stringify(health);
      expect(serialized).not.toContain(SECRET);
    });
  });
}
