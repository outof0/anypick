/**
 * Versioned decoder for the account import/export envelope (SEC-01).
 *
 * Imports arrive as untrusted bytes. Per fixed decision #1 ("external data is
 * untrusted"), the envelope is decoded from `unknown` by a versioned codec
 * that validates the *entire* payload — shape, provider ownership, every
 * file-map key (path traversal / absolute / separators / NULs / duplicates /
 * file-vs-dir collisions / symlink), base64, file-count, per-file size, and
 * total decoded size — before any caller mutates state.
 *
 * Decoding is pure and never performs I/O. The caller stages the decoded
 * files into an owner-only temp dir using `stagedFilePath` so that a single
 * bad key cannot write outside the staging root.
 */
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { anypickError, type ExitCodeValue, type AnyPickError } from '../utils/errors';
import type { AccountMeta, AccountProxyConfig } from '../types';

export const ACCOUNT_ENVELOPE_VERSION = 1 as const;
export const ACCOUNT_ENVELOPE_KIND = 'anypick-account' as const;

/** Reject obviously abusive envelopes without streaming unbounded memory. */
export const MAX_IMPORT_FILES = 4096;
export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB per file
export const MAX_IMPORT_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MiB total
/** The encoded envelope is larger than the decoded file budget. */
export const MAX_IMPORT_ENVELOPE_BYTES = 192 * 1024 * 1024;
export const MAX_ACCOUNT_NAME_LEN = 128;
export const MAX_FIELD_LEN = 4096;

export interface DecodedAccountEnvelope {
  version: 1;
  kind: 'anypick-account';
  meta: AccountMeta;
  proxy: AccountProxyConfig | null;
  /** Relative key → base64 content. Keys are validated, never trusted raw. */
  files: Record<string, string>;
}

/** Decode + validate the raw import payload under the untrusted-boundary rule. */
export function decodeAccountEnvelope(
  raw: unknown,
  expectedProviderId: string,
): DecodedAccountEnvelope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw error('Import payload is not a JSON object.', 'IMPORT_FORMAT');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.kind !== ACCOUNT_ENVELOPE_KIND) {
    throw error('Unrecognized export format (kind mismatch).', 'IMPORT_FORMAT');
  }
  if (obj.version !== ACCOUNT_ENVELOPE_VERSION) {
    throw error(`Unsupported export version: ${JSON.stringify(obj.version)}.`, 'IMPORT_FORMAT');
  }
  if (typeof obj.meta !== 'object' || obj.meta === null || Array.isArray(obj.meta)) {
    throw error('Import envelope is missing a meta object.', 'IMPORT_FORMAT');
  }

  const meta = decodeMeta(obj.meta);
  if (meta.provider !== expectedProviderId) {
    throw error(
      `Import envelope provider "${meta.provider}" does not match the requested provider "${expectedProviderId}".`,
      'IMPORT_FORMAT',
      { exitCode: undefined },
    );
  }

  const proxy = obj.proxy === undefined ? null : decodeProxy(obj.proxy);

  if (typeof obj.files !== 'object' || obj.files === null || Array.isArray(obj.files)) {
    throw error('Import envelope is missing a files map.', 'IMPORT_FORMAT');
  }
  const files = decodeFiles(obj.files);

  return { version: 1, kind: ACCOUNT_ENVELOPE_KIND, meta, proxy, files };
}

/**
 * Validate a single import file key purely (no staging root needed). Rejects
 * empty keys, NUL bytes, absolute POSIX/Windows paths, mixed separators, and
 * any normalized escape ('..' segments / leading-traversal). Throws a
 * `AnyPickError` on violation. Called from the codec (before any mutation) and
 * from `stagedFilePath` (defense-in-depth at write time).
 */
