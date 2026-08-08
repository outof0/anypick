/**
 * Codex Desktop only lists models whose slugs pass a server-delivered allowlist
 * of native GPT ids (typically ~5 "list" entries). Custom hub slugs (big-pickle,
 * claude-*, gemini-*) load fine in the CLI but are filtered out of the Desktop
 * picker — the same constraint codex-router works around by republishing
 * external models under native GPT slugs and rewriting on the wire.
 *
 * AnyPick mirrors that for Proxy Hub: catalog entries use native slugs + Hub
 * display names; the Hub route table maps those slugs back via `upstreamModel`.
 */

import { spawnSync } from 'node:child_process';
import type { CodexCatalogModel } from './codex';
import type { ModelReasoningLevel, ProxyHubRouteTarget } from '../types';

/** Fallback when `codex debug models --bundled` is unavailable. */
export const FALLBACK_NATIVE_LIST_SLUGS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.2',
] as const;

export interface NativeListSlot {
  slug: string;
  /** Full native catalog row used as a capability template when present. */
  template?: Record<string, unknown>;
}

export interface DesktopModelAlias {
  /** Allowlisted GPT slug shown in Desktop. */
  nativeSlug: string;
  /** Real Hub / upstream model id. */
  hubModel: string;
}

/**
 * Prefer configured models first (Default + List 2–5 from Apps / Configure
 * Models), then the rest of the hub catalog. Stable unique order.
 */
export function orderHubModelsForDesktop(
  hubModels: readonly string[],
  preferred?: string | readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const model = raw?.trim();
    if (!model || seen.has(model)) {
      return;
    }
    seen.add(model);
    out.push(model);
  };
  const preferredList = typeof preferred === 'string' ? [preferred] : (preferred ?? []);
  for (const model of preferredList) {
    push(model);
  }
  for (const model of hubModels) {
    push(model);
  }
  return out;
}

/** Role order for Codex Desktop list slots (matches CODEX_DESKTOP_MODEL_ROLES). */
export const CODEX_DESKTOP_ROLE_ORDER = ['default', 'list2', 'list3', 'list4', 'list5'] as const;

/**
 * Pull preferred Hub models from binding clientOptions.modelRoles in Desktop
 * slot order. Only non-empty customized roles are included (inherited slots
 * stay unset so the catalog can auto-fill from the Hub list).
 */
export function preferredHubModelsFromRoles(
  roles: Record<string, string> | undefined | null,
): string[] {
  if (!roles || typeof roles !== 'object') {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of CODEX_DESKTOP_ROLE_ORDER) {
    const model = roles[id]?.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    out.push(model);
  }
  return out;
}

/**
 * Pair non-allowlisted hub models (claude-*, gemini-*, big-pickle, …) onto the
 * native GPT list slots Desktop will actually show. Hub catalogs often also
 * list real `gpt-*` ids — those keep their own slugs for the CLI, but Desktop
 * slots are reserved for external Hub models (codex-router login-free style).
 */
export function assignDesktopAliases(
  hubModelsOrdered: readonly string[],
  nativeSlots: readonly NativeListSlot[],
): DesktopModelAlias[] {
  const nativeSlugSet = new Set(nativeSlots.map((slot) => slot.slug));
  // Prefer external models as alias *targets*; native GPT ids already pass the
  // Desktop allowlist under their own names when the hub routes them.
  const external = hubModelsOrdered.filter((model) => !nativeSlugSet.has(model));
  const n = Math.min(external.length, nativeSlots.length);
  const out: DesktopModelAlias[] = [];
  for (let i = 0; i < n; i++) {
    const slot = nativeSlots[i];
    const hubModel = external[i];
    if (!slot?.slug || !hubModel) {
      continue;
    }
    out.push({ nativeSlug: slot.slug, hubModel });
  }
  return out;
}

/**
 * Expand a Hub route table so Desktop-selected GPT slugs rewrite to real hub
 * models via `upstreamModel` (see proxy-hub-server request rewrite). Overwrites
 * a native-slug route when the hub already exposes that id — the Desktop picker
 * slot is the alias surface, not a second GPT identity.
 */
export function expandHubRoutesWithDesktopAliases(
  routes: readonly ProxyHubRouteTarget[],
  aliases: readonly DesktopModelAlias[],
): ProxyHubRouteTarget[] {
  if (aliases.length === 0) {
    return [...routes];
  }
  const byModel = new Map(routes.map((route) => [route.model, route]));
  for (const alias of aliases) {
    const base = byModel.get(alias.hubModel);
    if (!base) {
      continue;
    }
    byModel.set(alias.nativeSlug, {
      model: alias.nativeSlug,
      source: base.source,
      upstreamModel: base.upstreamModel,
    });
  }
  return [...byModel.values()];
}

/** Config top-level `model` that Desktop will highlight for a hub selection. */
export function desktopConfigModelId(
  preferredHubModel: string | undefined,
  aliases: readonly DesktopModelAlias[],
): string | undefined {
  if (preferredHubModel) {
    const hit = aliases.find((alias) => alias.hubModel === preferredHubModel);
    if (hit) {
      return hit.nativeSlug;
    }
  }
  return aliases[0]?.nativeSlug ?? preferredHubModel;
}

