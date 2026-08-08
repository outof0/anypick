import type { HotplugApp } from '../../core/app';
import type { AppBindingRow } from './bindings';
import { loadAppBindings } from './bindings';
import { formatRelativeTime } from './identity';
import { shortAppName } from './names';
import { gatewayAdapterFromProfile } from '../../sources/gateway-adapters';
import type { ModelPolicy, RuntimeProfile } from '../../types';

export interface GatewayRow {
  name: string;
  providerId: string;
  providerName: string;
  endpoint?: string;
  endpointShort: string;
  hasApiKey: boolean;
  defaultModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  /** Compact model summary for the list. */
  modelSummary?: string;
  /** Apps currently bound to this gateway. */
  usedByApps: string[];
  updatedAt: string;
  updatedRelative: string;
}

export async function loadGateways(app: HotplugApp, nowMs = Date.now()): Promise<GatewayRow[]> {
  const profiles = await app.profiles.list();
  const apps = loadAppBindings(app);
  const out: GatewayRow[] = [];

  for (const p of profiles) {
    let providerName = p.meta.provider;
    try {
      if (app.catalog.has(p.meta.provider)) {
        providerName = app.catalog.get(p.meta.provider).name;
      }
    } catch {
      // keep
    }
    const endpoint = p.meta.endpoint ?? '';
    let endpointShort = endpoint;
    try {
      if (endpoint) {
        const u = new URL(endpoint);
        endpointShort = u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
      }
    } catch {
      endpointShort = endpoint.slice(0, 32);
    }

    const usedByApps = apps
      .filter((a) => a.bound && a.sourceDisplay === p.meta.name)
      .map((a) => a.clientName);

    const bits: string[] = [];
    if (p.meta.defaultModel) {
      bits.push(p.meta.defaultModel);
    }
    const roleCount = [p.meta.sonnetModel, p.meta.opusModel, p.meta.haikuModel].filter(
      Boolean,
    ).length;
    if (roleCount > 0) {
      bits.push(`+${roleCount} roles`);
    }

    out.push({
      name: p.meta.name,
      providerId: p.meta.provider,
      providerName,
      endpoint,
      endpointShort: endpointShort || '—',
      hasApiKey: Boolean(p.secrets.apiKey?.trim()),
      defaultModel: p.meta.defaultModel,
      sonnetModel: p.meta.sonnetModel,
      opusModel: p.meta.opusModel,
      haikuModel: p.meta.haikuModel,
      modelSummary: bits.length ? bits.join(' · ') : undefined,
      usedByApps,
      updatedAt: p.meta.updatedAt,
      updatedRelative: formatRelativeTime(p.meta.updatedAt, nowMs),
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Minimal catalog shape these helpers need. Declared structurally so callers can
 * pass a `CatalogRegistry` without this module importing it.
 */
export interface CatalogLike {
  has(id: string): boolean;
  get(id: string): ModelPolicy;
}

/** Model roles stored on a gateway profile (Claude-shaped). */
export function gatewayProfileModelRoles(
  profile: {
    meta: {
      defaultModel?: string;
      sonnetModel?: string;
      opusModel?: string;
      haikuModel?: string;
      provider?: string;
    };
  },
  catalog?: CatalogLike,
): Record<string, string> {
  const defaults = defaultModelRolesFromCatalog(profile.meta.provider ?? 'custom', catalog);
  return {
    default: profile.meta.defaultModel ?? defaults.default ?? '',
    sonnet: profile.meta.sonnetModel ?? defaults.sonnet ?? defaults.default ?? '',
    opus: profile.meta.opusModel ?? defaults.opus ?? defaults.default ?? '',
    haiku: profile.meta.haikuModel ?? defaults.haiku ?? defaults.default ?? '',
  };
}

/**
 * Role defaults for a gateway catalog provider.
 *
 * The catalog entry owns the answer via `roleDefaults()`. Without a catalog (or
 * for an unregistered id) we return an empty map so callers fall back to the
 * profile's own stored model fields rather than inheriting another vendor's ids.
 */
function defaultModelRolesFromCatalog(
  providerId: string,
  catalog?: CatalogLike,
): Record<string, string> {
  if (!catalog?.has(providerId)) {
    return {};
  }
  try {
    return catalog.get(providerId).roleDefaults?.() ?? {};
  } catch {
    return {};
  }
}

/** Suggest model ids for a gateway catalog provider (rich list for autocomplete). */
export function suggestModelsForGateway(providerId: string, catalog?: CatalogLike): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    if (!v || seen.has(v)) {
      return;
    }
    seen.add(v);
    out.push(v);
  };

  const base = defaultModelRolesFromCatalog(providerId, catalog);
  for (const v of Object.values(base)) {
    push(v);
  }

  // Catalog suggestModels() when available
  if (catalog?.has(providerId)) {
    try {
      const map = catalog.get(providerId).suggestModels?.() ?? {};
      for (const [alias, id] of Object.entries(map)) {
        push(id);
        push(alias);
      }
    } catch {
      // ignore
    }
  }

  // Provider-declared friendly ids. An unregistered id gets a generic
  // multi-vendor list purely so the picker is not empty.
  const friendly = catalog?.has(providerId)
    ? (catalog.get(providerId).roleFriendlyModels?.() ?? [])
    : [
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-haiku-4-5',
        'gpt-5.6-sol',
        'grok-4.5',
        'gemini-3.1-pro-preview',
        'gemini-3.6-flash',
      ];
  for (const s of friendly) {
    push(s);
  }
  return out;
}

/** Apps that can use this gateway, plus existing bindings so they can be detached safely. */
export function compatibleAppsForGateway(
  app: HotplugApp,
  profile: RuntimeProfile,
): AppBindingRow[] {
  const all = loadAppBindings(app);
  const byId = new Map(all.map((a) => [a.clientId, a]));
  const catalogProvider = app.catalog.has(profile.meta.provider)
    ? app.catalog.get(profile.meta.provider)
    : undefined;
  const adapter = gatewayAdapterFromProfile(profile, { catalogProvider, clients: app.clients });
  const out: AppBindingRow[] = [];
  for (const client of app.clients.list()) {
    const existing = byId.get(client.id);
    const boundToGateway = existing?.bound && existing.sourceDisplay === profile.meta.name;
    if (adapter.transportFor(client.id) === 'unsupported' && !boundToGateway) {
      continue;
    }
    out.push(
      existing ?? {
        clientId: client.id,
        clientName: shortAppName(client.id, client.name),
        bound: false,
      },
    );
  }
  return out;
}

/** Display label for a proxy board row. */
