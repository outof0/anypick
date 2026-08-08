/**
 * Optional per-provider proxy pool (multi-account behind one endpoint).
 *
 * Default mode is **single** (no pool row, or mode: "single"):
 * each account keeps its own proxy process — current behavior.
 *
 * Opt-in **multi**: one shared process, members enable/disable independently.
 *
 * Pool state lives in the shared SQLite database (`pools` table) so it is
 * transactional with the rest of the data root. A previously written
 * `pool.json` (the pre-SQLite layout) is still read as a fallback on `get`
 * so existing installs keep their pool without a separate migration step; any
 * write replaces it (the JSON file is removed on `set`).
 */

import { join } from 'node:path';
import type { ProviderProxyPool, PoolMember } from '../types';
import { pathExists, readJsonFile, removePath } from '../utils/fs';
import { decodeWithFallback, decoders } from './codec';
import { providerDir } from './paths';
import type { HotplugDatabase } from './db';

export function poolConfigPath(root: string, providerId: string): string {
  return join(providerDir(root, providerId), 'pool.json');
}

export function poolRuntimeDir(root: string, providerId: string): string {
  return join(providerDir(root, providerId), 'pool-runtime');
}

export const DEFAULT_POOL: Omit<ProviderProxyPool, 'provider' | 'updatedAt' | 'members'> = {
  mode: 'single',
  enabled: false,
  strategy: 'failover',
};

export class PoolStore {
  constructor(
    private readonly root: string,
    private readonly db: HotplugDatabase,
  ) {}

  async get(providerId: string): Promise<ProviderProxyPool | null> {
    const row = this.db.prepare('SELECT * FROM pools WHERE provider = ?').get(providerId) as
      | PoolRow
      | undefined;
    if (row) {
      return rowToPool(row);
    }
    // Fallback: pre-SQLite pool.json from an earlier install.
    const legacy = await this.readLegacy(providerId);
    return legacy;
  }

  /** Effective pool — never null; default single with empty members. */
  async getOrDefault(providerId: string): Promise<ProviderProxyPool> {
    const existing = await this.get(providerId);
    if (existing) {
      return existing;
    }
    return {
      provider: providerId,
      ...DEFAULT_POOL,
      members: [],
      updatedAt: new Date().toISOString(),
    };
  }

