import { describe, expect, it } from 'vitest';
import { reapStaleLeases } from '../src/core/proxy-lifecycle';
import type { ProxyLease } from '../src/types';

describe('proxy lease reaping', () => {
  it('reaps legacy leases where the detached proxy was recorded as its own owner', async () => {
    const lease: ProxyLease = {
      leaseId: 'legacy',
      provider: 'gemini',
      account: 'work',
      port: 4131,
      host: '127.0.0.1',
      endpoint: 'http://127.0.0.1:4131',
      ownerPid: process.pid,
      bindingRefs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const stopped: string[] = [];
    const released: string[] = [];
    const proxy = {
      proxyStatus: async () => ({ enabled: true, running: true, pid: process.pid }),
      poolProxyStatus: async () => ({ enabled: false, running: false }),
      stopProxy: async (provider: string, account: string) => {
        stopped.push(`${provider}/${account}`);
      },
      stopPoolProxy: async () => {},
    };
    const leases = {
      list: () => [lease],
      release: (id: string) => {
        released.push(id);
        return true;
      },
    };

    const result = await reapStaleLeases({
      proxy: proxy as never,
      leases: leases as never,
    });

    expect(result).toEqual(['legacy']);
    expect(stopped).toEqual(['gemini/work']);
    expect(released).toEqual(['legacy']);
  });
});
