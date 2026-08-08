import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoolStore } from '../src/core/pool-store';
import { parseRef, displayRef, serializeRef, accountPoolRef } from '../src/core/refs';
import { createAppReady } from '../src/core/app';

describe('PoolStore', () => {
  let root: string;
  let pools: PoolStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-pool-'));
    const app = await createAppReady({ root, skipMigrate: true });
    pools = new PoolStore(root, app.db);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to single mode with no file', async () => {
    const p = await pools.getOrDefault('gemini');
    expect(p.mode).toBe('single');
    expect(p.enabled).toBe(false);
    expect(await pools.get('gemini')).toBeNull();
  });

  it('enableMulti then disableMulti', async () => {
    const multi = await pools.enableMulti('gemini', ['a', 'b'], { port: 4130 });
    expect(multi.mode).toBe('multi');
    expect(multi.enabled).toBe(true);
    expect(multi.members).toEqual([
      { account: 'a', enabled: true },
      { account: 'b', enabled: true },
    ]);
    expect(multi.port).toBe(4130);

    const loaded = await pools.get('gemini');
    expect(loaded?.mode).toBe('multi');

    const single = await pools.disableMulti('gemini');
    expect(single.mode).toBe('single');
    expect(single.enabled).toBe(false);
  });

  it('setMemberEnabled pauses a member', async () => {
    await pools.enableMulti('grok', ['work', 'personal']);
    const next = await pools.setMemberEnabled('grok', 'personal', false);
    expect(next.members.find((m) => m.account === 'personal')?.enabled).toBe(false);
    expect(next.members.find((m) => m.account === 'work')?.enabled).toBe(true);
  });
});

describe('pool refs', () => {
  it('parses pool:gemini and pool/gemini', () => {
    expect(parseRef('pool:gemini')).toEqual(accountPoolRef('gemini'));
    expect(parseRef('pool/grok')).toEqual(accountPoolRef('grok'));
    expect(displayRef(accountPoolRef('gemini'))).toBe('pool:gemini');
    expect(serializeRef(accountPoolRef('gemini'))).toBe('pool/gemini');
  });

  it('rejects unknown provider in pool ref', () => {
    expect(() => parseRef('pool:nope')).toThrow(/Unknown account provider/);
  });
});

describe('AccountService pool API', () => {
  it('enablePoolMulti requires accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-pool-svc-'));
    try {
      const app = await createAppReady({ root, skipMigrate: true });
      await expect(app.proxy.enablePoolMulti('gemini')).rejects.toMatchObject({
        code: 'NO_ACCOUNTS',
      });
      const pool = await app.proxy.getPool('gemini');
      expect(pool.mode).toBe('single');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([-1, 1.5, 65536, Number.NaN])(
    'rejects invalid shared port %s before persisting',
    async (port) => {
      const root = await mkdtemp(join(tmpdir(), 'anypick-pool-port-'));
      try {
        const app = await createAppReady({ root, skipMigrate: true });
        const { snapshotDir } = await app.accountStore.prepareSnapshot('gemini', 'one');
        await writeFile(join(snapshotDir, 'auth.json'), JSON.stringify({ token: 'one' }));
        const now = new Date().toISOString();
        await app.accountStore.writeMeta({
          name: 'one',
          provider: 'gemini',
          createdAt: now,
          updatedAt: now,
        });

        await expect(
          app.proxy.enablePoolMulti('gemini', { port, start: false }),
        ).rejects.toMatchObject({ code: 'PROXY_PORT_INVALID' });
        expect((await app.proxy.getPool('gemini')).mode).toBe('single');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
