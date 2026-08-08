import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  fetchModelsFromProxyEndpoint,
  mergeProxyModelSuggestions,
} from '../src/tui/proxy-models-fetch';
import { ProviderRegistry } from '../src/core/registry';
import { CatalogRegistry, registerBuiltinCatalog } from '../src/catalog/providers';
import { registerBuiltinProviders } from '../src/providers/index';
import { modelPolicyLookup } from '../src/core/model-policy';

/**
 * Fallback model ids now come from each provider's own `staticFallbackModels()`,
 * so these tests resolve policy through the real registries rather than calling
 * a central switch. That also proves the registry wiring itself works.
 */
const accountRegistry = new ProviderRegistry();
const catalog = new CatalogRegistry();
registerBuiltinProviders(accountRegistry);
registerBuiltinCatalog(catalog);
const policy = modelPolicyLookup({ accountRegistry, catalog });

const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('fetchModelsFromProxyEndpoint', () => {
  it('sends the per-proxy token when the local proxy is authenticated', async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/v1/models')) {
        if (req.headers.authorization !== 'Bearer proxy-secret') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'unauthorized' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'hy3-free' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const result = await fetchModelsFromProxyEndpoint(`http://127.0.0.1:${port}`, {
      apiKey: 'proxy-secret',
    });
    expect(result.source).toBe('proxy');
    expect(result.models).toEqual(['hy3-free']);
  });

  it('parses OpenAI-style /v1/models list', async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'opencode/claude-sonnet-4' },
              { id: 'opencode/gpt-4.1' },
              { id: 'opencode/claude-sonnet-4' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const result = await fetchModelsFromProxyEndpoint(`http://127.0.0.1:${port}`);
    expect(result.source).toBe('proxy');
    expect(result.models).toEqual(['opencode/claude-sonnet-4', 'opencode/gpt-4.1']);
  });

  it('preserves proxy order (does not alpha-sort 2.5 ahead of 3.x)', async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'gemini-3.1-pro' },
              { id: 'gemini-3.5-flash' },
              { id: 'gemini-2.5-flash' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const result = await fetchModelsFromProxyEndpoint(`http://127.0.0.1:${port}`);
    expect(result.models[0]).toBe('gemini-3.1-pro');
    expect(result.models[1]).toBe('gemini-3.5-flash');
    expect(result.models[2]).toBe('gemini-2.5-flash');
  });
});

describe('mergeProxyModelSuggestions', () => {
  it('uses live list and does not invent Claude ids for opencode', () => {
    const live = mergeProxyModelSuggestions('opencode', ['zen/foo', 'zen/bar']);
    expect(live.source).toBe('proxy');
    expect(live.suggestions).toEqual(['zen/foo', 'zen/bar']);

    const empty = mergeProxyModelSuggestions('opencode', [], { policy });
    expect(empty.suggestions).not.toContain('claude-sonnet-5');
    expect(policy('opencode')?.staticFallbackModels?.() ?? []).toEqual([]);
  });

  it('does not invent Grok ids when the account catalog is unavailable', () => {
    const m = mergeProxyModelSuggestions('grok', [], { policy });
    expect(m.source).toBe('empty');
    expect(m.suggestions).toEqual([]);
    expect(policy('grok')?.staticFallbackModels?.() ?? []).toEqual([]);
  });

  it('does not invent Gemini ids when the account catalog is unavailable', () => {
    const m = mergeProxyModelSuggestions('gemini', [], { policy });
    expect(m.source).toBe('empty');
    expect(m.suggestions).toEqual([]);
    expect(policy('gemini')?.staticFallbackModels?.() ?? []).toEqual([]);
  });
});
