/**
 * Google Gemini CLI
 *
 * Live auth under ~/.gemini/:
 *   .env                 — GEMINI_API_KEY / GOOGLE_CLOUD_* (API key + Vertex)
 *   oauth_creds.json     — Login with Google OAuth tokens (when on disk)
 *   google_accounts.json — active email + history
 *   settings.json        — security.auth.selectedType (merged, not fully replaced)
 *
 * Built-in dual-protocol proxy (API key accounts):
 *   OpenAI  (/v1/responses)         → Codex
 *   Anthropic (/v1/messages)        → Claude Code
 * Translates to Google Generative Language API (generateContent).
 *
 * Notes:
 * - Personal OAuth may also live in the OS keychain; we snapshot file-based
 *   material only. API-key accounts via .env drive the proxy most reliably.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  Account,
  AccountMeta,
  LiveAuthStatus,
  Provider,
  ProxyContext,
  ProxyHubBackendContext,
  ProxyHubBackendHandle,
  ProxyHandle,
  ProxyStatus,
  SourceAdapter,
} from '../types';
import { geminiAccountAdapter, poolAdapterFor } from '../sources/account-adapters';
import {
  copyFileSafe,
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
  writeTextFile,
} from '../utils/fs';
import { AnyPickError } from '../utils/errors';
import { readGeminiApiKeyFromEnvFile, stripEnvAuthKeys } from './gemini-env';
import { readIdentityFromDir } from './gemini-identity';
import {
  loadAntigravityOAuthCredentials,
  readAntigravityOAuthPayload,
  hydrateAntigravityOAuthPayload,
  saveAntigravityOAuthCredential,
  deleteAntigravityOAuthCredential,
  antigravityCredentialExists,
  antigravityKeychainSupported,
  type AntigravityKeyringPayload,
} from './gemini-antigravity-oauth';
import {
  antigravityApplicationRunning,
  assertAntigravityStateSafeToMutate,
  readAntigravityStateOAuthPayload,
} from './gemini-antigravity-state';
import { rolesFromLiveDiscovery } from './model-policy';
import {
  startGeminiProxy,
  stopGeminiProxy,
  geminiProxyStatus,
  readGeminiProxyLogs,
} from './gemini-proxy-lifecycle';
import { listenGeminiProxy } from './gemini-proxy/server';
import { closeProxyHubBackend } from './proxy-hub-backend';

const SNAPSHOT_FILES = ['.env', 'oauth_creds.json', 'google_accounts.json'] as const;
const ANTIGRAVITY_SNAPSHOT_FILE = 'antigravity_oauth.json';
const DEFAULT_PORT = 4130;

/**
 * Identify a Gemini CLI login by its long-lived credential material.
 *
 * The refresh token, not the access token: the access token rotates hourly and
 * both the CLI and the proxy rewrite the file in place.
 */
async function geminiAuthFingerprint(dir: string): Promise<string | null> {
  const parts: string[] = [];

  const oauthPath = join(dir, 'oauth_creds.json');
  if (await pathExists(oauthPath)) {
    try {
      const creds = await readJsonFile<{ refresh_token?: unknown }>(oauthPath);
      if (typeof creds.refresh_token === 'string' && creds.refresh_token.trim()) {
        parts.push(`rt:${createHash('sha256').update(creds.refresh_token.trim()).digest('hex')}`);
      }
    } catch {
      // Unreadable credential is no credential.
    }
  }

  const key = await readGeminiApiKeyFromEnvFile(join(dir, '.env')).catch(() => undefined);
  if (key) {
    parts.push(`key:${createHash('sha256').update(key).digest('hex')}`);
  }

  return parts.length > 0 ? parts.sort().join('|') : null;
}

/**
 * Antigravity exposes no email, so identify a login by its durable grant.
 * Keep the refresh token itself out of account metadata and UI output.
 */
