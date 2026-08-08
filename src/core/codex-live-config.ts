/**
 * Publish the active AnyPick Codex route into the user's base `~/.codex/config.toml`
 * so plain `codex` (and the desktop app, where it honors config) routes through
 * the proxy / gateway / Proxy Hub without a `--profile` flag.
 *
 * Codex routes globally: the top-level `model_provider` selects ONE provider that
 * serves the top-level `model`, so exactly one live provider is published.
 *
 * **Binding is the source of truth.** A hub route left attached for Claude (or a
 * stale `global/codex` after switching Codex off the Hub) must not takeover
 * Codex's top-level config. Resolve follows the global Codex binding only.
 *
 * Takeover policy: while mode is `routed`, the live managed block owns top-level
 * `model` / `model_provider`. The user's previous values are stashed on first
 * takeover and restored when mode flips to `native` (native account) or when
 * the live block is cleared (reset / nothing active).
 */

import { readFile, rm } from 'node:fs/promises';
import type { Account, Provider, ProxyHubStatus, ResourceRef } from '../types';
import type { ProxyHubRouteSecret } from './proxy-hub-store';
import {
  buildLiveCatalog,
  codexLiveCatalogPath,
  codexLiveModePath,
  codexLiveRoutePath,
  codexProfileName,
  codexUserDefaultsStashPath,
  configTomlPath,
  extractUserTopLevelDefaults,
  hasTopLevelKeyOutsideLiveBlock,
  liveRouteCatalogModels,
  prepareConfigForLiveTakeover,
  renderLiveManagedBlock,
  restoreUserTopLevelDefaults,
  type CodexLiveMode,
  type CodexUserDefaultsStash,
  type LiveCodexProvider,
  type StoredLiveRoute,
  upsertLiveBlock,
} from '../clients/codex';
import {
  assignDesktopAliases,
  desktopAwareRouteModels,
  desktopConfigModelId,
  loadNativeListSlots,
  orderHubModelsForDesktop,
  preferredHubModelsFromRoles,
} from '../clients/codex-desktop-catalog';
import { accountAdapterFor } from '../sources/account-adapters';
import { pathExists, writeJsonFile, writeTextFile } from '../utils/fs';

/** Persistent Proxy Hub route id for a client (see activation-planner.ts). */
const HUB_ROUTE_ID = 'global/codex';

export interface CodexLiveConfigDeps {
  hub: {
    getAttachedRoute(routeId: string): ProxyHubRouteSecret | null;
    status(name?: string): Promise<ProxyHubStatus>;
  };
  proxy: {
    listProxyRows(): Promise<
      Array<{
        provider: string;
        name: string;
        active: boolean;
        status: { running: boolean; endpoint?: string };
      }>
    >;
  };
  accounts: {
    getAccount(provider: string, name: string): Promise<Account | null>;
    readProxyState(provider: string, name: string): Promise<{ token?: string } | null>;
  };
  accountRegistry: {
    get(providerId: string): Provider | undefined;
  };
  /**
   * Global Codex binding. When absent, live config clears rather than guessing
   * from leftover hub routes or any running proxy. `modelId` seeds top-level
   * `model` so Desktop/CLI open on a real Hub model, not a stock GPT id.
   * `modelRoles` (Default + List 2–5) pins Desktop picker slots when set.
   */
  getCodexSource?: () => ResourceRef | null;
  getCodexModelId?: () => string | undefined;
  getCodexModelRoles?: () => Record<string, string> | undefined;
  home?: string;
  log?: (message: string) => void;
}

/**
 * Resolve the single active route Codex should point at from its binding, or
 * `null` when there is nothing worth publishing.
 */