/**
 * Build catalog models for live publish: Desktop-visible native-slug aliases
 * first (friendly Hub names), then every real hub model under its own slug for
 * CLI `/model` and direct use. Alias rows win on slug collision so Hub labels
 * surface instead of stock GPT names.
 */
export function desktopAwareRouteModels(
  routeModels: readonly CodexCatalogModel[],
  aliases: readonly DesktopModelAlias[],
  nativeSlots: readonly NativeListSlot[],
): CodexCatalogModel[] {
  const hubBySlug = new Map(routeModels.map((model) => [model.slug, model]));
  const aliasModels: CodexCatalogModel[] = [];
  for (const alias of aliases) {
    const hub = hubBySlug.get(alias.hubModel);
    // Hub id + marker so the Desktop picker is not mistaken for stock GPT.
    const hubLabel = hub?.displayName ?? hub?.slug ?? alias.hubModel;
    const displayName = `${hubLabel} · Hub`;
    const slot = nativeSlots.find((entry) => entry.slug === alias.nativeSlug);
    const template = slot?.template;
    // Prefer hub capability fields; fall back to the native allowlist row so
    // Desktop keeps treating the entry as a first-class list model — including
    // reasoning-effort / verbosity controls that empty catalog rows disable.
    const contextWindow = hub?.contextWindow ?? positiveFromUnknown(template?.context_window);
    const maxContextWindow =
      hub?.maxContextWindow ?? positiveFromUnknown(template?.max_context_window);
    const autoCompactTokenLimit =
      hub?.autoCompactTokenLimit ?? positiveFromUnknown(template?.auto_compact_token_limit);
    const supportedReasoningLevels = hub?.supportedReasoningLevels?.length
      ? hub.supportedReasoningLevels
      : reasoningLevelsFromTemplate(template);
    const defaultReasoningLevel =
      hub?.defaultReasoningLevel ??
      (typeof template?.default_reasoning_level === 'string'
        ? template.default_reasoning_level
        : undefined);
    const supportsVerbosity =
      hub?.supportsVerbosity ??
      (typeof template?.support_verbosity === 'boolean' ? template.support_verbosity : undefined);
    aliasModels.push({
      slug: alias.nativeSlug,
      displayName,
      description:
        hub?.description ??
        `Proxy Hub: ${alias.hubModel} (Desktop picker slot ${alias.nativeSlug}).`,
      contextWindow,
      maxContextWindow,
      autoCompactTokenLimit,
      defaultReasoningLevel,
      supportedReasoningLevels,
      inputModalities: hub?.inputModalities,
      supportsParallelToolCalls: hub?.supportsParallelToolCalls,
      supportsSearchTool: hub?.supportsSearchTool,
      supportsVerbosity,
      supportsImageDetailOriginal: hub?.supportsImageDetailOriginal,
    });
  }
  // Real hub slugs remain listed so CLI users can pick beyond the Desktop slots.
  // Drop hub rows whose slug was claimed by an alias (aliases win the label).
  const aliasSlugs = new Set(aliasModels.map((model) => model.slug));
  const rest = routeModels.filter((model) => !aliasSlugs.has(model.slug));
  return [...aliasModels, ...rest];
}

function positiveFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
  }
  return undefined;
}

/** Copy native allowlist reasoning efforts so Desktop keeps the effort UI. */
function reasoningLevelsFromTemplate(
  template: Record<string, unknown> | undefined,
): readonly ModelReasoningLevel[] | undefined {
  const raw = template?.supported_reasoning_levels;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const levels: ModelReasoningLevel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const effort = typeof row.effort === 'string' ? row.effort.trim() : '';
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    if (effort && description) {
      levels.push({ effort, description });
    }
  }
  return levels.length > 0 ? levels : undefined;
}

/**
 * Load list-visible native GPT models from the local Codex CLI (bundled catalog).
 * Falls back to a static allowlist when Codex is missing or the probe fails.
 */
export function loadNativeListSlots(): NativeListSlot[] {
  try {
    const result = spawnSync('codex', ['debug', 'models', '--bundled'], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout?.trim()) {
      return fallbackSlots();
    }
    const parsed = JSON.parse(result.stdout) as { models?: unknown };
    if (!Array.isArray(parsed.models)) {
      return fallbackSlots();
    }
    const slots = parsed.models
      .filter(
        (model): model is Record<string, unknown> =>
          Boolean(model) &&
          typeof model === 'object' &&
          !Array.isArray(model) &&
          (model as { visibility?: unknown }).visibility === 'list' &&
          typeof (model as { slug?: unknown }).slug === 'string',
      )
      .map((model) => ({
        slug: String(model.slug),
        template: model,
      }))
      .toSorted((left, right) => {
        const lp = Number(left.template?.priority ?? 999);
        const rp = Number(right.template?.priority ?? 999);
        return lp - rp || left.slug.localeCompare(right.slug);
      });
    return slots.length > 0 ? slots : fallbackSlots();
  } catch {
    return fallbackSlots();
  }
}

function fallbackSlots(): NativeListSlot[] {
  return FALLBACK_NATIVE_LIST_SLUGS.map((slug) => ({ slug }));
}
