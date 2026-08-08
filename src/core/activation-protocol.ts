import type { ClientCapabilities, Protocol } from '../types';

export function protocolForClient(
  caps: ClientCapabilities | undefined,
  sourceProtocols: Protocol[],
): Protocol {
  const preferred =
    caps?.protocolPreference ?? caps?.acceptedProtocols[0] ?? sourceProtocols[0] ?? 'openai';
  return sourceProtocols.includes(preferred) ? preferred : (sourceProtocols[0] ?? 'openai');
}
