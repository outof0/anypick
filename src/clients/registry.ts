import type { ClientAdapter } from '../types';
import { Registry } from '../core/registry';

export class ClientRegistry extends Registry<ClientAdapter> {
  constructor() {
    super({
      kind: 'Client',
      duplicateCode: 'DUPLICATE_CLIENT',
      unknownCode: 'UNKNOWN_CLIENT',
    });
  }
}

export const clientRegistry = new ClientRegistry();
