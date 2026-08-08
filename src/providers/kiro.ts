import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Account,
  AccountMeta,
  CredentialInput,
  CredentialInputField,
  LiveAuthStatus,
  Provider,
  ProxyContext,
  ProxyHandle,
  ProxyStatus,
  SnapshotMeta,
  SourceAdapter,
} from '../types';
import { kiroAccountAdapter, poolAdapterFor } from '../sources/account-adapters';
import {
  copyFileSafe,
  ensureDir,
  pathExists,
  readJsonFile,
  removePath,
  restoreRequiredFile,
  writeJsonFile,
} from '../utils/fs';
import { HotplugError } from '../utils/errors';
import {
  clearKiroSecrets,
  kiroSecretIdentity,
  readKiroSecrets,
  writeKiroSecrets,
  type KiroSecrets,
} from './kiro-secret-store';
import {
  readExternalProxyLogs,
  startExternalProxy,
  statusExternalProxy,
  stopExternalProxy,
} from './proxy-process';
import { snapshotMatchesLiveByFiles } from './auth-fingerprint';
import { rolesFromLiveDiscovery } from './model-policy';

/**
 * AWS Kiro (CLI + IDE social/Builder ID session tokens)
 *
 * A Kiro login has two possible homes and a machine can hold both:
 *   - kiro-cli 2.x keeps it in a secret store (see `kiro-secret-store.ts`)
 *   - the Kiro IDE and older kiro-cli write ~/.aws/sso/cache/*.json
 *
 * The IDE's filenames are SHA-1 hashes of the SSO session, not the two names
 * kiro-cli used, so files are recognised by *shape* rather than by name — that
 * also skips the client-registration files sitting in the same directory, which
 * carry a clientId but no token.
 *
 * Compatibility proxy: `kirolink` (Anthropic + OpenAI → Kiro API).
 */

/** Snapshot member holding the secret store; never a token file itself. */
const SECRETS_FILE = 'kiro-secret-store.json';

/**
 * Snapshot member holding a user-supplied Kiro API key. Its presence is what
 * makes the account `proxy-only`: nothing on this machine reads it, only the
 * proxy this account starts.
 */
const API_KEY_FILE = 'kiro-api-key.json';

type ApiKeySnapshot = { kiroApiKey: string; apiRegion?: string };

/** Mirrors kirolink's own floor for `KIROLINK_KIRO_API_KEY`. */
const MIN_API_KEY_BYTES = 16;

/**
 * Kiro runtime regions kirolink knows about, mirroring its own setup wizard.
 * The region selects the data-plane host (`runtime.<region>.kiro.dev`), so a
 * wrong one starts fine and then fails every request — offer the list rather
 * than a text box.
 */
const API_REGIONS = ['us-east-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'] as const;

const DEFAULT_PORT = 4119;

type TokenFile = { name: string; path: string; expiresAt: number };

/**
 * True for an SSO cache entry that carries a credential.
 *
 * Deliberately just "has an access token": that is already enough to exclude
 * the client-registration files sharing the directory, which hold a clientId
 * and an expiry but never a token. Demanding more — a profileArn, a parseable
 * expiry — would risk rejecting a real Kiro IDE token whose shape differs, and
 * failing to see a login is the bug this scan exists to fix.
 */
function looksLikeToken(data: Record<string, unknown>): boolean {
  const accessToken = data.accessToken ?? data.access_token;
  return typeof accessToken === 'string' && accessToken.length > 0;
}

export class KiroProvider implements Provider {
  readonly id = 'kiro';
  readonly name = 'AWS Kiro';
  readonly shortName = 'Kiro';
  readonly description =
    'Manages the kiro-cli secret store and ~/.aws/sso/cache (+ optional kirolink proxy)';
  readonly defaultProxyPort = DEFAULT_PORT;
  readonly proxyCompatibility = 'Anthropic + OpenAI API';

  roleDefaults(): Record<string, string> {
    return rolesFromLiveDiscovery();
  }

  roleFriendlyModels(): readonly string[] {
    return [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5',
      'claude-sonnet',
      'claude-opus',
      'claude-haiku',
    ];
  }

  constructor(private readonly home = homedir()) {}

  sourceAdapter(account: Account): SourceAdapter {
    return kiroAccountAdapter(account);
  }

  poolSourceAdapter(): SourceAdapter {
    // Kiro is served by the external `kirolink` bridge, not the builtin proxy.
    return poolAdapterFor(this.id, this, { proxyTransport: 'managed_external_proxy' });
  }

  private get cacheDir(): string {
    return process.env.KIRO_SSO_CACHE_DIR ?? join(this.home, '.aws', 'sso', 'cache');
  }

  private livePath(file: string): string {
    return join(this.cacheDir, file);
  }

