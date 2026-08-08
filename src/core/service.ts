import type {
  Account,
  AccountMeta,
  CredentialInput,
  LiveAuthStatus,
  LiveUsage,
  Provider,
} from '../types';
import { DEFAULT_PROXY_CONFIG } from '../types';
import { HotplugError, isHotplugError } from '../utils/errors';
import { displayLabelFromName, normalizeAccountName } from '../utils/slug';
import { pathExists } from '../utils/fs';
import type { ProviderRegistry } from './registry';
import type { AccountStore } from './store';
import { ProxyService } from './proxy-service';
import { providerCanProxy } from './capabilities';
import { withMutationLocks } from './mutation-lock';
import { providerScope } from './refs';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  chmod,
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeAccountEnvelope, MAX_IMPORT_ENVELOPE_BYTES, stagedFilePath } from './account-codec';

export interface ListedAccount {
  name: string;
  provider: string;
  identity?: string;
  label?: string;
  active: boolean;
  updatedAt: string;
  createdAt: string;
  proxyEnabled: boolean;
  proxyRunning: boolean;
  /** True when this snapshot's material matches the current live login. */
  isLiveMatch: boolean;
  /** False when comparing this provider's live credential would require a secret prompt. */
  liveMatchKnown: boolean;
}

export interface SwitchResult {
  provider: string;
  providerName: string;
  from: string | null;
  to: string;
  /** Whether the previous live auth was re-saved into the prior active account. */
  refreshedPrevious: boolean;
  /** Saved account whose snapshot received the latest live auth before switching. */
  refreshedAccount?: string;
  /** Proxy outcome for the newly active account (if any). */
  proxy?: {
    enabled: boolean;
    running: boolean;
    endpoint?: string;
    compatibility?: string;
    error?: string;
  };
}

/** Exact local-auth checkpoint used to compensate a failed/scoped switch. */
export interface LiveAuthCheckpoint {
  providerId: string;
  activeAccount: string | null;
  hadLiveAuth: boolean;
  directory: string;
}

/**
 * High-level account operations: save, switch, stash, refresh, delete,
 * and account metadata listing. Proxy lifecycle, pools, and port allocation
 * live in the injected `ProxyService` (exposed as `app.proxy`); this service
 * delegates to it for the proxy side effects of switch/stash/delete.
 *
 * CLI commands call this for account CRUD, and `app.proxy` for proxy control.
 */
export class AccountService {
  /** Proxy lifecycle collaborator (start/stop/pool/port). */
  readonly proxy: ProxyService;

  /**
   * `proxy` stays optional for callers that only need account CRUD (several
   * tests, and any embedder that never starts a proxy). When omitted a private
   * one is built here — deliberately without a lease store, because a service
   * that was never handed the app's lease table must not record leases into a
   * table nobody reaps.
   */
  constructor(
    private readonly store: AccountStore,
    private readonly registry: ProviderRegistry,
    proxy?: ProxyService,
  ) {
    this.proxy = proxy ?? new ProxyService(store, registry);
  }

  provider(id: string): Provider {
    return this.registry.get(id);
  }

  listProviders(): Provider[] {
    return this.registry.list();
  }

  /** Currently active (live) account name for a provider, if any. */
  async getActive(providerId: string): Promise<string | null> {
    return this.store.getActive(providerId);
  }

  /** Load a saved account or return null if missing. */
  async get(providerId: string, name: string): Promise<Account | null> {
    return this.store.getAccount(providerId, normalizeAccountName(name));
  }

  /** Saved local name for an upstream identity, if one is already known. */
  async findNameByIdentity(providerId: string, identity: string): Promise<string | null> {
    return this.findAccountNameByIdentity(providerId, identity);
  }

