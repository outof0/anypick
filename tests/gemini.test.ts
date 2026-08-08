import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `detectLive` falls back to the OS credential store, so without this stub these
// tests would read the developer's real Antigravity login and a cleared ~/.gemini
// would still report present. Individual tests override the return value.
const { credentialExists } = vi.hoisted(() => ({ credentialExists: vi.fn(async () => false) }));
vi.mock('../src/providers/gemini-antigravity-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/gemini-antigravity-oauth')>()),
  antigravityCredentialExists: credentialExists,
}));

const { GeminiProvider, upsertEnvFile, readGeminiApiKeyFromEnvFile } =
  await import('../src/providers/gemini');
import { createGeminiClient } from '../src/clients/gemini';
import { parseAntigravityOAuthCredential } from '../src/providers/gemini-antigravity-oauth';
import { geminiAccountAdapter } from '../src/sources/account-adapters';
import { createAppReady } from '../src/core/app';
import { openDatabase } from '../src/core/db';
import { pathExists } from '../src/utils/fs';
import type { Account } from '../src/types';
import { syntheticProxyProfile } from '../src/clients/isolation';

async function writeGeminiHome(
  home: string,
  opts: {
    apiKey?: string;
    email?: string;
    oauth?: boolean;
    authType?: string;
  },
) {
  const dir = join(home, '.gemini');
  await mkdir(dir, { recursive: true });
  if (opts.apiKey) {
    await writeFile(join(dir, '.env'), `GEMINI_API_KEY=${opts.apiKey}\n`, { mode: 0o600 });
  }
  if (opts.oauth) {
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
      }),
      { mode: 0o600 },
    );
  }
  if (opts.email) {
    await writeFile(
      join(dir, 'google_accounts.json'),
      JSON.stringify({ active: opts.email, old: [] }),
      { mode: 0o600 },
    );
  }
  if (opts.authType) {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: opts.authType } },
        general: { preferredEditor: 'vim' },
      }),
      { mode: 0o600 },
    );
  }
}

