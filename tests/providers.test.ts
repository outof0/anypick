import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../src/providers/codex';
import { GrokProvider } from '../src/providers/grok';
import { KiroProvider } from '../src/providers/kiro';
import { readKiroSecrets, writeKiroSecrets } from '../src/providers/kiro-secret-store';
import { OpenCodeProvider } from '../src/providers/opencode';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hotplug-prov-'));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

describe('CodexProvider', () => {
  it('backs up and restores auth.json', async () => {
    const home = await tempHome();
    const codexDir = join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    const auth = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'at',
        refresh_token: 'rt',
        account_id: 'acct_1234567890',
      },
    };
    await writeFile(join(codexDir, 'auth.json'), JSON.stringify(auth));

    const provider = new CodexProvider(home);
    const live = await provider.detectLive();
    expect(live.present).toBe(true);

    const snap = join(home, 'snap');
    await mkdir(snap);
    await provider.backup(snap);

    // Corrupt live, then restore
    await writeFile(join(codexDir, 'auth.json'), '{}');
    await provider.restore(snap);
    const restored = JSON.parse(await readFile(join(codexDir, 'auth.json'), 'utf8'));
    expect(restored.tokens.access_token).toBe('at');
  });

  it('extracts email from ChatGPT JWT claims (id_token or access_token profile)', async () => {
    const home = await tempHome();
    const codexDir = join(home, '.codex');
    await mkdir(codexDir, { recursive: true });

    // Minimal JWT: header.payload.sig with base64url payload containing email
    const payload = Buffer.from(JSON.stringify({ email: 'work@acme.com', name: 'Work' })).toString(
      'base64url',
    );
    const jwt = `eyJhbGciOiJub25lIn0.${payload}.sig`;

    await writeFile(
      join(codexDir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt,
          access_token: 'at',
          refresh_token: 'rt',
          account_id: '26ec4fcd-6904-4009-a368-503d226ac7fa',
        },
      }),
    );

    const provider = new CodexProvider(home);
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('work@acme.com');
    expect(live.details).toMatch(/chatgpt/);
  });

  it('reads email from access_token openai profile claim when id_token lacks it', async () => {
    const home = await tempHome();
    const codexDir = join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    const accessPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/profile': { email: 'from-access@acme.com' },
      }),
    ).toString('base64url');
    const accessJwt = `eyJhbGciOiJub25lIn0.${accessPayload}.sig`;

    await writeFile(
      join(codexDir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessJwt,
          refresh_token: 'rt',
          account_id: 'acct-1',
        },
      }),
    );

    const live = await new CodexProvider(home).detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('from-access@acme.com');
  });

  it('labels API-key mode without ChatGPT tokens', async () => {
    const home = await tempHome();
    const codexDir = join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'apikey',
        OPENAI_API_KEY: 'sk-test-key',
      }),
    );
    const live = await new CodexProvider(home).detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('API key');
  });

  it('reads usage only for the account currently live in auth.json', async () => {
    const home = await tempHome();
    const codexDir = join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'live-token', account_id: 'acct-live' },
      }),
    );
    let request: Request | undefined;
    const provider = new CodexProvider(home, async (input, init) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 60, limit_window_seconds: 604_800 },
          },
        }),
      );
    });

    await expect(provider.liveUsage()).resolves.toEqual({
      windows: [
        { label: '5h', remainingPercent: 75 },
        { label: '7d', remainingPercent: 40 },
      ],
    });
    expect(request?.headers.get('authorization')).toBe('Bearer live-token');
    expect(request?.headers.get('chatgpt-account-id')).toBe('acct-live');
  });

  it('does not query usage when Codex Desktop reports another live account', async () => {
    const home = await tempHome();
    const codexDir = join(home, '.codex');
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'old-token', account_id: 'acct-file' } }),
    );
    const sentryDir = join(home, 'Library', 'Application Support', 'Codex', 'sentry');
    await mkdir(sentryDir, { recursive: true });
    await writeFile(
      join(sentryDir, 'scope_v3.json'),
      JSON.stringify({ scope: { user: { account_id: 'acct-desktop', authMethod: 'chatgpt' } } }),
    );
    let calls = 0;
    const provider = new CodexProvider(home, async () => {
      calls += 1;
      return new Response('{}');
    });

    // Account switching follows the auth file that backup/restore can mutate,
    // never the Desktop telemetry session.
    await expect(provider.detectLive()).resolves.toMatchObject({
      present: true,
      accountId: 'acct-file',
    });
    await expect(provider.liveUsage()).resolves.toBeNull();
    expect(calls).toBe(0);

    const fileSnapshot = join(home, 'file-snapshot');
    const desktopSnapshot = join(home, 'desktop-snapshot');
    await mkdir(fileSnapshot);
    await mkdir(desktopSnapshot);
    await writeFile(
      join(fileSnapshot, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'old-token', account_id: 'acct-file' } }),
    );
    await writeFile(
      join(desktopSnapshot, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: 'desktop-token', account_id: 'acct-desktop' },
      }),
    );
    await expect(provider.snapshotMatchesLive(fileSnapshot)).resolves.toBe(true);
    await expect(provider.snapshotMatchesLive(desktopSnapshot)).resolves.toBe(false);
  });

  it('fingerprints Codex by refresh_token session, not only account_id/email', async () => {
    const { fingerprintCodexAuth } = await import('../src/providers/auth-fingerprint');
    const sameAccountDifferentSession = fingerprintCodexAuth({
      tokens: {
        account_id: 'acct-aaa',
        refresh_token: 'rt-one',
        access_token: 'at-1',
      },
    });
    const sameAccountOtherSession = fingerprintCodexAuth({
      tokens: {
        account_id: 'acct-aaa',
        refresh_token: 'rt-two',
        access_token: 'at-2',
      },
    });
    const exactCopy = fingerprintCodexAuth({
      tokens: {
        account_id: 'acct-aaa',
        refresh_token: 'rt-one',
        access_token: 'at-9',
      },
    });
    // Same ChatGPT account, different login sessions → not the same live
    expect(sameAccountDifferentSession).not.toBe(sameAccountOtherSession);
    // Same refresh_token → same live session
    expect(sameAccountDifferentSession).toBe(exactCopy);
  });
});

