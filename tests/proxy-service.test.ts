/**
 * ProxyService behaviour.
 *
 * Written before splitting the service (which had grown to ~1,300 lines owning
 * lifecycle, pools, leases and port allocation at once, with its `LeaseStore`
 * wired by a post-construction `setLeaseStore()` call). Port allocation now
 * lives in `ProxyPortAllocator` and the lease store is a constructor argument.
 *
 * These tests go through `createAppReady` (the real composition root) and assert
 * behaviour — allocation outcomes, lease records, config transitions — not
 * internal structure, which is why they survived that refactor unchanged.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createAppReady, type AnyPickApp } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import { ClientRegistry } from '../src/clients/registry';
import { CatalogRegistry } from '../src/catalog/providers';
import { openDatabase } from '../src/core/db';
import { FakeProvider } from './helpers';

async function seedAccount(app: AnyPickApp, provider: string, name: string): Promise<void> {
  const { snapshotDir } = await app.accountStore.prepareSnapshot(provider, name);
  await writeFile(join(snapshotDir, 'auth.json'), JSON.stringify({ token: 't' }), { mode: 0o600 });
  await app.accountStore.writeMeta({
    name,
    provider,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Occupy a real port so allocation has to walk past it. */
async function occupyPort(): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, server };
}

describe('ProxyService', () => {
  let root: string;
  let app: AnyPickApp;
  const openServers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-proxysvc-'));
    const accountRegistry = new ProviderRegistry();
    accountRegistry.register(
      new FakeProvider('p', join(root, 'live', 'p'), { withProxy: true, defaultProxyPort: 19100 }),
    );
    // A provider with no startProxy: must be rejected for proxy operations.
    accountRegistry.register(new FakeProvider('noproxy', join(root, 'live', 'noproxy')));
    app = await createAppReady({
      root,
      bare: true,
      accountRegistry,
      clients: new ClientRegistry(),
      catalog: new CatalogRegistry(),
      db: openDatabase(root),
    });
  });

  afterEach(async () => {
    for (const s of openServers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    try {
      await app.proxy.stopProxies('p');
    } catch {
      // best effort
    }
    app?.close();
    await rm(root, { recursive: true, force: true });
  });

  describe('capability gating', () => {
    it('refuses proxy operations for a provider without startProxy', () => {
      expect(() => app.proxy.requireProxyProvider('noproxy')).toThrow();
    });

    it('accepts a provider that implements startProxy', () => {
      expect(app.proxy.requireProxyProvider('p').id).toBe('p');
    });
  });

  describe('port allocation', () => {
    it("uses the provider's default port when it is free", async () => {
      await seedAccount(app, 'p', 'work');
      const { config } = await app.proxy.enableProxy('p', 'work', {});
      expect(config.enabled).toBe(true);
      expect(config.port).toBe(19100);
    });

    it('does not hand the same port to two accounts', async () => {
      await seedAccount(app, 'p', 'one');
      await seedAccount(app, 'p', 'two');

      const first = await app.proxy.enableProxy('p', 'one', {});
      const second = await app.proxy.enableProxy('p', 'two', {});

      expect(first.config.port).toBeDefined();
      expect(second.config.port).toBeDefined();
      expect(second.config.port).not.toBe(first.config.port);
    });

    it('refuses an explicit port held by a foreign process rather than silently moving it', async () => {
      const occupied = await occupyPort();
      openServers.push(occupied.server);
      await seedAccount(app, 'p', 'work');

      // An explicitly requested port is validated, not relocated: silently
      // moving a port the user typed would make `-p` a suggestion instead of an
      // instruction. Auto-allocation (no explicit port) is what walks upward.
      await expect(app.proxy.configureProxy('p', 'work', { port: occupied.port })).rejects.toThrow(
        /already in use/i,
      );
    });

    it('auto-allocates around a port held by a foreign process', async () => {
      const occupied = await occupyPort();
      openServers.push(occupied.server);
      await seedAccount(app, 'p', 'work');

      // Saved preference points at the occupied port, but because the caller did
      // not request it explicitly, allocation walks past it.
      await app.accountStore.setProxyConfig('p', 'work', {
        enabled: false,
        port: occupied.port,
      });

      const { config } = await app.proxy.enableProxy('p', 'work', {});
      expect(config.port).not.toBe(occupied.port);
    });

    it('rejects an explicit port already reserved by another account', async () => {
      await seedAccount(app, 'p', 'one');
      await seedAccount(app, 'p', 'two');
      const first = await app.proxy.enableProxy('p', 'one', { port: 19150 });
      expect(first.config.port).toBe(19150);

      await expect(app.proxy.enableProxy('p', 'two', { port: 19150 })).rejects.toThrow(/19150/);
    });

    it('rejects a non-loopback listen host', async () => {
      await seedAccount(app, 'p', 'work');
      await expect(app.proxy.enableProxy('p', 'work', { host: '0.0.0.0' })).rejects.toThrow();
    });
  });

  describe('lifecycle and leases', () => {
    it('records a lease when a proxy starts and releases it on stop', async () => {
      await seedAccount(app, 'p', 'work');
      await app.proxy.enableProxy('p', 'work', {});

      const handle = await app.proxy.startProxy('p', 'work');
      expect(handle.startedNow).toBe(true);
      expect(app.leases.list().length).toBe(1);
      expect(app.leases.list()[0]?.provider).toBe('p');

      await app.proxy.stopProxy('p', 'work');
      expect(app.leases.list()).toHaveLength(0);
    });

    /**
     * A pool once wrote its members' absolute snapshot paths onto the primary
     * account's proxy config, and nothing removed them when the pool went back
     * to single mode. Providers give `authDirs` precedence over the account's
     * own snapshot dir, so the account served whatever those paths held —
     * including a dead path, after the data directory was renamed.
     */
    it('does not hand a single-account proxy leftover pool options', async () => {
      await seedAccount(app, 'p', 'work');
      await app.proxy.enableProxy('p', 'work', {});
      const stored = await app.accountStore.getAccount('p', 'work');
      await app.accountStore.setProxyConfig('p', 'work', {
        ...stored!.proxy,
        options: { pool: true, authDirs: ['/gone/providers/p/accounts/other/snapshot'], keep: 1 },
      });

      await app.proxy.startProxy('p', 'work');

      const provider = app.accounts.provider('p') as InstanceType<typeof FakeProvider>;
      expect(provider.lastProxyContext?.config.options).toEqual({ keep: 1 });
    });

    it('is idempotent: a second start reuses the running process', async () => {
      await seedAccount(app, 'p', 'work');
      await app.proxy.enableProxy('p', 'work', {});

      const first = await app.proxy.startProxy('p', 'work');
      const second = await app.proxy.startProxy('p', 'work');

      expect(first.startedNow).toBe(true);
      expect(second.startedNow).toBeFalsy();
      expect(second.endpoint).toBe(first.endpoint);
      // Exactly one lease, not one per call.
      expect(app.leases.list()).toHaveLength(1);
    });

    it('reports running status with an endpoint while up', async () => {
      await seedAccount(app, 'p', 'work');
      await app.proxy.enableProxy('p', 'work', {});
      await app.proxy.startProxy('p', 'work');

      const status = await app.proxy.proxyStatus('p', 'work');
      expect(status.running).toBe(true);
      expect(status.endpoint).toBeTruthy();
    });

    it('stop is safe when nothing is running', async () => {
      await seedAccount(app, 'p', 'work');
      await app.proxy.enableProxy('p', 'work', {});
      await expect(app.proxy.stopProxy('p', 'work')).resolves.toBeUndefined();
    });

    it('disableProxy turns the config off', async () => {
      await seedAccount(app, 'p', 'work');
      await app.proxy.enableProxy('p', 'work', {});
      const cfg = await app.proxy.disableProxy('p', 'work');
      expect(cfg.enabled).toBe(false);
    });

    it('restoreProxyConfig puts back an exact prior config', async () => {
      await seedAccount(app, 'p', 'work');
      const { config: before } = await app.proxy.enableProxy('p', 'work', { port: 19200 });
      await app.proxy.disableProxy('p', 'work');

      await app.proxy.restoreProxyConfig('p', 'work', before);
      const rows = await app.proxy.listProxyRows('p');
      const row = rows.find((r) => r.name === 'work');
      expect(row?.status.enabled).toBe(true);
      expect(row?.status.port).toBe(19200);
    });
  });

  describe('pools', () => {
    it('defaults to single mode', async () => {
      const pool = await app.proxy.getPool('p');
      expect(pool.mode).toBe('single');
    });

    it('enabling multi mode records members and a port', async () => {
      await seedAccount(app, 'p', 'one');
      await seedAccount(app, 'p', 'two');

      const { pool } = await app.proxy.enablePoolMulti('p', { port: 19300 });
      expect(pool.mode).toBe('multi');
      expect(pool.enabled).toBe(true);
      expect(pool.port).toBe(19300);

      const disabled = await app.proxy.disablePoolMulti('p');
      expect(disabled.mode).toBe('single');
    });

    it('rejects a non-loopback pool host', async () => {
      await expect(app.proxy.enablePoolMulti('p', { host: '0.0.0.0' })).rejects.toThrow();
    });

    it('can pause an individual pool member', async () => {
      await seedAccount(app, 'p', 'one');
      await app.proxy.enablePoolMulti('p', {});
      const pool = await app.proxy.setPoolMemberEnabled('p', 'one', false);
      expect(pool.members.find((m) => m.account === 'one')?.enabled).toBe(false);
    });
  });
});
