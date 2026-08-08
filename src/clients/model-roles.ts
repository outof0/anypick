/**
 * Client-shaped model roles + provider default maps for proxy → app apply.
 *
 * Model *policy* (which model fills which role, what to suggest, what to fall
 * back to) belongs to the provider, not to this module. Callers pass a
 * `ModelPolicy` resolved from the provider or catalog registry; when none is
 * supplied these functions return generic, vendor-neutral answers rather than
 * guessing a specific vendor's model ids.
 */

import type { ClientAdapter, ClientModelRole, ModelPolicy } from '../types';
import { OPENAI_MODELS, ANTHROPIC_MODELS } from '../catalog/providers';

/** Resolves a provider/catalog id to its model policy, if it has one. */
export type ModelPolicyLookup = (providerId: string) => ModelPolicy | undefined;

export const CLAUDE_MODEL_ROLES: readonly ClientModelRole[] = [
  { id: 'default', label: 'Default' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
] as const;

/**
 * Codex Desktop only surfaces ~5 allowlisted GPT picker slots. AnyPick maps
 * Hub models onto those slots (see `codex-desktop-catalog.ts`). Configure Models
 * exposes one required Default plus four optional models — same multi-picker
 * shape as Claude's Default/Sonnet/Opus/Haiku, but for the Desktop list rather
 * than Claude Code env roles. Stable ids stay `list2`…`list5` (binding storage).
 */
export const CODEX_DESKTOP_MODEL_ROLES: readonly ClientModelRole[] = [
  { id: 'default', label: 'Default' },
  { id: 'list2', label: 'Model 2' },
  { id: 'list3', label: 'Model 3' },
  { id: 'list4', label: 'Model 4' },
  { id: 'list5', label: 'Model 5' },
] as const;

export const DEFAULT_MODEL_ROLE: readonly ClientModelRole[] = [
  { id: 'default', label: 'Default' },
] as const;

/**
 * Roles an app can map when applying a proxy/profile.
 *
 * Prefer passing a `ClientAdapter` (or anything with `modelRoles()`). The string
 * overload is only a fallback for call sites that have not resolved the
 * adapter yet — it returns the neutral single-role default so third-party
 * clients never inherit Anthropic's multi-role labels by id coincidence.
 */
export function modelRolesForClient(
  client: Pick<ClientAdapter, 'id' | 'modelRoles'> | string,
): readonly ClientModelRole[] {
  if (typeof client === 'string') {
    return DEFAULT_MODEL_ROLE;
  }
  if (typeof client.modelRoles === 'function') {
    return client.modelRoles();
  }
  return DEFAULT_MODEL_ROLE;
}

/**
 * Default role → model id when pointing a client at a proxy for this provider.
 * Values are bare ids suitable for Claude Code / Codex env injection.
 *
 * Pass a ClientAdapter (or anything with modelRoles) as the second argument so
 * multi-role clients keep their slots. A bare client id falls back to the
 * neutral single-role default.
 */
export function defaultModelRolesForProxy(
  providerId: string,
  client: Pick<ClientAdapter, 'id' | 'modelRoles'> | string,
  lookup?: ModelPolicyLookup,
): Record<string, string> {
  const roles = modelRolesForClient(client);
  const template = providerModelTemplate(providerId, lookup);
  const out: Record<string, string> = {};
  for (const role of roles) {
    const v = template[role.id] ?? template.default;
    if (v) {
      out[role.id] = v;
    }
  }
  return out;
}

/**
 * Reconcile provider templates with the models the proxy actually exposes.
 * Existing user-selected roles are merged later and therefore are preserved.
 *
 * Only applies to providers that declare `roleModelHints()` — i.e. those whose
 * roles are filled from live discovery. Without hints the declared defaults are
 * already authoritative and must not be second-guessed against a live list.
 */
export function modelDefaultsForSuggestions(
  providerId: string,
  defaults: Record<string, string>,
  suggestions: string[],
  lookup?: ModelPolicyLookup,
): Record<string, string> {
  const hints = lookup?.(providerId)?.roleModelHints?.();
  if (!suggestions.length || !hints) {
    return defaults;
  }
  const ids = new Set(suggestions);
  const lower = suggestions.map((id) => [id, id.toLowerCase()] as const);
  const pick = (role: string, current: string | undefined): string | undefined => {
    if (current && ids.has(current)) {
      return current;
    }
    for (const token of hints[role] ?? []) {
      const match = lower.find(([, id]) => id.includes(token));
      if (match) {
        return match[0];
      }
    }
    return suggestions[0];
  };
  const out = { ...defaults };
  for (const role of Object.keys(out)) {
    out[role] = pick(role, out[role]) ?? out[role];
  }
  return out;
}

/** Autocomplete candidates for a proxy provider (unique bare ids + aliases). */
export function suggestModelsForProxyProvider(
  providerId: string,
  lookup?: ModelPolicyLookup,
): string[] {
  const map = providerSuggestMap(providerId, lookup);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    if (!v || seen.has(v)) {
      return;
    }
    seen.add(v);
    out.push(v);
  };
  for (const [alias, id] of Object.entries(map)) {
    push(id);
    push(alias);
  }
  // Role-friendly short names first-class for Claude Code
  for (const extra of roleFriendlyExtras(providerId, lookup)) {
    push(extra);
  }
  return out;
}

