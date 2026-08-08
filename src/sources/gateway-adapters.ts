/**
 * Gateway-source adapters from RuntimeProfile / catalog metadata.
 * Spec §20.1.2 — transport is source×client, not a boolean.
 */

import type {
  CatalogProvider,
  ClientId,
  Protocol,
  RuntimeProfile,
  SourceAdapter,
  SourceCapabilities,
  TransportCapability,
} from '../types';
import { gatewayRef } from '../core/refs';
import type { ClientRegistry } from '../clients/registry';

function protocolsFromApiStyle(style: CatalogProvider['apiStyle']): Protocol[] {
  switch (style) {
    case 'openai':
      return ['openai'];
    case 'anthropic':
      return ['anthropic'];
    case 'custom':
      return ['openai', 'anthropic'];
    default:
      return ['openai'];
  }
}

/**
 * Classify gateway transport for a client based on declared protocols
 * and catalog provider identity.
 */
export function gatewayTransportFor(
  clientId: ClientId,
  protocols: readonly Protocol[],
  opts: { catalogProvider?: CatalogProvider; clients: Pick<ClientRegistry, 'has' | 'get'> },
): TransportCapability {
  // A gateway is direct only when its implementation was registered in this
  // app instance. Client protocol capabilities come from the client adapter,
  // not a core-maintained id matrix.
  if (!opts.catalogProvider || !opts.clients.has(clientId)) {
    return 'unsupported';
  }
  const accepted = opts.clients.get(clientId).capabilities?.acceptedProtocols ?? [];

  const overlap = protocols.some((p) => accepted.includes(p));
  if (!overlap) {
    return 'unsupported';
  }

  return 'direct';
}

export function gatewayAdapterFromProfile(
  profile: RuntimeProfile,
  opts: { catalogProvider?: CatalogProvider; clients: Pick<ClientRegistry, 'has' | 'get'> },
): SourceAdapter {
  const sourceRef = gatewayRef(profile.meta.name);
  const protocols = [
    opts.catalogProvider?.protocols ??
      protocolsFromApiStyle(opts.catalogProvider?.apiStyle ?? 'custom'),
  ].flat();

  const capabilities: SourceCapabilities = {
    sourceKind: 'gateway',
    provider: profile.meta.provider,
    nativeClients: [],
    protocols,
    canRefresh: false,
    supportsModelDiscovery: false,
    requiresNativeAuthWrite: false,
  };

  return {
    sourceRef,
    capabilities,
    transportFor(clientId: ClientId): TransportCapability {
      return gatewayTransportFor(clientId, protocols, opts);
    },
  };
}

export function createGatewaySourceAdapter(opts: {
  name: string;
  provider: string;
  protocols: Protocol[];
  catalogProvider?: CatalogProvider;
  clients: Pick<ClientRegistry, 'has' | 'get'>;
}): SourceAdapter {
  const sourceRef = gatewayRef(opts.name);
  return {
    sourceRef,
    capabilities: {
      sourceKind: 'gateway',
      provider: opts.provider,
      nativeClients: [],
      protocols: opts.protocols,
      canRefresh: false,
      supportsModelDiscovery: false,
      requiresNativeAuthWrite: false,
    },
    transportFor(clientId: ClientId): TransportCapability {
      return gatewayTransportFor(clientId, opts.protocols, opts);
    },
  };
}
