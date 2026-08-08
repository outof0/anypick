import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnyPickDatabase } from './db';
import { getMeta, setMeta } from './db';
import { decoders } from './codec';
import {
  accountMetaPath,
  accountProxyConfigPath,
  accountSnapshotDir,
  accountsDir,
  activePointerPath,
  clientStatePath,
  clientsDir,
  configPath,
  profileMetaPath,
  profileSecretsPath,
  profilesDir,
} from './paths';
import { listSubdirs, pathExists, readJsonFile, readAndDecodeJsonFile } from '../utils/fs';
import type {
  AccountMeta,
  AccountProxyConfig,
  ClientState,
  RuntimeProfileMeta,
  RuntimeProfileSecrets,
} from '../types';
import { DEFAULT_PROXY_CONFIG } from '../types';
import { normalizeAccountName } from '../utils/slug';

/**
 * One-time import of legacy filesystem layout into SQLite.
 * Safe to call every open: no-ops if already migrated or nothing to import.
 */
export async function migrateFilesystemIfNeeded(
  db: AnyPickDatabase,
  root: string,
): Promise<{ migrated: boolean; accounts: number; profiles: number }> {
  if (getMeta(db, 'fs_migrated') === '1') {
    return { migrated: false, accounts: 0, profiles: 0 };
  }

  // Already has SQL data → just mark migrated
  const accountCount = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  const profileCount = (db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;
  if (accountCount > 0 || profileCount > 0) {
    setMeta(db, 'fs_migrated', '1');
    return { migrated: false, accounts: 0, profiles: 0 };
  }

  const hasProviders = await pathExists(join(root, 'providers'));
  const hasProfiles = await pathExists(profilesDir(root));
  const hasConfig = await pathExists(configPath(root));
  const hasClients = await pathExists(clientsDir(root));

  if (!hasProviders && !hasProfiles && !hasConfig && !hasClients) {
    setMeta(db, 'fs_migrated', '1');
    return { migrated: false, accounts: 0, profiles: 0 };
  }

  let accounts = 0;
  let profiles = 0;

  const tx = db.prepare('BEGIN IMMEDIATE');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');

  try {
    tx.run();

    // config.json
    if (hasConfig) {
      try {
        const cfg = await readAndDecodeJsonFile(configPath(root), decoders.globalConfig);
        db.prepare(
          `INSERT INTO config (key, value) VALUES ('global', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(JSON.stringify(cfg));
      } catch {
        // ignore corrupt config
      }
    }

    // accounts
    if (hasProviders) {
      const providers = await listSubdirs(join(root, 'providers'));
      for (const provider of providers) {
        const activePath = activePointerPath(root, provider);
        if (await pathExists(activePath)) {
          const active = (await readFile(activePath, 'utf8')).trim();
          if (active) {
            try {
              db.prepare(
                `INSERT INTO provider_active (provider, account_name)
                 VALUES (?, ?)
                 ON CONFLICT(provider) DO UPDATE SET account_name = excluded.account_name`,
              ).run(provider, normalizeAccountName(active));
            } catch {
              // Ignore malformed legacy active pointers.
            }
          }
        }

        const names = await listSubdirs(accountsDir(root, provider));
        for (const name of names) {
          const metaPath = accountMetaPath(root, provider, name);
          if (!(await pathExists(metaPath))) {
            continue;
          }
          let rawMeta: AccountMeta;
          try {
            rawMeta = await readAndDecodeJsonFile(metaPath, decoders.accountMeta);
          } catch {
            continue;
          }
          const accountName = normalizeAccountName(name);
          // Directory/provider identity is canonical; never trust the legacy
          // metadata to choose a different account path or provider.
          const meta: AccountMeta = {
            ...rawMeta,
            name: accountName,
            provider,
            createdAt: rawMeta.createdAt ?? new Date().toISOString(),
            updatedAt: rawMeta.updatedAt ?? new Date().toISOString(),
          };
          let proxy: AccountProxyConfig = { ...DEFAULT_PROXY_CONFIG };
          const proxyPath = accountProxyConfigPath(root, provider, name);
          if (await pathExists(proxyPath)) {
            try {
              const rawProxy = await readJsonFile<Partial<AccountProxyConfig>>(proxyPath);
              // Legacy files can include old provider-specific `options`
              // (upstreams, auth paths). They are configuration, not portable
              // account state: import only a benign local port/host and require
              // an explicit enable after migration.
              const port = rawProxy.port;
              const host = rawProxy.host;
              proxy = {
                enabled: false,
                ...(typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535
                  ? { port }
                  : {}),
                ...(typeof host === 'string' && host.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(host)
                  ? { host }
                  : {}),
              };
            } catch {
              // keep default
            }
          }

          db.prepare(
            `INSERT INTO accounts (provider, name, meta_json, proxy_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, name) DO UPDATE SET
               meta_json = excluded.meta_json,
               proxy_json = excluded.proxy_json,
               updated_at = excluded.updated_at`,
          ).run(
            provider,
            accountName,
            JSON.stringify(meta),
            JSON.stringify(proxy),
            meta.createdAt ?? new Date().toISOString(),
            meta.updatedAt ?? new Date().toISOString(),
          );

          const snap = accountSnapshotDir(root, provider, name);
          if (await pathExists(snap)) {
            const files = await collectDirFiles(snap);
            const del = db.prepare(
              `DELETE FROM account_snapshot_files WHERE provider = ? AND account = ?`,
            );
            del.run(provider, accountName);
            const ins = db.prepare(
              `INSERT INTO account_snapshot_files (provider, account, path, content)
               VALUES (?, ?, ?, ?)`,
            );
            for (const [rel, buf] of files) {
              ins.run(provider, accountName, rel, buf);
            }
          }
          accounts++;
        }
      }
    }

    // profiles
    if (hasProfiles) {
      const names = await listSubdirs(profilesDir(root));
      for (const name of names) {
        const metaPath = profileMetaPath(root, name);
        if (!(await pathExists(metaPath))) {
          continue;
        }
        const meta = (await readAndDecodeJsonFile(
          metaPath,
          decoders.runtimeProfileMeta,
        )) as RuntimeProfileMeta;
        let secrets: RuntimeProfileSecrets = {};
        const secretsPath = profileSecretsPath(root, name);
        if (await pathExists(secretsPath)) {
          try {
            secrets = await readAndDecodeJsonFile(secretsPath, decoders.runtimeProfileSecrets);
          } catch {
            // ignore
          }
        }
        db.prepare(
          `INSERT INTO profiles (name, meta_json, secrets_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             meta_json = excluded.meta_json,
             secrets_json = excluded.secrets_json,
             updated_at = excluded.updated_at`,
        ).run(
          name,
          JSON.stringify(meta),
          JSON.stringify(secrets),
          meta.createdAt ?? new Date().toISOString(),
          meta.updatedAt ?? new Date().toISOString(),
        );
        profiles++;
      }
    }

    // client state
    if (hasClients) {
      const ids = await listSubdirs(clientsDir(root));
      for (const clientId of ids) {
        const path = clientStatePath(root, clientId);
        if (!(await pathExists(path))) {
          continue;
        }
        try {
          const state = (await readAndDecodeJsonFile(path, decoders.clientState)) as ClientState;
          db.prepare(
            `INSERT INTO client_state (client_id, state_json)
             VALUES (?, ?)
             ON CONFLICT(client_id) DO UPDATE SET state_json = excluded.state_json`,
          ).run(clientId, JSON.stringify(state));
        } catch {
          // ignore
        }
      }
    }

    setMeta(db, 'fs_migrated', '1');
    setMeta(db, 'fs_migrated_at', new Date().toISOString());
    commit.run();
  } catch (err) {
    try {
      rollback.run();
    } catch {
      // ignore
    }
    throw err;
  }

  return { migrated: true, accounts, profiles };
}

async function collectDirFiles(root: string): Promise<Array<[string, Buffer]>> {
  const out: Array<[string, Buffer]> = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        out.push([rel.split('\\').join('/'), await readFile(full)]);
      }
    }
  }
  const st = await stat(root).catch(() => null);
  if (st?.isDirectory()) {
    await walk(root, '');
  }
  return out;
}