async function resolveActiveProvider(deps: CodexLiveConfigDeps): Promise<LiveCodexProvider | null> {
  const source = deps.getCodexSource?.() ?? null;
  if (!source) {
    return null;
  }

  if (source.kind === 'proxy-hub') {
    return resolveHubProvider(deps, source.name);
  }

  if (source.kind === 'account') {
    return resolveAccountProxyProvider(deps, source.provider, source.name);
  }

  if (source.kind === 'account-pool') {
    return resolvePoolProxyProvider(deps, source.provider);
  }

  if (source.kind === 'gateway') {
    // Gateway credentials are not re-derived here; publishCodexLiveRoute wrote
    // a sticky route at apply time. Only reuse it when it still names this gateway.
    const sticky = await readStoredLiveRoute(deps.home);
    if (sticky && sticky.source === `gateway:${source.name}`) {
      return sticky;
    }
    return null;
  }

  // Presets are expanded before binding; a leftover preset pointer is not live.
  return null;
}

async function resolveHubProvider(
  deps: CodexLiveConfigDeps,
  hubName: string,
): Promise<LiveCodexProvider | null> {
  const route = deps.hub.getAttachedRoute(HUB_ROUTE_ID);
  if (route && route.manifest.client === 'codex' && route.manifest.hub === hubName) {
    const status = await deps.hub.status(route.manifest.hub);
    if (status.running && status.endpoint) {
      return {
        source: `hub:${route.manifest.hub}`,
        endpoint: status.endpoint,
        token: route.token,
      };
    }
  }
  const sticky = await readStoredLiveRoute(deps.home);
  if (sticky && sticky.source === `hub:${hubName}`) {
    return sticky;
  }
  return null;
}

async function resolveAccountProxyProvider(
  deps: CodexLiveConfigDeps,
  providerId: string,
  accountName: string,
): Promise<LiveCodexProvider | null> {
  const rows = await deps.proxy.listProxyRows();
  const row = rows.find(
    (candidate) =>
      candidate.provider === providerId &&
      candidate.name === accountName &&
      candidate.status.running &&
      candidate.status.endpoint,
  );
  if (!row?.status.endpoint) {
    return null;
  }
  const account = await deps.accounts.getAccount(providerId, accountName);
  const provider = deps.accountRegistry.get(providerId);
  if (!account || !provider) {
    return null;
  }
  const transport = accountAdapterFor(provider, account).transportFor('codex');
  if (transport !== 'managed_builtin_proxy' && transport !== 'managed_external_proxy') {
    return null;
  }
  const state = await deps.accounts.readProxyState(providerId, accountName);
  if (!state?.token) {
    return null;
  }
  return {
    source: `${providerId}/${accountName}`,
    endpoint: row.status.endpoint,
    token: state.token,
  };
}

async function resolvePoolProxyProvider(
  deps: CodexLiveConfigDeps,
  providerId: string,
): Promise<LiveCodexProvider | null> {
  const rows = await deps.proxy.listProxyRows();
  const row = rows.find(
    (candidate) =>
      candidate.provider === providerId &&
      (candidate.name === 'pool' || candidate.name === '*') &&
      candidate.status.running &&
      candidate.status.endpoint,
  );
  if (!row?.status.endpoint) {
    // Fall back to any running account proxy for this provider when the pool
    // row is not listed separately.
    return null;
  }
  // Pool tokens live on a member account; listProxyRows for pools usually
  // exposes the pool endpoint. Prefer sticky when it matches this pool.
  const sticky = await readStoredLiveRoute(deps.home);
  if (
    sticky &&
    (sticky.source === `pool:${providerId}` || sticky.source.startsWith(`${providerId}/`))
  ) {
    return {
      ...sticky,
      endpoint: row.status.endpoint,
      source: `pool:${providerId}`,
    };
  }
  return null;
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function readLiveMode(home?: string): Promise<CodexLiveMode | null> {
  const path = codexLiveModePath(home);
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { mode?: string };
    return raw.mode === 'routed' || raw.mode === 'native' ? raw.mode : null;
  } catch {
    return null;
  }
}

async function writeLiveMode(mode: CodexLiveMode, home?: string): Promise<void> {
  await writeJsonFile(codexLiveModePath(home), { version: 1, mode }, 0o600);
}

async function readStash(home?: string): Promise<CodexUserDefaultsStash | null> {
  const path = codexUserDefaultsStashPath(home);
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as CodexUserDefaultsStash;
    return raw?.version === 1 ? raw : null;
  } catch {
    return null;
  }
}

