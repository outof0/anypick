#!/usr/bin/env node
/**
 * Single local entry for the AnyPick app.
 *
 *   pnpm dev                 → interactive CLI / TUI from source
 *   pnpm dev --help
 *   pnpm dev list accounts
 *   pnpm dev tray start
 *   pnpm dev proxy serve hub …
 *
 * Long-running processes (tui, tray, proxy serve) use `tsx watch` so source
 * edits restart the process. One-shot commands exit normally without a watcher.
 *
 * Docs stay separate: `cd docs && pnpm dev`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const entry = join(root, 'src', 'cli.ts');

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const watch = shouldWatch(args);
const tsxArgs = watch
  ? [
      'watch',
      '--clear-screen=false',
      '--exclude',
      '**/dist/**',
      '--exclude',
      '**/node_modules/**',
      entry,
      ...args,
    ]
  : [entry, ...args];

const child = spawn(process.execPath, [tsxCli, ...tsxArgs], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function shouldWatch(argv) {
  if (process.env.ANYPICK_DEV_WATCH === '0') {
    return false;
  }
  if (process.env.ANYPICK_DEV_WATCH === '1') {
    return true;
  }
  // Explicit opt-in/out via flag (stripped so CLI never sees it).
  if (argv.includes('--watch')) {
    const i = argv.indexOf('--watch');
    argv.splice(i, 1);
    return true;
  }
  if (argv.includes('--no-watch')) {
    const i = argv.indexOf('--no-watch');
    argv.splice(i, 1);
    return false;
  }

  if (argv.length === 0) {
    return false;
  }
  // Only long-running supervisors — not one-shot `tray start/stop/status`.
  if (argv[0] === 'tui') {
    return true;
  }
  if (argv[0] === 'tray' && argv[1] === 'run') {
    return true;
  }
  if (argv[0] === 'proxy' && argv[1] === 'serve') {
    return true;
  }
  if (argv.includes('--tui')) {
    return true;
  }
  return false;
}
