/**
 * The anypick preview must not promise something `accounts.use()` does not do.
 *
 * `buildAnyPickPreview` (src/tui/model/pool.ts) is what the TUI shows before an
 * account rotation. Its step list is hand-written prose, and nothing previously
 * checked it against the operation it describes — so the preview could claim a
 * proxy would start when it would not, and no test would notice.
 *
 * Note this previews `AccountService.use()` (anypick the machine's live login for
 * one provider), which is a different operation from `BindingService.use()`
 * (point a client at a source). The activation planner models the latter and has
 * no step vocabulary for the former, so the two are deliberately separate.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady, type AnyPickApp } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import { ClientRegistry } from '../src/clients/registry';
import { CatalogRegistry } from '../src/catalog/providers';
import { openDatabase } from '../src/core/db';
import { buildAnyPickPreview } from '../src/tui/model';
import { FakeProvider } from './helpers';

describe('anypick preview fidelity', () => {
  let root: string;
  let app: AnyPickApp;
  let proxied: FakeProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-preview-'));
    const accountRegistry = new ProviderRegistry();
    proxied = new FakeProvider('withproxy', join(root, 'live', 'withproxy'), {
      withProxy: true,
      defaultProxyPort: 19800,
    });
    accountRegistry.register(proxied);
    accountRegistry.register(new FakeProvider('plain', join(root, 'live', 'plain')));
    app = await createAppReady({
      root,
      bare: true,
      accountRegistry,
      clients: new ClientRegistry(),
      catalog: new CatalogRegistry(),
      db: openDatabase(root),
    });
  });

  afterEach(async () => {
    try {
      await app.proxy.stopProxies('withproxy');
    } catch {
      // best effort
    }
    app?.close();
    await rm(root, { recursive: true, force: true });
  });

  async function seedTwo(providerId: string, fake: FakeProvider): Promise<void> {
    await fake.setLive({ email: 'a@x.test', token: 'a' });
    await app.accounts.save(providerId, 'alpha');
    await fake.setLive({ email: 'b@x.test', token: 'b' });
    await app.accounts.save(providerId, 'beta');
  }

  it('reports alreadyActive for the account that is already live', async () => {
    await seedTwo('plain', app.accounts.provider('plain') as FakeProvider);
    await app.accounts.use('plain', 'alpha');

    const preview = await buildAnyPickPreview(app, 'plain', 'alpha');
    expect(preview.alreadyActive).toBe(true);
    expect(preview.steps.notes.some((n) => /already active/i.test(n))).toBe(true);
  });

  it('does not promise a proxy start when the proxy is disabled', async () => {
    await seedTwo('withproxy', proxied);
    await app.accounts.use('withproxy', 'alpha');

    const preview = await buildAnyPickPreview(app, 'withproxy', 'beta');
    expect(preview.canProxy).toBe(true);
    expect(preview.targetProxy?.enabled).toBe(false);
    expect(preview.targetProxy?.willStart).toBe(false);
    // No "Start proxy" line may appear for a disabled proxy.
    expect(preview.steps.after.some((s) => /start proxy/i.test(s))).toBe(false);
    expect(preview.steps.notes.some((n) => /will not start/i.test(n))).toBe(true);
  });

  it('promises a proxy start only when enabled, and the rotation delivers one', async () => {
    await seedTwo('withproxy', proxied);
    await app.accounts.use('withproxy', 'alpha');
    await app.proxy.enableProxy('withproxy', 'beta', {});

    const preview = await buildAnyPickPreview(app, 'withproxy', 'beta');
    expect(preview.targetProxy?.willStart).toBe(true);
    expect(preview.steps.after.some((s) => /start proxy/i.test(s))).toBe(true);

    // Now perform the rotation the preview described and confirm the promise held.
    await app.accounts.use('withproxy', 'beta');
    const status = await app.proxy.proxyStatus('withproxy', 'beta');
    expect(status.running).toBe(true);
  });

  it('promises stopping the previous proxy only when one is running, and it stops', async () => {
    await seedTwo('withproxy', proxied);
    await app.accounts.use('withproxy', 'alpha');
    await app.proxy.enableProxy('withproxy', 'alpha', {});
    await app.proxy.startProxy('withproxy', 'alpha');

    const preview = await buildAnyPickPreview(app, 'withproxy', 'beta');
    expect(preview.previousProxy?.running).toBe(true);
    expect(preview.steps.before.some((s) => /stop proxy/i.test(s))).toBe(true);

    await app.accounts.use('withproxy', 'beta');
    const previous = await app.proxy.proxyStatus('withproxy', 'alpha');
    expect(previous.running).toBe(false);
  });

  it('says no pre-switch steps are needed when nothing has to be undone', async () => {
    await seedTwo('plain', app.accounts.provider('plain') as FakeProvider);
    // Nothing live yet for this provider, so there is no previous state.
    await app.accounts.provider('plain').clearLive?.();

    const preview = await buildAnyPickPreview(app, 'plain', 'beta');
    expect(preview.steps.before).toEqual(['No pre-switch steps required']);
  });

  it('always describes the native auth restore and the active-record update', async () => {
    await seedTwo('plain', app.accounts.provider('plain') as FakeProvider);
    const preview = await buildAnyPickPreview(app, 'plain', 'beta');

    // These are the two things `accounts.use()` unconditionally performs.
    expect(preview.steps.switch.some((s) => /restore/i.test(s))).toBe(true);
    expect(preview.steps.switch.some((s) => /active account record/i.test(s))).toBe(true);
  });

  it('still reports "already active" alongside a proxy note', async () => {
    // Regression: the notes were an if/else-if chain, so the already-active note
    // (which changes what the action does) was suppressed whenever a proxy note
    // also applied — which was every provider.
    await seedTwo('withproxy', proxied);
    await app.accounts.use('withproxy', 'alpha');

    const preview = await buildAnyPickPreview(app, 'withproxy', 'alpha');
    expect(preview.alreadyActive).toBe(true);
    expect(preview.steps.notes.some((n) => /already active/i.test(n))).toBe(true);
  });

  it('throws for an account that does not exist', async () => {
    await expect(buildAnyPickPreview(app, 'plain', 'nope')).rejects.toThrow(/not found/i);
  });
});
