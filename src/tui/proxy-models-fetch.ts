/**
 * Fetch model ids from a running local proxy (OpenAI-compatible GET /v1/models).
 */

import type { ModelPolicyLookup } from '../clients/model-roles';

export interface ProxyModelsFetchResult {
  models: string[];
  /** Where the list came from. */
  source: 'proxy' | 'fallback' | 'empty';
  endpoint?: string;
  error?: string;
}

/**
 * GET {endpoint}/v1/models and return sorted unique ids.
 */
export async function fetchModelsFromProxyEndpoint(
  endpoint: string,
  opts: { timeoutMs?: number; apiKey?: string } = {},
): Promise<ProxyModelsFetchResult> {
  const base = endpoint.replace(/\/$/, '');
  const url = `${base}/v1/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${opts.apiKey ?? 'hotplug-proxy'}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      return {
        models: [],
        source: 'empty',
        endpoint: base,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ id?: string; name?: string } | string>;
    };
    const ids: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) {
        ids.push(v.trim());
      }
    };
    if (Array.isArray(body.data)) {
      for (const m of body.data) {
        push(m?.id ?? m?.name);
      }
    }
    if (Array.isArray(body.models)) {
      for (const m of body.models) {
        if (typeof m === 'string') {
          push(m);
        } else {
          push(m?.id ?? m?.name);
        }
      }
    }
    // Preserve provider ranking. Alphabetical sorting can put an older version
    // ahead of a newer one and make the autocomplete default misleading.
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      unique.push(id);
    }
    return {
      models: unique,
      source: unique.length ? 'proxy' : 'empty',
      endpoint: base,
    };
  } catch (err) {
    return {
      models: [],
      source: 'empty',
      endpoint: base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build suggestion list: live proxy models first, then optional static fallback.
 *
 * The fallback comes from the provider's own `staticFallbackModels()`. Providers
 * whose entitlements are account-specific return an empty list on purpose: an
 * empty picker is safer than ids that look authoritative and then 404.
 */
export function mergeProxyModelSuggestions(
  providerId: string,
  fetched: string[],
  opts: { includeStaticFallback?: boolean; policy?: ModelPolicyLookup } = {},
): { suggestions: string[]; source: 'proxy' | 'fallback' | 'empty' } {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    if (!v || seen.has(v)) {
      return;
    }
    seen.add(v);
    out.push(v);
  };
  for (const id of fetched) {
    push(id);
  }
  if (out.length > 0) {
    return { suggestions: out, source: 'proxy' };
  }
  if (opts.includeStaticFallback !== false) {
    for (const id of opts.policy?.(providerId)?.staticFallbackModels?.() ?? []) {
      push(id);
    }
    if (out.length > 0) {
      return { suggestions: out, source: 'fallback' };
    }
  }
  return { suggestions: [], source: 'empty' };
}
