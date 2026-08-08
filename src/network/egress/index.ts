import { DirectEgressTransport } from './direct';
import { exactOriginAllowlist } from './allowlist';

export function createDirectEgress(origins: readonly string[]): DirectEgressTransport {
  return new DirectEgressTransport(exactOriginAllowlist(origins));
}

export * from './types';
export * from './errors';
export * from './direct';
