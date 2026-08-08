/**
 * TUI tests: pure account model + Ink screen navigation.
 * Uses temp roots / FakeProvider — never touches real ~/.hotplug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import { createAppReady } from '../src/core/app';
import { ProviderRegistry } from '../src/core/registry';
import { FakeProvider } from './helpers';
import {
  buildHotplugPreview,
  collectViewModelStrings,
  filterProviderRows,
  loadProviderPool,
  loadProxyOverview,
  loadRootModel,
  loadHotplugHome,
  loadClaudeBindStatus,
  formatHotplugHomeLine,
  formatHotplugHomeFlatLine,
  filterHotplugHomeRows,
  groupHotplugHomeRows,
  hotplugContextLines,
  providerCapabilities,
  receiptFromSwitchResult,
} from '../src/tui/model';
import { HotplugHomeScreen } from '../src/tui/screens/hotplug-home';
import { ProxyBoardScreen } from '../src/tui/screens/proxy-board';
import { AccountsHomeScreen } from '../src/tui/screens/accounts-home';
import { HotplugPreviewScreen } from '../src/tui/screens/hotplug-preview';
import { ConfirmScreen } from '../src/tui/screens/confirm';
import { ProxyListScreen } from '../src/tui/screens/proxy';
import { ProxyModelsScreen } from '../src/tui/screens/proxy-models';
import { GatewayConnectionFormScreen } from '../src/tui/screens/gateway-connection-form';
import { StashResultScreen } from '../src/tui/screens/add-account';
import { ProxyLogsView } from '../src/tui/components';
import type { SwitchResult } from '../src/core/service';
import type { HotplugApp } from '../src/core/app';
import { HotplugError } from '../src/utils/errors';

async function createTuiTestApp(
  providerSpecs: Array<{
    id: string;
    withProxy?: boolean;
    withRefresh?: boolean;
    withStash?: boolean;
  }>,
) {
  const root = await mkdtemp(join(tmpdir(), 'hotplug-tui-'));
  const liveRoot = join(root, 'live');
  const registry = new ProviderRegistry();
  const fakes: Record<string, FakeProvider> = {};

  for (const spec of providerSpecs) {
    const fake = new FakeProvider(spec.id, join(liveRoot, spec.id), {
      supportsProxy: spec.withProxy ?? false,
    });
    // Class methods live on the prototype — shadow with non-function own props.
    if (spec.withRefresh === false) {
      Object.defineProperty(fake, 'refreshAuth', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
    if (spec.withStash === false) {
      Object.defineProperty(fake, 'clearLive', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
    fakes[spec.id] = fake;
    registry.register(fake);
  }

  const app = await createAppReady({
    root,
    bare: true,
    accountRegistry: registry,
    skipMigrate: true,
  });

  return {
    app,
    root,
    fakes,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('tui model — with FakeProvider app', () => {
  let env: Awaited<ReturnType<typeof createTuiTestApp>>;

  beforeEach(async () => {
    env = await createTuiTestApp([
      { id: 'codex', withRefresh: true },
      { id: 'grok', withProxy: true, withRefresh: true },
      { id: 'kiro', withProxy: true, withRefresh: false },
    ]);
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('providerCapabilities derived from methods', () => {
    expect(providerCapabilities(env.fakes.codex)).toMatchObject({
      canRefresh: true,
      canProxy: false,
      canClear: true,
    });
    expect(providerCapabilities(env.fakes.grok)).toMatchObject({
      canRefresh: true,
      canProxy: true,
    });
    expect(providerCapabilities(env.fakes.kiro)).toMatchObject({
      canRefresh: false,
      canProxy: true,
    });
  });

  it('does not surface an empty legacy default account', async () => {
    await env.fakes.codex.setLive({ email: 'march@example.com', token: 't' });
    await env.app.accounts.save('codex', 'march');
    const now = new Date().toISOString();
    env.app.accountStore.db
      .prepare(
        `INSERT INTO accounts
          (provider, name, meta_json, proxy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'codex',
        'default',
        JSON.stringify({ name: 'default', provider: 'codex', createdAt: now, updatedAt: now }),
        JSON.stringify({ enabled: false }),
        now,
        now,
      );

    const home = await loadHotplugHome(env.app);

    expect(home.rows.map((row) => row.name)).toEqual(['march']);
  });

  it('falls back to stable names when two account labels collide', async () => {
    await env.fakes.codex.setLive({ email: 'hassock@example.com', token: 'h' });
    await env.app.accounts.save('codex', 'hassock');
    await env.fakes.codex.setLive({ email: 'loofah@example.com', token: 'l' });
    await env.app.accounts.save('codex', 'loofah');
    const hassock = await env.app.accounts.get('codex', 'hassock');
    await env.app.accountStore.writeMeta({
      ...hassock!.meta,
      label: 'loofah',
      updatedAt: new Date().toISOString(),
    });

    const home = await loadHotplugHome(env.app);
    const labels = home.rows.map((row) => row.label);

    expect(labels).toContain('hassock');
    expect(labels).toContain('loofah');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('loadRootModel groups providers and live/active relation', async () => {
    await env.fakes.codex.setLive({
      email: 'erik@acme.com',
      token: 'secret-token-xyz',
    });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({
      email: 'erik@acme.com',
      token: 'secret-token-xyz',
    });

    const root = await loadRootModel(env.app);
    expect(root.providers.map((p) => p.providerId).toSorted()).toEqual(['codex', 'grok', 'kiro']);
    const codex = root.providers.find((p) => p.providerId === 'codex')!;
    expect(codex.savedCount).toBe(1);
    expect(codex.activeName).toBe('work');
    expect(codex.relation).toBe('match');
    expect(codex.canRefresh).toBe(true);
    expect(codex.canProxy).toBe(false);

    const kiro = root.providers.find((p) => p.providerId === 'kiro')!;
    expect(kiro.canRefresh).toBe(false);
  });

  it('detects unsaved live identity on root', async () => {
    await env.fakes.codex.setLive({ email: 'old@x.com', token: 't1' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({ email: 'new@x.com', token: 't2' });

    const root = await loadRootModel(env.app);
    const codex = root.providers.find((p) => p.providerId === 'codex')!;
    expect(codex.relation).toBe('unsaved-live');
    expect(codex.statusHint).toMatch(/save/i);
  });

  it('detects no-live with saved accounts', async () => {
    await env.fakes.codex.setLive({ email: 'a@x.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.clearLive();

    const root = await loadRootModel(env.app);
    const codex = root.providers.find((p) => p.providerId === 'codex')!;
    expect(codex.relation).toBe('no-live');
    expect(codex.savedCount).toBe(1);
  });

  it('loadProviderPool marks active account and lists others', async () => {
    await env.fakes.codex.setLive({ email: 'work@x.com', token: 't1' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({ email: 'personal@x.com', token: 't2' });
    await env.app.accounts.save('codex', 'personal');
    await env.app.accounts.use('codex', 'work');

    const pool = await loadProviderPool(env.app, 'codex');
    expect(pool.accounts).toHaveLength(2);
    const work = pool.accounts.find((a) => a.name === 'work')!;
    const personal = pool.accounts.find((a) => a.name === 'personal')!;
    expect(work.active).toBe(true);
    expect(work.isLiveMatch).toBe(true);
    expect(personal.active).toBe(false);
    expect(personal.isLiveMatch).toBe(false);
  });

  it('loadHotplugHome flattens accounts with provider/name refs', async () => {
    await env.fakes.codex.setLive({ email: 'work@x.com', token: 't1' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({ email: 'personal@x.com', token: 't2' });
    await env.app.accounts.save('codex', 'personal');
    await env.app.accounts.use('codex', 'work');

    const home = await loadHotplugHome(env.app);
    expect(home.totalAccounts).toBe(2);
    expect(home.rows.map((r) => r.ref).toSorted()).toEqual(['codex/personal', 'codex/work']);
    const work = home.rows.find((r) => r.name === 'work')!;
    expect(work.active).toBe(true);
    expect(work.isLiveMatch).toBe(true);
    expect(formatHotplugHomeLine(work, true)).toMatch(/›/);
    expect(formatHotplugHomeLine(work, true)).toMatch(/work/);
    expect(formatHotplugHomeFlatLine(work, true)).toMatch(/codex\/work/);
    expect(filterHotplugHomeRows(home.rows, 'personal')).toHaveLength(1);
    const grouped = groupHotplugHomeRows(home.rows, home.providers);
    expect(grouped.some((g) => g.kind === 'provider' && g.provider.providerId === 'codex')).toBe(
      true,
    );
    expect(home.chrome.version).toBeTruthy();
    const ctx = hotplugContextLines(work).join('\n');
    expect(ctx).toMatch(/already uses|Switch |Sign in/i);
    expect(ctx).not.toMatch(/snapshot|make-live|drift/i);
  });

  it('treats an active account as live when its secret store cannot be compared', async () => {
    await env.fakes.codex.setLive({ token: 't1' });
    await env.app.accounts.save('codex', 'work');
    const provider = env.fakes.codex as FakeProvider & {
      snapshotMatchesLive?: (snapshotDir: string) => Promise<boolean>;
    };
    provider.snapshotMatchesLive = async () => {
      throw new HotplugError(
        'Live credential comparison needs a secret prompt.',
        'NOT_DETERMINABLE',
      );
    };

    const home = await loadHotplugHome(env.app);
    const work = home.rows.find((row) => row.name === 'work')!;

    expect(work).toMatchObject({ active: true, isLiveMatch: true, statusText: 'live' });
    expect(home.driftCount).toBe(0);
  });

  it('loadClaudeBindStatus is unbound by default', async () => {
    const status = loadClaudeBindStatus(env.app);
    expect(status.bound).toBe(false);
  });

  it('buildHotplugPreview describes switch without proxy for codex', async () => {
    await env.fakes.codex.setLive({ email: 'work@x.com', token: 't1' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({ email: 'personal@x.com', token: 't2' });
    await env.app.accounts.save('codex', 'personal');
    await env.app.accounts.use('codex', 'work');

    const preview = await buildHotplugPreview(env.app, 'codex', 'personal');
    expect(preview.alreadyActive).toBe(false);
    expect(preview.fromName).toBe('work');
    expect(preview.toName).toBe('personal');
    expect(preview.canProxy).toBe(false);
    expect(preview.steps.notes.some((n) => /no proxy/i.test(n))).toBe(true);
  });

  it('proxy overview labels inactive enabled accounts', async () => {
    await env.fakes.grok.setLive({ email: 'a@x.com', token: 't1' });
    await env.app.accounts.save('grok', 'work');
    await env.fakes.grok.setLive({ email: 'b@x.com', token: 't2' });
    await env.app.accounts.save('grok', 'personal');
    await env.app.accounts.use('grok', 'work');
    await env.app.proxy.enableProxy('grok', 'personal', { port: 19101 });

    const rows = await loadProxyOverview(env.app);
    const personal = rows.find((r) => r.name === 'personal');
    expect(personal).toBeTruthy();
    expect(personal!.active).toBe(false);
    expect(personal!.inactiveEnabled).toBe(true);
    expect(personal!.stateText).toBe('enabled');
  });

  it('view models never include secret token values', async () => {
    const secret = 'super-secret-token-value-999';
    await env.fakes.codex.setLive({ email: 'a@x.com', token: secret });
    await env.app.accounts.save('codex', 'work');

    const root = await loadRootModel(env.app);
    const pool = await loadProviderPool(env.app, 'codex');
    const strings = [...collectViewModelStrings(root), ...collectViewModelStrings(pool)].join('\n');
    expect(strings).not.toContain(secret);
  });

  it('receiptFromSwitchResult separates proxy failure', () => {
    const result: SwitchResult = {
      provider: 'grok',
      providerName: 'grok',
      from: 'work',
      to: 'personal',
      refreshedPrevious: true,
      proxy: {
        enabled: true,
        running: false,
        error: 'port in use',
      },
    };
    const receipt = receiptFromSwitchResult(result);
    // Partial success: switch ok but proxy failed
    expect(
      receipt.lines.some(
        (l) => (l.kind === 'warn' || l.kind === 'ok') && /switched|proxy/i.test(l.text),
      ),
    ).toBe(true);
  });

  it('filterProviderRows filters by query', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const root = await loadRootModel(env.app);
    expect(filterProviderRows(root.providers, 'codex').length).toBe(1);
    expect(filterProviderRows(root.providers, 'zzz-none').length).toBe(0);
  });
});

describe('gateway connection form', () => {
  it('edits endpoint and masked API key inline', async () => {
    const submit = vi.fn();
    const { lastFrame, stdin } = render(
      <GatewayConnectionFormScreen
        providerName="Custom"
        gatewayName="zendigi"
        initialEndpoint="https://gateway.example/v1"
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );

    expect(lastFrame()).toContain('Endpoint');
    expect(lastFrame()).toContain('API key');
    expect(lastFrame()).toContain('https://gateway.example/v1');

    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write('sk-secret');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lastFrame()).not.toContain('sk-secret');
    expect(lastFrame()).toContain('•••••••••');

    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(submit).toHaveBeenCalledWith({
      endpoint: 'https://gateway.example/v1',
      apiKey: 'sk-secret',
    });
  });

  it('validates endpoint before continuing', async () => {
    const submit = vi.fn();
    const { lastFrame, stdin } = render(
      <GatewayConnectionFormScreen
        providerName="Custom"
        gatewayName="test"
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );

    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lastFrame()).toContain('Endpoint is required.');
    expect(submit).not.toHaveBeenCalled();
  });
});

// ── Ink screens ──────────────────────────────────────────────────

describe('tui ink screens', () => {
  let env: Awaited<ReturnType<typeof createTuiTestApp>>;

  beforeEach(async () => {
    env = await createTuiTestApp([
      { id: 'codex', withRefresh: true },
      { id: 'grok', withProxy: true, withRefresh: true },
      { id: 'kiro', withProxy: true, withRefresh: false },
    ]);
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('switch screen matches DESIGN-TUI chrome (path + outcome + keys)', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const home = await loadHotplugHome(env.app);

    const { lastFrame, stdin } = render(
      <HotplugHomeScreen
        model={home}
        selectedIndex={0}
        columns={120}
        onMove={() => {}}
        onSwitch={() => {}}
        onRefresh={() => {}}
        onProxy={() => {}}
        onAccounts={() => {}}
        onFilter={() => {}}
        onQuit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    // Header path: hotplug / switch
    expect(frame).toMatch(/hotplug\s*\/\s*switch/i);
    expect(frame).toMatch(/\bwork\b/);
    expect(frame).toMatch(/live|already uses/i);
    expect(frame).not.toMatch(/cyan|INSPECT|make-live|stash|CONTEXT/i);
    expect(frame.toLowerCase()).not.toMatch(/\bclients?\b/);
    expect(frame.toLowerCase()).not.toMatch(/gateway/);
    expect(frame.toLowerCase()).not.toMatch(/palette/);

    const quit = vi.fn();
    const { stdin: s2 } = render(
      <HotplugHomeScreen
        model={home}
        selectedIndex={0}
        columns={80}
        onMove={() => {}}
        onSwitch={() => {}}
        onRefresh={() => {}}
        onProxy={() => {}}
        onAccounts={() => {}}
        onFilter={() => {}}
        onQuit={quit}
      />,
    );
    s2.write('q');
    await new Promise((r) => setTimeout(r, 50));
    expect(quit).toHaveBeenCalled();
    void stdin;
  });

  it('a committed filter that matches nothing says so and can be cleared with esc', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const home = await loadHotplugHome(env.app);
    const narrowed = { ...home, rows: filterHotplugHomeRows(home.rows, 'zzz') };
    expect(narrowed.rows).toHaveLength(0);

    const onFilterClear = vi.fn();
    const { lastFrame, stdin } = render(
      <HotplugHomeScreen
        model={narrowed}
        selectedIndex={0}
        columns={80}
        filter="zzz"
        onMove={() => {}}
        onSwitch={() => {}}
        onRefresh={() => {}}
        onProxy={() => {}}
        onAccounts={() => {}}
        onFilter={() => {}}
        onFilterClear={onFilterClear}
        onQuit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/No saved logins match "zzz"/);
    // The empty-machine copy would send the user off to save a login they have.
    expect(frame).not.toMatch(/No saved logins yet/);
    expect(frame).toMatch(/esc\s+clear filter/);

    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 50));
    expect(onFilterClear).toHaveBeenCalled();
  });

  it('proxy board matches DESIGN-TUI (no INSPECT, manage apps)', async () => {
    await env.fakes.grok.setLive({ email: 'g@x.com', token: 't' });
    await env.app.accounts.save('grok', 'work');
    await env.app.proxy.enableProxy('grok', 'work', {
      port: 18080,
      start: false,
    });
    const rows = await loadProxyOverview(env.app);
    expect(rows.length).toBeGreaterThan(0);

    const manage = vi.fn();
    const primary = vi.fn();
    const { lastFrame, stdin } = render(
      <ProxyBoardScreen
        rows={rows}
        selectedIndex={0}
        apps={[]}
        columns={120}
        onMove={() => {}}
        onPrimary={primary}
        onRestart={() => {}}
        onStop={() => {}}
        onEnableStart={() => {}}
        onDisable={() => {}}
        onLogs={() => {}}
        onManageApps={manage}
        onSwitch={() => {}}
        onAccounts={() => {}}
        onQuit={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/hotplug\s*\/\s*proxy/i);
    expect(frame).toMatch(/grok\/work/);
    expect(frame).not.toMatch(/INSPECT/i);
    expect(frame).toMatch(/start|stopped|off|running/i);

    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    // stopped proxy: enter starts
    expect(primary).toHaveBeenCalled();
  });

  // DESIGN-TUI.md acceptance check 1: every hue is read from `theme`. A colour literal
  // in a screen escapes brandColor()/statusColor() and so silently ignores NO_COLOR.
  it('all TUI colours come from the theme', async () => {
    const chrome = await import('../src/tui/components/chrome');
    expect(chrome.theme.brand).toMatch(/^#[0-9a-f]{6}$/i);
    expect(chrome.theme.accent).toMatch(/^#[0-9a-f]{6}$/i);

    const tuiDir = fileURLToPath(new URL('../src/tui', import.meta.url));
    const files = await readdir(tuiDir, { recursive: true });
    const offenders: string[] = [];
    for (const rel of files) {
      if (!/\.tsx?$/.test(rel)) {
        continue;
      }
      const source = await readFile(join(tuiDir, rel), 'utf8');
      for (const [, quoted, braced] of source.matchAll(/\bcolor=(?:"([a-z]+)"|\{'([a-z]+)'\})/g)) {
        offenders.push(`${rel}: ${quoted ?? braced}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('wired accounts screen renders saved providers and bans cyan', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const model = await loadHotplugHome(env.app);

    const { lastFrame } = render(
      <AccountsHomeScreen
        model={model}
        selectedIndex={0}
        columns={100}
        receipt={null}
        notice={null}
        onMove={() => {}}
        onAdd={() => {}}
        onRefresh={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
        onImport={() => {}}
        onOpenSwitch={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/codex/i);
    // No cyan ANSI escape (ESC [ … 36m) anywhere in the rendered output.
    // Build the ESC control char from its code point to avoid a control-char
    // literal in the regex source (no-control-regex).
    const esc = String.fromCharCode(27);
    expect(frame).not.toContain(`${esc}[36m`);
    expect(frame).not.toMatch(new RegExp(`${esc}\\[[0-9;]*36m`));
  });

  it('a reaches a provider with nothing saved, from Switch and Accounts', async () => {
    // Only codex has a saved login; kiro is registered but empty. The cursor can
    // never land on a kiro row, so `a` must still be able to add one.
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const model = await loadHotplugHome(env.app);
    expect(model.rows.some((r) => r.providerId === 'kiro')).toBe(false);
    expect(model.providers.some((p) => p.providerId === 'kiro')).toBe(true);

    const switchAdd = vi.fn();
    const sw = render(
      <HotplugHomeScreen
        model={model}
        selectedIndex={0}
        columns={100}
        onMove={() => {}}
        onSwitch={() => {}}
        onRefresh={() => {}}
        onAdd={switchAdd}
        onProxy={() => {}}
        onAccounts={() => {}}
        onFilter={() => {}}
        onQuit={() => {}}
      />,
    );
    const switchFrame = sw.lastFrame() ?? '';
    expect(switchFrame).toMatch(/kiro/i);
    expect(switchFrame).toMatch(/a\s+add/);
    sw.stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(switchAdd).toHaveBeenCalled();

    const accountsAdd = vi.fn();
    const acc = render(
      <AccountsHomeScreen
        model={model}
        selectedIndex={0}
        columns={100}
        receipt={null}
        notice={null}
        onMove={() => {}}
        onAdd={accountsAdd}
        onRefresh={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
        onImport={() => {}}
        onOpenSwitch={() => {}}
        onBack={() => {}}
        onQuit={() => {}}
      />,
    );
    // The empty group has to render, or there is no sign kiro can be added.
    expect(acc.lastFrame() ?? '').toMatch(/kiro/i);
    acc.stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(accountsAdd).toHaveBeenCalled();
  });

  it('hotplug preview confirm calls onConfirm once', async () => {
    await env.fakes.codex.setLive({ email: 'work@x.com', token: 't1' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({ email: 'personal@x.com', token: 't2' });
    await env.app.accounts.save('codex', 'personal');
    await env.app.accounts.use('codex', 'work');

    const preview = await buildHotplugPreview(env.app, 'codex', 'personal');
    const onConfirm = vi.fn();
    const { stdin, lastFrame } = render(
      <HotplugPreviewScreen preview={preview} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    expect(lastFrame() ?? '').toMatch(/Switch|after|enter confirm/i);
    stdin.write('\r');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirm screen requires explicit enter for destructive action', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, lastFrame } = render(
      <ConfirmScreen
        title="Remove codex/work?"
        body={['This deletes the saved snapshot.']}
        confirmLabel="Remove account"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(lastFrame() ?? '').toMatch(/Remove codex\/work/i);
    // Non-confirm keys must not fire confirm
    stdin.write('x');
    expect(onConfirm).not.toHaveBeenCalled();
    stdin.write('\r');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('proxy list shows inactive enabled semantics', async () => {
    await env.fakes.grok.setLive({ email: 'a@x.com', token: 't1' });
    await env.app.accounts.save('grok', 'work');
    await env.fakes.grok.setLive({ email: 'b@x.com', token: 't2' });
    await env.app.accounts.save('grok', 'personal');
    await env.app.accounts.use('grok', 'work');
    await env.app.proxy.enableProxy('grok', 'personal', { port: 19102 });

    const rows = await loadProxyOverview(env.app);
    const { lastFrame } = render(
      <ProxyListScreen
        rows={rows}
        selectedIndex={0}
        onMove={() => {}}
        onOpen={() => {}}
        onBack={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/inactive account/i);
  });

  it('proxy model screen exposes a apply action and applies with a', () => {
    const onConfirm = vi.fn();
    const { stdin, lastFrame } = render(
      <ProxyModelsScreen
        proxyRef="opencode/default"
        clientName="Claude"
        roles={[{ id: 'default', label: 'default' }]}
        values={{ default: 'hy3-free' }}
        suggestions={['hy3-free']}
        selectedIndex={0}
        onMove={() => {}}
        onStartEdit={() => {}}
        onEditChange={() => {}}
        onCommitEdit={() => {}}
        onCancelEdit={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    expect(lastFrame() ?? '').toMatch(/a.*apply models/i);
    stdin.write('a');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('q quits from accounts screen', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const model = await loadHotplugHome(env.app);
    const onQuit = vi.fn();
    const { stdin } = render(
      <AccountsHomeScreen
        model={model}
        selectedIndex={0}
        columns={80}
        receipt={null}
        notice={null}
        onMove={() => {}}
        onAdd={() => {}}
        onRefresh={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
        onImport={() => {}}
        onOpenSwitch={() => {}}
        onBack={() => {}}
        onQuit={onQuit}
      />,
    );
    stdin.write('q');
    expect(onQuit).toHaveBeenCalled();
  });

  it('uses the shared account shortcuts for add, refresh, delete, export, and next section', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const model = await loadHotplugHome(env.app);
    const onAdd = vi.fn();
    const onRefresh = vi.fn();
    const onDelete = vi.fn();
    const onExport = vi.fn();
    const onNextSection = vi.fn();
    const onViewDetail = vi.fn();
    const { stdin } = render(
      <AccountsHomeScreen
        model={model}
        selectedIndex={0}
        columns={80}
        onMove={() => {}}
        onAdd={onAdd}
        onRefresh={onRefresh}
        onDelete={onDelete}
        onExport={onExport}
        onImport={() => {}}
        onOpenSwitch={() => {}}
        onViewDetail={onViewDetail}
        onBack={() => {}}
        onNextSection={onNextSection}
        onQuit={() => {}}
      />,
    );

    stdin.write('a');
    stdin.write('v');
    stdin.write('r');
    stdin.write('e');
    stdin.write('d');
    stdin.write('\t');
    expect(onAdd).toHaveBeenCalledTimes(1);
    // Add keeps the selected row's provider so the picker is skipped.
    expect(onAdd).toHaveBeenCalledWith('codex');
    expect(onViewDetail).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onNextSection).toHaveBeenCalledTimes(1);
  });

  it('saves the current login when an active snapshot has changed', async () => {
    await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
    await env.app.accounts.save('codex', 'work');
    const model = await loadHotplugHome(env.app);
    const changed = {
      ...model,
      rows: model.rows.map((row) => ({
        ...row,
        active: true,
        isLiveMatch: false,
        providerRelation: 'drift' as const,
        statusText: 'changed',
      })),
    };
    const onSaveCurrent = vi.fn();
    const { lastFrame, stdin } = render(
      <AccountsHomeScreen
        model={changed}
        selectedIndex={0}
        columns={120}
        onMove={() => {}}
        onAdd={() => {}}
        onRefresh={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
        onImport={() => {}}
        onOpenSwitch={() => {}}
        onSaveCurrent={onSaveCurrent}
        onBack={() => {}}
        onQuit={() => {}}
      />,
    );

    expect(lastFrame() ?? '').toMatch(/s.*save current/i);
    stdin.write('s');
    expect(onSaveCurrent).toHaveBeenCalledWith(changed.rows[0]);
  });

  // The screen hints "enter check again" but used to share one handler with esc,
  // so a login completed in another terminal dropped straight back to the list
  // with no chance to save it.
  it('stash result screen separates check-again from done', async () => {
    const onCheckAgain = vi.fn();
    const onDone = vi.fn();
    const { stdin } = render(
      <StashResultScreen
        providerId="codex"
        displayName="Codex"
        cleared
        backedUpTo="codex/work"
        matchedByIdentity={false}
        onCheckAgain={onCheckAgain}
        onDone={onDone}
      />,
    );

    stdin.write('\r');
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    stdin.write('');
    // Ink holds a lone ESC briefly to see whether an escape sequence follows.
    await new Promise((r) => setTimeout(r, 100));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('NO_COLOR / narrow rendering remains structured', async () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      await env.fakes.codex.setLive({ email: 'erik@acme.com', token: 't' });
      await env.app.accounts.save('codex', 'work');
      const model = await loadHotplugHome(env.app);
      const { lastFrame } = render(
        <AccountsHomeScreen
          model={model}
          selectedIndex={0}
          columns={40}
          receipt={null}
          notice={null}
          onMove={() => {}}
          onAdd={() => {}}
          onRefresh={() => {}}
          onDelete={() => {}}
          onExport={() => {}}
          onImport={() => {}}
          onOpenSwitch={() => {}}
          onBack={() => {}}
          onQuit={() => {}}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toMatch(/codex/i);
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });

  it('accounts.use is called once on hotplug confirm integration', async () => {
    await env.fakes.codex.setLive({ email: 'work@x.com', token: 't1' });
    await env.app.accounts.save('codex', 'work');
    await env.fakes.codex.setLive({ email: 'personal@x.com', token: 't2' });
    await env.app.accounts.save('codex', 'personal');
    await env.app.accounts.use('codex', 'work');

    const spy = vi.spyOn(env.app.accounts, 'use');
    const result = await env.app.accounts.use('codex', 'personal');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.to).toBe('personal');
    const receipt = receiptFromSwitchResult(result);
    expect(receipt.lines.some((l) => /Switched/i.test(l.text))).toBe(true);
    spy.mockRestore();
  });

  it('shows appended proxy logs live without replaying the existing tail', async () => {
    let followOptions: { lines?: number; signal?: AbortSignal } | undefined;
    const proxyLogsFollow = vi.fn(
      async (
        _providerId: string,
        _name: string,
        onLine: (line: string) => void,
        options: { lines?: number; signal?: AbortSignal },
      ) => {
        followOptions = options;
        onLine('06:02 ERR ✗ upstream 500: overloaded');
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    );
    const app = {
      proxy: { proxyLogsFollow },
    } as unknown as HotplugApp;
    const view = render(
      <ProxyLogsView
        app={app}
        providerId="opencode"
        name="default"
        text="06:01 INFO existing"
        onBack={() => {}}
        readLogs={async () => '06:01 INFO existing'}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(view.lastFrame() ?? '').toContain('upstream 500: overloaded');
    expect(followOptions?.lines).toBe(0);
    view.unmount();
  });

  it(
    'refreshes the log tail while following when no pushed line arrives',
    { timeout: 15000 },
    async () => {
      let tail = '06:01 INFO existing';
      const readLogs = vi.fn(async () => tail);
      const proxyLogsFollow = vi.fn(
        async (
          _providerId: string,
          _name: string,
          _onLine: (line: string) => void,
          options: { signal?: AbortSignal },
        ) => {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      );
      const app = {
        proxy: { proxyLogsFollow },
      } as unknown as HotplugApp;
      const view = render(
        <ProxyLogsView
          app={app}
          providerId="opencode"
          name="default"
          text={tail}
          onBack={() => {}}
          readLogs={readLogs}
        />,
      );

      tail = '06:01 INFO existing\n06:02 OK completed';
      // Polled rather than slept past the one-second refresh: the whole suite runs
      // on twelve workers, and a saturated event loop delays the timer this waits
      // for well past any fixed budget.
      await vi.waitFor(
        () => {
          expect(view.lastFrame() ?? '').toContain('06:02 OK completed');
        },
        { timeout: 10000, interval: 50 },
      );

      expect(readLogs).toHaveBeenCalled();
      view.unmount();
    },
  );
});

// silence unused type import if tree-shaken
void (null as unknown as HotplugApp);
