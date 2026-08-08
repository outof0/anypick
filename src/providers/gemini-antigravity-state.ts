/**
 * Antigravity's authoritative OAuth state.
 *
 * The IDE mirrors its `uss-oauth` topic into VS Code's global state SQLite
 * database. Updating only the go-keyring item is not enough: a running IDE
 * keeps this topic in memory and later writes its old token back. We therefore
 * update both stores, but only while Antigravity is fully stopped.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { openForeignDatabase, type AnyPickDatabase } from '../core/db';
import { pathExists } from '../utils/fs';
import type { AntigravityKeyringPayload } from './gemini-antigravity-oauth';

const execFileAsync = promisify(execFile);
const STATE_STORAGE_KEY = 'antigravityUnifiedStateSync.oauthToken';
const TOKEN_SENTINEL_KEY = 'oauthTokenInfoSentinelKey';
const AUTH_STATE_SENTINEL_KEY = 'authStateWithContextSentinelKey';
const USER_STATUS_STORAGE_KEY = 'antigravityUnifiedStateSync.userStatus';
const USER_STATUS_SENTINEL_KEY = 'userStatusSentinelKey';
const LEGACY_AUTH_CACHE_KEYS = ['antigravityAuthStatus', 'antigravity.profileUrl'] as const;

interface ProtoVarintField {
  number: number;
  wireType: 0;
  value: bigint;
}

interface ProtoBytesField {
  number: number;
  wireType: 1 | 2 | 5;
  value: Buffer;
}

type ProtoField = ProtoVarintField | ProtoBytesField;

export interface AntigravityStateOptions {
  paths?: readonly string[];
  home?: string;
}

interface AntigravityStateMutationOptions extends AntigravityStateOptions {
  expectedPayload?: AntigravityKeyringPayload | null;
  isAppRunning?: () => Promise<boolean>;
}

/** Known Antigravity user-data locations, newest product name first. */
export function antigravityStateDatabasePaths(
  home?: string,
  platform = process.platform,
): string[] {
  const resolvedHome = home ?? homedir();
  const override = process.env.ANTIGRAVITY_USER_DATA_DIR?.trim();
  if (override) {
    return [join(override, 'User', 'globalStorage', 'state.vscdb')];
  }

  if (platform === 'darwin') {
    const support = join(resolvedHome, 'Library', 'Application Support');
    return [
      join(support, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      join(support, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    ];
  }
  if (platform === 'win32') {
    const appData =
      (home === undefined ? process.env.APPDATA?.trim() : undefined) ||
      join(resolvedHome, 'AppData', 'Roaming');
    return [
      join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    ];
  }
  const config =
    (home === undefined ? process.env.XDG_CONFIG_HOME?.trim() : undefined) ||
    join(resolvedHome, '.config');
  return [
    join(config, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
    join(config, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
  ];
}

async function existingStatePaths(opts: AntigravityStateOptions = {}): Promise<string[]> {
  const candidates = [...(opts.paths ?? antigravityStateDatabasePaths(opts.home))];
  const existing = (
    await Promise.all(candidates.map(async (path) => ((await pathExists(path)) ? path : undefined)))
  ).filter((path): path is string => path !== undefined);

  // Prefer the product the user touched most recently when reading live auth.
  const withTimes = await Promise.all(
    existing.map(async (path) => ({
      path,
      mtime: await stat(path)
        .then((entry) => entry.mtimeMs)
        .catch(() => 0),
    })),
  );
  return withTimes.toSorted((a, b) => b.mtime - a.mtime).map((entry) => entry.path);
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < buffer.length && index < offset + 10; index += 1) {
    const byte = BigInt(buffer[index]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      return { value, next: index + 1 };
    }
    shift += 7n;
  }
  throw new Error('Antigravity OAuth state contains an invalid protobuf varint.');
}

function encodeVarint(value: bigint): Buffer {
  if (value < 0n) {
    throw new Error('Antigravity OAuth state contains a negative protobuf varint.');
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(remaining === 0n ? byte : byte | 0x80);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

function parseProto(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);
    if (number <= 0) {
      throw new Error('Antigravity OAuth state contains an invalid protobuf field.');
    }

    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      fields.push({ number, wireType, value: value.value });
      offset = value.next;
      continue;
    }
    if (wireType === 1 || wireType === 5) {
      const length = wireType === 1 ? 8 : 4;
      if (offset + length > buffer.length) {
        throw new Error('Antigravity OAuth state contains a truncated protobuf field.');
      }
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
      continue;
    }
    if (wireType === 2) {
      const encodedLength = readVarint(buffer, offset);
      offset = encodedLength.next;
      const length = Number(encodedLength.value);
      if (!Number.isSafeInteger(length) || offset + length > buffer.length) {
        throw new Error('Antigravity OAuth state contains an invalid protobuf length.');
      }
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
      continue;
    }
    throw new Error(`Antigravity OAuth state uses unsupported protobuf wire type ${wireType}.`);
  }
  return fields;
}

function encodeProto(fields: readonly ProtoField[]): Buffer {
  return Buffer.concat(
    fields.flatMap((field) => {
      const tag = encodeVarint(BigInt((field.number << 3) | field.wireType));
      if (field.wireType === 0) {
        return [tag, encodeVarint(field.value)];
      }
      if (field.wireType === 2) {
        return [tag, encodeVarint(BigInt(field.value.length)), field.value];
      }
      return [tag, field.value];
    }),
  );
}

function replaceBytesField(
  fields: readonly ProtoField[],
  number: number,
  value: Buffer,
): ProtoField[] {
  let replaced = false;
  const next: ProtoField[] = [];
  for (const field of fields) {
    if (field.number !== number) {
      next.push(field);
      continue;
    }
    if (!replaced) {
      next.push({ number, wireType: 2, value });
      replaced = true;
    }
  }
  if (!replaced) {
    next.push({ number, wireType: 2, value });
  }
  return next;
}

function strictBase64(value: string, label: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Antigravity ${label} is not valid base64.`);
  }
  return Buffer.from(value, 'base64');
}

function firstBytesField(fields: readonly ProtoField[], number: number): Buffer | undefined {
  const field = fields.find(
    (candidate): candidate is ProtoBytesField =>
      candidate.number === number && candidate.wireType === 2,
  );
  return field?.value;
}

function decodeTimestamp(buffer: Buffer | undefined): string | undefined {
  if (!buffer) {
    return undefined;
  }
  const fields = parseProto(buffer);
  const seconds = fields.find(
    (field): field is ProtoVarintField => field.number === 1 && field.wireType === 0,
  )?.value;
  const nanos = fields.find(
    (field): field is ProtoVarintField => field.number === 2 && field.wireType === 0,
  )?.value;
  if (seconds === undefined) {
    return undefined;
  }
  const milliseconds = Number(seconds) * 1_000 + Number(nanos ?? 0n) / 1_000_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function encodeTimestamp(expiry: string | undefined): Buffer | undefined {
  if (!expiry) {
    return undefined;
  }
  const milliseconds = new Date(expiry).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error('Antigravity OAuth credential has an invalid expiry timestamp.');
  }
  const seconds = Math.floor(milliseconds / 1_000);
  const nanos = Math.floor((milliseconds - seconds * 1_000) * 1_000_000);
  const fields: ProtoField[] = [{ number: 1, wireType: 0, value: BigInt(seconds) }];
  if (nanos !== 0) {
    fields.push({ number: 2, wireType: 0, value: BigInt(nanos) });
  }
  return encodeProto(fields);
}

function decodeOAuthTokenInfo(encoded: string): AntigravityKeyringPayload | null {
  const fields = parseProto(strictBase64(encoded, 'OAuth token'));
  const refreshToken = firstBytesField(fields, 3)?.toString('utf8');
  if (!refreshToken) {
    return null;
  }
  const accessToken = firstBytesField(fields, 1)?.toString('utf8');
  const tokenType = firstBytesField(fields, 2)?.toString('utf8');
  const expiry = decodeTimestamp(firstBytesField(fields, 4));
  return {
    token: {
      ...(accessToken ? { access_token: accessToken } : {}),
      refresh_token: refreshToken,
      token_type: tokenType || 'Bearer',
      ...(expiry ? { expiry } : {}),
    },
  };
}

function encodeOAuthTokenInfo(payload: AntigravityKeyringPayload): string {
  const token = payload.token;
  if (!token?.refresh_token) {
    throw new Error('Refusing to write Antigravity state with no refresh token.');
  }
  const fields: ProtoField[] = [];
  if (token.access_token) {
    fields.push({ number: 1, wireType: 2, value: Buffer.from(token.access_token) });
  }
  fields.push({
    number: 2,
    wireType: 2,
    value: Buffer.from(token.token_type || 'Bearer'),
  });
  fields.push({ number: 3, wireType: 2, value: Buffer.from(token.refresh_token) });
  const expiry = encodeTimestamp(token.expiry);
  if (expiry) {
    fields.push({ number: 4, wireType: 2, value: expiry });
  }
  return encodeProto(fields).toString('base64');
}

function topicEntry(topic: Buffer, sentinelKey: string): { encoded: string; found: boolean } {
  for (const field of parseProto(topic)) {
    if (field.number !== 1 || field.wireType !== 2) {
      continue;
    }
    const entry = parseProto(field.value);
    if (firstBytesField(entry, 1)?.toString('utf8') !== sentinelKey) {
      continue;
    }
    const row = firstBytesField(entry, 2);
    const encoded = row ? firstBytesField(parseProto(row), 1)?.toString('utf8') : undefined;
    return { encoded: encoded ?? '', found: true };
  }
  return { encoded: '', found: false };
}

function rewriteTopicEntry(
  topic: Buffer,
  sentinelKey: string,
  encodedValue: string | null,
): Buffer {
  let found = false;
  const fields: ProtoField[] = [];
  for (const field of parseProto(topic)) {
    if (field.number !== 1 || field.wireType !== 2) {
      fields.push(field);
      continue;
    }
    const entry = parseProto(field.value);
    if (firstBytesField(entry, 1)?.toString('utf8') !== sentinelKey) {
      fields.push(field);
      continue;
    }
    found = true;
    if (encodedValue === null) {
      continue;
    }
    const row = firstBytesField(entry, 2);
    const rowFields = row ? parseProto(row) : [];
    const nextRow = encodeProto(replaceBytesField(rowFields, 1, Buffer.from(encodedValue)));
    fields.push({
      number: 1,
      wireType: 2,
      value: encodeProto(replaceBytesField(entry, 2, nextRow)),
    });
  }

  if (!found && encodedValue !== null) {
    const row = encodeProto([{ number: 1, wireType: 2, value: Buffer.from(encodedValue) }]);
    const entry = encodeProto([
      { number: 1, wireType: 2, value: Buffer.from(sentinelKey) },
      { number: 2, wireType: 2, value: row },
    ]);
    fields.push({ number: 1, wireType: 2, value: entry });
  }
  return encodeProto(fields);
}

function readTopic(db: AnyPickDatabase, storageKey = STATE_STORAGE_KEY): Buffer {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(storageKey) as
    | { value?: unknown }
    | undefined;
  if (row?.value === undefined || row.value === null || row.value === '') {
    return Buffer.alloc(0);
  }
  const encoded = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
  return strictBase64(encoded, 'unified state topic');
}

function writeTopic(db: AnyPickDatabase, topic: Buffer, storageKey = STATE_STORAGE_KEY): void {
  const encoded = topic.toString('base64');
  const updated = db
    .prepare('UPDATE ItemTable SET value = ? WHERE key = ?')
    .run(encoded, storageKey);
  if (Number(updated.changes) === 0) {
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(storageKey, encoded);
  }
}

/**
 * A new OAuth token must not inherit the previous account's cached profile or
 * auth state. Antigravity otherwise renders the old email and can skip token
 * validation even though the durable OAuth token was switched successfully.
 */
function clearAccountCaches(db: AnyPickDatabase, oauthTopic: Buffer): Buffer {
  const nextOAuthTopic = rewriteTopicEntry(oauthTopic, AUTH_STATE_SENTINEL_KEY, null);
  const userStatusTopic = readTopic(db, USER_STATUS_STORAGE_KEY);
  if (topicEntry(userStatusTopic, USER_STATUS_SENTINEL_KEY).found) {
    writeTopic(
      db,
      rewriteTopicEntry(userStatusTopic, USER_STATUS_SENTINEL_KEY, null),
      USER_STATUS_STORAGE_KEY,
    );
  }
  db.prepare('DELETE FROM ItemTable WHERE key = ? OR key = ?').run(...LEGACY_AUTH_CACHE_KEYS);
  return nextOAuthTopic;
}

function readPayloadFromPath(path: string): AntigravityKeyringPayload | null {
  const db = openForeignDatabase(path, true);
  try {
    const token = topicEntry(readTopic(db), TOKEN_SENTINEL_KEY);
    return token.found && token.encoded ? decodeOAuthTokenInfo(token.encoded) : null;
  } finally {
    db.close();
  }
}

/** Read the OAuth token Antigravity itself will use on its next startup. */
export async function readAntigravityStateOAuthPayload(
  opts: AntigravityStateOptions = {},
): Promise<AntigravityKeyringPayload | null> {
  let lastError: unknown;
  for (const path of await existingStatePaths(opts)) {
    try {
      const payload = readPayloadFromPath(path);
      if (payload) {
        return payload;
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

export async function antigravityStateCredentialExists(
  opts: AntigravityStateOptions = {},
): Promise<boolean> {
  return readAntigravityStateOAuthPayload(opts)
    .then((payload) => Boolean(payload?.token?.refresh_token))
    .catch(() => false);
}

export function antigravityProcessListHasApplication(
  stdout: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return /antigravity(?: ide)?\.exe/i.test(stdout);
  }
  if (platform === 'darwin') {
    return stdout.split(/\r?\n/gu).some((line) => {
      const executable = line.trim();
      const pathWithoutProductSpaces = executable.replaceAll('Antigravity IDE', 'Antigravity_IDE');
      return (
        executable === 'Antigravity' ||
        executable === 'Antigravity IDE' ||
        (!/\s/u.test(pathWithoutProductSpaces) &&
          /^\/.*\/Antigravity(?: IDE)?\.app\/Contents\/MacOS\/(?:Antigravity(?: IDE)?|Electron)$/u.test(
            executable,
          ))
      );
    });
  }
  return stdout
    .split(/\r?\n/gu)
    .some((line) => /^(?:.*\/)?antigravity(?:-ide)?$/iu.test(line.trim()));
}

export async function antigravityApplicationRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH']);
      return antigravityProcessListHasApplication(stdout, 'win32');
    }
    // `comm` contains only the executable identity. Searching the full command
    // line produced false positives when another process merely mentioned an
    // Antigravity.app path in one of its arguments.
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'comm='], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return antigravityProcessListHasApplication(stdout);
  } catch {
    // Process discovery is a guard, not the source of truth. SQLite will still
    // reject an unsafe concurrent write if the upstream store is locked.
    return false;
  }
}

/**
 * Refuse an external DB rewrite while the owner can overwrite it from memory.
 * Call before any Keychain mutation so a rejected switch remains mutation-free.
 */
export async function assertAntigravityStateSafeToMutate(
  opts: AntigravityStateMutationOptions = {},
): Promise<string[]> {
  const paths = await existingStatePaths(opts);
  const currentRefreshTokens: Array<string | null> = [];
  for (const path of paths) {
    const db = openForeignDatabase(path, true);
    try {
      // Validate the full envelope before another credential store is changed.
      const token = topicEntry(readTopic(db), TOKEN_SENTINEL_KEY);
      const payload = token.found && token.encoded ? decodeOAuthTokenInfo(token.encoded) : null;
      currentRefreshTokens.push(payload?.token?.refresh_token ?? null);
      topicEntry(readTopic(db, USER_STATUS_STORAGE_KEY), USER_STATUS_SENTINEL_KEY);
    } finally {
      db.close();
    }
  }
  if (paths.length > 0 && (await (opts.isAppRunning ?? antigravityApplicationRunning)())) {
    const expectedRefreshToken = opts.expectedPayload?.token?.refresh_token ?? null;
    const alreadyCurrent =
      opts.expectedPayload !== undefined &&
      currentRefreshTokens.every((refreshToken) => refreshToken === expectedRefreshToken);
    if (alreadyCurrent) {
      // The rollback/no-op path is safe while Antigravity runs: its in-memory
      // owner already holds this account, so there is no database rewrite to
      // race. Returning no paths makes the caller update only the keyring mirror.
      return [];
    }
    throw new Error(
      'Antigravity is running. Quit Antigravity completely, switch again, then reopen it.',
    );
  }
  return paths;
}

/** Update every installed Antigravity state store and verify the durable token. */
export async function writeAntigravityStateOAuthPayload(
  payload: AntigravityKeyringPayload,
  opts: AntigravityStateOptions = {},
): Promise<number> {
  const paths = await existingStatePaths(opts);
  const encodedToken = encodeOAuthTokenInfo(payload);
  for (const path of paths) {
    const db = openForeignDatabase(path);
    try {
      db.transaction(() => {
        const oauthTopic = clearAccountCaches(db, readTopic(db));
        writeTopic(db, rewriteTopicEntry(oauthTopic, TOKEN_SENTINEL_KEY, encodedToken));
      });
    } finally {
      db.close();
    }
    const verified = readPayloadFromPath(path);
    if (verified?.token?.refresh_token !== payload.token?.refresh_token) {
      throw new Error(`Antigravity OAuth state verification failed for ${path}.`);
    }
  }
  return paths.length;
}

/** Remove only the OAuth entry, preserving every unrelated unified-state key. */
export async function deleteAntigravityStateOAuthPayload(
  opts: AntigravityStateOptions = {},
): Promise<number> {
  const paths = await existingStatePaths(opts);
  let changed = 0;
  for (const path of paths) {
    const db = openForeignDatabase(path);
    try {
      db.transaction(() => {
        const topic = readTopic(db);
        const hadToken = topicEntry(topic, TOKEN_SENTINEL_KEY).found;
        const nextTopic = clearAccountCaches(db, topic);
        if (hadToken) {
          writeTopic(db, rewriteTopicEntry(nextTopic, TOKEN_SENTINEL_KEY, null));
          changed += 1;
        }
      });
    } finally {
      db.close();
    }
  }
  return changed;
}