describe('OpenCode auth fingerprint', () => {
  it('matches identical API key bags regardless of identity label', async () => {
    const { fingerprintOpenCodeAuth } = await import('../src/providers/auth-fingerprint');
    const { extractOpenCodeIdentity } = await import('../src/providers/opencode-auth');
    const bag = {
      deepseek: { type: 'api', key: 'sk-aaa' },
      'opencode-go': { type: 'api', key: 'sk-bbb' },
    };
    const fp1 = fingerprintOpenCodeAuth(bag);
    const fp2 = fingerprintOpenCodeAuth({ ...bag });
    expect(fp1).toBe(fp2);
    expect(fp1).toBeTruthy();
    // Display identity is stable short form — not a raw key dump for matching
    expect(extractOpenCodeIdentity(bag)).toBe('2 api keys');
  });
});

describe('GrokProvider', () => {
  it('matches sessions by their durable refresh token across access-key rotation', async () => {
    const { fingerprintGrokAuth } = await import('../src/providers/auth-fingerprint');
    const initial = fingerprintGrokAuth({
      session: { refresh_token: 'rt-one', key: 'access-one', expires_at: '2026-07-27T01:00:00Z' },
    });
    const refreshed = fingerprintGrokAuth({
      session: { refresh_token: 'rt-one', key: 'access-two', expires_at: '2026-07-27T02:00:00Z' },
    });
    const otherLogin = fingerprintGrokAuth({
      session: { refresh_token: 'rt-two', key: 'access-three', expires_at: '2026-07-27T03:00:00Z' },
    });

    expect(initial).toBe(refreshed);
    expect(initial).not.toBe(otherLogin);
  });

  it('extracts email identity', async () => {
    const home = await tempHome();
    const grokDir = join(home, '.grok');
    await mkdir(grokDir, { recursive: true });
    await writeFile(
      join(grokDir, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::client': {
          email: 'user@x.ai',
          refresh_token: 'r',
        },
      }),
    );

    const provider = new GrokProvider(home);
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('user@x.ai');
  });
});

