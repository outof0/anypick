/**
 * The TUI path for a credential the user types, end to end.
 *
 * `tests/credential-input.test.ts` covers the core guards; this drives the real
 * component, because the value of the flow is entirely in its wiring: a picker
 * that never reaches `save`, or a region that never reaches the snapshot, both
 * typecheck perfectly and both produce an account that cannot serve a request.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { addModeOptions } from '../src/tui/screens/add-account';
import { FakeProvider } from './helpers';
import type { CredentialInput, CredentialInputField, SnapshotMeta } from '../src/types';

const KEY_FILE = 'typed-key.json';

/** A provider that takes an API key with one qualifier, like Kiro's region. */
class KeyProvider extends FakeProvider {
  readonly credentialInputs = ['api-key'] as const;

  credentialInputFields(kind: string): readonly CredentialInputField[] {
    if (kind !== 'api-key') {
      return [];
    }
    return [
      {
        name: 'region',
        label: 'API region',
        choices: ['us-east-1', 'eu-central-1'],
        default: 'us-east-1',
      },
    ];
  }

  async backupInput(input: CredentialInput, destDir: string): Promise<SnapshotMeta> {
    await mkdir(destDir, { recursive: true });
    await writeFile(
      join(destDir, KEY_FILE),
      JSON.stringify({ secret: input.secret, region: input.options?.region }),
    );
    return { identity: `api-key:${input.secret.slice(-4)}`, credentialKind: 'proxy-only' };
  }
}

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface Ui {
  lastFrame: () => string | undefined;
  stdin: { write: (data: string) => void };
}

async function waitForFrame(ui: Ui, pattern: RegExp, budgetMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const frame = ui.lastFrame() ?? '';
    if (pattern.test(frame)) {
      return frame;
    }
    await settle();
  }
  throw new Error(`Timed out waiting for ${pattern}. Last frame:\n${ui.lastFrame() ?? ''}`);
}

/**
 * Send `keys` until the screen arrives. Every home screen drops input while its
 * async loaders run, so a keystroke sent at the wrong moment is simply lost.
 */
async function press(ui: Ui, keys: string, pattern: RegExp, budgetMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    ui.stdin.write(keys);
    await settle(120);
    const frame = ui.lastFrame() ?? '';
    if (pattern.test(frame)) {
      return frame;
    }
  }
  throw new Error(`Timed out sending ${keys} for ${pattern}. Last frame:\n${ui.lastFrame() ?? ''}`);
}

/** Walk the switch board to the add-account screen for the only provider. */
async function openAddScreen(ui: Ui): Promise<void> {
  await waitForFrame(ui, /No saved logins yet/);
  await press(ui, '\t', /hotplug \/ proxy/);
  await press(ui, '\t', /hotplug \/ accounts/);
  await press(ui, 'a', /Choose a tool|Use an API key instead/);
  if (/Choose a tool/.test(ui.lastFrame() ?? '')) {
    await press(ui, '\r', /Use an API key instead/);
  }
}

describe('addModeOptions', () => {
  it('offers the typed credential even with no login to save', () => {
    const ids = addModeOptions({
      livePresent: false,
      canClearLive: false,
      canUseApiKey: true,
    }).map((o) => o.id);
    expect(ids).toEqual(['login-help', 'api-key']);
  });

  it('leaves a provider that takes no typed credential untouched', () => {
    const ids = addModeOptions({
      livePresent: true,
      canClearLive: true,
      canUseApiKey: false,
    }).map((o) => o.id);
    expect(ids).toEqual(['save', 'add-another']);
  });
});

describe('TUI api-key flow', { timeout: 30000 }, () => {
  let root: string;
  let app: HotplugApp;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-credtui-'));
    const accountRegistry = new ProviderRegistry();
    accountRegistry.register(new KeyProvider('p', join(root, 'live', 'p')));
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
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      c();
    }
    app?.close();
    await rm(root, { recursive: true, force: true });
  });

  function mount() {
    const r = render(React.createElement(TuiApp, { app, onExit: () => {} }));
    cleanups.push(() => r.unmount());
    return r;
  }

  it('masks the key, records the picked region, and marks the account proxy-only', async () => {
    const ui = mount();
    // Nothing is signed in, so the add screen has no login to save: the typed
    // key is the only way forward, which is the case this flow exists for.
    await openAddScreen(ui);

    await press(ui, 'j', /›\s+Use an API key instead/);
    ui.stdin.write('\r');
    await waitForFrame(ui, /accounts \/ add \/ api key/);

    ui.stdin.write('sk-typed-secret-value');
    await settle();
    // One screen: key, region and name are all on it, and the key is never echoed.
    const form = ui.lastFrame() ?? '';
    expect(form).not.toContain('sk-typed-secret-value');
    expect(form).toMatch(/API region\s+us-east-1/);
    expect(form).toMatch(/Name\s+api-key/);

    ui.stdin.write('\r');
    // Focusing the region offers the provider's values and ← → walks them: a
    // typo here is unrecoverable at runtime, so the known ones stay one key away.
    const regions = await waitForFrame(ui, /eu-central-1/);
    expect(regions).toMatch(/us-east-1 · eu-central-1/);
    ui.stdin.write('\u001B[C');
    await waitForFrame(ui, /API region\s+eu-central-1/);
    ui.stdin.write('\r');
    await settle();

    // The name is pre-filled with the credential kind; clear it and pick one.
    // Ink delivers a whole written string as a single key event, so backspaces
    // have to be sent one at a time to erase more than one character.
    for (let i = 0; i < 'api-key'.length; i++) {
      ui.stdin.write('\u007F');
      await settle(20);
    }
    ui.stdin.write('teamkey');
    await settle();
    ui.stdin.write('\r');

    await waitForFrame(ui, /hotplug \/ accounts\s+1 saved/);
    expect(ui.lastFrame() ?? '').toMatch(/teamkey/);
    const account = await app.accounts.get('p', 'teamkey');
    expect(account?.meta.credentialKind).toBe('proxy-only');

    const saved = JSON.parse(await readFile(join(account!.snapshotDir, KEY_FILE), 'utf8')) as {
      secret: string;
      region: string;
    };
    expect(saved.secret).toBe('sk-typed-secret-value');
    expect(saved.region).toBe('eu-central-1');
  });

  it('will not save with the key left empty', async () => {
    const ui = mount();
    await openAddScreen(ui);
    await press(ui, 'j', /›\s+Use an API key instead/);
    ui.stdin.write('\r');
    await waitForFrame(ui, /accounts \/ add \/ api key/);

    // Enter through every field without typing: the region and the name are
    // pre-filled, so the key is the only thing that can stop the save.
    for (let i = 0; i < 3; i++) {
      ui.stdin.write('\r');
      await settle(40);
    }

    await waitForFrame(ui, /api key is required/i);
    expect(await app.accounts.get('p', 'api-key')).toBeNull();
  });
});
