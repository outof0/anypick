/**
 * Stable fingerprints for "is this saved login currently live?"
 *
 * Email/display identity is not reliable:
 * - Codex: two saved logins can share an email; account_id is the truth.
 * - OpenCode: multi-provider API bags — identity strings drift; key material must match.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathExists, readJsonFile } from '../utils/fs';
import { listAuthEntries } from './opencode-auth';

/** Live auth.json path for a known provider (mirrors each Provider class). */
export function liveAuthPath(providerId: string, home = homedir()): string | null {
  switch (providerId) {
    case 'codex':
      return process.env.CODEX_AUTH_PATH ?? join(home, '.codex', 'auth.json');
    case 'opencode': {
      if (process.env.OPENCODE_AUTH_PATH) {
        return process.env.OPENCODE_AUTH_PATH;
      }
      if (process.env.OPENCODE_DATA_DIR) {
        return join(process.env.OPENCODE_DATA_DIR, 'auth.json');
      }
      const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
      return join(xdg, 'opencode', 'auth.json');
    }
    case 'grok':
      return process.env.GROK_AUTH_PATH ?? join(home, '.grok', 'auth.json');
    default:
      return null;
  }
}

export async function fingerprintLiveAuth(
  providerId: string,
  home = homedir(),
): Promise<string | null> {
  const path = liveAuthPath(providerId, home);
  if (!path) {
    return null;
  }
  return fingerprintAuthFile(providerId, path);
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/**
 * Codex ~/.codex/auth.json → fingerprint of the *current session material*.
 *
 * Prefer refresh_token (unique per login session) over account_id.
 * Matching only on account_id marks every saved copy of the same ChatGPT
 * account as ● live (e.g. "live" + "vicen" with the same email).
 */
export function fingerprintCodexAuth(data: Record<string, unknown>): string | null {
  const tokens = data.tokens;
  if (tokens && typeof tokens === 'object') {
    const t = tokens as Record<string, unknown>;
    // Session material first — exact live match
    if (typeof t.refresh_token === 'string' && t.refresh_token.trim()) {
      const acct =
        typeof t.account_id === 'string' && t.account_id.trim() ? t.account_id.trim() : '';
      return acct
        ? `codex:rt:${sha8(t.refresh_token.trim())}:acct:${acct}`
        : `codex:rt:${sha8(t.refresh_token.trim())}`;
    }
    if (typeof t.access_token === 'string' && t.access_token.trim()) {
      return `codex:at:${sha8(t.access_token.trim())}`;
    }
    // Last resort: account only (cannot distinguish two snapshots of same user)
    if (typeof t.account_id === 'string' && t.account_id.trim()) {
      return `codex:acct:${t.account_id.trim()}`;
    }
  }
  if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) {
    return `codex:key:${sha8(data.OPENAI_API_KEY.trim())}`;
  }
  // Test / FakeProvider shapes: { email, token }
  if (typeof data.token === 'string' && data.token.trim()) {
    return `codex:tok:${sha8(data.token.trim())}`;
  }
  if (typeof data.email === 'string' && data.email.trim()) {
    return `codex:email:${data.email.trim().toLowerCase()}`;
  }
  return null;
}

/**
 * Grok rotates its access key and expiry during normal refreshes. The refresh
 * token identifies the durable login, so comparing the whole session JSON
 * would turn a healthy active account into false drift.
 */
export function fingerprintGrokAuth(data: Record<string, unknown>): string | null {
  const parts = Object.values(data)
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
    )
    .flatMap((session) => {
      if (typeof session.refresh_token === 'string' && session.refresh_token.trim()) {
        return `rt:${sha8(session.refresh_token.trim())}`;
      }
      if (typeof session.key === 'string' && session.key.trim()) {
        return `key:${sha8(session.key.trim())}`;
      }
      return [];
    })
    .toSorted();
  return parts.length > 0 ? `grok:${parts.join('|')}` : null;
}

/** OpenCode auth.json → stable bag fingerprint (sorted provider:type:material). */
export function fingerprintOpenCodeAuth(data: Record<string, unknown>): string | null {
  const entries = listAuthEntries(data);
  if (entries.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const { provider, entry } of entries) {
    if (entry.type === 'api' && entry.key) {
      parts.push(`${provider}:api:${sha8(entry.key)}`);
    } else if (entry.type === 'oauth') {
      if (entry.accountId) {
        parts.push(`${provider}:oauth:acct:${entry.accountId}`);
      } else if (entry.refresh) {
        parts.push(`${provider}:oauth:rt:${sha8(entry.refresh)}`);
      } else if (entry.access) {
        parts.push(`${provider}:oauth:at:${sha8(entry.access)}`);
      } else {
        parts.push(`${provider}:oauth`);
      }
    } else if (entry.type === 'wellknown' && entry.token) {
      parts.push(`${provider}:wk:${sha8(entry.token)}`);
    } else {
      parts.push(`${provider}:${entry.type}`);
    }
  }
  parts.sort();
  return `opencode:${parts.join('|')}`;
}

