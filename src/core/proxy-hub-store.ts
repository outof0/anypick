import { randomBytes } from 'node:crypto';
import type { ProxyHubConfig, ProxyHubRouteManifest, ProxyHubRuntimeState } from '../types';
import { decode, decoders } from './codec';
import type { AnyPickDatabase } from './db';

export const DEFAULT_PROXY_HUB = 'default';
export const DEFAULT_PROXY_HUB_PORT = 4680;

interface HubRow {
  name: string;
  config_json: string;
}

interface HubRuntimeRow {
  name: string;
  state_json: string;
}

interface HubRouteRow {
  route_id: string;
  hub_name: string;
  manifest_json: string;
  token_secret: string;
}

export interface ProxyHubRouteSecret {
  routeId: string;
  manifest: ProxyHubRouteManifest;
  /** Keep this private to the Hub service/executor boundary. */
  token: string;
}

export class ProxyHubStore {
  constructor(private readonly db: AnyPickDatabase) {}

  get(name = DEFAULT_PROXY_HUB): ProxyHubConfig | null {
    const row = this.db
      .prepare('SELECT name, config_json FROM proxy_hubs WHERE name = ?')
      .get(name) as HubRow | undefined;
    return row ? decode(row.config_json, decoders.proxyHubConfig, `proxy-hub/${name}`) : null;
  }

  getOrDefault(name = DEFAULT_PROXY_HUB): ProxyHubConfig {
    return this.get(name) ?? defaultConfig(name);
  }

  save(config: ProxyHubConfig): ProxyHubConfig {
    const now = new Date().toISOString();
    const previous = this.get(config.name);
    const next: ProxyHubConfig = {
      ...config,
      revision: previous ? previous.revision + 1 : Math.max(1, config.revision),
      createdAt: previous?.createdAt ?? config.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO proxy_hubs (name, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(next.name, JSON.stringify(next), next.createdAt, next.updatedAt);
    return next;
  }

  getRuntime(name = DEFAULT_PROXY_HUB): ProxyHubRuntimeState | null {
    const row = this.db
      .prepare('SELECT name, state_json FROM proxy_hub_runtime WHERE name = ?')
      .get(name) as HubRuntimeRow | undefined;
    return row
      ? decode(row.state_json, decoders.proxyHubRuntimeState, `proxy-hub-runtime/${name}`)
      : null;
  }

  saveRuntime(state: ProxyHubRuntimeState): void {
    this.db
      .prepare(
        `INSERT INTO proxy_hub_runtime (name, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(state.name, JSON.stringify(state), new Date().toISOString());
  }

  clearRuntime(name = DEFAULT_PROXY_HUB): void {
    this.db.prepare('DELETE FROM proxy_hub_runtime WHERE name = ?').run(name);
  }

  attachRoute(
    routeId: string,
    manifest: ProxyHubRouteManifest,
    token = randomBytes(32).toString('hex'),
  ): ProxyHubRouteSecret {
    this.db
      .prepare(
        `INSERT INTO proxy_hub_routes (route_id, hub_name, manifest_json, token_secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(route_id) DO UPDATE SET
           hub_name = excluded.hub_name,
           manifest_json = excluded.manifest_json,
           token_secret = excluded.token_secret,
           updated_at = excluded.updated_at`,
      )
      .run(
        routeId,
        manifest.hub,
        JSON.stringify(manifest),
        token,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    return { routeId, manifest, token };
  }

  getRoute(routeId: string): ProxyHubRouteSecret | null {
    const row = this.db
      .prepare(
        'SELECT route_id, hub_name, manifest_json, token_secret FROM proxy_hub_routes WHERE route_id = ?',
      )
      .get(routeId) as HubRouteRow | undefined;
    if (!row) {
      return null;
    }
    return {
      routeId: row.route_id,
      manifest: decodeProxyHubManifest(row.manifest_json, `proxy-hub-route/${row.route_id}`),
      token: row.token_secret,
    };
  }

  getRouteByToken(token: string): ProxyHubRouteSecret | null {
    const row = this.db
      .prepare(
        'SELECT route_id, hub_name, manifest_json, token_secret FROM proxy_hub_routes WHERE token_secret = ?',
      )
      .get(token) as HubRouteRow | undefined;
    if (!row) {
      return null;
    }
    return {
      routeId: row.route_id,
      manifest: decodeProxyHubManifest(row.manifest_json, `proxy-hub-route/${row.route_id}`),
      token: row.token_secret,
    };
  }

  /** Owner-only route records for the Hub server's constant-time auth check. */
  listRouteSecrets(name = DEFAULT_PROXY_HUB): ProxyHubRouteSecret[] {
    const rows = this.db
      .prepare(
        `SELECT route_id, hub_name, manifest_json, token_secret
         FROM proxy_hub_routes WHERE hub_name = ? ORDER BY route_id`,
      )
      .all(name) as unknown as HubRouteRow[];
    return rows.map((row) => ({
      routeId: row.route_id,
      manifest: decodeProxyHubManifest(row.manifest_json, `proxy-hub-route/${row.route_id}`),
      token: row.token_secret,
    }));
  }

  detachRoute(routeId: string): void {
    this.db.prepare('DELETE FROM proxy_hub_routes WHERE route_id = ?').run(routeId);
  }

  countRoutes(name = DEFAULT_PROXY_HUB): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM proxy_hub_routes WHERE hub_name = ?')
      .get(name) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }
}

function defaultConfig(name: string): ProxyHubConfig {
  const now = new Date().toISOString();
  return {
    name,
    enabled: false,
    host: '127.0.0.1',
    port: DEFAULT_PROXY_HUB_PORT,
    sources: [],
    modelOwners: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function decodeProxyHubManifest(json: string, key: string): ProxyHubRouteManifest {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`corrupt proxy hub route: ${key}`);
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.hub !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.client !== 'string' ||
    (value.protocol !== 'openai' && value.protocol !== 'anthropic') ||
    !Array.isArray(value.routes)
  ) {
    throw new Error(`corrupt proxy hub route: ${key}`);
  }
  const routes = value.routes.map((route, index) => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error(`corrupt proxy hub route: ${key}.routes[${index}]`);
    }
    const target = route as Record<string, unknown>;
    if (
      typeof target.model !== 'string' ||
      typeof target.upstreamModel !== 'string' ||
      !target.source ||
      typeof target.source !== 'object' ||
      Array.isArray(target.source)
    ) {
      throw new Error(`corrupt proxy hub route: ${key}.routes[${index}]`);
    }
    const source = target.source as Record<string, unknown>;
    if (
      source.kind === 'account' &&
      typeof source.provider === 'string' &&
      typeof source.name === 'string'
    ) {
      return {
        model: target.model,
        upstreamModel: target.upstreamModel,
        source: { kind: 'account' as const, provider: source.provider, name: source.name },
      };
    }
    if (source.kind === 'account-pool' && typeof source.provider === 'string') {
      return {
        model: target.model,
        upstreamModel: target.upstreamModel,
        source: { kind: 'account-pool' as const, provider: source.provider },
      };
    }
    throw new Error(`corrupt proxy hub route: ${key}.routes[${index}].source`);
  });
  return {
    version: 1,
    hub: value.hub,
    revision: value.revision,
    client: value.client,
    protocol: value.protocol,
    routes,
  };
}
