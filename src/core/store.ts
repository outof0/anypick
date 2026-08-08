import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AccountMeta, AccountProxyConfig } from '../types';
import { DEFAULT_PROXY_CONFIG } from '../types';
import { AnyPickError } from '../utils/errors';
import { ensureDir, removePath } from '../utils/fs';
import { decodeWithFallback, decoders } from './codec';
import type { AnyPickDatabase } from './db';
import {
  accountDir,
  accountProxyRuntimeDir,
  accountSnapshotDir,
  getAnyPickRoot,
  proxyLogPath,
  proxyPidPath,
} from './paths';
import { ingestSnapshotDir, materializeSnapshot, rowToAccount } from './store-snapshot';

export interface ProxyRuntimeState {
  accountName: string;
  endpoint: string;
  compatibility?: string;
  pid?: number;
  logPath?: string;
  startedAt: string;
  /**
   * Per-instance high-entropy secret (PROXY-01) required on every credentialed
   * route. Persisted owner-only in proxy_state; never surfaced in status/doctor.
   */
  token?: string;
}

/**
 * SQLite-backed account store.
 *
 * Structured data lives in ~/.anypick/anypick.db.
 * Snapshot bytes are BLOBs; they are materialized to a cache dir when
 * providers need a real filesystem path for backup/restore.
 * Proxy pid/log runtime stays on disk (process-local).
 */
export class AccountStore {
  readonly root: string;
  readonly db: AnyPickDatabase;

  constructor(root: string, db: AnyPickDatabase) {
    this.root = getAnyPickRoot(root);
    this.db = db;
  }

  async ensureProvider(_providerId: string): Promise<void> {
    // No-op: SQLite has no per-provider directories to create.
  }

  async listAccounts(providerId: string): Promise<Account[]> {
    const rows = this.db
      .prepare(
        `SELECT name, meta_json, proxy_json FROM accounts
         WHERE provider = ?
           AND EXISTS (
             SELECT 1 FROM account_snapshot_files
             WHERE account_snapshot_files.provider = accounts.provider
               AND account_snapshot_files.account = accounts.name
           )
         ORDER BY name`,
      )
      .all(providerId) as Array<{ name: string; meta_json: string; proxy_json: string }>;

    return rows.map((row) => rowToAccount(this.root, providerId, row));
  }

  async getAccount(providerId: string, name: string): Promise<Account | null> {
    const row = this.db
      .prepare(
        `SELECT name, meta_json, proxy_json FROM accounts
         WHERE provider = ? AND name = ?
           AND EXISTS (
             SELECT 1 FROM account_snapshot_files
             WHERE account_snapshot_files.provider = accounts.provider
               AND account_snapshot_files.account = accounts.name
           )`,
      )
      .get(providerId, name) as { name: string; meta_json: string; proxy_json: string } | undefined;
    if (!row) {
      return null;
    }
    const account = rowToAccount(this.root, providerId, row);
    // Ensure snapshot files are on disk for provider.restore / export
    materializeSnapshot(this.root, this.db, providerId, name);
    return account;
  }

  async requireAccount(providerId: string, name: string): Promise<Account> {
    const account = await this.getAccount(providerId, name);
    if (!account) {
      throw new AnyPickError(
        `No account "${name}" for provider "${providerId}".`,
        'ACCOUNT_NOT_FOUND',
      );
    }
    return account;
  }

  /**
   * Prepare an empty snapshot directory for writing a new/updated account.
   * Caller fills the snapshot (provider.backup / import), THEN calls
   * `writeMeta`, which atomically replaces the
   * snapshot's DB rows + metadata.
   *
   * NOTE: prepareSnapshot must NOT delete the existing snapshot's DB rows —
   * doing so before backup succeeds would destroy the previous snapshot on a
   * fault (DATA-01). The previous rows are replaced only inside
   * `writeMeta` transaction.
   */
  async prepareSnapshot(
    providerId: string,
    name: string,
  ): Promise<{ snapshotDir: string; accountDir: string }> {
    const snap = accountSnapshotDir(this.root, providerId, name);
    await ensureDir(snap);
    // Empty the on-disk materialize cache so the next backup starts fresh.
    // The DB rows (source of truth) are intentionally left intact here — they
    // are replaced only inside writeMeta's transaction, so a fault during
    // backup/describe cannot destroy the previous snapshot (DATA-01).
    for (const entry of readdirSync(snap, { withFileTypes: true })) {
      rmSync(join(snap, entry.name), { recursive: true, force: true });
    }
    return {
      snapshotDir: snap,
      accountDir: accountDir(this.root, providerId, name),
    };
  }

