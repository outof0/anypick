/**
 * Cached vendor model lists.
 *
 * Advisory data only: a miss costs one HTTP request, never correctness, so a
 * corrupt or absent row is read as "no cache" rather than raised. The store owns
 * its SQL and takes no locks — the service above it does that (ADR 0009).
 *
 * Keyed by provider *and* endpoint because the same provider id can point at
 * different hosts (a `custom` gateway, a self-hosted LiteLLM), and those serve
 * different model lists.
 */

import type { HotplugDatabase } from './db';
import { getHotplugRoot } from './paths';

export interface CachedModelList {
  provider: string;
  endpoint: string;
  models: string[];
  fetchedAt: string;
}

export class ModelCacheStore {
  readonly root: string;
  readonly db: HotplugDatabase;

  constructor(root: string, db: HotplugDatabase) {
    this.root = getHotplugRoot(root);
    this.db = db;
  }

  async get(provider: string, endpoint: string): Promise<CachedModelList | null> {
    const row = this.db
      .prepare(
        `SELECT models_json, fetched_at FROM model_catalog_cache
         WHERE provider = ? AND endpoint = ?`,
      )
      .get(provider, endpoint) as { models_json: string; fetched_at: string } | undefined;
    if (!row) {
      return null;
    }
    const models = parseModelsJson(row.models_json);
    if (!models) {
      return null;
    }
    return { provider, endpoint, models, fetchedAt: row.fetched_at };
  }

  async write(entry: CachedModelList): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO model_catalog_cache (provider, endpoint, models_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, endpoint) DO UPDATE SET
           models_json = excluded.models_json,
           fetched_at = excluded.fetched_at`,
      )
      .run(entry.provider, entry.endpoint, JSON.stringify(entry.models), entry.fetchedAt);
  }

  async clear(provider?: string): Promise<void> {
    if (provider) {
      this.db.prepare(`DELETE FROM model_catalog_cache WHERE provider = ?`).run(provider);
      return;
    }
    this.db.prepare(`DELETE FROM model_catalog_cache`).run();
  }
}

function parseModelsJson(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return null;
  }
}
