/**
 * Live model discovery with a cached fallback chain.
 *
 * The static catalog in `src/catalog/providers.ts` goes stale the moment a
 * vendor ships a model, and a user should not need a AnyPick release to select
 * one. So the answer is resolved in order:
 *
 *   1. a cache row younger than `TTL_MS`,
 *   2. a live `fetchLiveModels()` on the provider,
 *   3. a stale cache row, if the fetch failed,
 *   4. the provider's static catalog — always non-empty for known vendors.
 *
 * Nothing here can fail a caller: a model list is advisory, and a screen that
 * cannot render because a vendor is down would be worse than an outdated list.
 * `refresh` is therefore the only way to force step 2.
 *
 * Egress is allowlisted per call (ADR 0006 keeps proxy traffic on loopback; this
 * is the opposite direction — outbound, with the user's key attached). The
 * allowlist is the vendor origins AnyPick ships plus the origin already stored
 * in the user's own profile, so a rewritten endpoint cannot quietly receive a
 * credential that was issued for somewhere else.
 */

import type { ModelDiscoveryContext, ModelPolicy } from '../types';
import { createDirectEgress } from '../network/egress';
import { withMutationLock } from './mutation-lock';
import type { ModelCacheStore } from './model-cache-store';

/** How long a fetched list is trusted without asking the vendor again. */
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 6000;

export type ModelListSource = 'live' | 'cache' | 'stale' | 'catalog';

export interface ModelListResult {
  models: string[];
  source: ModelListSource;
  /** When the list was fetched, for `cache` and `stale`. */
  fetchedAt?: string;
  /** Why a live fetch did not happen or did not succeed. */
  note?: string;
}

export interface ModelDiscoveryRequest {
  /** Catalog or account provider id. */
  providerId: string;
  /** Endpoint to query. Falls back to the provider's own default. */
  endpoint?: string;
  apiKey?: string;
  /** Ignore a fresh cache row and ask the vendor. */
  refresh?: boolean;
}

export interface ModelDiscoveryDeps {
  root: string;
  cache: ModelCacheStore;
  policyFor: (providerId: string) => ModelPolicy | undefined;
  /** Overridden in tests; defaults to an allowlisted direct transport. */
  fetchImpl?: (origin: string) => ModelDiscoveryContext['fetch'];
  now?: () => number;
}

export class ModelDiscoveryService {
  constructor(private readonly deps: ModelDiscoveryDeps) {}

  /**
   * Best available model list for a provider/endpoint pair.
   *
   * Never throws for a network or vendor error — inspect `source` to see which
   * step answered.
   */
  async list(req: ModelDiscoveryRequest): Promise<ModelListResult> {
    const policy = this.deps.policyFor(req.providerId);
    const fallback = staticModels(policy);
    const endpoint = normalizeEndpoint(req.endpoint ?? defaultEndpoint(policy));

    if (!endpoint || !policy?.fetchLiveModels) {
      return { models: fallback, source: 'catalog', note: 'no live discovery for this provider' };
    }

    const cached = await this.deps.cache.get(req.providerId, endpoint);
    const now = this.deps.now?.() ?? Date.now();
    if (!req.refresh && cached && isFresh(cached.fetchedAt, now)) {
      return { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt };
    }

    let origin: string;
    try {
      origin = new URL(endpoint).origin;
    } catch {
      return { models: fallback, source: 'catalog', note: `endpoint is not a URL: ${endpoint}` };
    }

    try {
      const fetchImpl = (this.deps.fetchImpl ?? allowlistedFetch)(origin);
      const models = [
        ...(await policy.fetchLiveModels({ endpoint, apiKey: req.apiKey, fetch: fetchImpl })),
      ];
      if (models.length === 0) {
        throw new Error('vendor returned no models');
      }
      const fetchedAt = new Date(now).toISOString();
      // Cache writes are the one persisted mutation here, so they go through the
      // coordinator like every other store write (ADR 0009).
      await withMutationLock(this.deps.root, 'model-cache', () =>
        this.deps.cache.write({ provider: req.providerId, endpoint, models, fetchedAt }),
      );
      return { models, source: 'live', fetchedAt };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      if (cached) {
        return { models: cached.models, source: 'stale', fetchedAt: cached.fetchedAt, note };
      }
      return { models: fallback, source: 'catalog', note };
    }
  }

  /** Drop cached lists so the next `list` asks the vendor. */
  async clearCache(providerId?: string): Promise<void> {
    await withMutationLock(this.deps.root, 'model-cache', () => this.deps.cache.clear(providerId));
  }
}

/**
 * A fetch bound to exactly one origin.
 *
 * The transport is built per call rather than shared because the allowed origin
 * is the endpoint being asked about: that is what makes an endpoint the user did
 * not configure unable to receive their API key.
 */
function allowlistedFetch(origin: string): ModelDiscoveryContext['fetch'] {
  const egress = createDirectEgress([origin]);
  return async (target, init) =>
    egress.fetch(
      target,
      { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      { operation: 'catalog' },
    );
}

function isFresh(fetchedAt: string, now: number): boolean {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now - at < MODEL_CACHE_TTL_MS;
}

function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  const trimmed = endpoint?.trim().replace(/\/+$/, '');
  return trimmed || undefined;
}

function defaultEndpoint(policy: ModelPolicy | undefined): string | undefined {
  // `defaultEndpoint` belongs to CatalogProvider, not to ModelPolicy; account
  // providers reach their models through a local proxy and pass an endpoint in.
  const candidate = (policy as { defaultEndpoint?: unknown } | undefined)?.defaultEndpoint;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** Everything the provider offers offline: friendly ids, then alias targets. */
function staticModels(policy: ModelPolicy | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const id of policy?.roleFriendlyModels?.() ?? []) {
    push(id);
  }
  for (const id of Object.values(policy?.suggestModels?.() ?? {})) {
    push(id);
  }
  for (const id of policy?.staticFallbackModels?.() ?? []) {
    push(id);
  }
  return out;
}
