/**
 * kiro-cli's secret store.
 *
 * Since kiro-cli 2.x the login is no longer a file under ~/.aws/sso/cache. It
 * lives in the OS keychain, mirrored into an `auth_kv` table in kiro-cli's own
 * SQLite database, and kiro-cli reads the keychain *first* — so switching a Kiro
 * account has to write both tiers. Restoring only the database would be
 * silently ignored while a stale keychain item is still readable, which is the
 * worst possible outcome: anypick reports a switch that did not happen.
 *
 * Every access mirrors what kiro-cli itself does — `/usr/bin/security` and
 * `INSERT OR REPLACE INTO auth_kv` — so an item anypick writes carries the same
 * keychain ACL and kiro-cli reads it back without an authorization prompt.
 *
 * The secret never crosses `argv`: `security(1)` is driven through its `-i`
 * stdin mode, and the value is passed as hex (`-X`) because `-i` unquoting
 * mangles backslashes, which JSON escapes contain.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openForeignDatabase } from '../core/db';

/** Login kinds kiro-cli stores, each under its own keychain service name. */
export const KIRO_SECRET_KEYS = [
  'kirocli:social:token',
  'kirocli:odic:token',
  'kirocli:odic:device-registration',
  'kirocli:external-idp:token',
] as const;

/** Keyed by the names in `KIRO_SECRET_KEYS`; absent keys are simply not stored. */
export type KiroSecrets = Record<string, string>;

const SECURITY_BIN = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 5_000;

/** Set by the test suite so no test can touch the developer's real keychain. */
function keychainEnabled(): boolean {
  return process.platform === 'darwin' && process.env.ANYPICK_KIRO_NO_KEYCHAIN !== '1';
}

/** kiro-cli's data directory, following the same platform rules it does. */
export function kiroSecretDbPath(home = homedir()): string {
  const override = process.env.ANYPICK_KIRO_SECRET_DB;
  if (override) {
    return override;
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(base, 'kiro-cli', 'data.sqlite3');
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(xdg, 'kiro-cli', 'data.sqlite3');
}

/** Every secret kiro-cli currently holds. Empty when it is not logged in. */
export async function readKiroSecrets(home = homedir()): Promise<KiroSecrets> {
  const secrets: KiroSecrets = {};

  if (keychainEnabled()) {
    for (const key of KIRO_SECRET_KEYS) {
      const value = await keychainRead(key);
      if (value) {
        secrets[key] = value;
      }
    }
  }

  // Not an else: the keychain can hold a subset, and kiro-cli falls back to the
  // database per key rather than per store.
  const rows = readAuthKv(kiroSecretDbPath(home));
  for (const key of KIRO_SECRET_KEYS) {
    const value = rows.get(key);
    if (value && !secrets[key]) {
      secrets[key] = value;
    }
  }

  return secrets;
}

/** Replace the stored login. Writes both tiers; the keychain is best-effort. */
export async function writeKiroSecrets(secrets: KiroSecrets, home = homedir()): Promise<void> {
  writeAuthKv(kiroSecretDbPath(home), secrets);

  if (!keychainEnabled()) {
    return;
  }
  for (const key of KIRO_SECRET_KEYS) {
    const value = secrets[key];
    if (value) {
      await keychainWrite(key, value);
    } else {
      await keychainDelete(key);
    }
  }
}

/** Forget the local login. Does not call Kiro/AWS logout. */
export async function clearKiroSecrets(home = homedir()): Promise<void> {
  writeAuthKv(kiroSecretDbPath(home), {});
  if (!keychainEnabled()) {
    return;
  }
  for (const key of KIRO_SECRET_KEYS) {
    await keychainDelete(key);
  }
}

/**
 * A human label for the stored login.
 *
 * The token carries no email — the only per-account signal is the profile id at
 * the tail of `profile_arn`, so it is paired with the identity provider to give
 * something a person can tell two Google logins apart by.
 */
export function kiroSecretIdentity(secrets: KiroSecrets): string | undefined {
  for (const key of KIRO_SECRET_KEYS) {
    const raw = secrets[key];
    if (!raw) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const arn = record.profile_arn ?? record.profileArn;
    if (typeof arn !== 'string') {
      continue;
    }
    const profile = arn.split('/').pop();
    if (!profile) {
      continue;
    }
    const provider = record.provider;
    return typeof provider === 'string' && provider ? `${provider}:${profile}` : profile;
  }
  return undefined;
}

function readAuthKv(dbPath: string): Map<string, string> {
  const rows = new Map<string, string>();
  let db;
  try {
    db = openForeignDatabase(dbPath, true);
  } catch {
    // No kiro-cli database at all, or an older schema: nothing stored.
    return rows;
  }
  try {
    for (const row of db.prepare('SELECT key, value FROM auth_kv').all() as {
      key?: unknown;
      value?: unknown;
    }[]) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        rows.set(row.key, row.value);
      }
    }
  } catch {
    // Table absent on an older kiro-cli schema.
  } finally {
    db.close();
  }
  return rows;
}

function writeAuthKv(dbPath: string, secrets: KiroSecrets): void {
  let db;
  try {
    db = openForeignDatabase(dbPath);
  } catch {
    // kiro-cli has never run here; it will create the database on next login.
    return;
  }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    db.transaction(() => {
      const upsert = db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)');
      const remove = db.prepare('DELETE FROM auth_kv WHERE key = ?');
      for (const key of KIRO_SECRET_KEYS) {
        const value = secrets[key];
        if (value) {
          upsert.run(key, value);
        } else {
          remove.run(key);
        }
      }
    });
  } finally {
    db.close();
  }
}

function keychainRead(service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-w'],
      { timeout: SECURITY_TIMEOUT_MS },
      // A missing item and an unreadable keychain are both "nothing here"; the
      // database mirror is the fallback either way.
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

function keychainWrite(service: string, value: string): Promise<void> {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  // -a "" matches the NULL account kiro-cli's own items carry, so an update
  // replaces its item instead of creating a second one beside it.
  return securityStdin(`add-generic-password -U -s "${service}" -a "" -X ${hex}\n`);
}

function keychainDelete(service: string): Promise<void> {
  return securityStdin(`delete-generic-password -s "${service}"\n`);
}

/**
 * Drive `security(1)` through its batch mode so the secret is never an argument.
 * Failures are swallowed: the database mirror is already written, and a locked
 * or absent keychain must not fail an otherwise complete switch.
 */
function securityStdin(command: string): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile(SECURITY_BIN, ['-i'], { timeout: SECURITY_TIMEOUT_MS }, () => resolve());
    child.stdin?.end(command);
  });
}
