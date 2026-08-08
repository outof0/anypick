/**
 * Account-source adapters — transport classification via transportFor(clientId).
 * Replaces the coarse Provider.supportsProxy flag (spec §20.1).
 */

import type {
  Account,
  AccountMeta,
  ClientId,
  Provider,
  SourceAdapter,
  SourceCapabilities,
  TransportCapability,
} from '../types';
import { accountRef } from '../core/refs';
import { providerCanProxy } from '../core/capabilities';
import { resolveKiroProxyCommand, resolveKiroProxyCommandCached } from './kiro-proxy-bin';

function baseAccountCapabilities(
  provider: string,
  overrides: Partial<SourceCapabilities> = {},
): SourceCapabilities {
  return {
    sourceKind: 'account',
    provider,
    nativeClients: [],
    protocols: ['openai', 'anthropic'],
    canRefresh: false,
    supportsModelDiscovery: false,
    requiresNativeAuthWrite: false,
    ...overrides,
  };
}

/** Codex native login: direct for codex client; unsupported for others without proxy. */
export function codexAccountAdapter(account: Account): SourceAdapter {
  const sourceRef = accountRef(account.meta.provider, account.meta.name);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities('codex', {
      nativeClients: ['codex'],
      protocols: ['openai'],
      canRefresh: true,
      requiresNativeAuthWrite: true,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (clientId === 'codex') {
        return 'direct';
      }
      // Codex native auth is not a gateway for Claude/Kiro
      return 'unsupported';
    },
  };
}

/** Claude Code native login: direct only for Claude Code. */
export function claudeAccountAdapter(account: Account): SourceAdapter {
  const sourceRef = accountRef(account.meta.provider, account.meta.name);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities('claude', {
      nativeClients: ['claude'],
      protocols: ['anthropic'],
      requiresNativeAuthWrite: true,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      return clientId === 'claude' ? 'direct' : 'unsupported';
    },
  };
}

/** Gemini CLI: direct for gemini client; builtin proxy for Claude/Codex. */
export function geminiAccountAdapter(account: Account): SourceAdapter {
  const sourceRef = accountRef(account.meta.provider, account.meta.name);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities('gemini', {
      nativeClients: ['gemini'],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
      requiresNativeAuthWrite: true,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (clientId === 'gemini') {
        return 'direct';
      }
      if (clientId === 'claude' || clientId === 'codex') {
        return 'managed_builtin_proxy';
      }
      return 'unsupported';
    },
  };
}

/** Grok: built-in dual-protocol proxy for Claude/Codex. */
export function grokAccountAdapter(account: Account): SourceAdapter {
  const sourceRef = accountRef(account.meta.provider, account.meta.name);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities('grok', {
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (clientId === 'claude' || clientId === 'codex') {
        return 'managed_builtin_proxy';
      }
      return 'unsupported';
    },
  };
}

/** OpenCode: built-in Zen/Go proxy for Claude/Codex when API keys present. */
export function opencodeAccountAdapter(account: Account): SourceAdapter {
  const sourceRef = accountRef(account.meta.provider, account.meta.name);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities('opencode', {
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh: true,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (clientId === 'claude' || clientId === 'codex') {
        return 'managed_builtin_proxy';
      }
      return 'unsupported';
    },
  };
}

/**
 * Kiro: external kirolink proxy (spec §19.5).
 *
 * Classification shares `resolveKiroProxyCommand` with the launcher in
 * `providers/kiro.ts`, so the gate and the spawn can never disagree on a
 * binary name or on an env override. Missing → external_manual_proxy
 * (activation exits 7 before any mutation).
 */
