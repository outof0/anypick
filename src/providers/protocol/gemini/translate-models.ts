import type { ReasoningEffort } from '../../reasoning';

/** Normalize a client model id without changing the requested model. */
export function mapToGeminiModel(model: string | undefined): string {
  const raw = (model ?? '').trim();
  if (!raw) {
    return '';
  }
  const bare = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw;
  return bare.startsWith('models/') ? bare.slice('models/'.length) : bare;
}

export type GeminiModelIntent = 'quality' | 'fast' | 'lite';

export interface GeminiModelResolution {
  id: string;
  remapped: boolean;
  reason?: 'case' | 'alias' | 'effort' | 'intent' | 'default' | 'unavailable';
}

export interface GeminiModelDescriptor {
  id: string;
  displayName?: string;
  recommended?: boolean;
}

export interface GeminiModelCatalog {
  models: readonly GeminiModelDescriptor[];
  /** Upstream-selected default, when the catalog exposes one. */
  defaultModelId?: string;
  /** Upstream ordering for models intended for agent/chat requests. */
  preferredModelIds?: readonly string[];
}

export type GeminiModelCatalogInput = readonly string[] | GeminiModelCatalog;

/**
 * Resolve friendly/foreign role names against the live account catalog.
 * Concrete ids always pass through, including ids released after this proxy.
 */
export function resolveGeminiModel(
  requested: string | undefined,
  available: GeminiModelCatalogInput,
  effort?: ReasoningEffort,
): GeminiModelResolution {
  const catalog = normalizeModelCatalog(available);
  const ids = catalog.models.map((model) => model.id);
  const id = mapToGeminiModel(requested);
  if (id) {
    const exact = ids.find((candidate) => candidate === id);
    if (exact) {
      return { id: exact, remapped: false };
    }
    const caseInsensitive = ids.find((candidate) => candidate.toLowerCase() === id.toLowerCase());
    if (caseInsensitive) {
      return { id: caseInsensitive, remapped: caseInsensitive !== id, reason: 'case' };
    }

    // Code Assist model ids are opaque and can differ from their user-facing
    // names (for example a display-name tier may point at a rollout id). Match
    // aliases from the live catalog and let the upstream default/order break
    // ties; never infer an internal id from a version number.
    const aliasMatches = catalog.models.filter((model) =>
      modelAliases(model).has(normalizeModelName(id)),
    );
    const defaultAlias = preferCatalogModel(aliasMatches, catalog);
    const alias = preferCatalogModelForEffort(aliasMatches, catalog, effort);
    if (alias) {
      return {
        id: alias.id,
        remapped: alias.id !== id,
        reason: effort && alias.id !== defaultAlias?.id ? 'effort' : 'alias',
      };
    }

    const intent = modelIntent(id);
    if (!intent) {
      // Unknown concrete ids are intentionally not rejected. The live catalog can
      // be stale during a rollout and the upstream remains the source of truth.
      return { id, remapped: false };
    }
    const selected = selectGeminiModel(ids, intent);
    return selected
      ? { id: selected, remapped: selected !== id, reason: 'intent' }
      : { id: '', remapped: true, reason: 'unavailable' };
  }

  const selected =
    ids.find((candidate) => candidate === catalog.defaultModelId) ??
    selectGeminiModel(ids, 'quality');
  return selected
    ? { id: selected, remapped: true, reason: 'default' }
    : { id: '', remapped: false, reason: 'unavailable' };
}

function normalizeModelCatalog(available: GeminiModelCatalogInput): GeminiModelCatalog {
  if (Array.isArray(available)) {
    return { models: (available as string[]).map((id) => ({ id })) };
  }
  return available as GeminiModelCatalog;
}

function modelAliases(model: GeminiModelDescriptor): Set<string> {
  const aliases = new Set([normalizeModelName(model.id)]);
  if (!model.displayName) {
    return aliases;
  }
  aliases.add(normalizeModelName(model.displayName));
  // A parenthesized suffix is presentation metadata such as a thinking or
  // latency tier. The unsuffixed display name remains a valid client alias.
  const baseDisplayName = model.displayName.replace(/\s*\([^)]*\)\s*$/, '');
  aliases.add(normalizeModelName(baseDisplayName));
  return aliases;
}

function normalizeModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function preferCatalogModel(
  matches: readonly GeminiModelDescriptor[],
  catalog: GeminiModelCatalog,
): GeminiModelDescriptor | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const byId = new Map(matches.map((model) => [model.id, model]));
  if (catalog.defaultModelId && byId.has(catalog.defaultModelId)) {
    return byId.get(catalog.defaultModelId);
  }
  for (const id of catalog.preferredModelIds ?? []) {
    if (byId.has(id)) {
      return byId.get(id);
    }
  }
  return matches.find((model) => model.recommended) ?? matches[0];
}

/**
 * Code Assist can expose several opaque ids for one display-name alias, with
 * the public effort tier only present in the display name. Select from that
 * live metadata instead of inferring ids such as `-high` or `-agent`.
 */