async function ensureStash(content: string, home?: string): Promise<void> {
  const path = codexUserDefaultsStashPath(home);
  if (await pathExists(path)) {
    return;
  }
  // Only snapshot keys still outside the managed block (true user defaults).
  const stash = extractUserTopLevelDefaults(content);
  await writeJsonFile(path, stash, 0o600);
}

async function readStoredLiveRoute(home?: string): Promise<LiveCodexProvider | null> {
  const path = codexLiveRoutePath(home);
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as StoredLiveRoute;
    if (raw?.version !== 1 || !raw.source || !raw.endpoint || !raw.token) {
      return null;
    }
    return {
      source: raw.source,
      endpoint: raw.endpoint,
      token: raw.token,
      defaultModel: raw.defaultModel,
    };
  } catch {
    return null;
  }
}

async function writeStoredLiveRoute(provider: LiveCodexProvider, home?: string): Promise<void> {
  const payload: StoredLiveRoute = {
    version: 1,
    source: provider.source,
    endpoint: provider.endpoint,
    token: provider.token,
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
  };
  await writeJsonFile(codexLiveRoutePath(home), payload, 0o600);
}

/**
 * Publish an explicit route (gateway activation) and mark mode as routed.
 * Used when resolveActiveProvider cannot see the source (gateways are not
 * process-backed the way proxies are).
 */
export async function publishCodexLiveRoute(
  deps: CodexLiveConfigDeps,
  provider: LiveCodexProvider,
): Promise<void> {
  try {
    await writeLiveMode('routed', deps.home);
    await writeStoredLiveRoute(provider, deps.home);
    await writeLiveTakeover(deps, provider);
  } catch (error) {
    deps.log?.(`Codex live config publish failed: ${errorMessage(error)}`);
  }
}

/**
 * Mark Codex as native (ChatGPT account) and restore the user's top-level
 * model / model_provider defaults. Proxy lifecycle re-sync will no-op while
 * mode stays native.
 */
export async function restoreCodexLiveForNative(deps: CodexLiveConfigDeps): Promise<void> {
  try {
    await writeLiveMode('native', deps.home);
    await clearCodexLiveConfig(deps, { keepMode: true });
  } catch (error) {
    deps.log?.(`Codex live config native restore failed: ${errorMessage(error)}`);
  }
}

export interface SyncCodexLiveOptions {
  /**
   * Activation just bound Codex to a proxy/hub: flip mode to routed even if
   * the previous binding was a native account. Proxy lifecycle events leave
   * this unset so they never undo a native restore.
   */
  forceRouted?: boolean;
}

/**
 * Re-render the live managed block from the current active route. Best-effort:
 * never throws — sync is a convenience that must not break activation.
 *
 * When mode is `native` (and `forceRouted` is not set), leaves config alone so
 * a still-running proxy cannot re-takeover after the user switched to native.
 * When mode is `routed` (or unset with a resolvable provider), takes over
 * top-level `model_provider`.
 */
export async function syncCodexLiveConfig(
  deps: CodexLiveConfigDeps,
  opts: SyncCodexLiveOptions = {},
): Promise<void> {
  try {
    if (opts.forceRouted) {
      await writeLiveMode('routed', deps.home);
    }

    const mode = await readLiveMode(deps.home);
    if (mode === 'native' && !opts.forceRouted) {
      // Stay out of the way after a native account switch — even if a proxy
      // process is still running for some other client.
      return;
    }

    const provider = await resolveActiveProvider(deps);
    if (!provider) {
      await clearCodexLiveConfig(deps, { keepMode: true });
      return;
    }

    // First time we publish from a lifecycle event without an explicit mode,
    // treat it as routed so later native switches can distinguish.
    if (mode !== 'routed') {
      await writeLiveMode('routed', deps.home);
    }
    await writeStoredLiveRoute(provider, deps.home);
    await writeLiveTakeover(deps, provider);
  } catch (error) {
    deps.log?.(`Codex live config sync failed: ${errorMessage(error)}`);
  }
}

