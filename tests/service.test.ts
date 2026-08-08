import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '../src/utils/fs';
import { createTestEnv } from './helpers';
import { HotplugError } from '../src/utils/errors';

describe('AccountService', () => {
  it('saves, lists, switches, and deletes accounts in isolation', async () => {
    const { service, fakes } = await createTestEnv(['alpha', 'beta']);

    await fakes.alpha.setLive({ email: 'a1@example.com', token: 't1' });
    await service.save('alpha', 'work');

    await fakes.alpha.setLive({ email: 'a2@example.com', token: 't2' });
    await service.save('alpha', 'personal');

    await fakes.beta.setLive({ email: 'b@example.com', token: 'tb' });
    await service.save('beta', 'work');

    const all = await service.list();
    expect(all).toHaveLength(3);
    expect(all.filter((a) => a.provider === 'alpha')).toHaveLength(2);
    expect(all.filter((a) => a.provider === 'beta')).toHaveLength(1);

    // Active was set on first save per provider
    const alphaList = await service.list('alpha');
    expect(alphaList.find((a) => a.name === 'work')?.active).toBe(true);

    // The live Work token may have refreshed while it was in use. Preserve it
    // in Work before restoring Personal.
    await fakes.alpha.setLive({ email: 'a1@example.com', token: 't1-refreshed' });
    const beforeSwitch = await service.list('alpha');
    expect(beforeSwitch.find((account) => account.name === 'work')?.isLiveMatch).toBe(true);
    expect(beforeSwitch.find((account) => account.name === 'personal')?.isLiveMatch).toBe(false);
    const result = await service.use('alpha', 'personal');
    expect(result.to).toBe('personal');
    expect(result.from).toBe('work');
    expect(result.refreshedPrevious).toBe(true);
    expect(result.refreshedAccount).toBe('work');

    const live = await fakes.alpha.readLive();
    expect(live?.email).toBe('a2@example.com');
    expect(live?.token).toBe('t2');

    // beta untouched
    const betaLive = await fakes.beta.readLive();
    expect(betaLive?.email).toBe('b@example.com');

    await service.delete('alpha', 'work');
    expect(await service.list('alpha')).toHaveLength(1);
  });

  it('refreshes the saved account matching live auth instead of a stale active pointer', async () => {
    const { service, fakes } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'work@example.test', token: 'work' });
    await service.save('fake', 'work');
    await fakes.fake.setLive({ email: 'personal@example.test', token: 'personal' });
    await service.save('fake', 'personal');
    await fakes.fake.setLive({ email: 'other@example.test', token: 'other' });
    await service.save('fake', 'other');

    // The DB pointer is still Work, but auth.json belongs to Personal and has
    // a refreshed token. Switching to Other must update Personal, not Work.
    await fakes.fake.setLive({
      email: 'personal@example.test',
      token: 'personal-refreshed',
    });
    const result = await service.use('fake', 'other');

    expect(result.refreshedPrevious).toBe(false);
    expect(result.refreshedAccount).toBe('personal');
    const personal = await service.get('fake', 'personal');
    const work = await service.get('fake', 'work');
    const personalAuth = JSON.parse(
      await readFile(join(personal!.snapshotDir, 'auth.json'), 'utf8'),
    ) as { token: string };
    const workAuth = JSON.parse(await readFile(join(work!.snapshotDir, 'auth.json'), 'utf8')) as {
      token: string;
    };
    expect(personalAuth.token).toBe('personal-refreshed');
    expect(personal?.meta.label).toBeUndefined();
    expect(workAuth.token).toBe('work');
  });

  it('does not overwrite a saved account when the live login is unsaved', async () => {
    const { service, fakes } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'work@example.test', token: 'work' });
    await service.save('fake', 'work');
    await fakes.fake.setLive({ email: 'personal@example.test', token: 'personal' });
    await service.save('fake', 'personal');
    await fakes.fake.setLive({ email: 'new@example.test', token: 'new' });

    await expect(service.use('fake', 'personal')).rejects.toMatchObject({
      code: 'UNSAVED_LIVE_AUTH',
    });
    expect(await service.getActive('fake')).toBe('work');
    expect(await fakes.fake.readLive()).toEqual({
      email: 'new@example.test',
      token: 'new',
    });
  });

  it('refuses save when no live auth', async () => {
    const { service } = await createTestEnv(['fake']);
    await expect(service.save('fake', 'x')).rejects.toBeInstanceOf(HotplugError);
  });

  it('restores the previous live auth and active pointer when a switch fails mid-restore', async () => {
    const { service, fakes, store } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'work@example.test', token: 'work' });
    await service.save('fake', 'work');
    await fakes.fake.setLive({ email: 'personal@example.test', token: 'personal' });
    await service.save('fake', 'personal');
    await fakes.fake.setLive({ email: 'work@example.test', token: 'work' });

    const target = await store.requireAccount('fake', 'personal');
    const restore = fakes.fake.restore.bind(fakes.fake);
    fakes.fake.restore = async (snapshotDir) => {
      await restore(snapshotDir);
      if (snapshotDir === target.snapshotDir) {
        throw new Error('Injected restore failure after partial write');
      }
    };

    await expect(service.use('fake', 'personal')).rejects.toThrow('Injected restore failure');
    expect(await fakes.fake.readLive()).toEqual({ email: 'work@example.test', token: 'work' });
    expect(await service.getActive('fake')).toBe('work');
  });

  it('exports and imports accounts', async () => {
    const { service, fakes, root } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'export@me', token: 'secret' });
    await service.save('fake', 'main');

    const out = join(root, 'main.hotplug.json');
    await service.exportAccount('fake', 'main', out);
    expect(await pathExists(out)).toBe(true);

    await service.delete('fake', 'main');
    await fakes.fake.clearLive();

    await service.importAccount('fake', 'restored', out);
    await service.use('fake', 'restored');
    const live = await fakes.fake.readLive();
    expect(live?.email).toBe('export@me');
    expect(live?.token).toBe('secret');
  });

  it('does not allow import overwrite without force', async () => {
    const { service, fakes, root } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'a@x', token: '1' });
    await service.save('fake', 'main');
    const out = join(root, 'e.hotplug.json');
    await service.exportAccount('fake', 'main', out);

    await expect(service.importAccount('fake', 'main', out)).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });

    await service.importAccount('fake', 'main', out, { force: true });
  });

  it('rejects unknown providers', async () => {
    const { service } = await createTestEnv();
    expect(() => service.provider('nope')).toThrow(HotplugError);
  });

  it('keeps provider accounts fully isolated', async () => {
    const { service, fakes } = await createTestEnv(['codex', 'grok']);
    await fakes.codex.setLive({ email: 'c@x', token: 'c' });
    await fakes.grok.setLive({ email: 'g@x', token: 'g' });
    await service.save('codex', 'work');
    await service.save('grok', 'work');

    await fakes.codex.setLive({ email: 'c2@x', token: 'c2' });
    await service.save('codex', 'other');
    await service.use('codex', 'work');

    // grok still original
    expect((await fakes.grok.readLive())?.token).toBe('g');
    // codex switched
    expect((await fakes.codex.readLive())?.token).toBe('c');
  });
});