  /**
   * Capture the real local login before a switch. The checkpoint is private to
   * the current operation and must be cleaned by `discardLiveAuthCheckpoint`.
   */
  async checkpointLiveAuth(
    providerId: string,
    opts: { durable?: boolean } = {},
  ): Promise<LiveAuthCheckpoint> {
    const provider = this.registry.get(providerId);
    const checkpointRoot = opts.durable ? join(this.store.root, 'recovery', 'live-auth') : tmpdir();
    await mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(checkpointRoot, 'hotplug-live-checkpoint-'));
    try {
      const activeAccount = await this.store.getActive(providerId);
      const live = await provider.detectLive();
      if (live.present) {
        await provider.backup(directory);
      }
      return { providerId, activeAccount, hadLiveAuth: live.present, directory };
    } catch (err) {
      await rm(directory, { recursive: true, force: true });
      throw err;
    }
  }

  /** Restore a checkpoint, including the provider active pointer. */
  async restoreLiveAuthCheckpoint(checkpoint: LiveAuthCheckpoint): Promise<void> {
    const provider = this.registry.get(checkpoint.providerId);
    if (checkpoint.hadLiveAuth) {
      await provider.restore(checkpoint.directory);
    } else if (provider.clearLive) {
      await provider.clearLive();
    } else {
      throw new HotplugError(
        `Cannot restore an empty ${provider.name} login state safely.`,
        'SWITCH_ROLLBACK_UNAVAILABLE',
      );
    }
    if (checkpoint.activeAccount) {
      await this.store.setActive(checkpoint.providerId, checkpoint.activeAccount);
    } else {
      await this.store.clearActive(checkpoint.providerId);
    }
  }

  async discardLiveAuthCheckpoint(checkpoint: LiveAuthCheckpoint): Promise<void> {
    await rm(checkpoint.directory, { recursive: true, force: true });
  }

  async list(providerId?: string): Promise<ListedAccount[]> {
    const providers = providerId ? [this.registry.get(providerId)] : this.registry.list();

    const out: ListedAccount[] = [];
    for (const p of providers) {
      const active = await this.store.getActive(p.id);
      const accounts = await this.store.listAccounts(p.id);
      const live = await p.detectLive();
      const materialMatches = await Promise.all(
        accounts.map((account) => computeLiveMatch(p, account, live)),
      );
      const matchedNames = accounts
        .filter((_, index) => materialMatches[index] === true)
        .map((account) => account.meta.name);
      let liveAccountName =
        (active && matchedNames.includes(active) ? active : matchedNames[0]) ?? null;

      // A refreshed token can change the session fingerprint while keeping the
      // same upstream identity. Fall back once, choosing the active record when
      // possible, so duplicate snapshots never all render as live.
      const liveIdentity = live.identity;
      if (!liveAccountName && liveIdentity) {
        const identityMatches = accounts
          .filter(
            (account) =>
              account.meta.credentialKind !== 'proxy-only' &&
              account.meta.identity &&
              identitiesMatch(account.meta.identity, liveIdentity),
          )
          .map((account) => account.meta.name);
        liveAccountName =
          (active && identityMatches.includes(active) ? active : identityMatches[0]) ?? null;
      }
      // Some credential stores cannot be read during a background refresh without
      // prompting. The active pointer is authoritative immediately after Hotplug
      // restored that login, so present it as live until a provider can prove drift.
      if (!liveAccountName && active && live.present) {
        const activeIndex = accounts.findIndex((account) => account.meta.name === active);
        if (activeIndex >= 0 && materialMatches[activeIndex] === null) {
          liveAccountName = active;
        }
      }

      for (const [index, a] of accounts.entries()) {
        const proxyStatus =
          providerCanProxy(p) && a.proxy.enabled
            ? await this.proxy.proxyStatus(p.id, a.meta.name)
            : null;
        out.push({
          name: a.meta.name,
          provider: p.id,
          identity: a.meta.identity,
          label: a.meta.label,
          active: active === a.meta.name,
          updatedAt: a.meta.updatedAt,
          createdAt: a.meta.createdAt,
          proxyEnabled: a.proxy.enabled,
          proxyRunning: proxyStatus?.running ?? false,
          isLiveMatch: liveAccountName === a.meta.name,
          liveMatchKnown: materialMatches[index] !== null,
        });
      }
    }
    return out;
  }

  async current(providerId: string): Promise<{
    active: string | null;
    live: LiveAuthStatus;
    account: Account | null;
    proxy: import('../types').ProxyStatus | null;
    isLiveMatch: boolean;
    liveMatchKnown: boolean;
  }> {
    const provider = this.registry.get(providerId);
    const active = await this.store.getActive(providerId);
    const live = await provider.detectLive();
    const account = active ? await this.store.getAccount(providerId, active) : null;
    const proxy =
      providerCanProxy(provider) && account
        ? await this.proxy.proxyStatus(providerId, account.meta.name)
        : null;
    const liveMatch = account ? await computeLiveMatch(provider, account, live) : null;
    let isLiveMatch = liveMatch === true || (liveMatch === null && active !== null && live.present);
    if (
      !isLiveMatch &&
      account?.meta.credentialKind !== 'proxy-only' &&
      account?.meta.identity &&
      live.identity &&
      identitiesMatch(account.meta.identity, live.identity)
    ) {
      isLiveMatch = true;
    }
    return { active, live, account, proxy, isLiveMatch, liveMatchKnown: liveMatch !== null };
  }

  /** Best-effort usage for the provider's currently live local login only. */
  async liveUsage(providerId: string): Promise<LiveUsage | null> {
    const provider = this.registry.get(providerId);
    return provider.liveUsage ? provider.liveUsage() : null;
  }

  /**
   * Save current live auth as a named account.
   * If the name already exists, overwrite the snapshot (refresh).
   * Proxy config is preserved.
   */
  async save(
    providerId: string,
    name: string,
    opts: {
      label?: string;
      notes?: string;
      force?: boolean;
      source?: 'gemini-cli' | 'antigravity';
      /** Credential typed by the user; replaces reading a live login. */
      input?: CredentialInput;
    } = {},
  ): Promise<AccountMeta> {
    // ADR 0009: the service owns its lock. Identity resolution is part of the
    // mutation, not a preamble to it — a concurrent save that renames the
    // target account in between would send this one to a stale snapshot.
    return withMutationLocks(this.store.root, [providerScope(providerId)], () =>
      this.saveLocked(providerId, name, opts),
    );
  }

  private async saveLocked(
    providerId: string,
    name: string,
    opts: {
      label?: string;
      notes?: string;
      force?: boolean;
      source?: 'gemini-cli' | 'antigravity';
      /** Credential typed by the user; replaces reading a live login. */
      input?: CredentialInput;
    },
  ): Promise<AccountMeta> {
    const provider = this.registry.get(providerId);
    const requestedAccountName = normalizeAccountName(name);
    let accountName = requestedAccountName;

    if (opts.input && !provider.backupInput) {
      throw new HotplugError(
        `${provider.name} does not accept a ${opts.input.kind} credential.`,
        'UNSUPPORTED_CREDENTIAL_INPUT',
      );
    }

    // A typed-in credential has no live counterpart to read, so the live-auth
    // gate below would reject every one of them.
    const live: LiveAuthStatus = opts.input
      ? { present: true }
      : opts.source && provider.detectLiveSource
        ? await provider.detectLiveSource(opts.source)
        : await provider.detectLive();
    if (!live.present) {
      throw new HotplugError(`No live ${provider.name} login to save.`, {
        code: 'NO_LIVE_AUTH',
        suggestions: [
          `Sign in with the official tool first, then re-run this command.`,
          `Or clear the live auth without saving it: hotplug add account ${providerId} --new --no-backup`,
        ],
      });
    }

    // An identity (normally an email address) identifies the upstream login,
    // regardless of its local Hotplug name. A confirmed/automated overwrite
    // updates the existing snapshot instead of creating a duplicate.
    accountName = await this.resolveIdentityTarget(
      providerId,
      live.identity,
      accountName,
      opts.force === true,
    );

    const existing = await this.store.getAccount(providerId, accountName);
    if (!opts.input && existing?.meta.credentialKind === 'proxy-only') {
      throw new HotplugError(
        `${providerId}/${accountName} holds a credential you supplied, not a login on this machine.`,
        {
          code: 'CREDENTIAL_KIND_MISMATCH',
          suggestions: [
            `Save the live login under a different name.`,
            `To replace the stored credential, re-run the command that created it.`,
          ],
        },
      );
    }

    const now = new Date().toISOString();
    const prepared = await this.store.prepareSnapshot(providerId, accountName);
    let meta: AccountMeta;
    try {
      const fromProvider =
        opts.input && provider.backupInput
          ? await provider.backupInput(opts.input, prepared.snapshotDir)
          : opts.source && provider.backupSource
            ? await provider.backupSource(opts.source, prepared.snapshotDir)
            : await provider.backup(prepared.snapshotDir);
      meta = {
        name: accountName,
        provider: providerId,
        createdAt: existing?.meta.createdAt ?? now,
        updatedAt: now,
        label:
          opts.label ??
          existing?.meta.label ??
          fromProvider.label ??
          (accountName === requestedAccountName
            ? displayLabelFromName(name, accountName)
            : undefined),
        identity: fromProvider.identity ?? live.identity ?? existing?.meta.identity,
        notes: opts.notes ?? existing?.meta.notes ?? fromProvider.notes,
        credentialKind: fromProvider.credentialKind,
      };
      await this.store.writeMeta(meta);
    } catch (err) {
      if (existing) {
        // Re-materialize the last committed DB snapshot after prepareSnapshot
        // cleared its on-disk cache.
        await this.store.getAccount(providerId, accountName).catch(() => null);
      } else {
        // A failed first save must not leave an empty account directory that
        // can later be mistaken for a real login.
        await rm(prepared.accountDir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }

    if (!(await this.store.getActive(providerId))) {
      await this.store.setActive(providerId, accountName);
    }

    return meta;
  }

  /**
   * Resolve the saved name for the auth material currently on disk.
   *
   * Existing identities always win so a refreshed token overwrites its saved
   * snapshot instead of creating an alias such as "default". A new login gets
   * a stable identity-derived name unless the caller supplied one.
   */
  async resolveCurrentSaveName(providerId: string, requestedName?: string): Promise<string> {
    const provider = this.registry.get(providerId);
    const live = await provider.detectLive();
    if (!live.present) {
      throw new HotplugError(`No live ${provider.name} login to save.`, {
        code: 'NO_LIVE_AUTH',
        suggestions: ['Sign in with the official tool first, then try again.'],
      });
    }

    if (live.identity) {
      const existingName = await this.findAccountNameByIdentity(providerId, live.identity);
      if (existingName) {
        return existingName;
      }
    }

    if (requestedName?.trim()) {
      return normalizeAccountName(requestedName);
    }

    const active = await this.store.getActive(providerId);
    if (active) {
      const activeAccount = await this.store.getAccount(providerId, active);
      if (
        activeAccount &&
        (!live.identity ||
          (activeAccount.meta.identity &&
            identitiesMatch(activeAccount.meta.identity, live.identity)))
      ) {
        return active;
      }
    }

    if (live.identity) {
      return accountNameFromIdentity(live.identity);
    }

    throw new HotplugError(`Name the ${provider.name} login before saving it.`, {
      code: 'MISSING_ACCOUNT_NAME',
      suggestions: [`hotplug add account ${providerId} --current --name <name>`],
    });
  }

  /** Save current auth, reusing its existing account whenever possible. */
  async saveCurrent(providerId: string, requestedName?: string): Promise<AccountMeta> {
    const accountName = await this.resolveCurrentSaveName(providerId, requestedName);
    return this.save(providerId, accountName, { force: true });
  }

  /**
   * Switch live auth to a saved account.
   * Stops the previous account's proxy, restores auth, starts the new proxy if enabled.
   */
  async use(
    providerId: string,
    name: string,
    opts: { noRefresh?: boolean; noProxy?: boolean } = {},
  ): Promise<SwitchResult> {
    return withMutationLocks(this.store.root, [providerScope(providerId)], () =>
      this.useLocked(providerId, name, opts),
    );
  }

  private async useLocked(
    providerId: string,
    name: string,
    opts: { noRefresh?: boolean; noProxy?: boolean },
  ): Promise<SwitchResult> {
    const provider = this.registry.get(providerId);
    const accountName = normalizeAccountName(name);
    const target = await this.store.requireAccount(providerId, accountName);

    const previous = await this.store.getActive(providerId);
    let refreshedPrevious = false;
    let refreshedAccount: string | undefined;
    const checkpoint = await this.checkpointLiveAuth(providerId);
    let previousProxyWasRunning = false;

    try {
      // Stop previous proxy before swapping auth / starting a new one.
      if (previous && previous !== accountName && providerCanProxy(provider)) {
        const previousStatus = await this.proxy.proxyStatus(providerId, previous);
        previousProxyWasRunning = previousStatus.running;
        await this.proxy.stopProxyForAccount(provider, previous);
      }

      if (!opts.noRefresh && previous && previous !== accountName) {
        const live = await provider.detectLive();
        // Activating a proxy-only account never displaced the native login, so
        // there is nothing of its to preserve — and writing the live login into
        // its snapshot would overwrite the credential the user typed in.
        const previousMeta = await this.store.getAccount(providerId, previous);
        if (live.present && previousMeta?.meta.credentialKind !== 'proxy-only') {
          // Persist refreshed tokens into the account that actually owns the
          // live identity. The active pointer may be stale after an external
          // login change, so it must never choose the snapshot by itself.
          refreshedAccount = await this.saveLiveIntoExistingAccount(providerId, previous);
          refreshedPrevious = refreshedAccount === previous;
        }
      }

      // A proxy-only snapshot holds no native login, so restoring it would at
      // best write nothing and at worst let a provider that prunes stale
      // credential files delete the real login. Only the proxy reads it.
      if (target.meta.credentialKind !== 'proxy-only') {
        await provider.restore(target.snapshotDir);
      }
      await this.store.setActive(providerId, accountName);

      let proxy: SwitchResult['proxy'];
      if (!opts.noProxy && providerCanProxy(provider)) {
        const result = await this.proxy.startProxyForAccount(provider, accountName, target.proxy);
        if (result.error) {
          throw new HotplugError(`Could not start the ${provider.name} proxy: ${result.error}`, {
            code: 'PROXY_START_FAILED',
          });
        }
        proxy = {
          enabled: target.proxy.enabled,
          running: result.running,
          endpoint: result.endpoint,
          compatibility: provider.proxyCompatibility,
        };
      } else {
        proxy = { enabled: false, running: false };
      }

      return {
        provider: providerId,
        providerName: provider.name,
        from: previous,
        to: accountName,
        refreshedPrevious,
        refreshedAccount,
        proxy,
      };
    } catch (err) {
      try {
        await this.restoreLiveAuthCheckpoint(checkpoint);
        if (previousProxyWasRunning && previous && providerCanProxy(provider)) {
          const prior = await this.store.requireAccount(providerId, previous);
          await this.proxy.startProxyForAccount(provider, previous, prior.proxy);
        }
      } catch (rollbackErr) {
        throw new HotplugError(
          `Account switch failed and rollback could not complete: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          'SWITCH_ROLLBACK_FAILED',
        );
      }
      throw err;
    } finally {
      await this.discardLiveAuthCheckpoint(checkpoint);
    }
  }

  /**
   * Stash live auth: auto-backup (prefer matching email), then remove local
   * live files so the tool allows a new login — WITHOUT server-side logout/revoke.
   */
  async stash(
    providerId: string,
    opts: {
      /** Skip auto-backup before removing live files. */
      noBackup?: boolean;
      /** Force backup into this account name. */
      as?: string;
      /** Sign-in source to stash for providers that have more than one. */
      source?: 'gemini-cli' | 'antigravity';
    } = {},
  ): Promise<{
    provider: string;
    cleared: boolean;
    backedUpTo: string | null;
    previousIdentity?: string;
    /** True when backup reused an existing account with the same email. */
    matchedByIdentity: boolean;
    /** True when there was no live auth to back up (nothing to save). */
    skippedBackup: boolean;
  }> {
    return withMutationLocks(this.store.root, [providerScope(providerId)], () =>
      this.stashLocked(providerId, opts),
    );
  }

  private async stashLocked(
    providerId: string,
    opts: {
      noBackup?: boolean;
      as?: string;
      source?: 'gemini-cli' | 'antigravity';
    },
  ): Promise<{
    provider: string;
    cleared: boolean;
    backedUpTo: string | null;
    previousIdentity?: string;
    matchedByIdentity: boolean;
    skippedBackup: boolean;
  }> {
    const provider = this.registry.get(providerId);
    const clear =
      opts.source && provider.clearLiveSource
        ? () => provider.clearLiveSource!(opts.source!)
        : provider.clearLive
          ? () => provider.clearLive!()
          : null;
    if (!clear) {
      throw new HotplugError(
        `Provider "${providerId}" does not support stash (clear live auth).`,
        'STASH_UNSUPPORTED',
      );
    }

    const live =
      opts.source && provider.detectLiveSource
        ? await provider.detectLiveSource(opts.source)
        : await provider.detectLive();
    let backedUpTo: string | null = null;
    let matchedByIdentity = false;
    const previousIdentity = live.identity;
    let skippedBackup = !live.present;

    if (live.present && !opts.noBackup) {
      const resolved = await this.resolveStashBackupTarget(providerId, live.identity, opts.as);
      matchedByIdentity = resolved.matchedByIdentity;
      try {
        const meta = await this.save(providerId, resolved.name, {
          force: true,
          source: opts.source,
        });
        backedUpTo = meta.name;
      } catch (err) {
        // detectLive() may report a login from a Desktop/electron session while
        // the actual auth.json file (the thing we back up) is absent. Treat that
        // as "nothing to back up" rather than a hard failure.
        if (isHotplugError(err) && err.code === 'NO_LIVE_AUTH') {
          skippedBackup = true;
        } else if (isHotplugError(err) && err.code === 'ACCOUNT_IDENTITY_EXISTS') {
          // This is a user-resolvable naming conflict, not a failed backup.
          throw err;
        } else {
          throw new HotplugError(
            `Could not back up the live ${provider.name} login before clearing it.`,
            {
              code: 'STASH_BACKUP_FAILED',
              suggestions: [
                `Fix whatever is blocking the live login, then try again.`,
                `Or clear it without a backup (unsaved tokens will be lost): hotplug add account ${providerId} --new --no-backup`,
              ],
            },
          );
        }
      }
    }

    if (providerCanProxy(provider)) {
      const active = await this.store.getActive(providerId);
      if (active) {
        try {
          await this.proxy.stopProxyForAccount(provider, active);
        } catch {
          // continue
        }
      }
    }

    if (live.present) {
      await clear();
    }

    return {
      provider: providerId,
      cleared: live.present,
      backedUpTo,
      previousIdentity,
      matchedByIdentity,
      skippedBackup,
    };
  }

  /**
   * Pick account name for stash auto-backup, preferring same-email reuse.
   */
  private async resolveStashBackupTarget(
    providerId: string,
    liveIdentity: string | undefined,
    explicitAs?: string,
  ): Promise<{ name: string; matchedByIdentity: boolean }> {
    if (explicitAs) {
      return {
        name: normalizeAccountName(explicitAs),
        matchedByIdentity: false,
      };
    }

    if (liveIdentity) {
      const byIdentity = await this.findAccountNameByIdentity(providerId, liveIdentity);
      if (byIdentity) {
        return { name: byIdentity, matchedByIdentity: true };
      }
    }

    const active = await this.store.getActive(providerId);
    if (active) {
      const activeAccount = await this.store.getAccount(providerId, active);
      // Reuse active only when identity matches or active has no identity yet
      if (
        !liveIdentity ||
        !activeAccount?.meta.identity ||
        identitiesMatch(activeAccount.meta.identity, liveIdentity)
      ) {
        return { name: active, matchedByIdentity: false };
      }
    }

    if (liveIdentity) {
      return {
        name: accountNameFromIdentity(liveIdentity),
        matchedByIdentity: false,
      };
    }

    return { name: 'stash', matchedByIdentity: false };
  }

  private async findAccountNameByIdentity(
    providerId: string,
    identity: string,
  ): Promise<string | null> {
    const accounts = await this.store.listAccounts(providerId);
    for (const a of accounts) {
      if (a.meta.identity && identitiesMatch(a.meta.identity, identity)) {
        return a.meta.name;
      }
    }
    return null;
  }

  /**
   * Save live auth only into an already-saved account.
   *
   * Switching must never invent a new account or overwrite a stale active
   * pointer with another identity. An unsaved login is blocked so the caller
   * can explicitly name/save it before replacing the live auth file.
   */
  private async saveLiveIntoExistingAccount(
    providerId: string,
    fallbackActiveName: string,
  ): Promise<string> {
    const provider = this.registry.get(providerId);
    const live = await provider.detectLive();
    if (!live.present) {
      throw new HotplugError(`No live ${provider.name} login to preserve.`, 'NO_LIVE_AUTH');
    }

    let targetName = live.identity
      ? await this.findAccountNameByIdentity(providerId, live.identity)
      : null;

    if (!targetName) {
      const active = await this.store.getAccount(providerId, fallbackActiveName);
      if (
        active &&
        active.meta.credentialKind !== 'proxy-only' &&
        (!live.identity ||
          (active.meta.identity && identitiesMatch(active.meta.identity, live.identity)))
      ) {
        targetName = fallbackActiveName;
      }
    }

    if (!targetName) {
      throw new HotplugError(
        `The live ${provider.name} login${live.identity ? ` (${live.identity})` : ''} is not saved yet.`,
        {
          code: 'UNSAVED_LIVE_AUTH',
          suggestions: [
            `Save it first: hotplug add account ${providerId} --current${
              live.identity ? '' : ' --name <name>'
            }`,
          ],
        },
      );
    }

    const meta = await this.save(providerId, targetName, { force: true });
    return meta.name;
  }

  /** Resolve a duplicate identity to its existing local account after confirmation. */
  private async resolveIdentityTarget(
    providerId: string,
    identity: string | undefined,
    accountName: string,
    allowOverwrite: boolean,
  ): Promise<string> {
    if (!identity?.trim()) {
      return accountName;
    }
    const existingName = await this.findAccountNameByIdentity(providerId, identity);
    if (existingName && existingName !== accountName) {
      if (allowOverwrite) {
        return existingName;
      }
      throw new HotplugError(
        `Login ${identity} is already saved as ${providerId}/${existingName}.`,
        {
          code: 'ACCOUNT_IDENTITY_EXISTS',
          suggestions: [`Use ${providerId}/${existingName} instead of saving a duplicate.`],
          details: { provider: providerId, identity, existingName },
        },
      );
    }
    return accountName;
  }

  /**
   * Refresh OAuth/OIDC tokens.
   *
   * - `refresh codex` → live auth (+ sync into active saved account if any)
   * - `refresh codex lucy` → saved snapshot `lucy` (+ restore to live if active)
   * - `refresh codex --all` → every saved account for a provider
   */
  async refresh(
    providerId: string,
    name?: string,
    opts: { all?: boolean } = {},
  ): Promise<
    Array<{
      target: string;
      identity?: string;
      ok: boolean;
      error?: string;
    }>
  > {
    return withMutationLocks(this.store.root, [providerScope(providerId)], () =>
      this.refreshLocked(providerId, name, opts),
    );
  }

  private async refreshLocked(
    providerId: string,
    name: string | undefined,
    opts: { all?: boolean },
  ): Promise<
    Array<{
      target: string;
      identity?: string;
      ok: boolean;
      error?: string;
    }>
  > {
    const provider = this.registry.get(providerId);
    if (!provider.refreshAuth) {
      throw new HotplugError(
        `Provider "${providerId}" does not support token refresh.`,
        'REFRESH_UNSUPPORTED',
      );
    }

    const results: Array<{
      target: string;
      identity?: string;
      ok: boolean;
      error?: string;
    }> = [];

    if (opts.all) {
      const accounts = await this.store.listAccounts(providerId);
      for (const a of accounts) {
        results.push(await this.refreshSavedAccount(provider, a.meta.name));
      }
      if (results.length === 0) {
        throw new HotplugError(`No saved accounts for ${providerId}.`, 'REFRESH_EMPTY');
      }
      return results;
    }

    if (name) {
      results.push(await this.refreshSavedAccount(provider, normalizeAccountName(name)));
      return results;
    }

    // Default: refresh live auth
    results.push(await this.refreshLiveAuth(provider));
    return results;
  }

  private async refreshSavedAccount(
    provider: Provider,
    accountName: string,
  ): Promise<{
    target: string;
    identity?: string;
    ok: boolean;
    error?: string;
  }> {
    const target = `${provider.id}/${accountName}`;
    try {
      const account = await this.store.requireAccount(provider.id, accountName);
      const from = await provider.refreshAuth!(account.snapshotDir);
      const meta = {
        ...account.meta,
        updatedAt: new Date().toISOString(),
        identity: from.identity ?? account.meta.identity,
      };
      await this.store.writeMeta(meta);

      const active = await this.store.getActive(provider.id);
      if (active === accountName) {
        await provider.restore(account.snapshotDir);
      }

      return { target, identity: meta.identity, ok: true };
    } catch (err) {
      return {
        target,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async refreshLiveAuth(provider: Provider): Promise<{
    target: string;
    identity?: string;
    ok: boolean;
    error?: string;
  }> {
    const target = `${provider.id}/live`;
    try {
      const live = await provider.detectLive();
      if (!live.present) {
        // Fall back to active saved account
        const active = await this.store.getActive(provider.id);
        if (active) {
          return this.refreshSavedAccount(provider, active);
        }
        return {
          target,
          ok: false,
          error: 'No live auth and no active account.',
        };
      }

      const dir = await mkdtemp(join(tmpdir(), 'hotplug-refresh-'));
      try {
        await provider.backup(dir);
        const from = await provider.refreshAuth!(dir);
        await provider.restore(dir);

        // Sync the refreshed live login into the account that owns it — not
        // blindly into whichever account is active. A provider whose live auth
        // is a single global slot (Gemini reads one Antigravity keychain item
        // for every account) would otherwise let an out-of-band sign-in
        // overwrite an unrelated account's snapshot with someone else's token.
        const active = await this.store.getActive(provider.id);
        let syncError: string | undefined;
        if (active) {
          try {
            await this.saveLiveIntoExistingAccount(provider.id, active);
          } catch (err) {
            syncError = err instanceof Error ? err.message : String(err);
          }
        }

        return {
          target,
          identity: from.identity ?? live.identity,
          ok: !syncError,
          ...(syncError
            ? { error: `Live auth refreshed, but saved account sync failed: ${syncError}` }
            : {}),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (err) {
      return {
        target,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async delete(providerId: string, name: string): Promise<void> {
    const provider = this.registry.get(providerId);
    const accountName = normalizeAccountName(name);
    await withMutationLocks(this.store.root, [providerScope(providerId)], async () => {
      if (providerCanProxy(provider)) {
        await this.proxy.stopProxyForAccount(provider, accountName);
      }
      await this.store.deleteAccount(providerId, accountName);
    });
  }

  // ── Export / import ─────────────────────────────────────────────

  async exportAccount(providerId: string, name: string, outPath: string): Promise<void> {
    const account = await this.store.requireAccount(providerId, normalizeAccountName(name));
    const files = await collectFiles(account.snapshotDir);
    const payload = {
      version: 1 as const,
      kind: 'hotplug-account' as const,
      meta: account.meta,
      proxy: account.proxy,
      files,
    };

    // SEC-01: write to an owner-only temp file, then atomically rename.
    // Tighten the final mode even when overwriting an existing (permissive) file.
    const { tmpdir: tmpDir } = await import('node:os');
    const stage = await mkdtemp(join(tmpDir(), 'hotplug-export-'));
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

  async importAccount(
    providerId: string,
    name: string,
    inPath: string,
    opts: { force?: boolean } = {},
  ): Promise<AccountMeta> {
    return withMutationLocks(this.store.root, [providerScope(providerId)], () =>
      this.importAccountLocked(providerId, name, inPath, opts),
    );
  }

  private async importAccountLocked(
    providerId: string,
    name: string,
    inPath: string,
    opts: { force?: boolean },
  ): Promise<AccountMeta> {
    this.registry.get(providerId);
    let accountName = normalizeAccountName(name);
    if (!(await pathExists(inPath))) {
      throw new HotplugError(`Import file not found: ${inPath}`, 'IMPORT_MISSING');
    }

    let existing = await this.store.getAccount(providerId, accountName);
    if (existing && !opts.force) {
      throw new HotplugError(
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
        throw new HotplugError(`Import file exceeds ${MAX_IMPORT_ENVELOPE_BYTES} bytes.`, {
          code: 'IMPORT_LIMIT',
          mutated: false,
          exitCode: 9,
        });
      }
    } catch (err) {
      if (err instanceof HotplugError) {
        throw err;
      }
      throw new HotplugError(`Unable to inspect import file: ${inPath}`, {
        code: 'IMPORT_MISSING',
        mutated: false,
      });
    }
    const raw = await readFile(inPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HotplugError('Import file is not valid JSON.', 'IMPORT_FORMAT');
    }
    const envelope = decodeAccountEnvelope(parsed, providerId);

    const provider = this.registry.get(providerId);
    let identity = envelope.meta.identity;
    let label = envelope.meta.label;
    if (provider.describeSnapshot) {
      // Inspect a disposable copy first. prepareSnapshot() can replace an
      // existing snapshot, so identity conflicts must be found before it.
      const inspectDir = await mkdtemp(join(tmpdir(), 'hotplug-import-inspect-'));
      try {
        await writeFiles(inspectDir, envelope.files);
        const described = await provider.describeSnapshot(inspectDir);
        identity = described.identity ?? identity;
        label = described.label ?? label;
      } finally {
        await rm(inspectDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    accountName = await this.resolveIdentityTarget(
      providerId,
      identity,
      accountName,
      opts.force === true,
    );
    existing = await this.store.getAccount(providerId, accountName);

    // Stage into the live snapshot dir only after full validation and identity
    // conflict checks.
    const { snapshotDir } = await this.store.prepareSnapshot(providerId, accountName);
    await writeFiles(snapshotDir, envelope.files);

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
    await this.store.writeMeta(meta);

    // Imported proxies are always disabled and provider-specific options are
    // intentionally dropped by the codec. Starting a proxy is an explicit
    // local action, never something an imported file can trigger.
    if (envelope.proxy) {
      await this.store.setProxyConfig(providerId, accountName, {
        ...DEFAULT_PROXY_CONFIG,
        ...envelope.proxy,
        enabled: false,
        options: undefined,
      });
    }

    return meta;
  }
}

function identitiesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether a saved snapshot's auth material matches the current live login.
 * Capsule: delegates to the provider (which owns the fingerprint logic) and
 * falls back to identity equality when the provider does not implement it.
 */
async function computeLiveMatch(
  provider: Provider,
  account: Account,
  knownLive?: LiveAuthStatus,
): Promise<boolean | null> {
  // A proxy-only credential never occupies the provider's live login file, so
  // it cannot be what is on disk no matter what the fingerprint says.
  if (account.meta.credentialKind === 'proxy-only') {
    return false;
  }
  const { snapshotDir } = account;
  if (typeof provider.snapshotMatchesLive === 'function') {
    try {
      return await provider.snapshotMatchesLive(snapshotDir);
    } catch (err) {
      if (isHotplugError(err) && err.code === 'NOT_DETERMINABLE') {
        return null;
      }
      // fall through to identity-based fallback
    }
  }
  const live = knownLive ?? (await provider.detectLive());
  if (!live.identity) {
    return false;
  }
  const described = provider.describeSnapshot ? await provider.describeSnapshot(snapshotDir) : {};
  return described.identity != null && identitiesMatch(described.identity, live.identity);
}

/** Derive a stable account slug from an email / identity string. */
function accountNameFromIdentity(identity: string): string {
  const trimmed = identity.trim();
  const local = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  try {
    return normalizeAccountName(local);
  } catch {
    return 'stash';
  }
}

async function collectFiles(root: string): Promise<Record<string, string>> {
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

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, b64] of Object.entries(files)) {
    // Defense-in-depth: re-resolve each key against the staging root so a
    // malformed key can never write outside `root` (SEC-01).
    const dest = stagedFilePath(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(b64, 'base64'), { mode: 0o600 });
  }
}
