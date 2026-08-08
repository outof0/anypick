/**
 * Account export/import envelope I/O.
 *
 * Kept out of AccountService so the service stays focused on live-auth and
 * snapshot lifecycle; transfer is a separate boundary with its own SEC-01
 * validation (ADR 0002).
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountMeta, Provider } from '../types';
import { DEFAULT_PROXY_CONFIG } from '../types';
import { AnyPickError } from '../utils/errors';
import { pathExists } from '../utils/fs';
import { normalizeAccountName } from '../utils/slug';
import { decodeAccountEnvelope, MAX_IMPORT_ENVELOPE_BYTES, stagedFilePath } from './account-codec';
import type { AccountStore } from './store';

export async function collectSnapshotFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const buf = await readFile(full);
        out[rel] = buf.toString('base64');
      }
    }
  }
  if (await pathExists(root)) {
    await walk(root);
  }
  return out;
}

export async function writeSnapshotFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, b64] of Object.entries(files)) {
    // Defense-in-depth: re-resolve each key against the staging root so a
    // malformed key can never write outside `root` (SEC-01).
    const dest = stagedFilePath(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(b64, 'base64'), { mode: 0o600 });
  }
}

/** Serialize a saved account to a portable, owner-only JSON envelope. */
export async function exportAccountEnvelope(
  store: AccountStore,
  providerId: string,
  name: string,
  outPath: string,
): Promise<void> {
  const account = await store.requireAccount(providerId, normalizeAccountName(name));
  const files = await collectSnapshotFiles(account.snapshotDir);
  const payload = {
    version: 1 as const,
    kind: 'anypick-account' as const,
    meta: account.meta,
    proxy: account.proxy,
    files,
  };

  // SEC-01: write to an owner-only temp file, then atomically rename.
  // Tighten the final mode even when overwriting an existing (permissive) file.
  const stage = await mkdtemp(join(tmpdir(), 'anypick-export-'));
  const tmpPath = join(stage, 'account.json');
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmpPath, outPath);
    await chmod(outPath, 0o600).catch(() => {});
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  // Warn: the artifact carries live credentials.
  process.stderr.write(
    `Warning: exported account "${account.meta.name}" contains credentials. Store ${outPath} safely.\n`,
  );
}

export interface ImportAccountDeps {
  store: AccountStore;
  provider: Provider;
  /**
   * Resolve the final account name after identity collision checks. Owned by
   * AccountService because it also runs on save paths.
   */
  resolveIdentityTarget: (
    providerId: string,
    identity: string | undefined,
    accountName: string,
    force: boolean,
  ) => Promise<string>;
}

/** Decode, validate, and stage an account envelope under the provider. */
export async function importAccountEnvelope(
  deps: ImportAccountDeps,
  providerId: string,
  name: string,
  inPath: string,
  opts: { force?: boolean } = {},
): Promise<AccountMeta> {
  let accountName = normalizeAccountName(name);
  if (!(await pathExists(inPath))) {
    throw new AnyPickError(`Import file not found: ${inPath}`, 'IMPORT_MISSING');
  }

  let existing = await deps.store.getAccount(providerId, accountName);
  if (existing && !opts.force) {
    throw new AnyPickError(
      `Account "${accountName}" already exists. Use --force to overwrite.`,
      'ACCOUNT_EXISTS',
    );
  }

  // SEC-01: reject an oversized file before read/JSON.parse, then decode +
  // validate the *entire* envelope (provider ownership,
  // every file path, base64, size/count limits) BEFORE any mutation. A
  // rejection below leaves the DB, current snapshot, active account, and
  // live auth completely unchanged.
  try {
    const size = (await stat(inPath)).size;
    if (size > MAX_IMPORT_ENVELOPE_BYTES) {
      throw new AnyPickError(`Import file exceeds ${MAX_IMPORT_ENVELOPE_BYTES} bytes.`, {
        code: 'IMPORT_LIMIT',
        mutated: false,
        exitCode: 9,
      });
    }
  } catch (err) {
    if (err instanceof AnyPickError) {
      throw err;
    }
    throw new AnyPickError(`Unable to inspect import file: ${inPath}`, {
      code: 'IMPORT_MISSING',
      mutated: false,
    });
  }
  const raw = await readFile(inPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnyPickError('Import file is not valid JSON.', 'IMPORT_FORMAT');
  }
  const envelope = decodeAccountEnvelope(parsed, providerId);

  let identity = envelope.meta.identity;
  let label = envelope.meta.label;
  if (deps.provider.describeSnapshot) {
    // Inspect a disposable copy first. prepareSnapshot() can replace an
    // existing snapshot, so identity conflicts must be found before it.
    const inspectDir = await mkdtemp(join(tmpdir(), 'anypick-import-inspect-'));
    try {
      await writeSnapshotFiles(inspectDir, envelope.files);
      const described = await deps.provider.describeSnapshot(inspectDir);
      identity = described.identity ?? identity;
      label = described.label ?? label;
    } finally {
      await rm(inspectDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  accountName = await deps.resolveIdentityTarget(
    providerId,
    identity,
    accountName,
    opts.force === true,
  );
  existing = await deps.store.getAccount(providerId, accountName);

  // Stage into the live snapshot dir only after full validation and identity
  // conflict checks.
  const { snapshotDir } = await deps.store.prepareSnapshot(providerId, accountName);
  await writeSnapshotFiles(snapshotDir, envelope.files);

  const now = new Date().toISOString();
  const meta: AccountMeta = {
    name: accountName,
    provider: providerId,
    createdAt: existing?.meta.createdAt ?? envelope.meta.createdAt ?? now,
    updatedAt: now,
    label,
    identity,
    notes: envelope.meta.notes,
    credentialKind: envelope.meta.credentialKind,
  };
  await deps.store.writeMeta(meta);

  // Imported proxies are always disabled and provider-specific options are
  // intentionally dropped by the codec. Starting a proxy is an explicit
  // local action, never something an imported file can trigger.
  if (envelope.proxy) {
    await deps.store.setProxyConfig(providerId, accountName, {
      ...DEFAULT_PROXY_CONFIG,
      ...envelope.proxy,
      enabled: false,
      options: undefined,
    });
  }

  return meta;
}