async function writeLiveTakeover(
  deps: CodexLiveConfigDeps,
  provider: LiveCodexProvider,
): Promise<void> {
  const configPath = configTomlPath(deps.home);
  const catalogPath = codexLiveCatalogPath(deps.home);
  const profileName = codexProfileName(provider.source);
  const preferredFromRoles = preferredHubModelsFromRoles(deps.getCodexModelRoles?.());
  const preferredHubModel =
    preferredFromRoles[0] ||
    provider.defaultModel?.trim() ||
    deps.getCodexModelId?.()?.trim() ||
    undefined;
  const preferredList =
    preferredFromRoles.length > 0
      ? preferredFromRoles
      : preferredHubModel
        ? [preferredHubModel]
        : [];

  const models = await liveRouteCatalogModels({
    endpoint: provider.endpoint,
    token: provider.token,
    defaultModel: preferredHubModel,
  });

  // Desktop allowlist only shows native GPT slugs (~5). Alias top hub models
  // onto those slugs (codex-router technique) so the Desktop picker lists Hub
  // routes with friendly names; real hub slugs stay for the CLI.
  // Preferred list comes from Apps Configure Models (Default + List 2–5).
  const isHub = provider.source.startsWith('hub:');
  let catalogModels = models;
  let configModel = preferredHubModel;
  if (isHub && models.length > 0) {
    const nativeSlots = loadNativeListSlots();
    const ordered = orderHubModelsForDesktop(
      models.map((model) => model.slug),
      preferredList,
    );
    const aliases = assignDesktopAliases(ordered, nativeSlots);
    catalogModels = desktopAwareRouteModels(models, aliases, nativeSlots);
    configModel = desktopConfigModelId(preferredHubModel, aliases) ?? preferredHubModel;
    deps.log?.(
      `Codex Desktop: aliased ${aliases.length} Hub model(s) onto native GPT picker slots` +
        (aliases[0] ? ` (e.g. ${aliases[0].nativeSlug} → ${aliases[0].hubModel})` : ''),
    );
  }

  // Tag entries with the live provider id for CLI catalog association.
  await writeJsonFile(catalogPath, buildLiveCatalog(catalogModels, profileName), 0o600);

  const existing = await readFileSafe(configPath);
  await ensureStash(existing, deps.home);

  const includeCatalog = !hasTopLevelKeyOutsideLiveBlock(existing, 'model_catalog_json');
  // After prepareConfigForLiveTakeover, user model/model_provider are removed;
  // hasTopLevelKeyOutsideLiveBlock for those is irrelevant — we always own them.
  if (!includeCatalog) {
    deps.log?.(
      `Codex: keeping your own model_catalog_json in ${configPath}; routed models are not auto-listed. Use: codex --profile ${profileName}`,
    );
  }

  const prepared = prepareConfigForLiveTakeover(existing);
  const block = renderLiveManagedBlock({ ...provider, defaultModel: configModel }, catalogPath, {
    includeCatalog,
  });
  const next = upsertLiveBlock(prepared, block);
  if (next !== existing) {
    await writeTextFile(configPath, next, 0o600);
  }
}

/** Remove the live managed block, restore stashed defaults, drop sidecars. */
export async function clearCodexLiveConfig(
  deps: CodexLiveConfigDeps,
  opts: { keepMode?: boolean } = {},
): Promise<void> {
  try {
    await rm(codexLiveCatalogPath(deps.home), { force: true });
    await rm(codexLiveRoutePath(deps.home), { force: true });
    if (!opts.keepMode) {
      await rm(codexLiveModePath(deps.home), { force: true });
    }

    const stash = await readStash(deps.home);
    const stashPath = codexUserDefaultsStashPath(deps.home);
    const configPath = configTomlPath(deps.home);
    if (!(await pathExists(configPath))) {
      await rm(stashPath, { force: true });
      return;
    }
    const existing = await readFileSafe(configPath);
    const next = restoreUserTopLevelDefaults(existing, stash);
    await rm(stashPath, { force: true });
    if (next === existing) {
      return;
    }
    if (next.trim().length === 0) {
      await rm(configPath, { force: true });
    } else {
      await writeTextFile(configPath, next, 0o600);
    }
  } catch (error) {
    deps.log?.(`Codex live config cleanup failed: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
