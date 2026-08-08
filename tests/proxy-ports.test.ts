/**
 * `ProxyPortAllocator` in isolation.
 *
 * This is the payoff from splitting it out of `ProxyService`: allocation can be
 * constructed with just a registry and a store, so the port-selection rules are
 * testable without proxy lifecycle, pools, or leases in the picture.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { ProxyPortAllocator, validatePort } from '../src/core/proxy-ports';
import { ProviderRegistry } from '../src/core/registry';
import { AccountStore } from '../src/core/store';
import { openDatabase } from '../src/core/db';
import { FakeProvider } from './helpers';

async function occupyPort(): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, server };
}

describe('validatePort', () => {
  it('accepts 0 as the OS-ephemeral request', () => {
    expect(validatePort(0)).toBe(0);
  });

  it('accepts the valid range', () => {
    expect(validatePort(1)).toBe(1);
    expect(validatePort(65535)).toBe(65535);
  });

  it.each([-1, 65536, 1.5, Number.NaN])('rejects %s', (bad) => {
    expect(() => validatePort(bad)).toThrow(/Invalid port/);
  });
});

describe('ProxyPortAllocator', () => {
  let root: string;
  let allocator: ProxyPortAllocator;
  let registry: ProviderRegistry;
  let store: AccountStore;
  let provider: FakeProvider;
  const servers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-ports-'));
    registry = new ProviderRegistry();
    provider = new FakeProvider('p', join(root, 'live', 'p'), {
      withProxy: true,
      defaultProxyPort: 19500,
    });
    registry.register(provider);
    store = new AccountStore(root, openDatabase(root));
    allocator = new ProxyPortAllocator(registry, store);
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });

  it("prefers the provider's default when nothing conflicts", async () => {
    const port = await allocator.resolve(provider, {
      providerId: 'p',
      accountName: 'work',
    });
    expect(port).toBe(19500);
  });

  it('prefers a saved port over the provider default', async () => {
    const port = await allocator.resolve(provider, {
      providerId: 'p',
      accountName: 'work',
      existing: 19555,
    });
    expect(port).toBe(19555);
  });

  it('passes 0 through as an ephemeral request', async () => {
    const port = await allocator.resolve(provider, {
      providerId: 'p',
      accountName: 'work',
      existing: 0,
    });
    expect(port).toBe(0);
  });

  it('honors an explicit request when it is free', async () => {
    const port = await allocator.resolve(provider, {
      providerId: 'p',
      accountName: 'work',
      requested: 19600,
    });
    expect(port).toBe(19600);
  });

  it('rejects an explicit request held by a foreign process', async () => {
    const occupied = await occupyPort();
    servers.push(occupied.server);

    await expect(
      allocator.resolve(provider, {
        providerId: 'p',
        accountName: 'work',
        requested: occupied.port,
      }),
    ).rejects.toThrow(/already in use/i);
  });

  it('walks past a bound port when allocating implicitly', async () => {
    const occupied = await occupyPort();
    servers.push(occupied.server);

    const port = await allocator.resolve(provider, {
      providerId: 'p',
      accountName: 'work',
      existing: occupied.port,
    });
    expect(port).not.toBe(occupied.port);
    expect(port).toBeGreaterThan(occupied.port);
  });

  it('rejects an invalid explicit port before probing anything', async () => {
    await expect(
      allocator.resolve(provider, {
        providerId: 'p',
        accountName: 'work',
        requested: 70000,
      }),
    ).rejects.toThrow(/Invalid port/);
  });

  it('reports no used ports when nothing is saved', async () => {
    expect(await allocator.collectUsedPorts()).toEqual(new Set());
  });

  it('treats 0 as always available', async () => {
    await expect(allocator.assertAvailable(0, 'p', 'work')).resolves.toBeUndefined();
  });

  it('allocateFrom finds the first free port at or above the base', async () => {
    const port = await allocator.allocateFrom(19700, 'p', 'work');
    expect(port).toBeGreaterThanOrEqual(19700);
  });
});
