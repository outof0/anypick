import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  createDemoBridge,
  demoSnapshot,
  emptyDemoSnapshot,
} from '../src/tray/tauri/demo/bridge.js';

const root = resolve(import.meta.dirname, '..');
const manifest = resolve(root, 'src/tray/tauri/src-tauri/Cargo.toml');
const fixture = process.argv.includes('--empty') ? emptyDemoSnapshot : demoSnapshot;
const bridge = createDemoBridge(fixture);
const child = spawn('cargo', ['run', '--manifest-path', manifest], {
  cwd: root,
  env: { ...process.env, ANYPICK_TRAY_DEMO: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

await bridge.listen('supervisor-line', ({ payload }) => {
  if (child.stdin.writable) {
    child.stdin.write(`${payload}\n`);
  }
});

const initial = await bridge.invoke('last_supervisor_line');
child.stdin.write(`${initial}\n`);

const lines = createInterface({ input: child.stdout });
lines.on('line', (command) => {
  void bridge.invoke('send_command', { command }).catch((error) => {
    process.stderr.write(`[tray demo] ${error instanceof Error ? error.message : String(error)}\n`);
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
