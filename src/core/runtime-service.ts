import type { ClientState, GlobalConfig, ResolvedClientPlan, RuntimeProfile } from '../types';
import type { ClientRegistry } from '../clients/registry';
import type { ClientStateStore } from './client-state-store';
import type { ProfileStore } from './profile-store';
import type { GlobalConfigStore } from './config';
import type { ProviderRegistry } from './registry';
import { normalizeProfileName } from '../utils/slug';
import { getHotplugRoot } from './paths';
import { syntheticProxyProfile } from './profile-synth';
import { proxyEndpointSourceAdapter } from '../sources/account-adapters';
import { homedir } from 'node:os';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { recoveryDir } from './paths';

export interface RuntimeApplyResult {
  clientId: string;
  profileName: string;
  managedPaths: string[];
  managedEnvKeys: string[];
  dryRun: boolean;
  envHint?: string;
  /**
   * `src=>dest` entries of the on-disk backups taken for the files this apply
   * was about to overwrite (the client's previously-managed config paths).
   * Empty on first apply (nothing to lose). Consumed by the activation journal
   * so a crash mid-activation can be restored on next startup.
   */
  backupPaths?: string[];
}

export interface RuntimeSwitchResult {
  profileName: string;
  clients: RuntimeApplyResult[];
  dryRun: boolean;
}

export interface RuntimeResetResult {
  clientId: string;
  previousMode: string;
  previousProfile?: string;
  dryRun: boolean;
}

/**
 * Durable compensation prepared before a client adapter is allowed to mutate
 * local configuration. `backupPaths` is journal-compatible: `src=>dest`
 * restores an existing file while `delete=>dest` removes a newly-created one.
 */
export interface ClientConfigRecovery {
  backupPaths: string[];
}

export class RuntimeService {
  readonly root: string;

  constructor(
    private readonly profiles: ProfileStore,
    private readonly clientState: ClientStateStore,
    private readonly clients: ClientRegistry,
    private readonly config?: GlobalConfigStore,
    root?: string,
    private readonly accountRegistry?: ProviderRegistry,
  ) {
    this.root = getHotplugRoot(root);
  }

  /**
   * Switch to a runtime profile and apply it immediately.
   * This is the main entry point (profile use / profile switch).
   */
  async switchProfile(
    profileName: string,
    opts: {
      client?: string;
      allClients?: boolean;
      dryRun?: boolean;
      verbose?: boolean;
    } = {},
  ): Promise<RuntimeSwitchResult> {
    const name = normalizeProfileName(profileName);
    await this.profiles.require(name);

    const clientIds = await this.resolveTargetClients(opts);
    const results: RuntimeApplyResult[] = [];
    for (const clientId of clientIds) {
      results.push(
        await this.apply(name, clientId, {
          dryRun: opts.dryRun,
          verbose: opts.verbose,
        }),
      );
    }

    if (!opts.dryRun && this.config) {
      const cfg = await this.config.read();
      await this.config.write({
        ...cfg,
        activeProfile: name,
      } satisfies GlobalConfig);
    }

    return {
      profileName: name,
      clients: results,
      dryRun: Boolean(opts.dryRun),
    };
  }

