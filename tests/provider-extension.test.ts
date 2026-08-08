/**
 * The extension contract, exercised the way a third-party author would.
 *
 * A provider registered through the public API must be a first-class citizen:
 * it supplies its own model roles, suggestions and fallbacks, and it drives a
 * full activation. Before model policy moved onto the `Provider`/`CatalogProvider`
 * contracts, an external provider compiled fine and then fell into `default:`
 * branches across eight `switch (providerId)` statements — inheriting Anthropic
 * and OpenAI model ids regardless of what it actually served.
 *
 * Everything here imports from `../src/index` on purpose. If a symbol needed to
 * write a provider is not exported there, this file stops compiling, which is
 * the signal that the public surface has a hole.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

/**
 * A minimal but complete third-party provider: file-based auth, no proxy, and
 * an opinionated model catalog that overlaps with none of the built-ins.
 */
class AcmeProvider implements Provider {
  readonly id = 'acme';
  readonly name = 'ACME AI';
  readonly shortName = 'ACME';
  readonly description = 'Third-party provider defined outside the framework';

  constructor(private readonly liveDir: string) {}

  roleDefaults(): Record<string, string> {
    return {
      default: 'acme-large',
      sonnet: 'acme-medium',
      opus: 'acme-large',
      haiku: 'acme-small',
    };
  }

  suggestModels(): Record<string, string> {
    return { 'acme-fast': 'acme-small', 'acme-best': 'acme-large' };
  }

  roleFriendlyModels(): readonly string[] {
    return ['acme-small', 'acme-medium', 'acme-large'];
  }

  staticFallbackModels(): readonly string[] {
    return ['acme-large'];
  }

  private get authPath(): string {
    return join(this.liveDir, 'acme-auth.json');
  }

  async detectLive(): Promise<LiveAuthStatus> {
    const { readFile } = await import('node:fs/promises');
    try {
      const raw = await readFile(this.authPath, 'utf8');
      const parsed = JSON.parse(raw) as { email?: string };
      return { present: true, identity: parsed.email };
    } catch {
      return { present: false };
    }
  }

  async backup(destDir: string): Promise<Partial<AccountMeta>> {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(this.authPath, 'utf8');
    await writeFile(join(destDir, 'acme-auth.json'), raw, { mode: 0o600 });
    return { identity: (JSON.parse(raw) as { email?: string }).email };
  }

  async restore(srcDir: string): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(srcDir, 'acme-auth.json'), 'utf8');
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
        protocols: ['anthropic', 'openai'],
        canRefresh: false,
        supportsModelDiscovery: false,
      },
      // Direct: no proxy needed, so activation writes client config only.
      transportFor: () => 'direct',
    };
  }
}

describe('third-party provider extension', () => {
  let root: string;
  let liveDir: string;
  let app: AnyPickApp;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-ext-'));
    liveDir = join(root, 'acme-live');
    await mkdir(liveDir, { recursive: true });
    await writeFile(
      join(liveDir, 'acme-auth.json'),
      JSON.stringify({ email: 'dev@acme.test', token: 'secret' }),
      { mode: 0o600 },
    );

    const accountRegistry = new ProviderRegistry();
    accountRegistry.register(new AcmeProvider(liveDir));
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

  it('appears in the provider registry with its own identity', () => {
    expect(app.accounts.listProviders().map((p) => p.id)).toEqual(['acme']);
    expect(app.accounts.provider('acme').shortName).toBe('ACME');
  });

  it('supplies its own model policy instead of inheriting built-in vendor ids', () => {
    // Read policy only through the public Provider surface so this canary stays
    // on published entrypoints (`anypick/testing` + `anypick` types).
    const provider = app.accounts.provider('acme');
    expect(provider.roleDefaults?.()).toEqual({
      default: 'acme-large',
      sonnet: 'acme-medium',
      opus: 'acme-large',
      haiku: 'acme-small',
    });

    // The regression this guards: no Claude/GPT ids may leak in from a
    // fallback branch for a provider that never serves them.
    const suggestions = Object.values(provider.suggestModels?.() ?? {});
    const friendly = [...(provider.roleFriendlyModels?.() ?? [])];
    const all = [...suggestions, ...friendly];
    expect(all).toContain('acme-large');
    expect(all.some((id) => id.includes('claude'))).toBe(false);
    expect(all.some((id) => id.includes('gpt'))).toBe(false);
  });

  it('saves and reports an account through the normal service path', async () => {
    await app.accounts.saveCurrent('acme', 'work');

    const listed = await app.accounts.list('acme');
    expect(listed.map((a) => a.name)).toEqual(['work']);
    expect(listed[0]?.identity).toBe('dev@acme.test');
  });

  it('activates a client against the provider end to end', async () => {
    await app.accounts.saveCurrent('acme', 'work');

    const result = await app.bindingService.use('claude', { with: 'acme/work' });

    expect(result.dryRun).toBe(false);
    const binding = app.bindings.getGlobal('claude');
    expect(binding?.spec.source).toEqual({
      kind: 'account',
      provider: 'acme',
      name: 'work',
    });

    // The activation ran the real journal: it must have completed, not been
    // left half-applied.
    expect(app.journal.listIncomplete()).toHaveLength(0);
  });
});
