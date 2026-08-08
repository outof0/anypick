/**
 * macOS tray launcher.
 *
 * Default: REAL data — runs `tray run` against ANYPICK_HOME (default ~/.anypick).
 * --fixture: in-memory fake snapshot for layout-only work (never touches real state).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createDemoBridge,
  demoSnapshot,
  emptyDemoSnapshot,
} from '../src/tray/tauri/demo/bridge.js';

if (process.platform !== 'darwin') {
  throw new Error('The macOS tray demo only runs on macOS.');
}

const root = resolve(import.meta.dirname, '..');
const useFixture = process.argv.includes('--fixture') || process.argv.includes('--empty');
const empty = process.argv.includes('--empty');

// ─── REAL DATA (default) ───────────────────────────────────────────────────
if (!useFixture) {
  const anypickHome = process.env.ANYPICK_HOME || join(homedir(), '.anypick');
  process.stderr.write(
    [
      '',
      '[macOS tray] REAL data mode',
      `  ANYPICK_HOME=${anypickHome}`,
      '  Snapshot comes from your accounts, proxies, and Proxy Hub on disk.',
      '  (Fixture layout-only mode: pnpm tray:macos --fixture)',
      '',
    ].join('\n'),
  );

  // Always run from source in the repo. A stale dist/cli.js still points at the
  // old single-file AnyPickTray.swift and will look like fake/demo data.
  // Use `node --import tsx` (not the tsx CLI) so process.pid matches state.json.
  const srcEntry = resolve(root, 'src/cli.ts');
  const cmd = process.execPath;
  const args = ['--import', 'tsx', srcEntry, 'tray', 'run'];

  const child = spawn(cmd, args, {
    cwd: root,
    env: {
      ...process.env,
      ANYPICK_HOME: anypickHome,
      ANYPICK_TRAY_PROCESS: '1',
    },
    stdio: 'inherit',
  });

  const stop = () => {
    child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} else {
  // ─── FIXTURE (layout-only) ───────────────────────────────────────────────
  process.stderr.write(
    [
      '',
      '[macOS tray] FIXTURE mode — fake snapshot, no ~/.anypick reads/writes.',
      '  For real accounts/proxies:  pnpm dev tray start',
      '  Fixture layout-only:        pnpm tray:macos --fixture',
      '',
    ].join('\n'),
  );

  const nativeDir = resolve(root, 'src/tray/native');
  let names = [];
  try {
    names = readFileSync(join(nativeDir, 'sources.txt'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.endsWith('.swift'));
  } catch {
    names = readdirSync(nativeDir)
      .filter((name) => name.endsWith('.swift'))
      .sort();
  }
  const sources = names.map((name) => join(nativeDir, name));
  const binary = resolve('/private/tmp', 'anypick-tray-macos-demo');
  const compile = spawnSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-parse-as-library',
      ...sources,
      '-o',
      binary,
      '-framework',
      'AppKit',
      '-framework',
      'SwiftUI',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (compile.status !== 0) {
    throw new Error('Could not compile the native macOS tray demo.');
  }

  const iconDir = resolve('/private/tmp/icons');
  mkdirSync(iconDir, { recursive: true });
  for (const icon of [
    'claude.svg',
    'openai.svg',
    'googlegemini.svg',
    'opencode.svg',
    'openrouter.svg',
    'kiro.svg',
    'grok.svg',
  ]) {
    copyFileSync(resolve(root, 'src/tray/icons', icon), join(iconDir, icon));
  }

  const fixture = empty ? emptyDemoSnapshot : demoSnapshot;
  const bridge = createDemoBridge(fixture);
  const child = spawn(binary, ['1'], {
    env: { ...process.env, ANYPICK_TRAY_DEMO: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await bridge.listen('supervisor-line', ({ payload }) => {
    if (child.stdin.writable) {
      child.stdin.write(`${payload}\n`);
    }
  });

  const snapshotPayload = Buffer.from(JSON.stringify(fixture), 'utf8').toString('base64');
  child.stdin.write(`snapshot\t${snapshotPayload}\n`);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (command) => {
    void bridge.invoke('send_command', { command }).catch((error) => {
      process.stderr.write(
        `[macOS tray fixture] ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  });

  const stop = () => {
    child.stdin.end();
    child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
