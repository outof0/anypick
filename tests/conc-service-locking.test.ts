/**
 * ADR 0009, from the service side: correctness must not depend on the caller.
 *
 * Two things have to be true at once, and they pull against each other:
 *
 *   1. A service mutator locks its own scope, so two concurrent callers cannot
 *      interleave a multi-step credential write.
 *   2. That same mutator is routinely called by an activation that *already*
 *      holds the scope. File locks are not re-entrant by nature, so without the
 *      AsyncLocalStorage re-entrancy in `mutation-lock.ts` the inner acquisition
 *      spins against its own outer lock until it fails — turning every
 *      activation into a STATE_CONFLICT.
 *
 * These tests pin both, because satisfying either one alone is easy and wrong.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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
import type { Account, AccountMeta, LiveAuthStatus, Provider, SourceAdapter } from '../src/types';
import {
  withMutationLock,
  withMutationLocks,
  holdsMutationLock,
  heldMutationLocks,
  mutationLockPath,
} from '../src/core/mutation-lock';
import { providerScope, mutationScopeForRef, accountRef, accountPoolRef } from '../src/core/refs';

/**
 * A provider whose backup is deliberately slow and non-atomic: it writes a
 * marker, waits, then writes the payload. Interleaved saves would produce a
 * snapshot whose two files disagree, which is exactly what the lock prevents.
 */
class SlowProvider implements Provider {
  readonly id = 'slow';
  readonly name = 'Slow Provider';
  readonly description = 'Test provider with an observably non-atomic backup';

  /** Backups that were running at the same instant as another backup. */
  readonly overlaps: string[] = [];
  private inBackup = 0;

  constructor(private readonly liveDir: string) {}

  private get authPath(): string {
    return join(this.liveDir, 'auth.json');
  }

  async detectLive(): Promise<LiveAuthStatus> {
    try {
      const raw = await readFile(this.authPath, 'utf8');
      return { present: true, identity: (JSON.parse(raw) as { email?: string }).email };
    } catch {
      return { present: false };
    }
  }

  async backup(destDir: string): Promise<Partial<AccountMeta>> {
    this.inBackup += 1;
    if (this.inBackup > 1) {
      this.overlaps.push(destDir);
    }
    try {
      const raw = await readFile(this.authPath, 'utf8');
      await writeFile(join(destDir, 'stage-1'), 'started', { mode: 0o600 });
      await new Promise((r) => setTimeout(r, 40));
      await writeFile(join(destDir, 'auth.json'), raw, { mode: 0o600 });
      return { identity: (JSON.parse(raw) as { email?: string }).email };
    } finally {
      this.inBackup -= 1;
    }
  }

  async restore(srcDir: string): Promise<void> {
    const raw = await readFile(join(srcDir, 'auth.json'), 'utf8');
    await mkdir(this.liveDir, { recursive: true });
    await writeFile(this.authPath, raw, { mode: 0o600 });
  }

  sourceAdapter(account: Account): SourceAdapter {
    return {
      sourceRef: accountRef(this.id, account.meta.name),
      capabilities: {
        sourceKind: 'account',
        provider: this.id,
        nativeClients: [],
        protocols: ['anthropic', 'openai'],
        canRefresh: false,
        supportsModelDiscovery: false,
      },
      transportFor: () => 'direct',
    };
  }
}

describe('service-owned mutation locks (ADR 0009)', () => {
  let root: string;
  let liveDir: string;
  let app: AnyPickApp;
  let provider: SlowProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-conc-svc-'));
    liveDir = join(root, 'slow-live');
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'auth.json'), JSON.stringify({ email: 'dev@slow.test' }), {
      mode: 0o600,
    });

    provider = new SlowProvider(liveDir);
    const accountRegistry = new ProviderRegistry();
    accountRegistry.register(provider);
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

  it('serializes two concurrent saves without the caller locking anything', async () => {
    // Two different requested names, one live login. Identity resolution is
    // inside the lock, so the loser observes the winner's committed snapshot
    // and folds into it instead of racing to create a second account for the
    // same upstream identity.
    const [a, b] = await Promise.all([
      app.accounts.save('slow', 'one', { force: true }),
      app.accounts.save('slow', 'two', { force: true }),
    ]);

    expect(a.name).toBe(b.name);
    expect(a.identity).toBe('dev@slow.test');

    const listed = await app.accounts.list('slow');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.identity).toBe('dev@slow.test');

    // The lock is provider-wide precisely because both saves rewrite state
    // reached through one live auth file, so neither backup may overlap.
    expect(provider.overlaps).toEqual([]);
  });

  it('re-enters when the caller already holds the provider scope', async () => {
    // Exactly what activation-executor does: take the scope, then call the
    // service. Before re-entrancy this rejected with STATE_CONFLICT.
    const meta = await withMutationLock(root, providerScope('slow'), async () => {
      expect(holdsMutationLock(root, providerScope('slow'))).toBe(true);
      return app.accounts.save('slow', 'nested', { force: true });
    });

    expect(meta.name).toBe('nested');
    const listed = await app.accounts.list('slow');
    expect(listed.map((l) => l.name)).toEqual(['nested']);
  });

  it('releases the scope so a later mutation can acquire it again', async () => {
    await app.accounts.save('slow', 'first', { force: true });
    expect(heldMutationLocks().size).toBe(0);
    await app.accounts.save('slow', 'second', { force: true });
    expect(heldMutationLocks().size).toBe(0);
  });

  it('maps an activation source ref onto the same lock file the service uses', () => {
    // If these ever diverge, an activation holds one file while the nested
    // service call blocks on another — a self-deadlock that no test of either
    // side alone would catch.
    expect(mutationScopeForRef(accountRef('slow', 'work'))).toBe(providerScope('slow'));
    expect(mutationScopeForRef(accountPoolRef('slow'))).toBe(providerScope('slow'));
    expect(mutationLockPath(root, mutationScopeForRef(accountRef('slow', 'anything')))).toBe(
      mutationLockPath(root, providerScope('slow')),
    );
  });

  it('does not leak a held scope into an unrelated sibling scope', async () => {
    await withMutationLocks(root, ['client/claude', providerScope('slow')], async () => {
      expect(holdsMutationLock(root, providerScope('slow'))).toBe(true);
      expect(holdsMutationLock(root, 'client/claude')).toBe(true);
      // Never acquired, so it must not be reported as held.
      expect(holdsMutationLock(root, providerScope('other'))).toBe(false);
      expect(holdsMutationLock(root, 'client/codex')).toBe(false);
    });
  });
});
