/**
 * Deterministic source resolution for use / run / link (spec §15, §9.4).
 */

import type {
  Account,
  BindingSpec,
  ClientId,
  GlobalBinding,
  ModelSelection,
  ProjectBinding,
  ResolvedSource,
  ResourceRef,
  RuntimeProfile,
  SavedPreset,
} from '../types';
import { anypickError, ExitCode } from '../utils/errors';
import { displayRef, parseRef, resolveSourceRef, serializeRef, type ParseRefContext } from './refs';
import { accountAdapterFor, poolAdapterFor } from '../sources/account-adapters';
import { providerCanProxy } from './capabilities';
import { gatewayAdapterFromProfile } from '../sources/gateway-adapters';
import { proxyHubAdapter } from '../sources/proxy-hub-adapters';
import type { AccountService } from './service';
import type { ProxyService } from './proxy-service';
import type { ProfileService } from './profile-service';
import type { ProfileStore } from './profile-store';
import type { BindingStore } from './binding-store';
import type { PresetStore } from './preset-store';
import type { ProviderRegistry } from './registry';
import type { CatalogRegistry } from '../catalog/providers';
import type { ClientRegistry } from '../clients/registry';
import type { PoolStore } from './pool-store';
import { resolveProjectRoot } from './project-root';
import type { ProxyHubService } from './proxy-hub-service';

export interface ResolveSourceDeps {
  accounts: AccountService;
  proxy: ProxyService;
  accountRegistry: ProviderRegistry;
  profiles: ProfileService;
  profileStore: ProfileStore;
  bindings: BindingStore;
  presets: PresetStore;
  catalog: CatalogRegistry;
  clients: ClientRegistry;
  pools?: PoolStore;
  hub?: ProxyHubService;
}

export async function materializeResolvedSource(
  ref: ResourceRef,
  deps: ResolveSourceDeps,
): Promise<ResolvedSource> {
  if (ref.kind === 'preset') {
    throw anypickError(
      'Internal error: preset refs must be expanded before materialize.',
      'INVALID_USAGE',
      { exitCode: ExitCode.INVALID_USAGE },
    );
  }

  if (ref.kind === 'account') {
    const account = await deps.accounts.get(ref.provider, ref.name);
    if (!account) {
      throw anypickError(
        `Account \`${ref.provider}/${ref.name}\` was not found.`,
        'ACCOUNT_NOT_FOUND',
        {
          exitCode: ExitCode.NOT_FOUND,
          suggestions: [
            `anypick add account ${ref.provider} --current --name ${ref.name}`,
            'anypick list accounts',
          ],
        },
      );
    }
    const provider = deps.accountRegistry.get(ref.provider);
    const adapter = accountAdapterFor(provider, account);
    return {
      ref,
      kind: 'account',
      adapter,
      display: displayRef(ref),
    };
  }

  if (ref.kind === 'account-pool') {
    const provider = deps.accountRegistry.get(ref.provider);
    if (!providerCanProxy(provider)) {
      throw anypickError(
        `Provider ${ref.provider} has no proxy — cannot use pool:${ref.provider}.`,
        'PROXY_UNSUPPORTED',
        { exitCode: ExitCode.CAPABILITY_CONFLICT },
      );
    }
    let pool = deps.pools ? await deps.pools.get(ref.provider) : null;
    if (!pool || pool.mode !== 'multi') {
      throw anypickError(
        `Multi-account pool is not enabled for ${ref.provider}.\n\nEnable it:\n  anypick proxy pool enable ${ref.provider}\n\nOr bind a single account:\n  anypick use <client> --with ${ref.provider}/<name>`,
        'POOL_NOT_ENABLED',
        {
          exitCode: ExitCode.INVALID_USAGE,
          suggestions: [
            `anypick proxy pool enable ${ref.provider}`,
            `anypick use claude --with ${ref.provider}/work`,
          ],
        },
      );
    }
    const adapter = provider.poolSourceAdapter?.() ?? poolAdapterFor(ref.provider, provider);
    return {
      ref,
      kind: 'account',
      adapter,
      display: displayRef(ref),
    };
  }

  if (ref.kind === 'proxy-hub') {
    if (!deps.hub) {
      throw new Error('Proxy Hub service is unavailable in this composition.');
    }
    const hub = await deps.hub.get(ref.name);
    if (!hub.enabled) {
      throw anypickError(
        `Proxy Hub ${displayRef(ref)} is disabled. Enable it and add a source first.`,
        'PROXY_DISABLED',
        { exitCode: ExitCode.CAPABILITY_CONFLICT },
      );
    }
    return {
      ref,
      kind: 'proxy-hub',
      adapter: proxyHubAdapter(ref),
      display: displayRef(ref),
    };
  }

  // gateway (profiles store is the physical gateway store)
  const profile = await deps.profileStore.get(ref.name);
  if (!profile) {
    throw anypickError(`Gateway \`${ref.name}\` was not found.`, 'GATEWAY_NOT_FOUND', {
      exitCode: ExitCode.NOT_FOUND,
      suggestions: [
        'Accounts use provider/name:  anypick use claude --with grok/work',
        'Gateways use their saved name:  anypick use claude --with openrouter-work',
      ],
    });
  }
  const catalogProvider = deps.catalog.has(profile.meta.provider)
    ? deps.catalog.get(profile.meta.provider)
    : undefined;
  const adapter = gatewayAdapterFromProfile(profile, { catalogProvider, clients: deps.clients });
  return {
    ref,
    kind: 'gateway',
    adapter,
    display: displayRef(ref),
  };
}