/**
 * Provider-declared friendly ids, or a generic multi-vendor list for an unknown
 * provider. A provider that declares a policy but no friendly models gets an
 * empty list — that is an answer, not a gap.
 */
function roleFriendlyExtras(providerId: string, lookup?: ModelPolicyLookup): readonly string[] {
  const policy = lookup?.(providerId);
  if (policy) {
    return policy.roleFriendlyModels?.() ?? [];
  }
  return [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-haiku-4-5',
    'gpt-5.6-sol',
    'gemini-3.1-pro-preview',
    'gemini-3.6-flash',
  ];
}

/**
 * Merge user roles over defaults. Empty strings are dropped.
 * Ensures `default` is set when any role is present (from default role or first value).
 */
export function normalizeModelRoles(
  roles: Record<string, string> | undefined,
  defaults: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...defaults };
  if (roles) {
    for (const [k, v] of Object.entries(roles)) {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t) {
        merged[k] = t;
      }
    }
  }
  // Drop empty
  for (const k of Object.keys(merged)) {
    if (!merged[k]?.trim()) {
      delete merged[k];
    }
  }
  return merged;
}

// Moved to core so core does not take value imports from the clients package.
export { modelRolesFromClientOptions } from '../core/model-roles';

/**
 * Role → model template for a provider.
 *
 * A provider that declares `roleDefaults()` owns the answer. Otherwise we fall
 * back to a single generic `default` role: inventing Claude/GPT ids for an
 * unknown provider produces model names its API will reject.
 */
function providerModelTemplate(
  providerId: string,
  lookup?: ModelPolicyLookup,
): Record<string, string> {
  const declared = lookup?.(providerId)?.roleDefaults?.();
  if (declared) {
    return declared;
  }
  return { default: 'default' };
}

/**
 * Alias → id suggestion map for a provider.
 *
 * A provider that declares a policy owns its own map (possibly empty, when its
 * catalog is only knowable from a live `/v1/models` call). Only an unknown
 * provider falls back to the built-in Anthropic+OpenAI aliases.
 */
function providerSuggestMap(
  providerId: string,
  lookup?: ModelPolicyLookup,
): Record<string, string> {
  const policy = lookup?.(providerId);
  if (policy) {
    return policy.suggestModels?.() ?? {};
  }
  return {
    ...ANTHROPIC_MODELS,
    ...OPENAI_MODELS,
  };
}