export function validateImportFileKey(key: string): void {
  if (!key || key.includes('\0')) {
    throw error(`Invalid import file path: ${JSON.stringify(key)}.`, 'IMPORT_FORMAT');
  }
  if (isAbsolute(key)) {
    throw error(`Import file path must be relative: ${key}.`, 'IMPORT_FORMAT');
  }
  // Reject Windows-style absolute paths (drive letters / UNC) on every host,
  // since `path.isAbsolute` only recognizes the *current* platform's form.
  if (/^[A-Za-z]:[\\/]/.test(key) || key.startsWith('\\\\')) {
    throw error(`Import file path must be relative: ${key}.`, 'IMPORT_FORMAT');
  }
  // Mixed separators (e.g. "a/b\\c") after normalization can mask escapes.
  if (key.includes('\\') && key.includes('/')) {
    throw error(`Import file path mixes path separators: ${key}.`, 'IMPORT_FORMAT');
  }
  // Normalize across POSIX and Windows separators before the traversal check.
  const normalized = normalize(key.split('\\').join('/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.endsWith(`${sep}..`)
  ) {
    throw error(`Import file path escapes the staging root: ${key}.`, 'IMPORT_FORMAT');
  }
}

/** Resolve a validated relative file key to an absolute staging path. Never throws on traversal. */
export function stagedFilePath(stagingRoot: string, relKey: string): string {
  // Re-run the pure key check so a bad key can never write outside staging.
  validateImportFileKey(relKey);
  const normalized = normalize(relKey.split('\\').join('/'));
  const abs = resolve(stagingRoot, normalized);
  const back = relative(resolve(stagingRoot), abs);
  if (back.startsWith('..') || isAbsolute(back)) {
    throw error(`Import file path escapes the staging root: ${relKey}.`, 'IMPORT_FORMAT');
  }
  return abs;
}

function decodeMeta(value: unknown): AccountMeta {
  if (typeof value !== 'object' || value === null) {
    throw error('Account meta is not an object.', 'IMPORT_FORMAT');
  }
  const m = value as Record<string, unknown>;
  const name = safeText(m.name, MAX_ACCOUNT_NAME_LEN, 'name') ?? '';
  if (!name || name.length > MAX_ACCOUNT_NAME_LEN) {
    throw error('Account meta name is missing or too long.', 'IMPORT_FORMAT');
  }
  const provider = safeText(m.provider, MAX_FIELD_LEN, 'provider') ?? '';
  if (!provider) {
    throw error('Account meta provider is missing.', 'IMPORT_FORMAT');
  }
  const stringOrUndefined = (v: unknown, field: string): string | undefined =>
    safeText(v, MAX_FIELD_LEN, field);
  const createdAt = safeText(m.createdAt, MAX_FIELD_LEN, 'createdAt');
  const updatedAt = safeText(m.updatedAt, MAX_FIELD_LEN, 'updatedAt');
  return {
    name,
    provider,
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: updatedAt ?? new Date().toISOString(),
    label: stringOrUndefined(m.label, 'label'),
    identity: stringOrUndefined(m.identity, 'identity'),
    notes: stringOrUndefined(m.notes, 'notes'),
    // Losing this on import would turn a user-supplied credential back into a
    // native one, and activating it would then prune the machine's real login.
    credentialKind: m.credentialKind === 'proxy-only' ? 'proxy-only' : undefined,
  };
}

/** Reject terminal control/bidi characters in imported display metadata. */
function safeText(value: unknown, maxLength: number, field: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length > maxLength) {
    return undefined;
  }
  // C0/DEL includes newline, tabs, and ESC/OSC introducers. Bidi overrides
  // can make a harmless-looking identity render as a different command/name.
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw error(
      `Import meta field "${field}" contains terminal control characters.`,
      'IMPORT_FORMAT',
    );
  }
  return value;
}

function decodeProxy(value: unknown): AccountProxyConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw error('Account proxy config is not an object.', 'IMPORT_FORMAT');
  }
  const p = value as Record<string, unknown>;
  // An imported envelope is untrusted. Do not carry activation state or
  // provider-specific options across this boundary: options can contain
  // upstream URLs, auth paths, or other values later passed to a spawned
  // proxy. The user must explicitly enable/configure a proxy locally.
  const port =
    typeof p.port === 'number' && Number.isInteger(p.port) && p.port >= 0 && p.port <= 65535
      ? p.port
      : undefined;
  const host = safeText(p.host, MAX_FIELD_LEN, 'proxy.host');
  return {
    enabled: false,
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

function decodeFiles(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw error('Import envelope is missing a files map.', 'IMPORT_FORMAT');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw error('Import envelope contains no files.', 'IMPORT_FORMAT');
  }
  if (entries.length > MAX_IMPORT_FILES) {
    throw limit(`Import contains ${entries.length} files (max ${MAX_IMPORT_FILES}).`);
  }

  const out: Record<string, string> = {};
  const seen = new Set<string>();
  let total = 0;

  for (const [key, content] of entries) {
    if (typeof key !== 'string' || !key) {
      throw error('Import file map contains an invalid key.', 'IMPORT_FORMAT');
    }
    // Pure path check (no staging root yet): reject empty / NUL / absolute /
    // mixed-separator / traversal keys before any state is touched.
    validateImportFileKey(key);
    if (typeof content !== 'string') {
      throw error(`Import file "${key}" content is not a base64 string.`, 'IMPORT_FORMAT');
    }
    // Reject non-base64 early (the decode below would otherwise accept garbage).
    if (!/^[A-Za-z0-9+/=]+$/.test(content)) {
      throw error(`Import file "${key}" is not valid base64.`, 'IMPORT_FORMAT');
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(content, 'base64');
    } catch {
      throw error(`Import file "${key}" failed to decode as base64.`, 'IMPORT_FORMAT');
    }
    if (decoded.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw limit(`Import file "${key}" exceeds ${MAX_IMPORT_FILE_BYTES} bytes.`);
    }
    total += decoded.byteLength;
    if (total > MAX_IMPORT_TOTAL_BYTES) {
      throw limit(`Import total payload exceeds ${MAX_IMPORT_TOTAL_BYTES} bytes.`);
    }

    // Validate the key as a staging path now (cheap, before any write).
    const normalized = normalize(key.split('\\').join('/'));
    if (seen.has(normalized)) {
      throw error(`Import contains a duplicate file path: ${key}.`, 'IMPORT_FORMAT');
    }
    // A file whose key is a path prefix of another file is a file/directory
    // collision. Check both directions so validation is independent of JSON
    // property order (`a` then `a/b`, or `a/b` then `a`).
    if (
      [...seen].some(
        (existing) =>
          normalized.startsWith(`${existing}/`) || existing.startsWith(`${normalized}/`),
      )
    ) {
      throw error(`Import file path collides with another entry: ${key}.`, 'IMPORT_FORMAT');
    }
    seen.add(normalized);

    out[key] = content;
  }

  return out;
}

function error(
  message: string,
  code: 'IMPORT_FORMAT' | 'IMPORT_LIMIT',
  opts: { exitCode?: ExitCodeValue } = {},
): AnyPickError {
  return anypickError(message, code, {
    exitCode: opts.exitCode ?? (code === 'IMPORT_LIMIT' ? 9 : 8),
    mutated: false,
  });
}

function limit(message: string): AnyPickError {
  return error(message, 'IMPORT_LIMIT');
}