function preferCatalogModelForEffort(
  matches: readonly GeminiModelDescriptor[],
  catalog: GeminiModelCatalog,
  effort: ReasoningEffort | undefined,
): GeminiModelDescriptor | undefined {
  const target = reasoningEffortRank(effort);
  if (target == null) {
    return preferCatalogModel(matches, catalog);
  }
  const ranked = matches.flatMap((model) => {
    const rank = catalogModelEffortRank(model);
    return rank == null ? [] : [{ model, distance: Math.abs(rank - target) }];
  });
  const closestDistance = Math.min(...ranked.map(({ distance }) => distance));
  if (!Number.isFinite(closestDistance)) {
    return preferCatalogModel(matches, catalog);
  }
  return preferCatalogModel(
    ranked.filter(({ distance }) => distance === closestDistance).map(({ model }) => model),
    catalog,
  );
}

function catalogModelEffortRank(model: GeminiModelDescriptor): number | undefined {
  const tier = model.displayName?.match(/\(([^()]*)\)\s*$/)?.[1];
  return reasoningEffortRank(tier);
}

function reasoningEffortRank(value: string | undefined): number | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  switch (normalized) {
    case 'none':
    case 'minimal':
    case 'extra low':
      return 0;
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'xhigh':
    case 'extra high':
      return 4;
    case 'max':
      return 5;
    default:
      return undefined;
  }
}

/** Pick the newest matching tier from ids actually exposed by the account. */
export function selectGeminiModel(
  available: readonly string[],
  intent: GeminiModelIntent,
): string | undefined {
  const ranked = [...new Set(available.filter((id) => id.trim()))].toSorted(compareGeminiModelIds);
  const preferred = ranked.find((id) => {
    if (intent === 'lite') {
      return modelIdHas(id, 'lite');
    }
    if (intent === 'fast') {
      return modelIdHas(id, 'flash') && !modelIdHas(id, 'lite');
    }
    return modelIdHas(id, 'pro') && !modelIdHas(id, 'flash');
  });
  if (preferred) {
    return preferred;
  }
  if (intent === 'lite') {
    return ranked.find((id) => modelIdHas(id, 'flash')) ?? ranked[0];
  }
  if (intent === 'fast') {
    return ranked.find((id) => modelIdHas(id, 'lite')) ?? ranked[0];
  }
  return ranked.find((id) => !modelIdHas(id, 'flash') && !modelIdHas(id, 'lite')) ?? ranked[0];
}

function modelIdHas(id: string, token: string): boolean {
  return id.toLowerCase().includes(token);
}

function modelIntent(model: string): GeminiModelIntent | undefined {
  const id = model.toLowerCase();
  // A concrete Gemini/Gemma id must never be rewritten just because its name
  // contains a tier word such as "flash" or "pro".
  if (/^(?:gemini|gemma)-\d/.test(id)) {
    return undefined;
  }
  if (id.includes('lite') || id.includes('haiku')) {
    return 'lite';
  }
  if (id.includes('flash') || id.includes('mini') || id === 'fast') {
    return 'fast';
  }
  if (
    id === 'gemini' ||
    id === 'auto' ||
    id.includes('latest') ||
    id.includes('pro') ||
    id.includes('sonnet') ||
    id.includes('opus') ||
    id.startsWith('gpt') ||
    id.includes('codex')
  ) {
    return 'quality';
  }
  return undefined;
}

/**
 * Parse leading version from a live Google model id for ranking only.
 * e.g. gemini-<major>.<minor>-<tier> → [major, minor]
 */
export function parseGeminiModelVersion(id: string): [number, number] {
  const m = id.toLowerCase().match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (!m) {
    return [0, 0];
  }
  return [Number(m[1]) || 0, Number(m[2]) || 0];
}

/**
 * Sort key for live ListModels results: newer major.minor first, then family,
 * stable names before preview/exp. Does not invent model ids.
 */
export function compareGeminiModelIds(a: string, b: string): number {
  const [am, an] = parseGeminiModelVersion(a);
  const [bm, bn] = parseGeminiModelVersion(b);
  if (am !== bm) {
    return bm - am; // higher major first
  }
  if (an !== bn) {
    return bn - an; // higher minor first
  }
  const fa = geminiFamilyRank(a);
  const fb = geminiFamilyRank(b);
  if (fa !== fb) {
    return fa - fb;
  }
  // Prefer shorter / non-preview ids within same family+version
  const na = geminiModelNoise(a);
  const nb = geminiModelNoise(b);
  if (na !== nb) {
    return na - nb;
  }
  return a.localeCompare(b);
}

function geminiFamilyRank(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes('flash-lite') || lower.includes('flashlite') || /(^|-)lite($|-)/.test(lower)) {
    return 2;
  }
  if (lower.includes('flash')) {
    return 1;
  }
  if (lower.includes('pro')) {
    return 0;
  }
  return 3;
}

function geminiModelNoise(id: string): number {
  const lower = id.toLowerCase();
  const previewPenalty =
    lower.includes('preview') || lower.includes('exp') || lower.includes('latest') ? 10 : 0;
  return previewPenalty + Math.min(lower.length, 80) * 0.01;
}
