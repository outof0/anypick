import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestEnv, type FakeProvider } from './helpers';
import type { AccountService } from '../src/core/service';
import { refreshCodexAuth } from '../src/providers/codex-refresh';

describe('stash + refresh', () => {
  let service: AccountService;
  let fake: FakeProvider;
  let root: string;

  beforeEach(async () => {
    const env = await createTestEnv(['fake']);
    service = env.service;
    fake = env.fakes.fake;
    root = env.root;
    await fake.setLive({ email: 'a@x.com', token: 't1' });
    await service.save('fake', 'work');
  });

  afterEach(async () => {
    await fake.dispose();
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  it('stash backs up then removes live without logout', async () => {
    await fake.setLive({ email: 'a@x.com', token: 't-live-new' });
    const result = await service.stash('fake');
    expect(result.cleared).toBe(true);
    // same email as "work" → reuse that account
    expect(result.backedUpTo).toBe('work');
    expect(result.matchedByIdentity).toBe(true);

    const live = await fake.detectLive();
    expect(live.present).toBe(false);

    const account = await service['store'].requireAccount('fake', 'work');
    const snap = JSON.parse(await readFile(join(account.snapshotDir, 'auth.json'), 'utf8')) as {
      token: string;
    };
    expect(snap.token).toBe('t-live-new');

    await service.use('fake', 'work', { noRefresh: true });
    expect((await fake.detectLive()).present).toBe(true);
  });

  it('stash reuses existing account when email matches (no duplicate)', async () => {
    // work has a@x.com; switch live to a new email and save it once.
    await fake.setLive({ email: 'b@y.com', token: 'tb' });
    await service.save('fake', 'bob');

    // Live still b@y.com → stash should update bob, not create new
    await fake.setLive({ email: 'b@y.com', token: 'tb-refreshed' });
    const result = await service.stash('fake');
    expect(result.matchedByIdentity).toBe(true);
    expect(result.backedUpTo).toBe('bob');

    const list = await service.list('fake');
    const bAccounts = list.filter((a) => a.identity?.toLowerCase() === 'b@y.com');
    expect(bAccounts).toHaveLength(1);
    expect(bAccounts[0].name).toBe('bob');
  });

  it('saveCurrent overwrites the existing identity and never invents default', async () => {
    await fake.setLive({ email: 'a@x.com', token: 't-refreshed' });

    const meta = await service.saveCurrent('fake');

    expect(meta.name).toBe('work');
    expect((await service.list('fake')).map((a) => a.name)).toEqual(['work']);
    const account = await service.get('fake', 'work');
    const auth = JSON.parse(await readFile(join(account!.snapshotDir, 'auth.json'), 'utf8')) as {
      token: string;
    };
    expect(auth.token).toBe('t-refreshed');
  });

  it('rejects saving one identity under a second local account name', async () => {
    await expect(service.save('fake', 'default')).rejects.toMatchObject({
      code: 'ACCOUNT_IDENTITY_EXISTS',
    });

    const accounts = await service.list('fake');
    expect(accounts.map((a) => a.name)).toEqual(['work']);
  });

  it('rejects importing one identity under a second local account name', async () => {
    const exported = join(root, 'account.json');
    await service.exportAccount('fake', 'work', exported);

    await expect(service.importAccount('fake', 'default', exported)).rejects.toMatchObject({
      code: 'ACCOUNT_IDENTITY_EXISTS',
    });

    const accounts = await service.list('fake');
    expect(accounts.map((a) => a.name)).toEqual(['work']);
  });

  it('stash creates name from email when no match', async () => {
    await fake.setLive({ email: 'newbie@z.com', token: 'tn' });
    // work is a@x.com active; identity differs → new slug from email
    const result = await service.stash('fake');
    expect(result.matchedByIdentity).toBe(false);
    expect(result.backedUpTo).toBe('newbie');
    expect(result.cleared).toBe(true);

    const list = await service.list('fake');
    expect(list.some((a) => a.name === 'newbie')).toBe(true);
  });

  it('stash refreshes the existing identity instead of creating a forced duplicate', async () => {
    await fake.setLive({ email: 'a@x.com', token: 'tx' });
    const result = await service.stash('fake', { as: 'forced' });

    expect(result.backedUpTo).toBe('work');
    expect((await service.list('fake')).map((a) => a.name)).toEqual(['work']);
  });

  it('stash routes detect/backup/clear to the source variants when a source is given', async () => {
    // A provider with more than one sign-in source (Gemini CLI vs Antigravity)
    // must not have its default credential store cleared for the other source.
    const seen: string[] = [];
    const multi = fake as typeof fake & {
      detectLiveSource?: (s: string) => Promise<{ present: boolean; identity?: string }>;
      backupSource?: (s: string, destDir: string) => Promise<{ identity?: string }>;
      clearLiveSource?: (s: string) => Promise<void>;
    };
    multi.detectLiveSource = async (s) => {
      seen.push(`detect:${s}`);
      return { present: true, identity: 'alt@x.com' };
    };
    multi.backupSource = async (s, destDir) => {
      seen.push(`backup:${s}`);
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, 'auth.json'), JSON.stringify({ alt: true }));
      return { identity: 'alt@x.com' };
    };
    multi.clearLiveSource = async (s) => {
      seen.push(`clear:${s}`);
    };

    const result = await service.stash('fake', { source: 'antigravity' });

    // save() re-detects before snapshotting, hence the repeated detect.
    expect(seen).toEqual([
      'detect:antigravity',
      'detect:antigravity',
      'backup:antigravity',
      'clear:antigravity',
    ]);
    expect(result.cleared).toBe(true);
    expect(result.backedUpTo).toBe('alt');
    // The default source stayed signed in.
    expect((await fake.detectLive()).present).toBe(true);
  });

  it('refresh updates saved account snapshot', async () => {
    const results = await service.refresh('fake', 'work');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);

    const account = await service['store'].requireAccount('fake', 'work');
    const snap = JSON.parse(await readFile(join(account.snapshotDir, 'auth.json'), 'utf8')) as {
      refreshed?: boolean;
      token: string;
    };
    expect(snap.refreshed).toBe(true);
    expect(String(snap.token)).toMatch(/^refreshed-/);
  });

  it('refresh live when no name given', async () => {
    await fake.setLive({ email: 'a@x.com', token: 'live-1' });
    const results = await service.refresh('fake');
    expect(results[0].ok).toBe(true);
    expect(results[0].target).toBe('fake/live');
    const live = await fake.readLive();
    expect(live?.refreshed).toBe(true);
  });
});

async function mockRefreshTokenFetch(): Promise<Response> {
  return new Response(
    JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      id_token: 'x.e30.y',
    }),
    { status: 200 },
  );
}

describe('refreshCodexAuth', () => {
  it('posts refresh_token and updates auth object', async () => {
    const result = await refreshCodexAuth(
      {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'old',
          refresh_token: 'rt',
          id_token: 'old-id',
          account_id: 'acc',
        },
      },
      mockRefreshTokenFetch,
    );

    expect(result.auth.tokens?.access_token).toBe('new-access');
    expect(result.auth.tokens?.refresh_token).toBe('new-refresh');
    expect(result.auth.last_refresh).toBeTruthy();
  });

  it('fails without refresh_token', async () => {
    await expect(refreshCodexAuth({ tokens: { access_token: 'only' } })).rejects.toThrow(
      /refresh_token/,
    );
  });
});