export async function expandPreset(
  name: string,
  client: ClientId,
  deps: ResolveSourceDeps,
): Promise<{
  preset: SavedPreset;
  source: ResolvedSource;
  model: ModelSelection;
  bindingSpec: BindingSpec;
}> {
  const preset = deps.presets.getByName(name);
  if (!preset) {
    throw anypickError(`Preset \`@${name}\` was not found.`, 'PRESET_NOT_FOUND', {
      exitCode: ExitCode.NOT_FOUND,
      suggestions: ['anypick list presets'],
    });
  }
  if (preset.spec.client !== client) {
    const presetClient = deps.clients.has(preset.spec.client)
      ? deps.clients.get(preset.spec.client).name
      : preset.spec.client;
    const wantClient = deps.clients.has(client) ? deps.clients.get(client).name : client;
    throw anypickError(
      `Preset @${name} is for ${presetClient}, not ${wantClient}.\n\nTry:\n  anypick run ${preset.spec.client} --with @${name}`,
      'PRESET_CLIENT_MISMATCH',
      {
        exitCode: ExitCode.INVALID_USAGE,
        suggestions: [`anypick run ${preset.spec.client} --with @${name}`],
      },
    );
  }
  const sourceRef = preset.spec.source;
  if (sourceRef.kind === 'preset') {
    throw anypickError('Nested presets are not supported.', 'INVALID_USAGE', {
      exitCode: ExitCode.INVALID_USAGE,
    });
  }
  const source = await materializeResolvedSource(sourceRef, deps);
  const model = preset.spec.model;
  const bindingSpec: BindingSpec = {
    client,
    source: sourceRef,
    model,
    transportPolicy: preset.spec.transportPolicy,
    clientOptions: { ...preset.spec.clientOptions },
  };
  return { preset, source, model, bindingSpec };
}

export async function parseAndResolveSourceInput(
  input: string,
  deps: ResolveSourceDeps,
): Promise<ResourceRef> {
  const providerIds = new Set(deps.accountRegistry.ids());
  return resolveSourceRef(input, {
    accountProviders: providerIds,
    gatewayExists: async (name) => {
      return (await deps.profileStore.get(name)) != null;
    },
    presetExists: (name) => deps.presets.exists(name),
    accountExists: async (provider, name) => {
      try {
        return (await deps.accounts.get(provider, name)) != null;
      } catch {
        return false;
      }
    },
  });
}

/**
 * Effective binding for run without --with:
 * 1. project binding
 * 2. global binding
 * 3. error (no unmanaged fallback)
 */
export function resolveEffectiveBinding(
  client: ClientId,
  deps: ResolveSourceDeps,
  projectRoot: string = resolveProjectRoot(),
): { scope: 'project' | 'global'; binding: GlobalBinding | ProjectBinding } {
  const project = deps.bindings.getProject(projectRoot, client);
  if (project) {
    return { scope: 'project', binding: project };
  }
  const global = deps.bindings.getGlobal(client);
  if (global) {
    return { scope: 'global', binding: global };
  }

  const clientName = deps.clients.has(client) ? deps.clients.get(client).name : client;
  throw anypickError(
    `No AnyPick source is configured for ${clientName}.\n\nSet a persistent default:\n  anypick use ${client} --with <source>\n\nOr run once:\n  anypick run ${client} --with <source>\n\nExisting native configuration may be present, but AnyPick will not use it implicitly.`,
    'NO_ACTIVE_BINDING',
    {
      exitCode: ExitCode.CAPABILITY_CONFLICT,
      suggestions: [
        `anypick use ${client} --with <source>`,
        `anypick run ${client} --with <source>`,
      ],
      details: { client },
    },
  );
}

export async function loadAccountForRef(
  ref: ResourceRef,
  deps: ResolveSourceDeps,
): Promise<Account | undefined> {
  if (ref.kind !== 'account') {
    return undefined;
  }
  return (await deps.accounts.get(ref.provider, ref.name)) ?? undefined;
}

export async function loadProfileForRef(
  ref: ResourceRef,
  deps: ResolveSourceDeps,
): Promise<RuntimeProfile | undefined> {
  if (ref.kind !== 'gateway') {
    return undefined;
  }
  return (await deps.profileStore.get(ref.name)) ?? undefined;
}

export function modelFromRequest(
  explicit?: string,
  fallback: ModelSelection = { mode: 'omitted' },
): ModelSelection {
  if (explicit && explicit.trim()) {
    return { mode: 'explicit', id: explicit.trim() };
  }
  return fallback;
}

export function parseSourceInputSync(
  input: string,
  accountProviders: ReadonlySet<string>,
): ResourceRef {
  return parseRef(input, { accountProviders });
}

export type { ParseRefContext };
export { serializeRef, displayRef };