export function kiroAccountAdapter(
  account: Account,
  opts: { findExecutable?: (name: string) => string | null } = {},
): SourceAdapter {
  const sourceRef = accountRef(account.meta.provider, account.meta.name);

  return {
    sourceRef,
    capabilities: baseAccountCapabilities('kiro', {
      nativeClients: ['kiro'],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
      requiresNativeAuthWrite: true,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (clientId === 'kiro') {
        return 'direct';
      }
      if (clientId === 'claude' || clientId === 'codex') {
        // The test seam bypasses env-driven discovery; the live path caches.
        const command = opts.findExecutable
          ? resolveKiroProxyCommand({ findExecutable: opts.findExecutable })
          : resolveKiroProxyCommandCached();
        return command ? 'managed_external_proxy' : 'external_manual_proxy';
      }
      return 'unsupported';
    },
  };
}

/** How a pool serves a borrowing client, when the provider can proxy at all. */
export type PoolProxyTransport = Extract<
  TransportCapability,
  'managed_builtin_proxy' | 'managed_external_proxy'
>;

/**
 * Multi-account pool source (opt-in). Same transports as a proxy-capable
 * account for the provider, without native auth write.
 *
 * A pool only ever serves a *borrowing* client through a proxy, so the single
 * axis of variation is which proxy the provider manages — passed in by the
 * provider's own `poolSourceAdapter()` rather than branched on here. Invariant:
 * only `claude` and `codex` accept a source from another provider, so every
 * other client is `unsupported` regardless of the pool.
 */
export function poolAdapterFor(
  providerId: string,
  provider: Provider,
  opts: { proxyTransport?: PoolProxyTransport } = {},
): SourceAdapter {
  const sourceRef = { kind: 'account-pool' as const, provider: providerId };
  const proxyTransport = opts.proxyTransport ?? 'managed_builtin_proxy';
  return {
    sourceRef,
    capabilities: baseAccountCapabilities(providerId, {
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
      requiresNativeAuthWrite: false,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (!providerCanProxy(provider)) {
        return 'unsupported';
      }
      return clientId === 'claude' || clientId === 'codex' ? proxyTransport : 'unsupported';
    },
  };
}

/** Generic fallback for unknown providers. */
export function genericAccountAdapter(
  account: Pick<AccountMeta, 'provider' | 'name'>,
  provider: Provider,
): SourceAdapter {
  const sourceRef = accountRef(account.provider, account.name);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities(provider.id, {
      nativeClients: provider.id === account.provider ? [provider.id] : [],
      requiresNativeAuthWrite: true,
    }),
    transportFor(clientId: ClientId): TransportCapability {
      if (clientId === provider.id) {
        return 'direct';
      }
      // Cross-provider account transport is deliberately narrow. The client
      // registry says what exists; this adapter remains the authority for what
      // is safe to pair (ADR 0011 / account-adapter invariant).
      if (providerCanProxy(provider) && (clientId === 'claude' || clientId === 'codex')) {
        return 'managed_builtin_proxy';
      }
      return 'unsupported';
    },
  };
}

/**
 * Build a SourceAdapter for a saved account. Providers own their transport
 * policy; core has only a conservative generic fallback for third-party
 * providers that have not implemented the extension contract yet.
 */
export function accountAdapterFor(provider: Provider, account: Account): SourceAdapter {
  if (provider.sourceAdapter) {
    return provider.sourceAdapter(account);
  }
  return genericAccountAdapter(account.meta, provider);
}

/**
 * Build a `SourceAdapter` for a managed proxy endpoint injection.
 *
 * This is the source-layer factory for `RuntimeService.applyProxyEndpoint`,
 * which previously hand-constructed an ad-hoc `SourceAdapter` inline in the
 * core service. Keeping adapter construction here honours the rule that core
 * must never contain client/source-shaped logic. When the real `Provider` is
 * available we delegate to `genericAccountAdapter` so capabilities/transport
 * classification stay consistent with the rest of the system; callers that
 * only have a provider id + name (e.g. ephemeral runs before a snapshot
 * exists) pass `provider: undefined` and get a neutral account adapter whose
 * `transportFor` always reports `managed_builtin_proxy`.
 */
export function proxyEndpointSourceAdapter(
  providerId: string,
  accountName: string,
  provider?: Provider,
): SourceAdapter {
  if (provider) {
    return genericAccountAdapter({ provider: providerId, name: accountName }, provider);
  }
  const sourceRef = accountRef(providerId, accountName);
  return {
    sourceRef,
    capabilities: baseAccountCapabilities(providerId, {
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      requiresNativeAuthWrite: false,
    }),
    transportFor(_clientId: ClientId): TransportCapability {
      return 'managed_builtin_proxy';
    },
  };
}
