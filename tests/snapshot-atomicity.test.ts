import { describe, it, expect, afterEach } from 'vitest';
import { createTestEnv } from './helpers';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '../src/utils/fs';

let root: string;

async function readSnapshotAuth(
  service: Awaited<ReturnType<typeof createTestEnv>>['service'],
  providerId: string,
  name: string,
): Promise<string | null> {
  const account = await service.get(providerId, name);
  if (!account) {
    return null;
  }
  try {
    return (await readFile(join(account.snapshotDir, 'auth.json'), 'utf8')).trim();
  } catch {
    return null;
  }
}

describe('DATA-01 atomic, non-destructive snapshot save', () => {
  it('a failed backup during save preserves the previous snapshot untouched', async () => {
    const env = await createTestEnv(['fake']);
    root = env.root;
    const { service, fakes } = env;
    const fake = fakes.fake;

    await fake.setLive({ email: 'keep@me', token: 'original' });
    await service.save('fake', 'main');
    const before = await readSnapshotAuth(service, 'fake', 'main');
    expect(before).toContain('original');

    // Inject a backup failure, then attempt a refresh.
    fake.backupShouldFail = true;
    await fake.setLive({ email: 'gone@me', token: 'leaked' });

    await expect(service.save('fake', 'main', { force: true })).rejects.toThrow();

    // The previous snapshot must still be intact — no partial/empty write.
    const after = await readSnapshotAuth(service, 'fake', 'main');
    expect(after).toContain('original');
    expect(after).not.toContain('leaked');
  });

  it('a failed first save leaves no empty account or default directory', async () => {
    const env = await createTestEnv(['fake']);
    root = env.root;
    const { service, fakes, store, storeRoot } = env;
    const fake = fakes.fake;
    await fake.setLive({ email: 'new@me', token: 'secret' });
    fake.backupShouldFail = true;

    await expect(service.save('fake', 'default', { force: true })).rejects.toThrow();

    expect(await service.list('fake')).toEqual([]);
    expect(await service.get('fake', 'default')).toBeNull();
    const raw = store.db
      .prepare(`SELECT name FROM accounts WHERE provider = ? AND name = ?`)
      .get('fake', 'default');
    expect(raw).toBeUndefined();
    expect(await pathExists(join(storeRoot, 'providers', 'fake', 'accounts', 'default'))).toBe(
      false,
    );
  });

  it('a successful overwrite fully replaces the snapshot', async () => {
    const env = await createTestEnv(['fake']);
    root = env.root;
    const { service, fakes } = env;
    const fake = fakes.fake;

    await fake.setLive({ email: 'first@me', token: 'a' });
    await service.save('fake', 'main');

    await fake.setLive({ email: 'second@me', token: 'b' });
    await service.save('fake', 'main', { force: true });

    const after = await readSnapshotAuth(service, 'fake', 'main');
    expect(after).toContain('second');
    expect(after).not.toContain('first');
  });

  it('importing into a fresh account commits atomically and round-trips', async () => {
    const env = await createTestEnv(['fake']);
    root = env.root;
    const { service, fakes } = env;
    const fake = fakes.fake;

    await fake.setLive({ email: 'ok@me', token: 's' });
    await service.save('fake', 'main');
    const out = join(root, 'main.anypick.json');
    await service.exportAccount('fake', 'main', out);

    await service.delete('fake', 'main');
    await fake.clearLive();

    const meta = await service.importAccount('fake', 'restored', out);
    expect(meta.name).toBe('restored');
    expect(await readSnapshotAuth(service, 'fake', 'restored')).toContain('ok');
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = '';
    }
  });
});