  /** Cache entries that carry a credential, freshest first. */
  private async liveTokenFiles(): Promise<TokenFile[]> {
    const { readdir } = await import('node:fs/promises');
    let entries: string[];
    try {
      entries = await readdir(this.cacheDir);
    } catch {
      return [];
    }

    const found: TokenFile[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const path = this.livePath(name);
      try {
        const data = await readJsonFile<Record<string, unknown>>(path);
        if (!looksLikeToken(data)) {
          continue;
        }
        const raw = data.expiresAt ?? data.expires_at;
        const at = typeof raw === 'string' ? new Date(raw).getTime() : Number.NaN;
        found.push({ name, path, expiresAt: Number.isFinite(at) ? at : 0 });
      } catch {
        // Unreadable or not JSON: not a credential.
      }
    }
    return found.sort((a, b) => b.expiresAt - a.expiresAt);
  }

  /** Token files a snapshot carries, by their original cache-dir names. */
  private async snapshotTokenFiles(srcDir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    try {
      return (await readdir(srcDir)).filter(
        (name) => name !== SECRETS_FILE && name !== API_KEY_FILE,
      );
    } catch {
      return [];
    }
  }

  async detectLive(): Promise<LiveAuthStatus> {
    const [secrets, files] = await Promise.all([readKiroSecrets(this.home), this.liveTokenFiles()]);

    const where: string[] = [];
    if (Object.keys(secrets).length > 0) {
      where.push('kiro-cli secret store');
    }
    where.push(...files.map((file) => file.name));

    if (where.length === 0) {
      return { present: false };
    }

    const identity =
      kiroSecretIdentity(secrets) ?? (await identityFrom(files.map((file) => file.path)));

    return { present: true, identity, details: where.join(', ') };
  }

  async snapshotMatchesLive(snapshotDir: string): Promise<boolean> {
    // An API key is never on disk as a Kiro login, and its snapshot carries no
    // token files — which the file comparison below would read as a vacuous
    // match, marking every api-key account live.
    if (await readApiKeyFile(join(snapshotDir, API_KEY_FILE))) {
      return false;
    }

    const snapshotSecrets = await readSecretsFile(join(snapshotDir, SECRETS_FILE));
    if (snapshotSecrets) {
      // The secret store is what kiro-cli actually reads, so when a snapshot has
      // one it decides the answer on its own — a leftover cache file from an
      // older login must not make a live account look stale, or the reverse.
      return sameSecrets(snapshotSecrets, await readKiroSecrets(this.home));
    }

    const names = await this.snapshotTokenFiles(snapshotDir);
    return snapshotMatchesLiveByFiles(
      names.map((name) => ({
        name,
        livePath: this.livePath(name),
        snapshotPath: join(snapshotDir, name),
      })),
    );
  }

  readonly credentialInputs = ['api-key'] as const;

  credentialInputFields(kind: string): readonly CredentialInputField[] {
    if (kind !== 'api-key') {
      return [];
    }
    return [{ name: 'region', label: 'API region', choices: API_REGIONS, default: API_REGIONS[0] }];
  }

  /**
   * Save a Kiro API key (`ksk_…`) as an account. There is no live login to read
   * and nothing to restore later: the key only ever reaches the Kiro runtime
   * through `kirolink`, which this account's proxy starts in `api-key` mode.
   */
  async backupInput(input: CredentialInput, destDir: string): Promise<SnapshotMeta> {
    if (input.kind !== 'api-key') {
      throw new HotplugError(
        `AWS Kiro does not accept a ${input.kind} credential.`,
        'UNSUPPORTED_CREDENTIAL_INPUT',
      );
    }
    const kiroApiKey = input.secret.trim();
    if (!kiroApiKey) {
      throw new HotplugError('The Kiro API key is empty.', 'INVALID_CREDENTIAL');
    }
    // kirolink refuses a shorter key, and it refuses it at proxy start — which
    // is long after the point where the user could still see what they typed.
    if (Buffer.byteLength(kiroApiKey) < MIN_API_KEY_BYTES) {
      throw new HotplugError(
        `That Kiro API key is too short to be valid (needs at least ${MIN_API_KEY_BYTES} characters).`,
        {
          code: 'INVALID_CREDENTIAL',
          suggestions: ['Copy the whole key, including its ksk_ prefix.'],
        },
      );
    }

    const apiRegion = input.options?.region?.trim() || undefined;
    // The region becomes a hostname (`runtime.<region>.kiro.dev`), so a shape
    // kirolink would refuse has to fail here. At proxy start it is a line in a
    // log file nobody is watching.
    if (apiRegion && !/^[a-z0-9-]+$/u.test(apiRegion)) {
      throw new HotplugError(`"${apiRegion}" is not a valid Kiro API region.`, {
        code: 'INVALID_CREDENTIAL',
        suggestions: [`Known regions: ${API_REGIONS.join(', ')}.`],
      });
    }
    await ensureDir(destDir);
    const snapshot: ApiKeySnapshot = { kiroApiKey, apiRegion };
    await writeJsonFile(join(destDir, API_KEY_FILE), snapshot);

    return { identity: apiKeyIdentity(kiroApiKey), credentialKind: 'proxy-only' };
  }