describe('GeminiProvider', () => {
  let home: string;
  let provider: InstanceType<typeof GeminiProvider>;

  beforeEach(async () => {
    credentialExists.mockResolvedValue(false);
    home = await mkdtemp(join(tmpdir(), 'hotplug-gemini-home-'));
    provider = new GeminiProvider(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('detectLive finds api key in .env', async () => {
    await writeGeminiHome(home, { apiKey: 'sk-test-1', email: 'a@example.com' });
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('a@example.com');
    expect(live.details).toMatch(/api-key/);
  });

  it('detectLive finds oauth_creds', async () => {
    await writeGeminiHome(home, {
      oauth: true,
      email: 'oauth@example.com',
      authType: 'oauth-personal',
    });
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('oauth@example.com');
    expect(live.details).toMatch(/oauth/);
  });

  // An Antigravity-only user has nothing under ~/.gemini, so a file-only
  // detectLive reported them signed out and `hotplug use` had nothing to
  // checkpoint. CLI files still win when both exist, otherwise restoring a CLI
  // account would be masked by a stale keychain entry.
  it('detectLive falls back to the Antigravity credential store', async () => {
    credentialExists.mockResolvedValue(true);
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.details).toMatch(/antigravity/);
  });

  it('detectLive prefers gemini-cli files over an Antigravity credential', async () => {
    credentialExists.mockResolvedValue(true);
    await writeGeminiHome(home, { apiKey: 'sk-cli', email: 'cli@example.com' });
    const live = await provider.detectLive();
    expect(live.identity).toBe('cli@example.com');
    expect(live.details).not.toMatch(/antigravity/);
  });

  it('backup / restore round-trips api key account', async () => {
    await writeGeminiHome(home, {
      apiKey: 'sk-work',
      email: 'work@example.com',
      authType: 'gemini-api-key',
    });
    const snap = join(home, 'snap-a');
    const meta = await provider.backup(snap);
    expect(meta.identity).toBe('work@example.com');
    expect(await pathExists(join(snap, '.env'))).toBe(true);

    await provider.clearLive();
    expect((await provider.detectLive()).present).toBe(false);

    await provider.restore(snap);
    const live = await provider.detectLive();
    expect(live.present).toBe(true);
    expect(live.identity).toBe('work@example.com');
    expect(await readGeminiApiKeyFromEnvFile(join(home, '.gemini', '.env'))).toBe('sk-work');
  });

  it('switch between two snapshots does not mix credentials', async () => {
    await writeGeminiHome(home, { apiKey: 'key-a', email: 'a@x.com' });
    const snapA = join(home, 'a');
    await provider.backup(snapA);

    await writeGeminiHome(home, { apiKey: 'key-b', email: 'b@x.com', oauth: true });
    const snapB = join(home, 'b');
    await provider.backup(snapB);

    await provider.restore(snapA);
    expect(await readGeminiApiKeyFromEnvFile(join(home, '.gemini', '.env'))).toBe('key-a');
    expect(await pathExists(join(home, '.gemini', 'oauth_creds.json'))).toBe(false);

    await provider.restore(snapB);
    expect(await readGeminiApiKeyFromEnvFile(join(home, '.gemini', '.env'))).toBe('key-b');
    expect(await pathExists(join(home, '.gemini', 'oauth_creds.json'))).toBe(true);
  });

  it('clearLive strips auth keys but keeps unrelated .env lines', async () => {
    const dir = join(home, '.gemini');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'GEMINI_API_KEY=secret\nMY_CUSTOM=keep\n', { mode: 0o600 });
    await writeFile(join(dir, 'oauth_creds.json'), '{}', { mode: 0o600 });
    await provider.clearLive();
    expect(await pathExists(join(dir, 'oauth_creds.json'))).toBe(false);
    const env = await readFile(join(dir, '.env'), 'utf8');
    expect(env).toContain('MY_CUSTOM=keep');
    expect(env).not.toContain('GEMINI_API_KEY');
  });

  it('backup fails when nothing is present', async () => {
    await expect(provider.backup(join(home, 'empty'))).rejects.toMatchObject({
      code: 'NO_LIVE_AUTH',
    });
  });

  it('backupAntigravity writes a re-parseable snapshot from a credential file', async () => {
    const credFile = join(home, 'cred.json');
    await writeFile(credFile, JSON.stringify({ refresh_token: 'rt', token_type: 'Bearer' }));
    const destDir = join(home, 'snapshot');
    const meta = await provider.backupAntigravity(destDir, credFile);
    expect(meta.notes).toMatch(/antigravity/i);
    expect(meta.identity).toBeUndefined();

    const written = JSON.parse(await readFile(join(destDir, 'antigravity_oauth.json'), 'utf8'));
    // The snapshot must be the shape the proxy accepts on start.
    const reparsed = parseAntigravityOAuthCredential(JSON.stringify(written));
    expect(reparsed).toEqual({ refresh_token: 'rt', token_type: 'Bearer' });
  });

  it('detectLiveSource(antigravity) reports present for a valid credential file', async () => {
    const credFile = join(home, 'cred.json');
    await writeFile(credFile, JSON.stringify({ refresh_token: 'rt' }));
    const live = await provider.detectAntigravityLive(credFile);
    expect(live.present).toBe(true);
    expect(live.details).toMatch(/antigravity/i);
  });

  it('detectLiveSource routes gemini-cli to the default detector', async () => {
    await writeGeminiHome(home, { apiKey: 'sk-test-src', email: 'src@example.com' });
    const live = await provider.detectLiveSource('gemini-cli');
    expect(live.present).toBe(true);
    expect(live.identity).toBe('src@example.com');
  });

  /**
   * The shared default looks for `auth.json`, which Gemini never writes, so it
   * answered "not live" for every account including the one actually signed in.
   */
  describe('snapshotMatchesLive', () => {
    it('matches the login that is on disk and rejects the one that is not', async () => {
      await writeGeminiHome(home, { apiKey: 'sk-live', email: 'live@example.com' });

      const mine = join(home, 'snap-mine');
      await provider.backup(mine);
      expect(await provider.snapshotMatchesLive(mine)).toBe(true);

      const theirs = join(home, 'snap-theirs');
      await mkdir(theirs, { recursive: true });
      await writeFile(join(theirs, '.env'), 'GEMINI_API_KEY=sk-other\n');
      expect(await provider.snapshotMatchesLive(theirs)).toBe(false);
    });

    it('survives the access-token rotation that happens hourly', async () => {
      await writeGeminiHome(home, { oauth: true, email: 'oauth@example.com' });
      const snap = join(home, 'snap');
      await provider.backup(snap);

      // The CLI refreshes in place; only the refresh token is durable, so a
      // whole-file hash would report the live account as "changed".
      await writeFile(
        join(home, '.gemini', 'oauth_creds.json'),
        JSON.stringify({ access_token: 'rotated', refresh_token: 'rt', token_type: 'Bearer' }),
      );
      expect(await provider.snapshotMatchesLive(snap)).toBe(true);
    });

    it('declines to answer for an Antigravity snapshot rather than guessing', async () => {
      const snap = join(home, 'snap-ag');
      const credFile = join(home, 'cred.json');
      await writeFile(credFile, JSON.stringify({ refresh_token: 'rt' }));
      await provider.backupAntigravity(snap, credFile);

      // Naming the account inside the credential store means reading the
      // secret, which prompts. Callers fall back to identity comparison.
      await expect(provider.snapshotMatchesLive(snap)).rejects.toThrow(/credential store/i);
    });
  });
});

describe('upsertEnvFile', () => {
  it('merges and replaces keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hotplug-env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'FOO=1\nGEMINI_API_KEY=old\n', { mode: 0o600 });
    await upsertEnvFile(path, { GEMINI_API_KEY: 'new', GEMINI_MODEL: 'gemini-2.5-pro' });
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('FOO=1');
    expect(raw).toContain('GEMINI_API_KEY=new');
    expect(raw).toContain('GEMINI_MODEL=gemini-2.5-pro');
    expect(raw).not.toContain('old');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('geminiAccountAdapter', () => {
  it('direct for gemini client; proxy for claude/codex', () => {
    const account: Account = {
      meta: {
        name: 'work',
        provider: 'gemini',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      snapshotDir: '/tmp/x',
      accountDir: '/tmp/x',
      proxy: { enabled: false },
    };
    const a = geminiAccountAdapter(account);
    expect(a.transportFor('gemini')).toBe('direct');
    expect(a.transportFor('claude')).toBe('managed_builtin_proxy');
    expect(a.transportFor('codex')).toBe('managed_builtin_proxy');
  });
});

describe('createGeminiClient', () => {
  let home: string;
  let hotplugRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hotplug-gclient-'));
    hotplugRoot = await mkdtemp(join(tmpdir(), 'hotplug-groot-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(hotplugRoot, { recursive: true, force: true });
  });

  it('writes GEMINI_API_KEY and GEMINI_MODEL into ~/.gemini/.env', async () => {
    const client = createGeminiClient(home);
    const profile = syntheticProxyProfile({
      name: 'gemini-api-work',
      endpoint: 'https://generativelanguage.googleapis.com',
      apiKey: 'sk-from-profile',
      defaultModel: 'gemini-2.5-flash',
      provider: 'gemini-api',
    });
    await client.apply({
      profile,
      clientId: 'gemini',
      dryRun: false,
      verbose: false,
      hotplugRoot,
    });

    const envFile = join(home, '.gemini', '.env');
    expect(await pathExists(envFile)).toBe(true);
    expect(await readGeminiApiKeyFromEnvFile(envFile)).toBe('sk-from-profile');
    const raw = await readFile(envFile, 'utf8');
    expect(raw).toContain('GEMINI_MODEL=gemini-2.5-flash');
  });
});

describe('proxyApiKeyGate', () => {
  it('flags gemini snapshot without API key', async () => {
    const { proxyApiKeyGate } = await import('../src/tui/model');
    const root = await mkdtemp(join(tmpdir(), 'hotplug-gkey-'));
    const liveHome = await mkdtemp(join(tmpdir(), 'hotplug-gkey-live-'));
    try {
      const { AccountStore } = await import('../src/core/store');
      const { AccountService } = await import('../src/core/service');
      const { ProviderRegistry } = await import('../src/core/registry');
      const { createAppReady } = await import('../src/core/app');
      const provider = new GeminiProvider(liveHome);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const store = new AccountStore(root, openDatabase(root));
      const service = new AccountService(store, registry);

      // OAuth-only style snapshot (no key)
      await writeGeminiHome(liveHome, {
        oauth: true,
        email: 'oauth@example.com',
        authType: 'oauth-personal',
      });
      await service.save('gemini', 'oauth-only');

      const app = {
        accounts: service,
      } as unknown as import('../src/core/app').HotplugApp;
      const gate = await proxyApiKeyGate(app, 'gemini', 'oauth-only');
      expect(gate.needsApiKey).toBe(true);
      expect(gate.hint).toMatch(/GEMINI_API_KEY|OAuth/i);

      // With key
      await writeGeminiHome(liveHome, { apiKey: 'sk-ok', email: 'k@x.com' });
      await service.save('gemini', 'with-key');
      const gate2 = await proxyApiKeyGate(app, 'gemini', 'with-key');
      expect(gate2.needsApiKey).toBe(false);
      void createAppReady;
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(liveHome, { recursive: true, force: true });
    }
  });
});

describe('registerBuiltin includes gemini', () => {
  it('provider and client are registered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hotplug-gapp-'));
    try {
      const app = await createAppReady({ root, skipMigrate: true });
      expect(app.accountRegistry.has('gemini')).toBe(true);
      expect(app.clients.has('gemini')).toBe(true);
      expect(app.accounts.provider('gemini').name).toMatch(/Gemini/i);
      expect(
        app.clients
          .get('gemini')
          .modelRoles?.()
          .map((r) => r.id),
      ).toEqual(['default']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('account service can save and switch gemini logins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hotplug-gsvc-'));
    const liveHome = await mkdtemp(join(tmpdir(), 'hotplug-glive-'));
    try {
      // Use a dedicated provider instance wired via bare app is hard;
      // exercise provider + store through AccountService with custom registry.
      const { AccountStore } = await import('../src/core/store');
      const { AccountService } = await import('../src/core/service');
      const { ProviderRegistry } = await import('../src/core/registry');
      const provider = new GeminiProvider(liveHome);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const store = new AccountStore(root, openDatabase(root));
      const service = new AccountService(store, registry);

      await writeGeminiHome(liveHome, { apiKey: 'k1', email: 'one@x.com' });
      await service.save('gemini', 'one');
      await writeGeminiHome(liveHome, { apiKey: 'k2', email: 'two@x.com' });
      await service.save('gemini', 'two');

      await service.use('gemini', 'one');
      expect(await readGeminiApiKeyFromEnvFile(join(liveHome, '.gemini', '.env'))).toBe('k1');
      const cur = await service.current('gemini');
      expect(cur.active).toBe('one');

      await service.use('gemini', 'two');
      expect(await readGeminiApiKeyFromEnvFile(join(liveHome, '.gemini', '.env'))).toBe('k2');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(liveHome, { recursive: true, force: true });
    }
  });
});
