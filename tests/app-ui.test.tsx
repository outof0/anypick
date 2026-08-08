/**
 * `TuiApp` smoke + navigation tests, pinned before decomposition.
 *
 * `src/tui/app-ui.tsx` is the largest file in the repo (~3,400 lines) and had no
 * test that mounted it: `tests/tui.test.tsx` renders individual screens, but the
 * component that owns all screen state and dispatch was never exercised. That
 * made it the riskiest file to refactor.
 *
 * These tests mount the real component against a temp root and drive it with
 * keystrokes. They deliberately assert on navigation outcomes and absence of
 * crashes rather than exact copy, so they survive the state-management refactor
 * (useState → reducer) that follows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import React from 'react';
import { createAppReady, type HotplugApp } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import { ClientRegistry, registerBuiltinClients } from '../src/clients/index';
import { CatalogRegistry, registerBuiltinCatalog } from '../src/catalog/providers';
import { openDatabase } from '../src/core/db';
import { TuiApp } from '../src/tui/app-ui';
import { FakeProvider } from './helpers';

/**
 * Ink renders asynchronously, and the home screen ignores input while its async
 * loaders run (`if (busy) return` in hotplug-home). A fixed sleep is fragile on
 * slow CI, so `settled` polls until the frame stops changing.
 */
async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until the frame stops changing. A *loading* frame is also stable, so
 * callers that need real content pass `expect` and we keep polling until it
 * appears — under a loaded CI machine the async loaders can take seconds.
 */
async function settled(
  ui: { lastFrame: () => string | undefined },
  opts: { budgetMs?: number; expect?: RegExp } = {},
): Promise<void> {
  const budgetMs = opts.budgetMs ?? 15000;
  const start = Date.now();
  let previous = ui.lastFrame();
  let stableFor = 0;
  while (Date.now() - start < budgetMs) {
    await settle(50);
    const current = ui.lastFrame();
    if (opts.expect) {
      if (current && opts.expect.test(current)) {
        return;
      }
      previous = current;
      continue;
    }
    if (current && current === previous) {
      stableFor += 50;
      if (stableFor >= 200) {
        return;
      }
    } else {
      stableFor = 0;
      previous = current;
    }
  }
}

async function seedAccount(app: HotplugApp, provider: string, name: string): Promise<void> {
  const { snapshotDir } = await app.accountStore.prepareSnapshot(provider, name);
  await writeFile(join(snapshotDir, 'auth.json'), JSON.stringify({ token: 't' }), { mode: 0o600 });
  await app.accountStore.writeMeta({
    name,
    provider,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    identity: `${name}@example.test`,
  });
}

/**
 * Poll `predicate` until it holds. Used instead of asserting right after a
 * keystroke: this file mounts the whole app (SQLite + loaders) and runs
 * alongside 11 other workers, so a fixed sleep is inherently racy.
 */
async function waitFor(predicate: () => boolean, budgetMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (predicate()) {
      return true;
    }
    await settle(50);
  }
  return predicate();
}

// `settled`/`waitFor` budget 15s each for a loaded machine; the 5s default
// timeout cuts them off first and the slowest cases flake under a full run.
describe('TuiApp', { timeout: 20000 }, () => {
  let root: string;
  let app: HotplugApp;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-appui-'));
    const accountRegistry = new ProviderRegistry();
    accountRegistry.register(
      new FakeProvider('p', join(root, 'live', 'p'), { withProxy: true, defaultProxyPort: 19400 }),
    );
    const clients = new ClientRegistry();
    registerBuiltinClients(clients);
    const catalog = new CatalogRegistry();
    registerBuiltinCatalog(catalog);

    app = await createAppReady({
      root,
      bare: true,
      accountRegistry,
      clients,
      catalog,
      db: openDatabase(root),
    });
    await seedAccount(app, 'p', 'work');
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      c();
    }
    app?.close();
    await rm(root, { recursive: true, force: true });
  });

  function mount() {
    let exitCode: number | undefined;
    let exited = false;
    const r = render(
      React.createElement(TuiApp, {
        app,
        onExit: (code?: number) => {
          exited = true;
          exitCode = code;
        },
      }),
    );
    cleanups.push(() => r.unmount());
    return {
      ...r,
      get exited() {
        return exited;
      },
      get exitCode() {
        return exitCode;
      },
    };
  }

  it('mounts and reaches a rendered home screen without crashing', async () => {
    const ui = mount();
    await settled(ui, { expect: /work/i });

    const out = ui.lastFrame() ?? '';
    expect(out.length).toBeGreaterThan(0);
    // The seeded account should surface somewhere on the landing screen.
    expect(out).toMatch(/work/i);
  });

  it('renders the saved account identity from the store', async () => {
    const ui = mount();
    await settled(ui, { expect: /work/i });
    expect(ui.lastFrame() ?? '').toMatch(/work@example\.test|work/i);
  });

  it('opens the help screen and returns from it', async () => {
    const ui = mount();
    // Input is ignored while loading, so wait for real content before keying.
    await settled(ui, { expect: /work/i });
    const home = ui.lastFrame();

    expect(
      await waitFor(() => {
        if (ui.lastFrame() !== home) {
          return true;
        }
        ui.stdin.write('h');
        return ui.lastFrame() !== home;
      }),
    ).toBe(true);

    // Escape backs out of help.
    ui.stdin.write('');
    await settle();
    expect(ui.lastFrame()).toBeTruthy();
  });

  it('survives arrow-key navigation without throwing', async () => {
    const ui = mount();
    await settled(ui, { expect: /work/i });

    for (const key of ['[B', '[B', '[A', '[C', '[D']) {
      ui.stdin.write(key);
      await settle(30);
    }
    expect(ui.lastFrame()).toBeTruthy();
  });

  it('exits on q', async () => {
    const ui = mount();
    await settled(ui, { expect: /work/i });

    // The home screen drops input while its loaders run (`if (busy) return`),
    // and "content is visible" does not imply "busy cleared". Re-send the key
    // while waiting, the way a user would press it again.
    expect(
      await waitFor(() => {
        if (ui.exited) {
          return true;
        }
        ui.stdin.write('q');
        return ui.exited;
      }),
    ).toBe(true);
  });

  it('tolerates unknown keystrokes', async () => {
    const ui = mount();
    await settled(ui, { expect: /work/i });

    for (const key of ['z', 'X', '9', '!', '\t']) {
      ui.stdin.write(key);
      await settle(20);
    }
    expect(ui.lastFrame()).toBeTruthy();
    expect(ui.exited).toBe(false);
  });

  it('renders with no saved accounts at all', async () => {
    // A fresh install is the first thing a new user sees; it must not blow up on
    // empty collections.
    const emptyRoot = await mkdtemp(join(tmpdir(), 'hotplug-appui-empty-'));
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider('p', join(emptyRoot, 'live', 'p')));
    const emptyApp = await createAppReady({
      root: emptyRoot,
      bare: true,
      accountRegistry: registry,
      clients: new ClientRegistry(),
      catalog: new CatalogRegistry(),
      db: openDatabase(emptyRoot),
    });

    const r = render(React.createElement(TuiApp, { app: emptyApp, onExit: () => {} }));
    await settled(r);
    expect(r.lastFrame()).toBeTruthy();
    r.unmount();
    emptyApp.close();
    await rm(emptyRoot, { recursive: true, force: true });
  });
});