  async backup(
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    await ensureDir(destDir);
    const [secrets, files] = await Promise.all([readKiroSecrets(this.home), this.liveTokenFiles()]);

    let saved = 0;
    if (Object.keys(secrets).length > 0) {
      await writeJsonFile(join(destDir, SECRETS_FILE), secrets);
      saved += 1;
    }

    const copied: string[] = [];
    for (const file of files) {
      if (await copyFileSafe(file.path, join(destDir, file.name))) {
        saved += 1;
        copied.push(join(destDir, file.name));
      }
    }

    const identity = kiroSecretIdentity(secrets) ?? (await identityFrom(copied));

    if (saved === 0) {
      throw new HotplugError(
        `No Kiro login found in the kiro-cli secret store or ${this.cacheDir}. Run kiro-cli login first.`,
        'NO_LIVE_AUTH',
      );
    }

    return { identity };
  }

  async restore(srcDir: string): Promise<void> {
    // Core already skips restore for a proxy-only account; this also holds for
    // any other caller, because writing an empty secret store and pruning the
    // cache would wipe a real login to activate a key that never lived there.
    if (await readApiKeyFile(join(srcDir, API_KEY_FILE))) {
      return;
    }

    const secrets = await readSecretsFile(join(srcDir, SECRETS_FILE));
    const names = await this.snapshotTokenFiles(srcDir);
    if (!secrets && names.length === 0) {
      throw new HotplugError(`Kiro snapshot has no credentials in ${srcDir}`, 'EMPTY_SNAPSHOT');
    }

    // Another account's cache file left in place would still be picked up — the
    // proxy chooses by expiry, not by name — so the switch has to remove what it
    // is not restoring rather than just overwriting.
    for (const file of await this.liveTokenFiles()) {
      if (!names.includes(file.name)) {
        await removePath(file.path);
      }
    }

    await ensureDir(this.cacheDir);
    for (const name of names) {
      await restoreRequiredFile(join(srcDir, name), this.livePath(name), name);
    }

    await writeKiroSecrets(secrets ?? {}, this.home);
  }

  async describeSnapshot(
    srcDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const apiKey = await readApiKeyFile(join(srcDir, API_KEY_FILE));
    if (apiKey) {
      return { identity: apiKeyIdentity(apiKey.kiroApiKey) };
    }

    const secrets = await readSecretsFile(join(srcDir, SECRETS_FILE));
    const names = await this.snapshotTokenFiles(srcDir);
    const identity =
      (secrets ? kiroSecretIdentity(secrets) : undefined) ??
      (await identityFrom(names.map((name) => join(srcDir, name))));
    return identity ? { identity } : {};
  }

  /**
   * Remove the local Kiro login only — does NOT call AWS/Kiro logout.
   */
  async clearLive(): Promise<void> {
    for (const file of await this.liveTokenFiles()) {
      await removePath(file.path);
    }
    await clearKiroSecrets(this.home);
  }

  // ── Proxy (kirolink) ────────────────────────────────────────────