  /**
   * Atomically replace an account's metadata + snapshot files in one
   * transaction. Callers MUST fill `snapshotDir` (via provider.backup or import)
   * before calling. Any throw leaves the previous rows + metadata exactly as
   * they were (DATA-01): the old snapshot files are deleted and re-ingested
   * together, never partially.
   */
  async writeMeta(meta: AccountMeta): Promise<void> {
    const now = meta.updatedAt || new Date().toISOString();
    const snap = accountSnapshotDir(this.root, meta.provider, meta.name);

    this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT proxy_json, created_at FROM accounts WHERE provider = ? AND name = ?`)
        .get(meta.provider, meta.name) as { proxy_json: string; created_at: string } | undefined;

      const proxyJson = existing?.proxy_json ?? JSON.stringify(DEFAULT_PROXY_CONFIG);
      const createdAt = existing?.created_at ?? meta.createdAt ?? now;

      this.db
        .prepare(
          `INSERT INTO accounts (provider, name, meta_json, proxy_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, name) DO UPDATE SET
             meta_json = excluded.meta_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          meta.provider,
          meta.name,
          JSON.stringify({ ...meta, updatedAt: now }),
          proxyJson,
          createdAt,
          now,
        );

      // Delete + re-ingest snapshot files atomically so a partial write cannot
      // strand old rows.
      this.db
        .prepare(`DELETE FROM account_snapshot_files WHERE provider = ? AND account = ?`)
        .run(meta.provider, meta.name);
      ingestSnapshotDir(this.db, meta.provider, meta.name, snap);
    });
  }

  async getProxyConfig(providerId: string, name: string): Promise<AccountProxyConfig> {
    const row = this.db
      .prepare(`SELECT proxy_json FROM accounts WHERE provider = ? AND name = ?`)
      .get(providerId, name) as { proxy_json: string } | undefined;
    if (!row) {
      return { ...DEFAULT_PROXY_CONFIG };
    }
    return decodeWithFallback(
      row.proxy_json,
      decoders.accountProxyConfig,
      {
        ...DEFAULT_PROXY_CONFIG,
      },
      `${providerId}/${name}`,
    );
  }

  async setProxyConfig(
    providerId: string,
    name: string,
    config: AccountProxyConfig,
  ): Promise<void> {
    await this.requireAccount(providerId, name);
    this.db
      .prepare(`UPDATE accounts SET proxy_json = ?, updated_at = ? WHERE provider = ? AND name = ?`)
      .run(JSON.stringify(config), new Date().toISOString(), providerId, name);
  }

  runtimeDir(providerId: string, name: string): string {
    return accountProxyRuntimeDir(this.root, providerId, name);
  }

  pidPath(providerId: string, name: string): string {
    return proxyPidPath(this.root, providerId, name);
  }

  logPath(providerId: string, name: string): string {
    return proxyLogPath(this.root, providerId, name);
  }

  async writeProxyState(providerId: string, name: string, state: ProxyRuntimeState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO proxy_state (provider, account, state_json)
         VALUES (?, ?, ?)
         ON CONFLICT(provider, account) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(providerId, name, JSON.stringify(state));
  }

  async readProxyState(providerId: string, name: string): Promise<ProxyRuntimeState | null> {
    const row = this.db
      .prepare(`SELECT state_json FROM proxy_state WHERE provider = ? AND account = ?`)
      .get(providerId, name) as { state_json: string } | undefined;
    if (!row) {
      return null;
    }
    return decodeWithFallback(
      row.state_json,
      decoders.proxyRuntimeState,
      null as ProxyRuntimeState | null,
      `${providerId}/${name}`,
    );
  }

  async clearProxyState(providerId: string, name: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM proxy_state WHERE provider = ? AND account = ?`)
      .run(providerId, name);
  }

  async deleteAccount(providerId: string, name: string): Promise<void> {
    const deleted = this.db.transaction(() => {
      const result = this.db
        .prepare(`DELETE FROM accounts WHERE provider = ? AND name = ?`)
        .run(providerId, name);
      if (result.changes === 0) {
        return false;
      }
      this.db
        .prepare(`DELETE FROM proxy_state WHERE provider = ? AND account = ?`)
        .run(providerId, name);
      return true;
    });
    if (!deleted) {
      throw new AnyPickError(
        `No account "${name}" for provider "${providerId}".`,
        'ACCOUNT_NOT_FOUND',
      );
    }

    // Clear materialize cache (best-effort; DB state already consistent)
    const snap = accountSnapshotDir(this.root, providerId, name);
    await removePath(snap);
    await removePath(accountDir(this.root, providerId, name));

    const active = await this.getActive(providerId);
    if (active === name) {
      await this.clearActive(providerId);
    }
  }

  async getActive(providerId: string): Promise<string | null> {
    const row = this.db
      .prepare(`SELECT account_name FROM provider_active WHERE provider = ?`)
      .get(providerId) as { account_name: string } | undefined;
    return row?.account_name ?? null;
  }

  async setActive(providerId: string, name: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO provider_active (provider, account_name)
         VALUES (?, ?)
         ON CONFLICT(provider) DO UPDATE SET account_name = excluded.account_name`,
      )
      .run(providerId, name);
  }

  async clearActive(providerId: string): Promise<void> {
    this.db.prepare(`DELETE FROM provider_active WHERE provider = ?`).run(providerId);
  }
}