/**
 * Generic JSON auth fingerprint for unknown providers: hash of stable JSON.
 * Prefer provider-specific fingerprints when available.
 */
export function fingerprintJsonAuth(data: unknown): string | null {
  if (data == null || typeof data !== 'object') {
    return null;
  }
  try {
    return `json:${sha8(JSON.stringify(data))}`;
  } catch {
    return null;
  }
}

export function fingerprintAuthData(
  providerId: string,
  data: Record<string, unknown>,
): string | null {
  if (providerId === 'codex') {
    return fingerprintCodexAuth(data);
  }
  if (providerId === 'opencode') {
    return fingerprintOpenCodeAuth(data);
  }
  if (providerId === 'grok') {
    return fingerprintGrokAuth(data) ?? fingerprintJsonAuth(data);
  }
  // Grok / fakes / others: prefer known fields then full JSON
  if (typeof data.token === 'string' && data.token.trim()) {
    return `${providerId}:tok:${sha8(data.token.trim())}`;
  }
  if (typeof data.email === 'string' && data.email.trim()) {
    return `${providerId}:email:${data.email.trim().toLowerCase()}`;
  }
  return fingerprintJsonAuth(data);
}

export async function fingerprintAuthFile(
  providerId: string,
  authPath: string,
): Promise<string | null> {
  if (!(await pathExists(authPath))) {
    return null;
  }
  try {
    const data = await readJsonFile<Record<string, unknown>>(authPath);
    return fingerprintAuthData(providerId, data);
  } catch {
    return null;
  }
}

/** Snapshot dir → fingerprint (auth.json). */
export async function fingerprintSnapshot(
  providerId: string,
  snapshotDir: string,
): Promise<string | null> {
  return fingerprintAuthFile(providerId, join(snapshotDir, 'auth.json'));
}

/** Extract ChatGPT account_id from a codex auth.json object or snapshot. */
export function codexAccountIdFromAuth(data: Record<string, unknown>): string | null {
  const tokens = data.tokens;
  if (tokens && typeof tokens === 'object') {
    const id = (tokens as Record<string, unknown>).account_id;
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
  }
  return null;
}

export async function codexAccountIdFromSnapshot(snapshotDir: string): Promise<string | null> {
  const path = join(snapshotDir, 'auth.json');
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    const data = await readJsonFile<Record<string, unknown>>(path);
    return codexAccountIdFromAuth(data);
  } catch {
    return null;
  }
}

/**
 * Default "is this snapshot the live login?" using stable material fingerprints.
 * Providers that need richer file layouts implement their own
 * `snapshotMatchesLive`; everyone else delegates here.
 */
export async function snapshotMatchesLiveDefault(
  providerId: string,
  snapshotDir: string,
): Promise<boolean> {
  if (providerId === 'codex') {
    const live = await fingerprintLiveAuth('codex');
    if (!live) {
      return false;
    }
    const snap = await fingerprintSnapshot('codex', snapshotDir);
    return snap != null && snap === live;
  }
  const live = await fingerprintLiveAuth(providerId);
  if (!live) {
    return false;
  }
  const snap = await fingerprintSnapshot(providerId, snapshotDir);
  return snap != null && snap === live;
}

/**
 * Compare a set of named auth files between a live location and a snapshot dir.
 * Used by providers (e.g. Kiro) whose live auth lives outside the standard
 * auth.json convention. Returns true only if every present live file has an
 * identical counterpart in the snapshot (and vice-versa for present files).
 */
export async function snapshotMatchesLiveByFiles(
  liveFiles: { name: string; livePath: string; snapshotPath: string }[],
): Promise<boolean> {
  let any = false;
  for (const { livePath, snapshotPath } of liveFiles) {
    const [live, snap] = await Promise.all([
      fileFingerprint(livePath),
      fileFingerprint(snapshotPath),
    ]);
    if (live == null && snap == null) {
      continue;
    }
    if (live == null || snap == null || live !== snap) {
      return false;
    }
    any = true;
  }
  return any;
}

async function fileFingerprint(p: string): Promise<string | null> {
  if (!(await pathExists(p))) {
    return null;
  }
  try {
    const buf = await readFile(p);
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
