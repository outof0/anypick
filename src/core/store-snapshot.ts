import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Account, AccountMeta } from '../types';
import { DEFAULT_PROXY_CONFIG } from '../types';
import { AnyPickError } from '../utils/errors';
import { normalizeAccountName } from '../utils/slug';
import { stagedFilePath } from './account-codec';
import { decode, decodeWithFallback, decoders } from './codec';
import type { AnyPickDatabase } from './db';
import { accountDir, accountSnapshotDir } from './paths';

export function rowToAccount(
  root: string,
  providerId: string,
  row: { name: string; meta_json: string; proxy_json: string },
): Account {
  const storedName = normalizeAccountName(row.name);
  const rawMeta = decode(row.meta_json, decoders.accountMeta, `${providerId}/${storedName}`);
  // The SQL primary key is the authority for identity and filesystem paths.
  // Never let legacy/corrupt metadata redirect a snapshot outside its own
  // provider/account directory.
  const meta: AccountMeta = {
    ...rawMeta,
    name: storedName,
    provider: providerId,
  };
  const proxy = decodeWithFallback(
    row.proxy_json,
    decoders.accountProxyConfig,
    {
      ...DEFAULT_PROXY_CONFIG,
    },
    `${providerId}/${storedName}`,
  );
  return {
    meta,
    snapshotDir: accountSnapshotDir(root, providerId, storedName),
    accountDir: accountDir(root, providerId, storedName),
    proxy,
  };
}

export function ingestSnapshotDir(
  db: AnyPickDatabase,
  providerId: string,
  name: string,
  snapDir: string,
): void {
  db.prepare(`DELETE FROM account_snapshot_files WHERE provider = ? AND account = ?`).run(
    providerId,
    name,
  );

  if (!existsSync(snapDir)) {
    return;
  }

  const ins = db.prepare(
    `INSERT INTO account_snapshot_files (provider, account, path, content)
     VALUES (?, ?, ?, ?)`,
  );

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        ins.run(providerId, name, rel.split('\\').join('/'), readFileSync(full));
      }
    }
  };
  walk(snapDir, '');
}

export function materializeSnapshot(
  root: string,
  db: AnyPickDatabase,
  providerId: string,
  name: string,
): void {
  const snap = accountSnapshotDir(root, providerId, name);
  mkdirSync(snap, { recursive: true, mode: 0o700 });

  const rows = db
    .prepare(
      `SELECT path, content FROM account_snapshot_files
       WHERE provider = ? AND account = ?`,
    )
    .all(providerId, name) as Array<{ path: string; content: Buffer }>;

  const destinations = rows.map((row) => {
    if (typeof row.path !== 'string') {
      throw new AnyPickError('Snapshot contains an invalid file path.', 'SNAPSHOT_INVALID');
    }
    try {
      return { row, dest: stagedFilePath(snap, row.path) };
    } catch {
      throw new AnyPickError(
        `Snapshot contains an unsafe file path: ${JSON.stringify(row.path)}.`,
        'SNAPSHOT_INVALID',
      );
    }
  });
  const seen = new Set<string>();
  for (const { row } of destinations) {
    const rel = row.path.split('\\').join('/').replace(/^\.\//, '');
    if (
      [...seen].some(
        (existing) =>
          rel === existing || rel.startsWith(`${existing}/`) || existing.startsWith(`${rel}/`),
      )
    ) {
      throw new AnyPickError('Snapshot contains colliding file paths.', 'SNAPSHOT_INVALID');
    }
    seen.add(rel);
  }

  for (const entry of readdirSync(snap, { withFileTypes: true })) {
    rmSync(join(snap, entry.name), { recursive: true, force: true });
  }

  for (const { row, dest } of destinations) {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const buf = Buffer.isBuffer(row.content)
      ? row.content
      : Buffer.from(row.content as unknown as ArrayBuffer);
    writeFileSync(dest, buf, { mode: 0o600 });
  }
}
