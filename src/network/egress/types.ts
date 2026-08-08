export type EgressOperation = 'catalog' | 'inference' | 'diagnostic';

export interface EgressDescriptor {
  id: string;
  kind: 'direct' | 'relay' | 'http-connect';
  networkPath: 'local' | 'remote';
  verification: 'not-applicable' | 'unverified' | 'verified';
  confidentiality: 'end-to-end-tls' | 'relay-terminates-tls';
}

export interface EgressTransport {
  readonly descriptor: EgressDescriptor;
  fetch(
    target: string | URL,
    init: RequestInit,
    meta: { operation: EgressOperation },
  ): Promise<Response>;
  close(): Promise<void>;
}
