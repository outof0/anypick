/**
 * Accounts whose credential the user typed in rather than logged in for.
 *
 * Such an account is `proxy-only`: it never occupies the provider's live
 * credential file, so every core path that treats a snapshot as a mirror of
 * that file — live detection, activation's restore, the refresh-into-active
 * save — has to leave it alone. Getting any of them wrong silently replaces the
 * key the user supplied with an unrelated OAuth login, or the reverse.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAppReady,
  ProviderRegistry,
  CatalogRegistry,
  ClientRegistry,
  registerBuiltinClients,
  type AnyPickApp,
} from '../src/testing';
import type {
  Account,
  CredentialInput,
  LiveAuthStatus,
  Provider,
  SnapshotMeta,
  SourceAdapter,
} from '../src/types';

const AUTH_FILE = 'acme-auth.json';
const KEY_FILE = 'acme-api-key.json';

/** A provider that accepts both a native login and a typed-in API key. */
class AcmeProvider implements Provider {
  readonly id = 'acme';
  readonly name = 'ACME AI';
  readonly shortName = 'ACME';
  readonly description = 'Provider with a native login and an API key';
  readonly credentialInputs = ['api-key'] as const;

  constructor(private readonly liveDir: string) {}

  roleDefaults(): Record<string, string> {
    return { default: 'acme-large' };
  }

  private get authPath(): string {
    return join(this.liveDir, AUTH_FILE);
  }

  async detectLive(): Promise<LiveAuthStatus> {
    try {
      const raw = await readFile(this.authPath, 'utf8');
      return { present: true, identity: (JSON.parse(raw) as { email?: string }).email };
    } catch {
      return { present: false };
    }
  }

  async backup(destDir: string): Promise<SnapshotMeta> {
    const raw = await readFile(this.authPath, 'utf8');
    await writeFile(join(destDir, AUTH_FILE), raw, { mode: 0o600 });
    return { identity: (JSON.parse(raw) as { email?: string }).email };
  }

  async backupInput(input: CredentialInput, destDir: string): Promise<SnapshotMeta> {
    await writeFile(join(destDir, KEY_FILE), JSON.stringify({ key: input.secret }), {
      mode: 0o600,
    });
    return { identity: `api-key:${input.secret.slice(-4)}`, credentialKind: 'proxy-only' };
  }

  async restore(srcDir: string): Promise<void> {
    const raw = await readFile(join(srcDir, AUTH_FILE), 'utf8');
    await mkdir(this.liveDir, { recursive: true });
    await writeFile(this.authPath, raw, { mode: 0o600 });
  }

  sourceAdapter(account: Account): SourceAdapter {
    return {
      sourceRef: { kind: 'account', provider: this.id, name: account.meta.name },
      capabilities: {
        sourceKind: 'account',
        provider: this.id,
        nativeClients: [],
        protocols: ['anthropic'],
        canRefresh: false,
        supportsModelDiscovery: false,
      },
      transportFor: () => 'direct',
    };
  }
}

/** A provider that declares no credential inputs at all. */
class PlainProvider implements Provider {
  readonly id = 'plain';
  readonly name = 'Plain';
  readonly shortName = 'Plain';
  readonly description = 'Login only';

  roleDefaults(): Record<string, string> {
    return { default: 'plain-1' };
  }
  async detectLive(): Promise<LiveAuthStatus> {
    return { present: true, identity: 'someone@plain.test' };
  }
  async backup(): Promise<SnapshotMeta> {
    return {};
  }
  async restore(): Promise<void> {}
  sourceAdapter(account: Account): SourceAdapter {
    return {
      sourceRef: { kind: 'account', provider: this.id, name: account.meta.name },
      capabilities: {
        sourceKind: 'account',
        provider: this.id,
        nativeClients: [],
        protocols: ['anthropic'],
        canRefresh: false,
        supportsModelDiscovery: false,
      },
      transportFor: () => 'direct',
    };
  }
}

describe('user-supplied credentials', () => {
  let root: string;
  let liveDir: string;
  let app: AnyPickApp;

  const liveLogin = () =>
    writeFile(
      join(liveDir, AUTH_FILE),
      JSON.stringify({ email: 'dev@acme.test', token: 'oauth' }),
      {
        mode: 0o600,
      },
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-input-'));
    liveDir = join(root, 'acme-live');
    await mkdir(liveDir, { recursive: true });
    await liveLogin();

    const accountRegistry = new ProviderRegistry();
    accountRegistry.register(new AcmeProvider(liveDir));
    accountRegistry.register(new PlainProvider());
    const clients = new ClientRegistry();
    registerBuiltinClients(clients);

    app = await createAppReady({
      root,
      bare: true,
      accountRegistry,
      clients,
      catalog: new CatalogRegistry(),
    });
  });

  afterEach(async () => {
    app?.close();
    await rm(root, { recursive: true, force: true });
  });

  const saveKey = (name = 'key', secret = 'sk-abcd1234') =>
    app.accounts.save('acme', name, { force: true, input: { kind: 'api-key', secret } });

  it('saves without a live login and marks the account proxy-only', async () => {
    await rm(join(liveDir, AUTH_FILE));

    const meta = await saveKey();

    expect(meta.credentialKind).toBe('proxy-only');
    expect(meta.identity).toBe('api-key:1234');
  });

  it('rejects an input the provider does not declare', async () => {
    await expect(
      app.accounts.save('plain', 'key', { input: { kind: 'api-key', secret: 'x' } }),
    ).rejects.toThrow(/does not accept/i);
  });

  it('never reports as live, even while it is the active account', async () => {
    await saveKey();
    await app.accounts.use('acme', 'key', { noProxy: true });

    const listed = await app.accounts.list('acme');
    expect(listed.find((a) => a.name === 'key')?.isLiveMatch).toBe(false);
    expect((await app.accounts.current('acme')).isLiveMatch).toBe(false);
  });

  it('leaves the live login in place when activated', async () => {
    await saveKey();

    await app.accounts.use('acme', 'key', { noProxy: true });

    const live = JSON.parse(await readFile(join(liveDir, AUTH_FILE), 'utf8')) as { token: string };
    expect(live.token).toBe('oauth');
  });

  it('does not absorb the live login when switching away from it', async () => {
    await saveKey();
    await app.accounts.use('acme', 'key', { noProxy: true });
    await app.accounts.saveCurrent('acme', 'work');

    // Switching off the key must not write the live OAuth login into its
    // snapshot the way it would for a native account.
    await app.accounts.use('acme', 'work', { noProxy: true });

    const account = await app.accounts.get('acme', 'key');
    await expect(readFile(join(account!.snapshotDir, AUTH_FILE), 'utf8')).rejects.toThrow();
    expect(account!.meta.identity).toBe('api-key:1234');
  });

  it('refuses to overwrite a stored credential with the live login', async () => {
    await saveKey();

    await expect(app.accounts.save('acme', 'key', { force: true })).rejects.toThrow(
      /credential you supplied/i,
    );
  });
});