function antigravityIdentity(payload: AntigravityKeyringPayload | null): string | undefined {
  const refreshToken = payload?.token?.refresh_token?.trim();
  return refreshToken
    ? `antigravity:${createHash('sha256').update(refreshToken).digest('hex').slice(0, 12)}`
    : undefined;
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  readonly name = 'Gemini CLI';
  readonly shortName = 'Gemini';
  /** Gemini CLI vs Antigravity — TUI offers a source picker before mode. */
  readonly requiresAccountSourcePick = true;
  readonly description = 'Manages ~/.gemini auth + OpenAI/Anthropic→Gemini proxy (Codex + Claude)';
  readonly defaultProxyPort = DEFAULT_PORT;
  readonly proxyCompatibility = 'OpenAI + Anthropic → Gemini API';
  /** The Gemini proxy cannot be driven from an OAuth-only snapshot. */
  readonly proxyRequiresApiKey = true;

  async proxyApiKeyStatus(snapshotDir: string): Promise<{ present: boolean; hint?: string }> {
    try {
      const key = await readGeminiApiKeyFromEnvFile(join(snapshotDir, '.env'));
      if (key) {
        return { present: true };
      }
      return {
        present: false,
        hint: 'Needs GEMINI_API_KEY in .env — OAuth-only cannot run this proxy',
      };
    } catch {
      return { present: false, hint: 'Could not read Gemini API key for this login' };
    }
  }

  // Model rollout differs between API-key and Code Assist OAuth accounts, so
  // roles are resolved from the proxy's live model list.
  roleDefaults(): Record<string, string> {
    return rolesFromLiveDiscovery();
  }

  /** Gemini names cheap models "flash"/"lite" and strong models "pro". */
  roleModelHints(): Record<string, readonly string[]> {
    return {
      default: ['pro'],
      opus: ['pro'],
      sonnet: ['flash', 'lite'],
      haiku: ['flash', 'lite'],
    };
  }

  constructor(
    private readonly home = homedir(),
    private readonly saveAntigravityCredential: (
      payload: AntigravityKeyringPayload,
    ) => Promise<void> = saveAntigravityOAuthCredential,
    private readonly hydrateAntigravityCredential: (
      payload: AntigravityKeyringPayload,
    ) => Promise<AntigravityKeyringPayload> = hydrateAntigravityOAuthPayload,
    private readonly deleteAntigravityCredential: () => Promise<boolean> = deleteAntigravityOAuthCredential,
    private readonly readAntigravityStateCredential: () => Promise<AntigravityKeyringPayload | null> = readAntigravityStateOAuthPayload,
  ) {}

  sourceAdapter(account: Account): SourceAdapter {
    return geminiAccountAdapter(account);
  }

  poolSourceAdapter(): SourceAdapter {
    return poolAdapterFor(this.id, this);
  }

  async createProxyHubBackend(ctx: ProxyHubBackendContext): Promise<ProxyHubBackendHandle> {
    const [primary, ...rest] = ctx.accounts;
    if (!primary) {
      throw new Error('Gemini Hub backend requires at least one account');
    }
    const options = primary.proxy.options ?? {};
    const oauthSource =
      options.oauthSource === 'gemini-cli' ||
      options.oauthSource === 'antigravity' ||
      options.oauthSource === 'auto'
        ? options.oauthSource
        : 'auto';
    const { server, endpoint } = await listenGeminiProxy({
      host: '127.0.0.1',
      port: 0,
      authDir: primary.snapshotDir,
      authDirs: rest.map((account) => account.snapshotDir),
      authAccountNames: ctx.accounts.map((account) => account.name),
      oauthSource,
      antigravityOAuthFile:
        typeof options.antigravityOAuthFile === 'string' ? options.antigravityOAuthFile : undefined,
      upstream: typeof options.upstream === 'string' ? options.upstream : undefined,
      codeAssistUpstream:
        typeof options.codeAssistUpstream === 'string' ? options.codeAssistUpstream : undefined,
      token: ctx.token,
      log: ctx.log,
    });
    return { endpoint, close: () => closeProxyHubBackend(server) };
  }

  private get geminiDir(): string {
    return process.env.GEMINI_CONFIG_DIR ?? join(this.home, '.gemini');
  }

  private livePath(name: string): string {
    return join(this.geminiDir, name);
  }

  /** True when ~/.gemini holds credential material the CLI backup can snapshot. */
  private async hasGeminiCliAuth(): Promise<boolean> {
    return (
      (await this.hasApiKeyMaterial()) || (await pathExists(this.livePath('oauth_creds.json')))
    );
  }

  /**
   * Which source a source-less operation acts on.
   *
   * Gemini CLI files win whenever they exist, so restoring a CLI account always
   * takes precedence over a lingering Antigravity keychain entry. Antigravity
   * only surfaces when there is no CLI login at all — otherwise a user signed in
   * through Antigravity alone would look signed out everywhere.
   */
  private async resolveAutoSource(): Promise<'gemini-cli' | 'antigravity' | null> {
    if (await this.hasGeminiCliAuth()) {
      return 'gemini-cli';
    }
    return (await antigravityCredentialExists()) ? 'antigravity' : null;
  }

  async detectLive(): Promise<LiveAuthStatus> {
    const cli = await this.detectGeminiCliLive();
    if (cli.present) {
      return cli;
    }
    // Existence-only probe: reads no secret, so no Keychain prompt.
    if (!(await antigravityCredentialExists())) {
      return { present: false };
    }
    // Unified state is a local SQLite database, so it is safe to fingerprint
    // during routine detection. Never fall back to reading the Keychain here.
    const payload = await this.readAntigravityStateCredential().catch(() => null);
    return {
      present: true,
      identity: antigravityIdentity(payload),
      details: 'antigravity oauth',
    };
  }

  private async detectGeminiCliLive(): Promise<LiveAuthStatus> {
    const hasEnv = await this.hasApiKeyMaterial();
    const hasOauth = await pathExists(this.livePath('oauth_creds.json'));
    if (!hasEnv && !hasOauth) {
      return { present: false };
    }

    const identity = await this.readIdentity();
    const details: string[] = [];
    if (hasOauth) {
      details.push('oauth');
    }
    if (hasEnv) {
      details.push('api-key');
    }
    const authType = await this.readSelectedAuthType();
    if (authType) {
      details.push(authType);
    }

    return {
      present: true,
      identity,
      details: details.join(', '),
    };
  }

  /**
   * Explicit Antigravity liveness check. Reads the macOS Keychain (or a portable
   * file), so it MUST NOT be folded into detectLive() — that runs on every home
   * refresh and would trigger repeated Keychain permission prompts. Only call it
   * when the user explicitly chose the Antigravity source.
   */
  async detectAntigravityLive(credentialFile?: string): Promise<LiveAuthStatus> {
    if (!credentialFile && !antigravityKeychainSupported()) {
      throw new AnyPickError(
        `Antigravity accounts are not supported on ${process.platform} yet.`,
        'NO_LIVE_AUTH',
      );
    }
    try {
      const creds = await loadAntigravityOAuthCredentials(credentialFile);
      if (!creds) {
        return { present: false };
      }
      const identity = creds.refresh_token
        ? antigravityIdentity({ token: { refresh_token: creds.refresh_token } })
        : undefined;
      return { present: true, identity, details: 'antigravity oauth' };
    } catch {
      return { present: false };
    }
  }

  /**
   * Snapshot the Antigravity credential into the account dir.
   *
   * The whole credential-store payload is written, not the reduced
   * {refresh_token, token_type} the proxy needs: restoring this account has to
   * put the credential back into the store, and a token stripped of its access
   * token and expiry is not the one that was saved. The proxy is unaffected —
   * parseAntigravityOAuthCredential accepts this nested shape too.
   */
  async backupAntigravity(
    destDir: string,
    credentialFile?: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    if (!credentialFile && !antigravityKeychainSupported()) {
      throw new AnyPickError(
        `Antigravity accounts are not supported on ${process.platform} yet.`,
        'NO_LIVE_AUTH',
      );
    }
    const payload = await readAntigravityOAuthPayload(credentialFile);
    if (!payload) {
      throw new AnyPickError(
        'No Antigravity OAuth credential found. Sign in with Antigravity first.',
        'NO_LIVE_AUTH',
      );
    }
    await ensureDir(destDir);
    await writeJsonFile(join(destDir, ANTIGRAVITY_SNAPSHOT_FILE), payload, 0o600);
    return { identity: antigravityIdentity(payload), notes: 'Antigravity login' };
  }

  async detectLiveSource(source: string): Promise<LiveAuthStatus> {
    // Pinned to one source: `gemini-cli` must not fall through to Antigravity,
    // or the source picker would report a login the chosen source cannot use.
    return source === 'antigravity' ? this.detectAntigravityLive() : this.detectGeminiCliLive();
  }

  async backupSource(
    source: string,
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    return source === 'antigravity' ? this.backupAntigravity(destDir) : this.backup(destDir);
  }

  async clearLiveSource(source: string): Promise<void> {
    return source === 'antigravity' ? this.clearAntigravityLive() : this.clearLive();
  }

  /**
   * Drop the Antigravity credential from the OS credential store so Antigravity
   * asks for a new sign-in. The ~/.gemini CLI files belong to the other source
   * and are deliberately left alone.
   */
  async clearAntigravityLive(): Promise<void> {
    if (!antigravityKeychainSupported()) {
      throw new AnyPickError(
        `Antigravity accounts are not supported on ${process.platform} yet.`,
        'NO_LIVE_AUTH',
      );
    }
    await deleteAntigravityOAuthCredential();
  }

  async backup(
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    // Must agree with detectLive(): callers that snapshot whatever it reported
    // live (checkpointLiveAuth, save, stash) would otherwise fail outright for
    // an Antigravity-only login.
    if ((await this.resolveAutoSource()) === 'antigravity') {
      return this.backupAntigravity(destDir);
    }
    await ensureDir(destDir);
    let copied = 0;

    for (const file of SNAPSHOT_FILES) {
      const ok = await copyFileSafe(this.livePath(file), join(destDir, file));
      if (ok) {
        copied += 1;
      }
    }

    // Auth-related settings slice only (do not clobber MCP/hooks on restore)
    const authSettings = await this.readAuthSettingsSlice();
    if (authSettings) {
      await writeJsonFile(join(destDir, 'auth-settings.json'), authSettings, 0o600);
      copied += 1;
    }

    if (copied === 0) {
      throw new AnyPickError(
        'No Gemini CLI auth found under ~/.gemini (.env, oauth_creds.json, or google_accounts.json).',
        'NO_LIVE_AUTH',
      );
    }

    // Require at least one credential-bearing file
    const hasCred =
      (await pathExists(join(destDir, '.env'))) ||
      (await pathExists(join(destDir, 'oauth_creds.json')));
    if (!hasCred) {
      throw new AnyPickError(
        'Gemini google_accounts.json alone is not enough — need .env (API key) or oauth_creds.json.',
        'NO_LIVE_AUTH',
      );
    }

    const identity = (await readIdentityFromDir(destDir)) ?? (await this.readIdentity());
    return {
      identity,
      notes: hasCred ? undefined : 'Partial Gemini snapshot',
    };
  }

  async restore(srcDir: string): Promise<void> {
    await ensureDir(this.geminiDir);
    let restored = 0;

    for (const file of SNAPSHOT_FILES) {
      const src = join(srcDir, file);
      if (await pathExists(src)) {
        await copyFileSafe(src, this.livePath(file));
        restored += 1;
      } else {
        // Clear every credential file not present in the snapshot so accounts
        // do not mix. Previously only .env and oauth_creds.json were removed;
        // google_accounts.json had the same stale-state risk when restoring an
        // Antigravity-only snapshot — the ghost identity confused
        // snapshotMatchesLive into fingerprint-matching the wrong account.
        await rm(this.livePath(file), { force: true }).catch(() => {});
      }
    }

    const authSlicePath = join(srcDir, 'auth-settings.json');
    if (await pathExists(authSlicePath)) {
      try {
        const slice = await readJsonFile<Record<string, unknown>>(authSlicePath);
        await this.mergeAuthSettings(slice);
        restored += 1;
      } catch {
        // ignore corrupt slice
      }
    }

    // An Antigravity credential has no home under ~/.gemini: it lives in the OS
    // credential store. AnyPick's own proxy reads it straight from the snapshot
    // dir, but Antigravity itself only ever reads the store — so without this
    // write a switch changes nothing the user can see.
    const antigravitySnapshot = join(srcDir, ANTIGRAVITY_SNAPSHOT_FILE);
    if (await pathExists(antigravitySnapshot)) {
      await this.restoreAntigravity(antigravitySnapshot);
      restored += 1;
    } else if (antigravityKeychainSupported()) {
      // Restoring a Gemini CLI account: clear the Antigravity credential so
      // Antigravity itself follows the switch rather than retaining a stale
      // login from the previous account. Best-effort — a missing or
      // inaccessible entry is the desired end state either way (ADR 0004).
      await this.deleteAntigravityCredential().catch(() => {});
    }

    if (restored === 0) {
      throw new AnyPickError(`No Gemini auth files in snapshot: ${srcDir}`, 'SNAPSHOT_INVALID');
    }
  }

  /**
   * Refuse an Antigravity switch before AccountService checkpoints or mutates
   * anything. Without this early guard, the late SQLite rejection caused core
   * to attempt a rollback that the same running app also rejected.
   */
  async preflightRestore(srcDir: string): Promise<void> {
    const snapshotFile = join(srcDir, ANTIGRAVITY_SNAPSHOT_FILE);
    if (!(await pathExists(snapshotFile))) {
      return;
    }
    const payload = await readAntigravityOAuthPayload(snapshotFile);
    if (!payload) {
      throw new AnyPickError(
        'Saved Antigravity credential has no refresh token and cannot be restored.',
        'ANTIGRAVITY_RESTORE_FAILED',
      );
    }
    try {
      await assertAntigravityStateSafeToMutate({ expectedPayload: payload });
    } catch (err) {
      if (err instanceof Error && /Antigravity is running/i.test(err.message)) {
        throw new AnyPickError('Antigravity is still open.', {
          code: 'RESTORE_OWNER_RUNNING',
          suggestions: ['Quit Antigravity completely, return to AnyPick, then press Enter again.'],
        });
      }
      throw err;
    }
  }

  async restoreOwnerStatus(srcDir: string): Promise<{ name: string; running: boolean } | null> {
    if (!(await pathExists(join(srcDir, ANTIGRAVITY_SNAPSHOT_FILE)))) {
      return null;
    }
    return {
      name: 'Antigravity',
      running: await antigravityApplicationRunning(),
    };
  }

  async accountSource(srcDir: string): Promise<{ id: string; name: string }> {
    return (await pathExists(join(srcDir, ANTIGRAVITY_SNAPSHOT_FILE)))
      ? { id: 'antigravity', name: 'Antigravity' }
      : { id: 'gemini-cli', name: 'Gemini CLI' };
  }

  async liveAccountSource(live: LiveAuthStatus): Promise<{ id: string; name: string }> {
    return live.details?.toLowerCase().includes('antigravity')
      ? { id: 'antigravity', name: 'Antigravity' }
      : { id: 'gemini-cli', name: 'Gemini CLI' };
  }

  /** Push a snapshotted Antigravity credential back into the OS credential store. */
  private async restoreAntigravity(snapshotFile: string): Promise<void> {
    if (!antigravityKeychainSupported()) {
      throw new AnyPickError(
        `Writing the Antigravity OAuth credential is not supported on ${process.platform}.`,
        'ANTIGRAVITY_RESTORE_FAILED',
      );
    }
    const payload = await readAntigravityOAuthPayload(snapshotFile);
    if (!payload) {
      throw new AnyPickError(
        'Saved Antigravity credential has no refresh token and cannot be restored.',
        'ANTIGRAVITY_RESTORE_FAILED',
      );
    }
    // Do not hide this error. AccountService rolls the live checkpoint and
    // active pointer back when restore rejects; pretending success leaves the
    // UI pointing at an account Antigravity never received.
    await this.saveAntigravityCredential(await this.hydrateAntigravityCredential(payload));
  }

  /**
   * Clear local Gemini CLI auth files so the user can sign in as someone else.
   * Does not revoke OAuth server-side or remove OS keychain entries.
   */
  async clearLive(): Promise<void> {
    if ((await this.resolveAutoSource()) === 'antigravity') {
      await this.clearAntigravityLive();
      return;
    }
    for (const file of ['oauth_creds.json', 'google_accounts.json'] as const) {
      await rm(this.livePath(file), { force: true }).catch(() => {});
    }

    // Strip known auth keys from .env; remove file if empty
    const envPath = this.livePath('.env');
    if (await pathExists(envPath)) {
      const next = await stripEnvAuthKeys(envPath);
      if (next.trim()) {
        await writeTextFile(envPath, next.endsWith('\n') ? next : `${next}\n`, 0o600);
      } else {
        await rm(envPath, { force: true }).catch(() => {});
      }
    }

    // Clear selected auth type in settings (keep the rest of user config)
    try {
      const settingsPath = this.livePath('settings.json');
      if (await pathExists(settingsPath)) {
        const doc = await readJsonFile<Record<string, unknown>>(settingsPath);
        const security =
          doc.security && typeof doc.security === 'object'
            ? { ...(doc.security as Record<string, unknown>) }
            : {};
        if (security.auth && typeof security.auth === 'object') {
          const auth = { ...(security.auth as Record<string, unknown>) };
          delete auth.selectedType;
          if (Object.keys(auth).length === 0) {
            delete security.auth;
          } else {
            security.auth = auth;
          }
        }
        if (Object.keys(security).length === 0) {
          delete doc.security;
        } else {
          doc.security = security;
        }
        await writeJsonFile(settingsPath, doc, 0o600);
      }
    } catch {
      // best-effort
    }
  }

  // ── Built-in proxy (API key → Codex + Claude) ───────────────────

  async startProxy(ctx: ProxyContext): Promise<ProxyHandle> {
    return startGeminiProxy(ctx, {
      liveDir: this.geminiDir,
      compatibility: this.proxyCompatibility,
      defaultPort: DEFAULT_PORT,
    });
  }

  async stopProxy(ctx: ProxyContext): Promise<void> {
    await stopGeminiProxy(ctx);
  }

  async proxyStatus(ctx: ProxyContext): Promise<ProxyStatus> {
    return geminiProxyStatus(ctx, this.proxyCompatibility, DEFAULT_PORT);
  }

  async readProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
    return readGeminiProxyLogs(ctx, lines);
  }

  /**
   * Gemini keeps no `auth.json`, so the shared default could never find a live
   * file to compare and reported every saved account as not-live.
   *
   * Only credential material is compared, and only its durable part: the CLI
   * rewrites `oauth_creds.json` on every access-token refresh, so hashing the
   * whole file would mark the live account "changed" within the hour.
   */
  async snapshotMatchesLive(snapshotDir: string): Promise<boolean> {
    if (await pathExists(join(snapshotDir, ANTIGRAVITY_SNAPSHOT_FILE))) {
      // Compare against the local unified-state token rather than Keychain.
      // This avoids permission prompts on every list refresh while still
      // preventing an identity-less active pointer from choosing a snapshot.
      const snapshot = await readAntigravityOAuthPayload(
        join(snapshotDir, ANTIGRAVITY_SNAPSHOT_FILE),
      );
      const live = await this.readAntigravityStateCredential().catch(() => null);
      const snapshotIdentity = antigravityIdentity(snapshot);
      const liveIdentity = antigravityIdentity(live);
      if (!snapshotIdentity || !liveIdentity) {
        throw new AnyPickError(
          'The current Antigravity login cannot be fingerprinted from unified state.',
          'NOT_DETERMINABLE',
        );
      }
      return snapshotIdentity === liveIdentity;
    }
    const snap = await geminiAuthFingerprint(snapshotDir);
    if (!snap) {
      return false;
    }
    return snap === (await geminiAuthFingerprint(this.geminiDir));
  }

  private async hasApiKeyMaterial(): Promise<boolean> {
    if (process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()) {
      // Env may be set outside ~/.gemini — still counts as live for detect
      // but backup prefers on-disk .env
    }
    const envPath = this.livePath('.env');
    if (!(await pathExists(envPath))) {
      return Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
    }
    try {
      const raw = await readFile(envPath, 'utf8');
      return /^(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)=/m.test(
        raw,
      );
    } catch {
      return false;
    }
  }

  private async readIdentity(): Promise<string | undefined> {
    return readIdentityFromDir(this.geminiDir);
  }

  private async readSelectedAuthType(): Promise<string | undefined> {
    try {
      const settingsPath = this.livePath('settings.json');
      if (!(await pathExists(settingsPath))) {
        return undefined;
      }
      const doc = await readJsonFile<Record<string, unknown>>(settingsPath);
      const security = doc.security as Record<string, unknown> | undefined;
      const auth = security?.auth as Record<string, unknown> | undefined;
      return typeof auth?.selectedType === 'string' ? auth.selectedType : undefined;
    } catch {
      return undefined;
    }
  }

  private async readAuthSettingsSlice(): Promise<Record<string, unknown> | null> {
    try {
      const settingsPath = this.livePath('settings.json');
      if (!(await pathExists(settingsPath))) {
        return null;
      }
      const doc = await readJsonFile<Record<string, unknown>>(settingsPath);
      const security = doc.security as Record<string, unknown> | undefined;
      if (!security || typeof security !== 'object') {
        return null;
      }
      return { security: { ...security } };
    } catch {
      return null;
    }
  }

  private async mergeAuthSettings(slice: Record<string, unknown>): Promise<void> {
    const settingsPath = this.livePath('settings.json');
    let doc: Record<string, unknown> = {};
    if (await pathExists(settingsPath)) {
      try {
        doc = await readJsonFile<Record<string, unknown>>(settingsPath);
      } catch {
        doc = {};
      }
    }
    if (slice.security && typeof slice.security === 'object') {
      const existing =
        doc.security && typeof doc.security === 'object'
          ? (doc.security as Record<string, unknown>)
          : {};
      doc.security = {
        ...existing,
        ...(slice.security as Record<string, unknown>),
      };
    }
    await writeJsonFile(settingsPath, doc, 0o600);
  }
}

export { readGeminiApiKeyFromEnvFile, upsertEnvFile } from './gemini-env';

export const geminiProvider = new GeminiProvider();
