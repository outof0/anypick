import type { ApiStyle, ApplyContext, CatalogProvider, ModelMap, RuntimeProfile } from '../types';
import { catalogRegistry, type CatalogRegistry } from '../catalog/providers';

export interface ResolvedRuntime {
  apiKey: string;
  endpoint: string;
  apiStyle: ApiStyle;
  defaultModel?: string;
  models: ModelMap;
  headers: Record<string, string>;
  /** Models from the profile (optionally expanded via models map). */
  roles: {
    default?: string;
    sonnet?: string;
    opus?: string;
    haiku?: string;
  };
  overlay: Record<string, unknown>;
}

function expandModel(value: string | undefined, models: ModelMap): string | undefined {
  if (!value) {
    return undefined;
  }
  return models[value] ?? value;
}

/**
 * Resolve profile → concrete runtime values for a client.
 *
 * Models live on the profile (set at create/edit). Switching a profile
 * just reuses those fields — no per-client ceremony.
 */
export function resolveRuntime(
  profile: RuntimeProfile,
  clientId: string,
  catalog: CatalogRegistry = catalogRegistry,
  proxyEndpoint?: string,
): ResolvedRuntime {
  let provider: CatalogProvider | undefined;
  if (catalog.has(profile.meta.provider)) {
    provider = catalog.get(profile.meta.provider);
  }

  const overlay = profile.meta.clientOverrides?.[clientId] ?? {};
  const models = { ...profile.meta.models };
  const headers = { ...profile.secrets.headers };

  const apiKey =
    (typeof overlay.apiKey === 'string' ? overlay.apiKey : undefined) ??
    (typeof profile.secrets.apiKey === 'string' ? profile.secrets.apiKey : '') ??
    '';

  const endpoint =
    proxyEndpoint ??
    (typeof overlay.endpoint === 'string' ? overlay.endpoint : undefined) ??
    profile.meta.endpoint ??
    provider?.defaultEndpoint ??
    '';

  const apiStyle: ApiStyle =
    (overlay.apiStyle as ApiStyle | undefined) ?? provider?.apiStyle ?? 'openai';

  // Profile fields first; advanced clientOverrides can still override.
  const defaultAlias =
    (typeof overlay.defaultModel === 'string' ? overlay.defaultModel : undefined) ??
    profile.meta.defaultModel;

  const sonnetAlias =
    (typeof overlay.sonnetModel === 'string' ? overlay.sonnetModel : undefined) ??
    profile.meta.sonnetModel;

  const opusAlias =
    (typeof overlay.opusModel === 'string' ? overlay.opusModel : undefined) ??
    profile.meta.opusModel;

  const haikuAlias =
    (typeof overlay.haikuModel === 'string' ? overlay.haikuModel : undefined) ??
    profile.meta.haikuModel;

  const roles = {
    default: expandModel(defaultAlias, models),
    sonnet: expandModel(sonnetAlias, models),
    opus: expandModel(opusAlias, models),
    haiku: expandModel(haikuAlias, models),
  };

  return {
    apiKey,
    endpoint,
    apiStyle,
    defaultModel: roles.default,
    models,
    headers,
    roles,
    overlay,
  };
}

export function resolveFromContext(ctx: ApplyContext, catalog?: CatalogRegistry): ResolvedRuntime {
  return resolveRuntime(ctx.profile, ctx.clientId, catalog, ctx.proxyEndpoint);
}
