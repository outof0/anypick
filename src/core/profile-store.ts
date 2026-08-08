import type { RuntimeProfile, RuntimeProfileMeta, RuntimeProfileSecrets } from '../types';
import { HotplugError } from '../utils/errors';
import { decode, decodeWithFallback, decoders } from './codec';
import type { HotplugDatabase } from './db';
import { getHotplugRoot, profileDir } from './paths';

/**
 * SQLite-backed runtime profile store.
 * Secrets live in the same DB (file mode 0600).
 */
export class ProfileStore {
  readonly root: string;
  readonly db: HotplugDatabase;

  constructor(root: string, db: HotplugDatabase) {
    this.root = getHotplugRoot(root);
    this.db = db;
  }

  async listNames(): Promise<string[]> {
    const rows = this.db.prepare(`SELECT name FROM profiles ORDER BY name`).all() as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  }

  async list(): Promise<RuntimeProfile[]> {
    const names = await this.listNames();
    const out: RuntimeProfile[] = [];
    for (const name of names) {
      const profile = await this.get(name);
      if (profile) {
        out.push(profile);
      }
    }
    return out;
  }

  async get(name: string): Promise<RuntimeProfile | null> {
    const row = this.db
      .prepare(`SELECT meta_json, secrets_json FROM profiles WHERE name = ?`)
      .get(name) as { meta_json: string; secrets_json: string } | undefined;
    if (!row) {
      return null;
    }
    const meta = decode(
      row.meta_json,
      decoders.runtimeProfileMeta,
      `profile/${name}`,
    ) as RuntimeProfileMeta;
    const secrets = decodeWithFallback(
      row.secrets_json,
      decoders.runtimeProfileSecrets,
      {},
      `profile/${name}/secrets`,
    );
    return {
      meta,
      secrets,
      profileDir: profileDir(this.root, name),
    };
  }

  async require(name: string): Promise<RuntimeProfile> {
    const profile = await this.get(name);
    if (!profile) {
      throw new HotplugError(`No runtime profile "${name}".`, 'PROFILE_NOT_FOUND');
    }
    return profile;
  }

  async writeMeta(meta: RuntimeProfileMeta): Promise<void> {
    const now = meta.updatedAt || new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT secrets_json, created_at FROM profiles WHERE name = ?`)
      .get(meta.name) as { secrets_json: string; created_at: string } | undefined;

    const secretsJson = existing?.secrets_json ?? '{}';
    const createdAt = existing?.created_at ?? meta.createdAt ?? now;

    this.db
      .prepare(
        `INSERT INTO profiles (name, meta_json, secrets_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           meta_json = excluded.meta_json,
           updated_at = excluded.updated_at`,
      )
      .run(meta.name, JSON.stringify({ ...meta, updatedAt: now }), secretsJson, createdAt, now);
  }

  async writeSecrets(name: string, secrets: RuntimeProfileSecrets): Promise<void> {
    const existing = this.db.prepare(`SELECT name FROM profiles WHERE name = ?`).get(name) as
      | { name: string }
      | undefined;

    if (!existing) {
      // Create shell row if secrets written first
      const now = new Date().toISOString();
      const meta: RuntimeProfileMeta = {
        name,
        provider: 'custom',
        createdAt: now,
        updatedAt: now,
        models: {},
      };
      this.db
        .prepare(
          `INSERT INTO profiles (name, meta_json, secrets_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(name, JSON.stringify(meta), JSON.stringify(secrets), now, now);
      return;
    }

    this.db
      .prepare(`UPDATE profiles SET secrets_json = ?, updated_at = ? WHERE name = ?`)
      .run(JSON.stringify(secrets), new Date().toISOString(), name);
  }

  async delete(name: string): Promise<void> {
    const result = this.db.prepare(`DELETE FROM profiles WHERE name = ?`).run(name);
    if (result.changes === 0) {
      throw new HotplugError(`No runtime profile "${name}".`, 'PROFILE_NOT_FOUND');
    }
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const src = await this.require(oldName);
    if (await this.get(newName)) {
      throw new HotplugError(`Profile "${newName}" already exists.`, 'PROFILE_EXISTS');
    }

    const now = new Date().toISOString();
    const meta: RuntimeProfileMeta = {
      ...src.meta,
      name: newName,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO profiles (name, meta_json, secrets_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        newName,
        JSON.stringify(meta),
        JSON.stringify(src.secrets),
        src.meta.createdAt ?? now,
        now,
      );

    this.db.prepare(`DELETE FROM profiles WHERE name = ?`).run(oldName);
  }
}
