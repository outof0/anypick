import type { EgressOperation, EgressTransport } from './types';
import { EgressPolicyError } from './errors';

export class DirectEgressTransport implements EgressTransport {
  readonly descriptor = {
    id: 'direct',
    kind: 'direct' as const,
    networkPath: 'local' as const,
    verification: 'not-applicable' as const,
    confidentiality: 'end-to-end-tls' as const,
  };

  constructor(private readonly allowedOrigins: readonly string[]) {}

  async fetch(
    target: string | URL,
    init: RequestInit,
    _meta: { operation: EgressOperation },
  ): Promise<Response> {
    const url = new URL(target);
    if (url.username || url.password || !this.allowedOrigins.includes(url.origin)) {
      throw new EgressPolicyError(`Target origin is not allowed: ${url.origin}`);
    }
    return fetch(url, { ...init, redirect: 'manual' });
  }

  async close(): Promise<void> {}
}
