import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openForeignDatabase } from '../src/core/db';
import {
  antigravityProcessListHasApplication,
  antigravityStateDatabasePaths,
  assertAntigravityStateSafeToMutate,
  deleteAntigravityStateOAuthPayload,
  readAntigravityStateOAuthPayload,
  writeAntigravityStateOAuthPayload,
} from '../src/providers/gemini-antigravity-state';

const roots: string[] = [];

async function makeStateDatabase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anypick-antigravity-state-'));
  roots.push(root);
  const path = join(root, 'User', 'globalStorage', 'state.vscdb');
  await mkdir(dirname(path), { recursive: true });
  const db = openForeignDatabase(path);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'unrelated.setting',
      'preserve-me',
    );
  } finally {
    db.close();
  }
  return path;
}

function payload(refreshToken: string, accessToken = 'access-token') {
  return {
    token: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expiry: '2030-01-02T03:04:05.000Z',
    },
  };
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining === 0 ? byte : byte | 0x80);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function bytesField(number: number, value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function topicWithEntry(sentinel: string, value: string): string {
  const row = bytesField(1, value);
  const entry = Buffer.concat([bytesField(1, sentinel), bytesField(2, row)]);
  return bytesField(1, entry).toString('base64');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Antigravity unified OAuth state', () => {
  it('detects only the Antigravity executable, not a path mentioned by another process', () => {
    expect(
      antigravityProcessListHasApplication(
        '/Applications/Antigravity.app/Contents/MacOS/Electron\n',
        'darwin',
      ),
    ).toBe(true);
    expect(antigravityProcessListHasApplication('Antigravity IDE\n', 'darwin')).toBe(true);
    expect(
      antigravityProcessListHasApplication(
        '/usr/bin/open /Applications/Antigravity.app/Contents/MacOS/Electron\n' +
          '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper\n',
        'darwin',
      ),
    ).toBe(false);
  });

  it('uses the known global-storage paths for each desktop platform', () => {
    expect(antigravityStateDatabasePaths('/home/test', 'darwin')).toContain(
      '/home/test/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb',
    );
    expect(antigravityStateDatabasePaths('/home/test', 'linux')).toContain(
      '/home/test/.config/Antigravity IDE/User/globalStorage/state.vscdb',
    );
  });

  it('writes, reads, replaces, and removes the OAuth topic without touching other state', async () => {
    const path = await makeStateDatabase();

    await expect(
      writeAntigravityStateOAuthPayload(payload('refresh-one'), { paths: [path] }),
    ).resolves.toBe(1);
    await expect(readAntigravityStateOAuthPayload({ paths: [path] })).resolves.toEqual(
      payload('refresh-one'),
    );

    await expect(
      writeAntigravityStateOAuthPayload(payload('refresh-two', 'access-two'), { paths: [path] }),
    ).resolves.toBe(1);
    await expect(readAntigravityStateOAuthPayload({ paths: [path] })).resolves.toEqual(
      payload('refresh-two', 'access-two'),
    );

    await expect(deleteAntigravityStateOAuthPayload({ paths: [path] })).resolves.toBe(1);
    await expect(readAntigravityStateOAuthPayload({ paths: [path] })).resolves.toBeNull();

    const db = openForeignDatabase(path, true);
    try {
      expect(
        db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('unrelated.setting'),
      ).toEqual({ value: 'preserve-me' });
    } finally {
      db.close();
    }
  });

  it('invalidates the previous account profile and auth-state caches when switching', async () => {
    const path = await makeStateDatabase();
    const db = openForeignDatabase(path);
    try {
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.oauthToken',
        topicWithEntry(
          'authStateWithContextSentinelKey',
          JSON.stringify({ state: 'signedIn', context: { email: 'old@example.com' } }),
        ),
      );
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.userStatus',
        topicWithEntry('userStatusSentinelKey', 'old-profile'),
      );
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityAuthStatus',
        'old-auth',
      );
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravity.profileUrl',
        'old-profile-url',
      );
    } finally {
      db.close();
    }

    await writeAntigravityStateOAuthPayload(payload('new-refresh'), { paths: [path] });

    const verified = openForeignDatabase(path, true);
    try {
      const oauth = verified
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityUnifiedStateSync.oauthToken') as { value: string };
      const userStatus = verified
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityUnifiedStateSync.userStatus') as { value: string };
      expect(Buffer.from(oauth.value, 'base64').includes('authStateWithContextSentinelKey')).toBe(
        false,
      );
      expect(Buffer.from(oauth.value, 'base64').includes('oauthTokenInfoSentinelKey')).toBe(true);
      expect(Buffer.from(userStatus.value, 'base64')).toHaveLength(0);
      expect(
        verified
          .prepare('SELECT key FROM ItemTable WHERE key = ? OR key = ?')
          .all('antigravityAuthStatus', 'antigravity.profileUrl'),
      ).toEqual([]);
      expect(
        verified.prepare('SELECT value FROM ItemTable WHERE key = ?').get('unrelated.setting'),
      ).toEqual({ value: 'preserve-me' });
    } finally {
      verified.close();
    }
  });

  it('blocks a real account change while Antigravity is running', async () => {
    const path = await makeStateDatabase();
    await writeAntigravityStateOAuthPayload(payload('current-refresh'), { paths: [path] });
    const before = await readFile(path);

    await expect(
      assertAntigravityStateSafeToMutate({
        paths: [path],
        expectedPayload: payload('different-refresh'),
        isAppRunning: async () => true,
      }),
    ).rejects.toThrow('Quit Antigravity completely');
    expect(await readFile(path)).toEqual(before);
  });

  it('allows an idempotent restore while Antigravity is running', async () => {
    const path = await makeStateDatabase();
    const current = payload('same-refresh');
    await writeAntigravityStateOAuthPayload(current, { paths: [path] });

    await expect(
      assertAntigravityStateSafeToMutate({
        paths: [path],
        expectedPayload: current,
        isAppRunning: async () => true,
      }),
    ).resolves.toEqual([]);
  });

  it('rejects an unfamiliar state envelope before any credential mutation', async () => {
    const path = await makeStateDatabase();
    const db = openForeignDatabase(path);
    try {
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.oauthToken',
        'not-base64',
      );
    } finally {
      db.close();
    }

    await expect(
      assertAntigravityStateSafeToMutate({
        paths: [path],
        isAppRunning: async () => false,
      }),
    ).rejects.toThrow('not valid base64');
  });
});
