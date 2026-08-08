import type { PluginRecord } from '../types';
import type { HotplugDatabase } from './db';

interface PluginRow {
  name: string;
  path: string;
  version: string;
  enabled: number;
  digest: string;
  added_at: string;
  updated_at: string;
}

function parse(row: PluginRow): PluginRecord {
  return {
    name: row.name,
    path: row.path,
    version: row.version,
    enabled: row.enabled === 1,
    digest: row.digest,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'name, path, version, enabled, digest, added_at, updated_at';

/**
 * The installed plugin registry.
 *
 * Kept in SQLite rather than a config file so `hotplug plugin` mutations are
 * transactional with the rest of the data root, and so a plugin cannot enable
 * itself by writing a file the loader happens to read.
 */
export class PluginStore {
  constructor(private readonly db: HotplugDatabase) {}

  list(): PluginRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM plugins ORDER BY name`)
      .all() as unknown as PluginRow[];
    return rows.map(parse);
  }

  get(name: string): PluginRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM plugins WHERE name = ?`).get(name) as
      | PluginRow
      | undefined;
    return row ? parse(row) : null;
  }

  upsert(record: PluginRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugins (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           version = excluded.version,
           enabled = excluded.enabled,
           digest = excluded.digest,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.name,
        record.path,
        record.version,
        record.enabled ? 1 : 0,
        record.digest,
        record.addedAt,
        record.updatedAt,
      );
  }

  remove(name: string): boolean {
    const info = this.db.prepare('DELETE FROM plugins WHERE name = ?').run(name);
    return Number(info.changes ?? 0) > 0;
  }
}
