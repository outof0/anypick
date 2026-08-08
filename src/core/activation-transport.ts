import type {
  ClientCapabilities,
  ResolvedSource,
  ResolvedTransport,
  TransportCapability,
} from '../types';
import { protocolForClient } from './activation-protocol';

export function buildTransport(
  clientCaps: ClientCapabilities | undefined,
  source: ResolvedSource,
  capability: TransportCapability,
  account?: { meta: { provider: string; name: string }; proxy?: { port?: number } },
  profile?: { meta: { endpoint?: string } },
  poolPort?: number,
): ResolvedTransport {
  const protocol = protocolForClient(clientCaps, source.adapter.capabilities.protocols);
  const transport: ResolvedTransport = { capability, protocol };
  if (capability === 'managed_builtin_proxy' || capability === 'managed_external_proxy') {
    const port = poolPort ?? account?.proxy?.port ?? 8080;
    transport.managedProxy = {
      provider:
        source.ref.kind === 'account' || source.ref.kind === 'account-pool'
          ? source.ref.provider
          : source.adapter.capabilities.provider,
      account: source.ref.kind === 'account' ? source.ref.name : undefined,
      port,
      leaseId: 'pending',
    };
    transport.endpoint = `http://127.0.0.1:${port}`;
  } else if (capability === 'direct' && profile?.meta.endpoint) {
    transport.endpoint = profile.meta.endpoint;
  }
  return transport;
}
