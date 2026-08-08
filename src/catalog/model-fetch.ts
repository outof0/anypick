/**
 * Vendor model-list requests, one shape per API family.
 *
 * These live next to the catalog because the wire shape belongs to the vendor,
 * not to core: `ModelPolicy.fetchLiveModels` is what lets the TUI ask for a live
 * list without growing a `switch (providerId)`.
 *
 * Every function preserves the vendor's own ordering. Sorting here would defeat
 * the picker, which shows the first match as the default — vendors list newest
 * first, and alphabetical order puts `claude-opus-4-6` above `claude-opus-5`.
 */

import type { ModelDiscoveryContext } from '../types';

/** `2023-06-01` is the oldest version that serves `/v1/models`; any works. */
const ANTHROPIC_VERSION = '2023-06-01';

function trimBase(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Pull ids out of a model-list body.
 *
 * Handles the three shapes in circulation: OpenAI's `data[].id`, Anthropic's
 * `data[].id`, and Google's `models[].name` (which is path-qualified, e.g.
 * `models/gemini-3.6-flash`). A bare `models: string[]` also appears in
 * self-hosted gateways.
 */
export function parseModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const shape = body as {
    data?: unknown;
    models?: unknown;
  };
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') {
      return;
    }
    // Google returns `models/<id>`; the request-time id is the last segment.
    const id = raw.trim().replace(/^models\//, '');
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    ids.push(id);
  };
  for (const list of [shape.data, shape.models]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (typeof entry === 'string') {
        push(entry);
        continue;
      }
      if (typeof entry === 'object' && entry !== null) {
        const item = entry as { id?: unknown; name?: unknown };
        push(item.id ?? item.name);
      }
    }
  }
  return ids;
}

async function readModelIds(res: Response): Promise<readonly string[]> {
  if (!res.ok) {
    // A model list is advisory: the caller falls back to the static catalog, so
    // an unauthorized or rate-limited vendor must not fail the whole screen.
    return [];
  }
  return parseModelIds(await res.json());
}

/** `GET {endpoint}/v1/models` with a bearer token — OpenAI and every clone. */
export async function fetchOpenAiStyleModels(
  ctx: ModelDiscoveryContext,
): Promise<readonly string[]> {
  const base = trimBase(ctx.endpoint);
  // A gateway endpoint is often already version-qualified (`.../api/v1`), and
  // appending `/v1` again 404s.
  const url = /\/v\d+(beta)?$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-opencode-client': 'desktop',
    'user-agent': 'opencode/desktop',
  };
  if (ctx.apiKey) {
    headers.authorization = `Bearer ${ctx.apiKey}`;
  }
  return readModelIds(await ctx.fetch(url, { headers }));
}

/** Anthropic requires its own key header plus a version header. */
export async function fetchAnthropicModels(ctx: ModelDiscoveryContext): Promise<readonly string[]> {
  if (!ctx.apiKey) {
    return [];
  }
  const base = trimBase(ctx.endpoint);
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  return readModelIds(
    await ctx.fetch(url, {
      headers: {
        accept: 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    }),
  );
}

/**
 * Google puts the key in the query string, and pages its results.
 *
 * The key must not go in a header here; the Generative Language API only reads
 * `?key=`. Paging is followed because the first page is capped well below the
 * number of published models.
 */
export async function fetchGeminiModels(ctx: ModelDiscoveryContext): Promise<readonly string[]> {
  if (!ctx.apiKey) {
    return [];
  }
  const base = trimBase(ctx.endpoint);
  const root = /\/v\d+(beta)?$/.test(base) ? base : `${base}/v1beta`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  // Bounded rather than `while (pageToken)`: a vendor that echoes the same token
  // would otherwise spin forever inside a screen the user is waiting on.
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${root}/models`);
    url.searchParams.set('key', ctx.apiKey);
    url.searchParams.set('pageSize', '200');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    const res = await ctx.fetch(url.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok) {
      break;
    }
    const body = (await res.json()) as { nextPageToken?: unknown };
    ids.push(...parseModelIds(body));
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    if (!pageToken) {
      break;
    }
  }
  return [...new Set(ids)];
}
