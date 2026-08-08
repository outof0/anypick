/**
 * Spec §28.3 PTY / interactive guards (without requiring a real PTY).
 * Full interactive picker UX needs a PTY harness; these lock the non-TTY contracts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { ExitCode } from '../src/utils/errors';
import { setUxMode, getUxMode } from '../src/cli/ux';
import { buildProgram, requestedLaunchSurface } from '../src/cli/commands';

describe('§28.3 PTY / non-TTY interactive guards', () => {
  let root: string;
  const prevUx = getUxMode();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-pty-'));
  });

  afterEach(async () => {
    setUxMode(prevUx);
    await rm(root, { recursive: true, force: true });
  });

  it('cancellation code is 130', () => {
    expect(ExitCode.CANCELLED).toBe(130);
  });

  it('non-TTY use without --with/--current exits 2 (no picker)', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    // Force non-interactive mode as CI would
    setUxMode({ json: false, quiet: false, verbose: false, interactive: false });

    await expect(app.bindingService.use('claude', {})).rejects.toMatchObject({
      exitCode: ExitCode.INVALID_USAGE,
      code: 'MISSING_SOURCE',
    });
  });

  it('no prompt under json mode (interactive false)', () => {
    setUxMode({ json: true, quiet: false, verbose: false, interactive: true });
    // setUxMode forces interactive false when json
    expect(getUxMode().interactive).toBe(false);
  });

  it('no prompt under quiet mode', () => {
    setUxMode({ json: false, quiet: true, verbose: false, interactive: true });
    expect(getUxMode().interactive).toBe(false);
  });

  it('root help text available without TTY (launcher contract)', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const program = buildProgram(app);
    // commander help does not require TTY
    const help = program.helpInformation();
    expect(help).toMatch(/Usage:/i);
    expect(help).toMatch(/use|run|current/i);
  });

  it('resolves the bare-command surface with explicit overrides first', () => {
    expect(requestedLaunchSurface({ tui: true }, 'tray', 'tray')).toBe('tui');
    expect(requestedLaunchSurface({ tray: true }, 'tui', 'tui')).toBe('tray');
    expect(requestedLaunchSurface({}, 'tray', 'tui')).toBe('tray');
    expect(requestedLaunchSurface({}, undefined, 'tui')).toBe('tui');
    expect(requestedLaunchSurface({}, undefined, undefined)).toBeUndefined();
    expect(() => requestedLaunchSurface({ tui: true, tray: true }, undefined, undefined)).toThrow(
      /only one/i,
    );
    expect(() => requestedLaunchSurface({}, 'desktop', undefined)).toThrow(/ANYPICK_UI/i);
  });

  it('uses anypick tray itself as the open action without an open subcommand', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const program = buildProgram(app);
    const tui = program.commands.find((command) => command.name() === 'tui');
    const tray = program.commands.find((command) => command.name() === 'tray');
    expect(tui).toBeDefined();
    expect(tray).toBeDefined();
    expect((tray as unknown as { _actionHandler?: unknown })._actionHandler).toBeTypeOf('function');
    expect(tray!.commands.some((command) => command.name() === 'open')).toBe(false);
    expect(tray!.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['start', 'status', 'stop']),
    );
  });

  it('use --help and run --help expose source grammar', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const program = buildProgram(app);
    const useCmd = program.commands.find((c) => c.name() === 'use');
    const runCmd = program.commands.find((c) => c.name() === 'run');
    expect(useCmd).toBeDefined();
    expect(runCmd).toBeDefined();
    const useHelp = useCmd!.helpInformation();
    const runHelp = runCmd!.helpInformation();
    expect(useHelp).toMatch(/--with|--current/i);
    expect(runHelp).toMatch(/--with/i);
  });
});