  /**
   * Snapshot the client's previously-managed config files before overwriting.
   * Returns `src=>dest` backup entries for any that currently exist on disk, so
   * a crashed activation can be restored on next startup (TXN-01).
   *
   * Backups are stored in the owner-only Hotplug recovery directory (not the
   * system temp dir) with collision-free hashed filenames, so two targets with
   * the same basename — or concurrent activations — never clobber each other's
   * backup. Files that do not yet exist (first apply) yield no backup: there is
   * nothing to lose.
   */
  async prepareClientConfigRecovery(
    clientId: string,
    operationId?: string,
  ): Promise<ClientConfigRecovery> {
    try {
      const prior = await this.clientState.get(clientId);
      const client = this.clients.get(clientId);
      const inspected = await client.inspect();
      const targets = [
        ...(prior?.managedPaths ?? []),
        ...inspected.configPaths,
        // All bundled adapters use these Hotplug-owned environment files. They
        // must be compensated too even on a first apply.
        join(this.root, 'clients', clientId, 'env.sh'),
        join(this.root, 'clients', clientId, 'env.ps1'),
      ].toSorted();
      const unique = [...new Set(targets)];
      const dir = operationId
        ? join(recoveryDir(this.root), 'clients', clientId, operationId)
        : join(recoveryDir(this.root), 'clients', clientId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const entries: string[] = [];
      for (const target of unique) {
        if (!existsSync(target)) {
          entries.push(`delete=>${target}`);
          continue;
        }
        // Hash the absolute target so two different files named e.g. settings.json
        // back up to distinct paths; include the basename for human readability.
        const hash = createHash('sha1').update(target).digest('hex').slice(0, 16);
        const dest = join(dir, `${hash}-${basename(target)}`);
        try {
          await copyFile(target, dest);
          entries.push(`${dest}=>${target}`);
        } catch (err) {
          // Existing state that cannot be snapshotted is not safe to overwrite.
          // Do not turn this into a best-effort backup: the caller has already
          // promised the journal can compensate every managed write.
          throw new Error(
            `Could not back up ${target}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
      return { backupPaths: entries };
    } catch {
      // A recovery plan that cannot be prepared must never permit a mutation.
      throw new Error(`Could not prepare durable recovery for client ${clientId}`);
    }
  }

  async restoreClientConfigRecovery(recovery: ClientConfigRecovery): Promise<void> {
    for (const entry of recovery.backupPaths) {
      const [source, target] = entry.split('=>').map((value) => value.trim());
      if (!source || !target) {
        throw new Error(`Invalid client recovery entry: ${entry}`);
      }
      if (source === 'delete') {
        await rm(target, { force: true });
        continue;
      }
      if (!existsSync(source)) {
        throw new Error(`Client recovery backup is missing: ${source}`);
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
    }
  }

  async apply(
    profileName: string,
    clientId: string,
    opts: {
      dryRun?: boolean;
      verbose?: boolean;
      /** Override endpoint (e.g. managed proxy URL). */
      proxyEndpoint?: string;
      /** Prepared and journaled before this method is allowed to mutate. */
      recovery?: ClientConfigRecovery;
    } = {},
  ): Promise<RuntimeApplyResult> {
    const name = normalizeProfileName(profileName);
    const profile = await this.profiles.require(name);
    const client = this.clients.get(clientId);
    const dryRun = Boolean(opts.dryRun);

    const recovery = dryRun
      ? { backupPaths: [] }
      : (opts.recovery ?? (await this.prepareClientConfigRecovery(clientId)));

    const ctx = {
      profile,
      clientId: client.id,
      dryRun,
      verbose: Boolean(opts.verbose),
      hotplugRoot: this.root,
      proxyEndpoint: opts.proxyEndpoint,
    };

    await client.validate(ctx);
    const result = await client.apply(ctx);

    if (!dryRun) {
      const state: ClientState = {
        clientId: client.id,
        mode: 'profile',
        profileName: name,
        updatedAt: new Date().toISOString(),
        managedPaths: result.managedPaths,
        managedEnvKeys: result.managedEnvKeys,
      };
      await this.clientState.write(state);
    }

    return {
      clientId: client.id,
      profileName: name,
      managedPaths: result.managedPaths,
      managedEnvKeys: result.managedEnvKeys,
      dryRun,
      envHint: `${this.root}/clients/${client.id}/env.sh`,
      backupPaths: recovery.backupPaths.length ? recovery.backupPaths : undefined,
    };
  }

  /**
   * Apply client config for an account+proxy activation (spec §22).
   * Injects the managed proxy endpoint into the client without requiring
   * a saved gateway profile.
   */
  async applyProxyEndpoint(
    clientId: string,
    opts: {
      endpoint: string;
      apiKey?: string;
      defaultModel?: string;
      sonnetModel?: string;
      opusModel?: string;
      haikuModel?: string;
      /** Role id → model id (preferred; fills default/sonnet/opus/haiku). */
      modelRoles?: Record<string, string>;
      accountRef?: { provider: string; name: string };
      dryRun?: boolean;
      verbose?: boolean;
      /** Label for synthetic profile / state tracking. */
      label?: string;
      /** Prepared and journaled before this method is allowed to mutate. */
      recovery?: ClientConfigRecovery;
    },
  ): Promise<RuntimeApplyResult> {
    const client = this.clients.get(clientId);
    const dryRun = Boolean(opts.dryRun);
    const recovery = dryRun
      ? { backupPaths: [] }
      : (opts.recovery ?? (await this.prepareClientConfigRecovery(clientId)));
    const label =
      opts.label ??
      (opts.accountRef
        ? `proxy:${opts.accountRef.provider}/${opts.accountRef.name}`
        : 'proxy:account');

    const roles = opts.modelRoles;
    const defaultModel = opts.defaultModel ?? roles?.default;
    const profile: RuntimeProfile = syntheticProxyProfile({
      name: label,
      endpoint: opts.endpoint,
      apiKey: opts.apiKey ?? 'hotplug-proxy',
      defaultModel,
      sonnetModel: opts.sonnetModel ?? roles?.sonnet,
      opusModel: opts.opusModel ?? roles?.opus,
      haikuModel: opts.haikuModel ?? roles?.haiku,
      modelRoles: roles,
      provider: 'custom',
    });

    // Prefer applyPersistent when available
    if (client.applyPersistent) {
      const providerId = opts.accountRef?.provider ?? 'unknown';
      const accountName = opts.accountRef?.name ?? 'unknown';
      const provider = this.accountRegistry?.has(providerId)
        ? this.accountRegistry.get(providerId)
        : undefined;
      const plan: ResolvedClientPlan = {
        clientId: client.id,
        source: {
          ref: { kind: 'account', provider: providerId, name: accountName },
          kind: 'account',
          adapter: proxyEndpointSourceAdapter(providerId, accountName, provider),
          display: label,
        },
        transport: {
          capability: 'managed_builtin_proxy',
          protocol:
            client.capabilities?.protocolPreference ??
            client.capabilities?.acceptedProtocols[0] ??
            'openai',
          endpoint: opts.endpoint,
        },
        model: defaultModel ? { mode: 'explicit', id: defaultModel } : { mode: 'omitted' },
        mode: 'persistent',
        profile,
        dryRun,
        verbose: Boolean(opts.verbose),
        hotplugRoot: this.root,
      };
      const result = await client.applyPersistent(plan);
      if (!dryRun) {
        await this.clientState.write({
          clientId: client.id,
          mode: 'account',
          accountRef: opts.accountRef,
          updatedAt: new Date().toISOString(),
          managedPaths: result.managedPaths,
          managedEnvKeys: result.managedEnvKeys,
        });
      }
      return {
        clientId: client.id,
        profileName: label,
        managedPaths: result.managedPaths,
        managedEnvKeys: result.managedEnvKeys,
        dryRun,
        envHint: `${this.root}/clients/${client.id}/env.sh`,
        backupPaths: recovery.backupPaths.length ? recovery.backupPaths : undefined,
      };
    }

    const ctx = {
      profile,
      clientId: client.id,
      dryRun,
      verbose: Boolean(opts.verbose),
      hotplugRoot: this.root,
      proxyEndpoint: opts.endpoint,
    };
    await client.validate(ctx);
    const result = await client.apply(ctx);
    if (!dryRun) {
      await this.clientState.write({
        clientId: client.id,
        mode: 'account',
        accountRef: opts.accountRef,
        updatedAt: new Date().toISOString(),
        managedPaths: result.managedPaths,
        managedEnvKeys: result.managedEnvKeys,
      });
    }
    return {
      clientId: client.id,
      profileName: label,
      managedPaths: result.managedPaths,
      managedEnvKeys: result.managedEnvKeys,
      dryRun,
      envHint: `${this.root}/clients/${client.id}/env.sh`,
      backupPaths: recovery.backupPaths.length ? recovery.backupPaths : undefined,
    };
  }

  /**
   * Build an isolated ephemeral runtime for `hotplug run` (spec §9.7.1).
   * Never mutates live client configuration.
   */
  async createEphemeralRuntime(plan: ResolvedClientPlan): Promise<{
    environment: Record<string, string>;
    args?: string[];
    cleanup: () => Promise<void>;
    directory: string;
  }> {
    const client = this.clients.get(plan.clientId);
    const caps = client.capabilities;
    if (caps?.supportsIsolatedHome && client.listIsolatablePaths && client.createIsolatedRuntime) {
      const liveHome = process.env.HOME ?? homedir();
      const paths = await client.listIsolatablePaths({ home: liveHome });
      const runtime = await client.createIsolatedRuntime(plan, paths);
      return {
        environment: runtime.environment,
        args: runtime.args,
        cleanup: () => runtime.cleanup(),
        directory: runtime.directory,
      };
    }

    if (caps?.supportsEnvironmentOverlay && client.createEnvironmentOverlay) {
      const runtime = await client.createEnvironmentOverlay(plan);
      return {
        environment: runtime.environment,
        args: runtime.args,
        cleanup: () => runtime.cleanup(),
        directory: runtime.directory,
      };
    }

    throw new Error(`Client ${plan.clientId} does not implement an ephemeral runtime`);
  }

  async reset(clientId: string, opts: { dryRun?: boolean } = {}): Promise<RuntimeResetResult> {
    const client = this.clients.get(clientId);
    const existing = await this.clientState.get(client.id);
    const dryRun = Boolean(opts.dryRun);

    const state: ClientState = existing ?? {
      clientId: client.id,
      mode: 'none',
      updatedAt: new Date().toISOString(),
      managedPaths: [],
      managedEnvKeys: [],
    };

    if (!dryRun) {
      await client.reset(state);
      await this.clientState.write({
        clientId: client.id,
        mode: 'none',
        updatedAt: new Date().toISOString(),
        managedPaths: [],
        managedEnvKeys: [],
      });
    }

    return {
      clientId: client.id,
      previousMode: state.mode,
      previousProfile: state.profileName,
      dryRun,
    };
  }

  async status(clientId?: string): Promise<
    Array<{
      clientId: string;
      clientName: string;
      state: ClientState | null;
      inspect: Awaited<ReturnType<import('../types').ClientAdapter['inspect']>>;
    }>
  > {
    const list = clientId ? [this.clients.get(clientId)] : this.clients.list();

    const out = [];
    for (const c of list) {
      out.push({
        clientId: c.id,
        clientName: c.name,
        state: await this.clientState.get(c.id),
        inspect: await c.inspect(),
      });
    }
    return out;
  }

  async which(clientId: string): Promise<ClientState | null> {
    this.clients.get(clientId);
    return this.clientState.get(clientId);
  }

  async activeProfile(): Promise<string | null> {
    if (!this.config) {
      return null;
    }
    const cfg = await this.config.read();
    return cfg.activeProfile ?? null;
  }

  private async resolveTargetClients(opts: {
    client?: string;
    allClients?: boolean;
  }): Promise<string[]> {
    if (opts.allClients) {
      return this.clients.ids();
    }
    if (opts.client) {
      this.clients.get(opts.client);
      return [opts.client];
    }
    // Default client from config (claude)
    let defaultClient = 'claude';
    if (this.config) {
      const cfg = await this.config.read();
      if (cfg.defaultClient) {
        defaultClient = cfg.defaultClient;
      }
    }
    if (this.clients.has(defaultClient)) {
      return [defaultClient];
    }
    const first = this.clients.ids()[0];
    if (!first) {
      throw new Error('No client adapters registered.');
    }
    return [first];
  }
}
