import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { accountRef, gatewayRef } from '../src/core/refs';
import { buildLauncherModel, SECTION_ORDER } from '../src/cli/launcher-model';
import {
  cursorForActionId,
  layoutForColumns,
  orderedActions,
  renderLauncherFrame,
} from '../src/cli/launcher-render';

async function seedAccount(
  app: Awaited<ReturnType<typeof createAppReady>>,
  provider: string,
  name: string,
): Promise<void> {
  const { snapshotDir } = await app.accountStore.prepareSnapshot(provider, name);
  await writeFile(join(snapshotDir, 'auth.json'), JSON.stringify({ token: 't' }), {
    mode: 0o600,
  });
  await app.accountStore.writeMeta({
    name,
    provider,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('launcher layout breakpoints', () => {
  it('classifies wide / medium / narrow', () => {
    expect(layoutForColumns(120)).toBe('wide');
    expect(layoutForColumns(80)).toBe('wide');
    expect(layoutForColumns(79)).toBe('medium');
    expect(layoutForColumns(50)).toBe('medium');
    expect(layoutForColumns(49)).toBe('narrow');
  });
});

describe('launcher model + render', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-launch-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('empty state exposes Connect + Add account/gateway', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const model = await buildLauncherModel(app, { cwd: '/tmp/project' });
    expect(model.mode).toBe('empty');
    expect(model.subtitle).toMatch(/No clients connected/i);
    const ids = model.actions.map((a) => a.id);
    expect(ids.some((id) => id.startsWith('connect:'))).toBe(true);
    expect(ids).toContain('other:add-account');
    expect(ids).toContain('other:add-gateway');
    // no Run section for ready clients
    expect(model.actions.every((a) => a.section !== 'run')).toBe(true);
  });

  it('ready state puts configured clients under Run as direct actions', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await seedAccount(app, 'grok', 'work');
    app.bindings.upsertGlobal(
      'claude',
      {
        client: 'claude',
        source: accountRef('grok', 'work'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );

    const model = await buildLauncherModel(app, { cwd: '/Users/erik/code/acme' });
    expect(model.mode).toBe('ready');
    const run = model.actions.filter((a) => a.section === 'run');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      id: 'run:claude',
      kind: 'run',
      label: expect.stringMatching(/claude/i),
      detail: 'grok/work',
      status: 'ready',
    });
    // configure has Add connection (not separate account/gateway)
    expect(model.actions.some((a) => a.id === 'configure:add-connection')).toBe(true);
    expect(model.actions.some((a) => a.label === 'Exit')).toBe(false);
  });

  it('attention items sort before Run', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    // Binding to missing account → attention
    app.bindings.upsertGlobal(
      'codex',
      {
        client: 'codex',
        source: accountRef('codex', 'gone'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );
    await seedAccount(app, 'grok', 'work');
    app.bindings.upsertGlobal(
      'claude',
      {
        client: 'claude',
        source: accountRef('grok', 'work'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );

    const model = await buildLauncherModel(app);
    expect(model.mode).toBe('degraded');
    const ordered = orderedActions(model);
    const firstRun = ordered.findIndex((a) => a.section === 'run');
    const firstAtt = ordered.findIndex((a) => a.section === 'attention');
    expect(firstAtt).toBeGreaterThanOrEqual(0);
    expect(firstAtt).toBeLessThan(firstRun);
    expect(SECTION_ORDER.indexOf('attention')).toBeLessThan(SECTION_ORDER.indexOf('run'));
  });

  it('render is compact: short names, status dots, contextual footer, no rails', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await seedAccount(app, 'grok', 'work');
    app.bindings.upsertGlobal(
      'claude',
      {
        client: 'claude',
        source: accountRef('grok', 'work'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );
    const model = await buildLauncherModel(app, { cwd: '/tmp/x' });
    const ordered = orderedActions(model);
    const runIdx = ordered.findIndex((a) => a.id === 'run:claude');
    const frame = renderLauncherFrame(model, {
      cursor: runIdx >= 0 ? runIdx : 0,
      columns: 100,
      color: false,
    });

    expect(frame).toMatch(/anypick/);
    expect(frame).toMatch(/RUN|Run/i);
    expect(frame).toMatch(/Claude/);
    expect(frame).not.toMatch(/Claude Code/); // short label
    expect(frame).toMatch(/grok\/work/);
    expect(frame).toMatch(/ready/);
    expect(frame).toMatch(/anypick run claude/); // contextual preview
    expect(frame).toMatch(/↑↓|esc/);
    // no clack vertical rails
    expect(frame).not.toMatch(/^[│┌└├]/m);
    expect(frame).not.toMatch(/\n│ /);
    // no Exit action
    expect(frame).not.toMatch(/\bExit\b/);
    // selection marker + hotkey
    expect(frame).toMatch(/›/);
    expect(frame).toMatch(/[1-9]/);
  });

  it('preserves selection by semantic action id', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await app.profiles.create('gw', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk',
    });
    app.bindings.upsertGlobal(
      'claude',
      {
        client: 'claude',
        source: gatewayRef('gw'),
        model: { mode: 'omitted' },
        transportPolicy: 'auto',
        clientOptions: {},
      },
      { kind: 'direct' },
    );
    const model = await buildLauncherModel(app);
    const idx = cursorForActionId(model, 'configure:add-connection');
    const ordered = orderedActions(model);
    expect(ordered[idx]?.id).toBe('configure:add-connection');
  });

  it('NO_COLOR path still renders structure', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const model = await buildLauncherModel(app);
    const frame = renderLauncherFrame(model, { cursor: 0, columns: 40, color: false });
    expect(frame.split('\n').length).toBeGreaterThan(3);
    expect(frame).toMatch(/Get started|Add account|anypick/);
  });
});
