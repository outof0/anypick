import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveAnyPickCliLaunch,
  shouldWatchDetachedDev,
} from '../src/providers/opencode-cli-entry';

describe('resolveAnyPickCliLaunch', () => {
  const prevWatch = process.env.ANYPICK_DEV_WATCH;
  const prevTray = process.env.ANYPICK_TRAY_CLI_ENTRY;

  afterEach(() => {
    if (prevWatch === undefined) {
      delete process.env.ANYPICK_DEV_WATCH;
    } else {
      process.env.ANYPICK_DEV_WATCH = prevWatch;
    }
    if (prevTray === undefined) {
      delete process.env.ANYPICK_TRAY_CLI_ENTRY;
    } else {
      process.env.ANYPICK_TRAY_CLI_ENTRY = prevTray;
    }
  });

  it('spawns tsx watch for a TypeScript CLI entry by default', () => {
    const entry = resolve('src/cli.ts');
    expect(existsSync(entry)).toBe(true);
    process.env.ANYPICK_TRAY_CLI_ENTRY = entry;
    delete process.env.ANYPICK_DEV_WATCH;

    const launch = resolveAnyPickCliLaunch(['proxy', 'serve', 'hub', '--name', 'default']);
    expect(launch.watch).toBe(true);
    expect(launch.entry).toBe(entry);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/tsx[/\\]dist[/\\]cli\.mjs$|tsx[/\\]cli/);
    expect(launch.args).toContain('watch');
    expect(launch.args).toContain(entry);
    expect(launch.args.slice(-5)).toEqual(['proxy', 'serve', 'hub', '--name', 'default']);
  });

  it('disables watch when ANYPICK_DEV_WATCH=0', () => {
    const entry = resolve('src/cli.ts');
    process.env.ANYPICK_TRAY_CLI_ENTRY = entry;
    process.env.ANYPICK_DEV_WATCH = '0';

    const launch = resolveAnyPickCliLaunch(['proxy', 'serve', 'hub']);
    expect(launch.watch).toBe(false);
    expect(launch.args[0]).toBe('--import');
    expect(launch.args[1]).toBe('tsx');
    expect(launch.args[2]).toBe(entry);
    expect(launch.args).not.toContain('watch');
  });

  it('honors explicit watch:false even when env allows it', () => {
    const entry = resolve('src/cli.ts');
    process.env.ANYPICK_TRAY_CLI_ENTRY = entry;
    process.env.ANYPICK_DEV_WATCH = '1';

    const launch = resolveAnyPickCliLaunch(['proxy', 'serve', 'hub'], { watch: false });
    expect(launch.watch).toBe(false);
    expect(launch.args).not.toContain('watch');
  });

  it('shouldWatchDetachedDev follows ANYPICK_DEV_WATCH', () => {
    process.env.ANYPICK_DEV_WATCH = '0';
    expect(shouldWatchDetachedDev()).toBe(false);
    process.env.ANYPICK_DEV_WATCH = '1';
    expect(shouldWatchDetachedDev()).toBe(true);
    delete process.env.ANYPICK_DEV_WATCH;
    expect(shouldWatchDetachedDev()).toBe(true);
  });
});
