import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, type ClaudeCredentialStore } from '../src/providers/claude';
import type { Account } from '../src/types';

interface StoredCredential {
  account: string;
  credential: string;
}

const roots: string[] = [];

function credential(refreshToken: string, subscriptionType = 'max'): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${refreshToken}`,
      refreshToken,
      subscriptionType,
    },
  });
}

function account(provider = 'claude'): Account {
  return {
    meta: {
      name: 'work',
      provider,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    accountDir: '/unused/account',
    snapshotDir: '/unused/snapshot',
    proxy: { enabled: false },
  };
}

describe('Claude Code native provider', () => {
  let root: string;
  let current: StoredCredential | null;
  let store: ClaudeCredentialStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-claude-provider-'));
    roots.push(root);
    current = { account: 'local-user', credential: credential('refresh-one') };
    store = {
      read: vi.fn(async () => current),
      write: vi.fn(async (keychainAccount, value) => {
        current = { account: keychainAccount, credential: value };
      }),
      clear: vi.fn(async () => {
        current = null;
      }),
    };
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('backs up and restores the native credential without exposing it in metadata', async () => {
    const provider = new ClaudeProvider(root, {
      credentialStore: store,
      isOwnerRunning: async () => false,
    });
    const snapshotDir = join(root, 'snapshot');
    await mkdir(snapshotDir);

    await expect(provider.detectLive()).resolves.toMatchObject({
      present: true,
      identity: 'Claude max',
    });
    await expect(provider.backup(snapshotDir)).resolves.toEqual({ identity: 'Claude max' });

    const snapshotText = await readFile(join(snapshotDir, 'credentials.json'), 'utf8');
    expect(snapshotText).toContain('refresh-one');
    expect(JSON.stringify(await provider.describeSnapshot(snapshotDir))).not.toContain(
      'refresh-one',
    );

    current = { account: 'other-user', credential: credential('refresh-two', 'pro') };
    await expect(provider.snapshotMatchesLive(snapshotDir)).resolves.toBe(false);
    await provider.restore(snapshotDir);
    await expect(provider.snapshotMatchesLive(snapshotDir)).resolves.toBe(true);
    expect(store.write).toHaveBeenCalledWith('local-user', credential('refresh-one'));
  });

  it('blocks a restore before mutation while Claude Code owns its credential', async () => {
    const provider = new ClaudeProvider(root, {
      credentialStore: store,
      isOwnerRunning: async () => true,
    });

    await expect(provider.preflightRestore('/unused')).rejects.toMatchObject({
      code: 'RESTORE_OWNER_RUNNING',
    });
    await expect(provider.restoreOwnerStatus('/unused')).resolves.toEqual({
      name: 'Claude Code',
      running: true,
    });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('clears only the active credential and declares native-only routing', async () => {
    const provider = new ClaudeProvider(root, {
      credentialStore: store,
      isOwnerRunning: async () => false,
    });

    const adapter = provider.sourceAdapter(account());
    expect(adapter.transportFor('claude')).toBe('direct');
    expect(adapter.transportFor('codex')).toBe('unsupported');
    expect(adapter.transportFor('gemini')).toBe('unsupported');

    await provider.clearLive();
    expect(store.clear).toHaveBeenCalledWith('local-user');
    await expect(provider.detectLive()).resolves.toEqual({ present: false });
  });
});