  async startProxy(ctx: ProxyContext): Promise<ProxyHandle> {
    // Force kirolink onto the credential this binding activated. Left to its own
    // saved config it may run in a mode against an unrelated Kiro credential, so
    // the proxy would serve a different identity than the account the user
    // bound — silently, since it still starts and answers /health. These are
    // environment overrides, which kirolink applies for the run without writing
    // them back, so a bare `kirolink` outside Hotplug keeps the user's own mode.
    const apiKey = await readApiKeyFile(join(ctx.snapshotDir, API_KEY_FILE));
    const authMode: Record<string, string> = apiKey
      ? {
          KIROLINK_AUTH: 'api-key',
          KIROLINK_KIRO_API_KEY: apiKey.kiroApiKey,
          ...(apiKey.apiRegion ? { KIROLINK_API_REGION: apiKey.apiRegion } : {}),
        }
      : { KIROLINK_AUTH: 'cli' };

    const tokenPath = apiKey ? undefined : await this.resolveTokenPath();

    // Discovery is PATH-based only (spec §19.5): no hardcoded platform-specific
    // paths, so this works unchanged on macOS, Linux, and Windows.
    //   - KIROLINK_BIN  : explicit binary override (e.g. full path or alias)
    //   - KIROLINK_JS   : run a JS entry via `node` (no shebang exec needed)
    const jsEntry = process.env.KIROLINK_JS;
    const useNodeEntry = jsEntry != null && (await pathExists(jsEntry));

    if (useNodeEntry) {
      return startExternalProxy(ctx, {
        label: 'Kiro',
        binaries: ['node'],
        defaultPort: DEFAULT_PORT,
        compatibility: this.proxyCompatibility,
        buildArgs: (_c, port, host) => [jsEntry, '-p', String(port), '--host', host],
        env: () => ({
          ...process.env,
          ...authMode,
          ...(tokenPath ? { KIRO_PROXY_TOKEN_PATH: tokenPath } : {}),
        }),
        readyTimeoutMs: 5000,
      });
    }

    return startExternalProxy(ctx, {
      label: 'Kiro',
      binaries: process.env.KIROLINK_BIN ? [process.env.KIROLINK_BIN] : ['kirolink', 'kiro-proxy'],
      defaultPort: DEFAULT_PORT,
      compatibility: this.proxyCompatibility,
      buildArgs: (_c, port, host) => ['-p', String(port), '--host', host],
      env: () => ({
        ...process.env,
        ...authMode,
        ...(tokenPath ? { KIRO_PROXY_TOKEN_PATH: tokenPath } : {}),
      }),
      readyTimeoutMs: 5000,
    });
  }

  async stopProxy(ctx: ProxyContext): Promise<void> {
    await stopExternalProxy(ctx);
  }

  async proxyStatus(ctx: ProxyContext): Promise<ProxyStatus> {
    const status = await statusExternalProxy(ctx, {
      compatibility: this.proxyCompatibility,
    });
    // Fill endpoint from defaults when running but port was defaulted
    if (status.running && !status.endpoint) {
      const host = ctx.config.host ?? '127.0.0.1';
      const port = ctx.config.port ?? DEFAULT_PORT;
      status.endpoint = `http://${host}:${port}`;
    }
    return status;
  }

  async readProxyLogs(ctx: ProxyContext, lines?: number): Promise<string> {
    return readExternalProxyLogs(ctx, lines);
  }

  /**
   * Pin the proxy to a cache file only when the secret store is empty. A pin is
   * an override that stops kirolink searching, so pinning while kiro-cli holds
   * the real login would force the proxy onto a stale file.
   */
  private async resolveTokenPath(): Promise<string | undefined> {
    if (Object.keys(await readKiroSecrets(this.home)).length > 0) {
      return undefined;
    }
    const [freshest] = await this.liveTokenFiles();
    return freshest?.path;
  }
}

async function readApiKeyFile(path: string): Promise<ApiKeySnapshot | null> {
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    const data = await readJsonFile<Record<string, unknown>>(path);
    if (typeof data.kiroApiKey !== 'string' || !data.kiroApiKey) {
      return null;
    }
    return {
      kiroApiKey: data.kiroApiKey,
      apiRegion: typeof data.apiRegion === 'string' ? data.apiRegion : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * A stable name for an API key that does not disclose it. A key carries no
 * email, and the raw value must not become an account identity — identities are
 * printed, exported, and stored in meta.
 */
function apiKeyIdentity(kiroApiKey: string): string {
  return `api-key:${createHash('sha256').update(kiroApiKey).digest('hex').slice(0, 12)}`;
}

async function readSecretsFile(path: string): Promise<KiroSecrets | null> {
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    const data = await readJsonFile<Record<string, unknown>>(path);
    const secrets: KiroSecrets = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        secrets[key] = value;
      }
    }
    return secrets;
  } catch {
    return null;
  }
}

function sameSecrets(a: KiroSecrets, b: KiroSecrets): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * A name for the account a token file belongs to, or undefined when the file
 * carries nothing identifying.
 *
 * The placeholder for "a token with no identity in it" is applied by
 * `identityFrom` rather than here: cache filenames are content hashes, so the
 * scan order is arbitrary, and returning the placeholder early would let it win
 * over a real identity sitting in the next file.
 */
async function tryIdentity(path: string): Promise<string | undefined> {
  try {
    const data = await readJsonFile<Record<string, unknown>>(path);
    for (const key of ['email', 'username', 'startUrl', 'clientId', 'provider']) {
      if (typeof data[key] === 'string' && data[key]) {
        return data[key];
      }
    }
    const arn = data.profileArn ?? data.profile_arn;
    if (typeof arn === 'string') {
      return arn.split('/').pop() ?? undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** The best identity across some token files, falling back to a placeholder. */
async function identityFrom(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const identity = await tryIdentity(path);
    if (identity) {
      return identity;
    }
  }
  return paths.length > 0 ? 'session-token' : undefined;
}

export const kiroProvider = new KiroProvider();
