import type { ClientId, ProxyHubResourceRef, SourceAdapter, TransportCapability } from '../types';

/**
 * The Hub is a local managed transport, not a provider. Individual provider
 * compatibility is validated while attaching its compiled route manifest.
 */
export function proxyHubAdapter(ref: ProxyHubResourceRef): SourceAdapter {
  return {
    sourceRef: ref,
    capabilities: {
      sourceKind: 'proxy-hub',
      provider: 'proxy-hub',
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
      supportsModelDiscovery: true,
      requiresNativeAuthWrite: false,
    },
    transportFor(clientId: ClientId): TransportCapability {
      return clientId === 'claude' || clientId === 'codex'
        ? 'managed_builtin_proxy'
        : 'unsupported';
    },
  };
}