  async set(pool: ProviderProxyPool): Promise<void> {
    const next = normalizePool({ ...pool, updatedAt: new Date().toISOString() }, pool.provider);
    const membersJson = JSON.stringify(next.members);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pools (provider, mode, enabled, strategy, host, port, members_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             mode = excluded.mode,
             enabled = excluded.enabled,
             strategy = excluded.strategy,
             host = excluded.host,
             port = excluded.port,
             members_json = excluded.members_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          next.provider,
          next.mode,
          next.enabled ? 1 : 0,
          next.strategy,
          next.host ?? null,
          typeof next.port === 'number' ? next.port : null,
          membersJson,
          next.updatedAt,
        );
      // Replace the legacy JSON file (if any) with the canonical DB row.
      void removePath(poolConfigPath(this.root, next.provider));
    });
  }

  async delete(providerId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM pools WHERE provider = ?').run(providerId);
      void removePath(poolConfigPath(this.root, providerId));
    });
  }

  /**
   * Ensure members list tracks known accounts.
   * New accounts are added enabled:true in multi mode, or ignored in single.
   */
  async syncMembers(providerId: string, accountNames: string[]): Promise<ProviderProxyPool> {
    const pool = await this.getOrDefault(providerId);
    const known = new Set(accountNames);
    const byName = new Map(pool.members.map((m) => [m.account, m]));
    const members: PoolMember[] = [];
    for (const name of accountNames.toSorted()) {
      const prev = byName.get(name);
      members.push({
        account: name,
        enabled: prev?.enabled ?? true,
      });
    }
    // drop unknown
    const next: ProviderProxyPool = {
      ...pool,
      members: members.filter((m) => known.has(m.account)),
      updatedAt: new Date().toISOString(),
    };
    if (pool.mode === 'multi' || (await this.get(providerId)) !== null) {
      await this.set(next);
    }
    return next;
  }

  /** Turn multi-account pool on (opt-in). */
  async enableMulti(
    providerId: string,
    accountNames: string[],
    opts: { port?: number; host?: string } = {},
  ): Promise<ProviderProxyPool> {
    const members: PoolMember[] = accountNames.toSorted().map((account) => ({
      account,
      enabled: true,
    }));
    const pool: ProviderProxyPool = {
      provider: providerId,
      mode: 'multi',
      enabled: true,
      strategy: 'failover',
      host: opts.host ?? '127.0.0.1',
      port: opts.port,
      members,
      updatedAt: new Date().toISOString(),
    };
    await this.set(pool);
    return pool;
  }

  /** Back to single-account proxies (default). */
  async disableMulti(providerId: string): Promise<ProviderProxyPool> {
    const pool = await this.getOrDefault(providerId);
    const next: ProviderProxyPool = {
      ...pool,
      mode: 'single',
      enabled: false,
      updatedAt: new Date().toISOString(),
    };
    await this.set(next);
    return next;
  }

  async setMemberEnabled(
    providerId: string,
    account: string,
    enabled: boolean,
  ): Promise<ProviderProxyPool> {
    const pool = await this.getOrDefault(providerId);
    const members = pool.members.map((m) => (m.account === account ? { ...m, enabled } : m));
    if (!members.some((m) => m.account === account)) {
      members.push({ account, enabled });
      members.sort((a, b) => a.account.localeCompare(b.account));
    }
    const next = { ...pool, members, updatedAt: new Date().toISOString() };
    await this.set(next);
    return next;
  }

  private async readLegacy(providerId: string): Promise<ProviderProxyPool | null> {
    const path = poolConfigPath(this.root, providerId);
    if (!(await pathExists(path))) {
      return null;
    }
    try {
      const data = await readJsonFile<ProviderProxyPool>(path);
      if (!data || data.provider !== providerId) {
        return null;
      }
      return normalizePool(data, providerId);
    } catch {
      return null;
    }
  }
}

interface PoolRow {
  provider: string;
  mode: string;
  enabled: number;
  strategy: string;
  host: string | null;
  port: number | null;
  members_json: string;
  updated_at: string;
}

function rowToPool(row: PoolRow): ProviderProxyPool {
  const members = decodeWithFallback(
    row.members_json,
    decoders.poolMembers,
    [],
    `${row.provider}/members`,
  ) as PoolMember[];
  return normalizePool(
    {
      provider: row.provider,
      mode: row.mode,
      enabled: Boolean(row.enabled),
      strategy: row.strategy,
      host: row.host ?? undefined,
      port: row.port ?? undefined,
      members,
      updatedAt: row.updated_at,
    },
    row.provider,
  );
}

/** Loose shape accepted by normalizePool — widened from ProviderProxyPool so
 *  DB-row / legacy-JSON sources (string-typed mode/strategy) can be normalized. */
type PoolInput = {
  provider?: string;
  mode?: string;
  enabled?: unknown;
  host?: string | null;
  port?: number | null;
  strategy?: string;
  members?: unknown;
  updatedAt?: string;
};

function normalizePool(data: PoolInput, providerId: string): ProviderProxyPool {
  return {
    provider: providerId,
    mode: data.mode === 'multi' ? 'multi' : 'single',
    enabled: Boolean(data.enabled),
    host: typeof data.host === 'string' ? data.host : undefined,
    port: typeof data.port === 'number' ? data.port : undefined,
    strategy: data.strategy === 'round-robin' ? 'round-robin' : 'failover',
    members: Array.isArray(data.members)
      ? (data.members as unknown[])
          .filter(
            (m): m is { account: string; enabled?: unknown } =>
              typeof m === 'object' &&
              m !== null &&
              typeof (m as { account?: unknown }).account === 'string',
          )
          .map((m) => ({
            account: m.account,
            enabled: m.enabled !== false,
          }))
      : [],
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
  };
}