describe('KiroProvider', () => {
  it('leaves kirolink request tracing enabled so proxy logs are useful', async () => {
    const home = await tempHome();
    const entry = join(home, 'kirolink-test.cjs');
    const runtimeDir = join(home, 'runtime');
    const port = await availablePort();
    await writeFile(
      entry,
      `const http = require('node:http');
const args = process.argv.slice(2);
console.log(JSON.stringify({ args }));
const port = Number(args[args.indexOf('-p') + 1]);
const host = args[args.indexOf('--host') + 1];
http.createServer((_request, response) => response.end('ok')).listen(port, host);`,
    );

    const previousEntry = process.env.KIROLINK_JS;
    process.env.KIROLINK_JS = entry;
    const provider = new KiroProvider(home);
    const ctx = {
      providerId: 'kiro',
      accountName: 'work',
      snapshotDir: join(home, 'snapshot'),
      runtimeDir,
      config: { enabled: true, host: '127.0.0.1', port },
    };

    try {
      await provider.startProxy(ctx);
      const output = JSON.parse((await readFile(join(runtimeDir, 'proxy.log'), 'utf8')).trim()) as {
        args: string[];
      };
      expect(output.args).not.toContain('-q');
      expect(output.args).not.toContain('--quiet');
    } finally {
      await provider.stopProxy(ctx);
      if (previousEntry === undefined) {
        delete process.env.KIROLINK_JS;
      } else {
        process.env.KIROLINK_JS = previousEntry;
      }
    }
  });

  it('backs up both token files when present', async () => {
    const home = await tempHome();
    const cache = join(home, '.aws', 'sso', 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, 'kiro-auth-token.json'),
      JSON.stringify({ accessToken: 'a', email: 'k@aws' }),
    );
    await writeFile(join(cache, 'kiro-auth-token-cli.json'), JSON.stringify({ accessToken: 'b' }));

    const provider = new KiroProvider(home);
    const snap = join(home, 'snap');
    await mkdir(snap);
    const meta = await provider.backup(snap);
    expect(meta.identity).toBe('k@aws');

    // Clear and restore
    await writeFile(join(cache, 'kiro-auth-token.json'), '{}');
    await provider.restore(snap);
    const restored = JSON.parse(await readFile(join(cache, 'kiro-auth-token.json'), 'utf8'));
    expect(restored.accessToken).toBe('a');
  });

  it('errors when no tokens exist', async () => {
    const home = await tempHome();
    const provider = new KiroProvider(home);
    const snap = join(home, 'snap');
    await mkdir(snap);
    await expect(provider.backup(snap)).rejects.toThrow(/No Kiro login/);
  });

  it('finds a Kiro IDE token whose filename is a hash, and ignores registrations', async () => {
    const home = await tempHome();
    const cache = join(home, '.aws', 'sso', 'cache');
    await mkdir(cache, { recursive: true });
    // What the IDE writes: a SHA-1 named token beside the client registration
    // that shares the directory and carries no credential.
    await writeFile(
      join(cache, 'd2b1f0e4c9a8b7d6e5f4a3b2c1d0e9f8a7b6c5d4.json'),
      JSON.stringify({
        accessToken: 'ide-token',
        profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/IDE',
        expiresAt: '2030-01-01T00:00:00Z',
      }),
    );
    await writeFile(
      join(cache, 'aaaabbbbccccdddd.json'),
      JSON.stringify({ clientId: 'c', clientSecret: 's', expiresAt: '2030-01-01T00:00:00Z' }),
    );

    const provider = new KiroProvider(home);
    const live = await provider.detectLive();

    expect(live.present).toBe(true);
    expect(live.details).toContain('d2b1f0e4');
    expect(live.details).not.toContain('aaaabbbb');
  });

  it('does not leave another account behind when restoring', async () => {
    const home = await tempHome();
    const cache = join(home, '.aws', 'sso', 'cache');
    await mkdir(cache, { recursive: true });

    // Save account A, which the IDE stored under its own hashed filename.
    await writeFile(
      join(cache, 'aaaa1111.json'),
      JSON.stringify({ accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z' }),
    );
    const provider = new KiroProvider(home);
    const snapA = join(home, 'snap-a');
    await mkdir(snapA);
    await provider.backup(snapA);

    // Account B arrives under a different name and expires later, so leaving A
    // in place would let the proxy pick A back up after switching to B.
    await writeFile(
      join(cache, 'bbbb2222.json'),
      JSON.stringify({ accessToken: 'b', expiresAt: '2031-01-01T00:00:00Z' }),
    );

    await provider.restore(snapA);

    const live = await provider.detectLive();
    expect(live.details).toBe('aaaa1111.json');
    await expect(readFile(join(cache, 'bbbb2222.json'), 'utf8')).rejects.toThrow();
  });
});

describe('KiroProvider secret store', () => {
  async function kiroHome(): Promise<string> {
    const home = await tempHome();
    // Keychain access is disabled suite-wide (tests/setup.ts); point the
    // SQLite tier at a throwaway file so kiro-cli's real store is never opened.
    process.env.HOTPLUG_KIRO_SECRET_DB = join(home, 'kiro-data.sqlite3');
    return home;
  }

  afterEach(() => {
    delete process.env.HOTPLUG_KIRO_SECRET_DB;
  });

  const token = (profile: string) =>
    JSON.stringify({
      access_token: 'a'.repeat(40),
      refresh_token: 'r'.repeat(20),
      expires_at: '2030-01-01T00:00:00Z',
      provider: 'google',
      profile_arn: `arn:aws:codewhisperer:us-east-1:1:profile/${profile}`,
    });

  it('detects a login that exists only in the secret store', async () => {
    const home = await kiroHome();
    await writeKiroSecrets({ 'kirocli:social:token': token('ONE') }, home);

    const live = await new KiroProvider(home).detectLive();

    expect(live.present).toBe(true);
    expect(live.details).toBe('kiro-cli secret store');
    // No email is available anywhere in the token, so the profile id is what
    // tells two Google logins apart.
    expect(live.identity).toBe('google:ONE');
  });

  it('round-trips the secret store through backup and restore', async () => {
    const home = await kiroHome();
    const provider = new KiroProvider(home);
    await writeKiroSecrets({ 'kirocli:social:token': token('ONE') }, home);

    const snap = join(home, 'snap');
    await mkdir(snap);
    const meta = await provider.backup(snap);
    expect(meta.identity).toBe('google:ONE');
    await expect(provider.snapshotMatchesLive(snap)).resolves.toBe(true);

    // A second login replaces the first, exactly as kiro-cli login would.
    await writeKiroSecrets({ 'kirocli:social:token': token('TWO') }, home);
    await expect(provider.snapshotMatchesLive(snap)).resolves.toBe(false);

    await provider.restore(snap);
    await expect(provider.snapshotMatchesLive(snap)).resolves.toBe(true);
    expect(await readKiroSecrets(home)).toEqual({ 'kirocli:social:token': token('ONE') });
  });

  it('clears the secret store, not just the cache files', async () => {
    const home = await kiroHome();
    await writeKiroSecrets({ 'kirocli:social:token': token('ONE') }, home);

    await new KiroProvider(home).clearLive();

    expect(await readKiroSecrets(home)).toEqual({});
    await expect(new KiroProvider(home).detectLive()).resolves.toEqual({ present: false });
  });
});

describe('KiroProvider api key', () => {
  async function apiKeySnapshot(secret = 'ksk_test_key_long_enough'): Promise<{
    home: string;
    provider: KiroProvider;
    snap: string;
  }> {
    const home = await tempHome();
    process.env.HOTPLUG_KIRO_SECRET_DB = join(home, 'kiro-data.sqlite3');
    const provider = new KiroProvider(home);
    const snap = join(home, 'snap');
    await mkdir(snap);
    await provider.backupInput({ kind: 'api-key', secret, options: { region: 'eu-1' } }, snap);
    return { home, provider, snap };
  }

  afterEach(() => {
    delete process.env.HOTPLUG_KIRO_SECRET_DB;
  });

  it('saves the key as a proxy-only snapshot with a non-disclosing identity', async () => {
    const home = await tempHome();
    const provider = new KiroProvider(home);
    const snap = join(home, 'snap');
    await mkdir(snap);

    const secret = 'ksk_secret_key_material';
    const meta = await provider.backupInput({ kind: 'api-key', secret }, snap);

    expect(meta.credentialKind).toBe('proxy-only');
    expect(meta.identity).toMatch(/^api-key:[0-9a-f]{12}$/);
    expect(meta.identity).not.toContain(secret);
    await expect(provider.describeSnapshot(snap)).resolves.toEqual({ identity: meta.identity });
  });

  it('rejects an empty key rather than saving an unusable account', async () => {
    const home = await tempHome();
    const snap = join(home, 'snap');
    await mkdir(snap);

    await expect(
      new KiroProvider(home).backupInput({ kind: 'api-key', secret: '   ' }, snap),
    ).rejects.toThrow(/empty/i);
  });

  it('rejects a truncated key at save time, not at proxy start', async () => {
    const home = await tempHome();
    const snap = join(home, 'snap');
    await mkdir(snap);

    await expect(
      new KiroProvider(home).backupInput({ kind: 'api-key', secret: 'ksk_short' }, snap),
    ).rejects.toThrow(/too short/i);
  });

  it('rejects a region that cannot be a runtime hostname', async () => {
    const home = await tempHome();
    const snap = join(home, 'snap');
    await mkdir(snap);

    await expect(
      new KiroProvider(home).backupInput(
        { kind: 'api-key', secret: 'ksk_test_key_long_enough', options: { region: 'US East 1' } },
        snap,
      ),
    ).rejects.toThrow(/not a valid Kiro API region/i);
  });

  it('offers the known regions so a caller can ask without knowing Kiro', async () => {
    const provider = new KiroProvider(await tempHome());

    const fields = provider.credentialInputFields('api-key');
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe('region');
    expect(fields[0]?.choices).toContain('us-east-1');
    expect(fields[0]?.default).toBe('us-east-1');
    expect(provider.credentialInputFields('oauth')).toEqual([]);
  });

  it('never reports as live, even with no Kiro login on the machine', async () => {
    const { provider, snap } = await apiKeySnapshot();

    // The snapshot carries no token files, which a plain file comparison reads
    // as a vacuous match.
    await expect(provider.snapshotMatchesLive(snap)).resolves.toBe(false);
  });

  it('leaves a real Kiro login untouched when restored', async () => {
    const { home, provider, snap } = await apiKeySnapshot();
    await writeKiroSecrets({ 'kirocli:social:token': 'live-token' }, home);

    await provider.restore(snap);

    expect(await readKiroSecrets(home)).toEqual({ 'kirocli:social:token': 'live-token' });
  });
});

describe('OpenCodeProvider', () => {
  it('backs up and restores auth.json (api + oauth like Codex)', async () => {
    const home = await tempHome();
    const dataDir = join(home, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    // Fake JWT payload {"email":"user@example.com"} — display only
    const payload = Buffer.from(JSON.stringify({ email: 'user@example.com' })).toString(
      'base64url',
    );
    const access = `hdr.${payload}.sig`;
    await writeFile(
      join(dataDir, 'auth.json'),
      JSON.stringify({
        openai: {
          type: 'oauth',
          access,
          refresh: 'rt-openai',
          expires: Date.now() + 3600_000,
          accountId: 'acct_abc',
        },
        'opencode-go': { type: 'api', key: 'sk-test-go' },
        deepseek: { type: 'api', key: 'sk-ds' },
      }),
    );

    const provider = new OpenCodeProvider(home);
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('user@example.com');
    expect(live.details).toContain('openai:oauth');
    expect(live.details).toContain('opencode-go:api');

    const snap = join(home, 'snap');
    await mkdir(snap);
    const meta = await provider.backup(snap);
    expect(meta.identity).toBe('user@example.com');

    await writeFile(join(dataDir, 'auth.json'), '{}');
    await provider.restore(snap);
    const restored = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8')) as {
      openai: { type: string; refresh: string };
      'opencode-go': { key: string };
    };
    expect(restored.openai.type).toBe('oauth');
    expect(restored.openai.refresh).toBe('rt-openai');
    expect(restored['opencode-go'].key).toBe('sk-test-go');
  });
});
