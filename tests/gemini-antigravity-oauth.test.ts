import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAntigravityOAuthCredentials,
  parseAntigravityOAuthCredential,
  readAntigravityOAuthPayload,
  hydrateAntigravityOAuthPayload,
} from '../src/providers/gemini-antigravity-oauth';
import { GeminiProvider } from '../src/providers/gemini';

describe('parseAntigravityOAuthCredential', () => {
  it('parses a go-keyring-base64 payload down to the refresh token', () => {
    const payload = {
      token: { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer' },
    };
    const raw = `go-keyring-base64:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
    const creds = parseAntigravityOAuthCredential(raw);
    expect(creds).toEqual({ refresh_token: 'rt', token_type: 'Bearer' });
  });

  it('returns null for a go-keyring payload without a refresh token', () => {
    const raw = `go-keyring-base64:${Buffer.from(JSON.stringify({ token: {} })).toString('base64')}`;
    expect(parseAntigravityOAuthCredential(raw)).toBeNull();
  });

  it('parses a raw nested JSON payload (Linux/Windows shape, no prefix)', () => {
    const raw = JSON.stringify({
      token: { access_token: 'stale', refresh_token: 'rt', token_type: 'Bearer' },
    });
    const creds = parseAntigravityOAuthCredential(raw);
    // access_token is dropped so the proxy refreshes from the durable token.
    expect(creds).toEqual({ refresh_token: 'rt', token_type: 'Bearer' });
  });

  it('returns null for a nested payload without a refresh token', () => {
    const raw = JSON.stringify({ token: { access_token: 'at' } });
    expect(parseAntigravityOAuthCredential(raw)).toBeNull();
  });

  it('parses a raw JSON credential', () => {
    const creds = parseAntigravityOAuthCredential(
      JSON.stringify({ refresh_token: 'rt', token_type: 'Bearer' }),
    );
    expect(creds).toEqual({ refresh_token: 'rt', token_type: 'Bearer' });
  });

  it('returns null when raw JSON has no usable token', () => {
    expect(parseAntigravityOAuthCredential(JSON.stringify({ token_type: 'Bearer' }))).toBeNull();
  });

  it('throws on an unsupported format', () => {
    expect(() => parseAntigravityOAuthCredential('not json at all')).toThrow(/unsupported format/);
  });
});

describe('loadAntigravityOAuthCredentials from a file', () => {
  it('reads and parses a portable credential file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anypick-antigravity-'));
    try {
      const file = join(dir, 'cred.json');
      await writeFile(file, JSON.stringify({ refresh_token: 'rt', token_type: 'Bearer' }));
      const creds = await loadAntigravityOAuthCredentials(file);
      expect(creds).toEqual({ refresh_token: 'rt', token_type: 'Bearer' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A snapshot that will be written back to the credential store has to survive
 * the round trip whole. `loadAntigravityOAuthCredentials` deliberately discards
 * the access token, which is right for the proxy and wrong for a restore.
 */
describe('readAntigravityOAuthPayload', () => {
  async function withFile<T>(contents: string, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'anypick-antigravity-'));
    try {
      const file = join(dir, 'cred.json');
      await writeFile(file, contents);
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('keeps the access token and expiry the reduced reader throws away', async () => {
    const payload = {
      token: {
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expiry: '2030-01-01T00:00:00Z',
      },
    };
    const kept = await withFile(JSON.stringify(payload), readAntigravityOAuthPayload);
    expect(kept).toEqual(payload);
    // The same file through the proxy's reader loses both, by design.
    const reduced = await withFile(JSON.stringify(payload), loadAntigravityOAuthCredentials);
    expect(reduced).toEqual({ refresh_token: 'rt', token_type: 'Bearer' });
  });

  it('wraps a flat credential so snapshots saved before this shape restore too', async () => {
    const wrapped = await withFile(
      JSON.stringify({ refresh_token: 'rt', token_type: 'Bearer' }),
      readAntigravityOAuthPayload,
    );
    expect(wrapped).toEqual({ token: { refresh_token: 'rt', token_type: 'Bearer' } });
  });

  it('refuses a payload with nothing durable to restore', async () => {
    const none = await withFile(
      JSON.stringify({ token: { access_token: 'at' } }),
      readAntigravityOAuthPayload,
    );
    expect(none).toBeNull();
  });
});

describe('hydrateAntigravityOAuthPayload', () => {
  it('materializes an access token for an older refresh-token-only snapshot', async () => {
    const payload = await hydrateAntigravityOAuthPayload(
      { token: { refresh_token: 'rt', token_type: 'Bearer' } },
      async () => new Response(JSON.stringify({ access_token: 'at', expires_in: 3_600 })),
    );

    expect(payload.token).toMatchObject({
      refresh_token: 'rt',
      token_type: 'Bearer',
      access_token: 'at',
    });
    expect(payload.token?.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not refresh a credential whose access token is still valid', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const complete = { token: { refresh_token: 'rt', access_token: 'at', expiry: future } };
    const fetchImpl = async () => {
      throw new Error('should not fetch');
    };

    await expect(hydrateAntigravityOAuthPayload(complete, fetchImpl)).resolves.toBe(complete);
  });

  it('refreshes an expired access token before writing back to the keychain', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const expired = {
      token: { refresh_token: 'rt', access_token: 'stale-at', token_type: 'Bearer', expiry: past },
    };

    const payload = await hydrateAntigravityOAuthPayload(
      expired,
      async () => new Response(JSON.stringify({ access_token: 'fresh-at', expires_in: 3_600 })),
    );

    expect(payload.token?.access_token).toBe('fresh-at');
    expect(payload.token?.refresh_token).toBe('rt');
  });

  it('refreshes a credential with no expiry field (older snapshot)', async () => {
    const noExpiry = { token: { refresh_token: 'rt', access_token: 'at' } };
    const payload = await hydrateAntigravityOAuthPayload(
      noExpiry,
      async () => new Response(JSON.stringify({ access_token: 'fresh-at', expires_in: 3_600 })),
    );

    expect(payload.token?.access_token).toBe('fresh-at');
    expect(payload.token?.refresh_token).toBe('rt');
    expect(payload.token?.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('Antigravity restore', () => {
  it('fails the account restore when the credential store rejects the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anypick-antigravity-'));
    try {
      await writeFile(
        join(dir, 'antigravity_oauth.json'),
        JSON.stringify({ token: { refresh_token: 'test-refresh-token', token_type: 'Bearer' } }),
      );
      const provider = new GeminiProvider(
        dir,
        async () => {
          throw new Error('credential store rejected write');
        },
        async (payload) => ({ ...payload, token: { ...payload.token, access_token: 'at' } }),
      );

      await expect(provider.restore(dir)).rejects.toThrow('credential store rejected write');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
