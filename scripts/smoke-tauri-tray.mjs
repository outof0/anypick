/**
 * Protocol smoke for the packaged Tauri tray helper (Linux / Windows).
 *
 * Default (one process): seed snapshot/status/result → multi-command probe →
 * garbage rejection → quit. Covers both the short pipe smoke and deep probe.
 *
 * Flags / env:
 *   --smoke-only | ANYPICK_TRAY_SMOKE=1 (without probe)
 *     snapshot → refresh → exit only (legacy short path)
 *   --probe | ANYPICK_TRAY_PROBE=1 | default
 *     full multi-command suite
 *
 * Never reads/writes ~/.anypick. Protocol mode exits before desktop initialization.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '..');
const extension = process.platform === 'win32' ? '.exe' : '';
const packagedName = `anypick-tray-${process.platform}-${process.arch}${extension}`;
const candidates = [
  process.env.ANYPICK_TAURI_TRAY_BINARY,
  resolve(root, 'dist/tray/bin', packagedName),
  resolve(
    root,
    'src/tray/tauri/src-tauri/target/release',
    process.platform === 'win32' ? 'anypick-tray.exe' : 'anypick-tray',
  ),
].filter(Boolean);

// Default is the full probe suite (one spawn). Explicit --smoke-only keeps the short path.
const fullSuite = !process.argv.includes('--smoke-only');

if (!['linux', 'win32'].includes(process.platform)) {
  console.error(
    `smoke-tauri-tray: skip on ${process.platform} (Tauri helper is Linux/Windows only)`,
  );
  process.exit(0);
}

async function resolveBinary() {
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `No tray helper binary found. Build with \`pnpm tray:build\` or set ANYPICK_TAURI_TRAY_BINARY.\nTried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

const encoder = new TextEncoder();
function encode(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const emptySnapshot = {
  proxyCount: 0,
  revision: 1,
  routes: [],
  actions: [],
  clientModelConfigs: [],
  usage: [],
  proxies: [],
  accounts: [],
  hubSources: [],
  hubConflicts: [],
  logSources: [],
  gateways: [],
  accountProviders: [],
  gatewayProviders: [],
  settings: {},
  activity: [],
};

const binary = await resolveBinary();
const timeoutMs = Number(process.env.ANYPICK_TRAY_SMOKE_TIMEOUT_MS || 60_000);
const mode = fullSuite ? 'full' : 'smoke-only';

console.log(`smoke-tauri-tray[${mode}]: spawning ${binary}`);

const child = spawn(binary, [], {
  cwd: root,
  env: {
    ...process.env,
    // Full suite uses PROBE only — SMOKE auto-exits on first snapshot and would
    // prevent multi-command coverage in the same process. Protocol modes also
    // skip the visible window and system tray so headless CI tests only the bridge.
    ...(fullSuite ? { ANYPICK_TRAY_PROBE: '1' } : { ANYPICK_TRAY_SMOKE: '1' }),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const stdoutLines = [];
const stderrChunks = [];

const stdout = createInterface({ input: child.stdout });
stdout.on('line', (line) => {
  stdoutLines.push(line);
});

child.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk.toString());
});

function dumpIo() {
  return `stdout:\n${stdoutLines.join('\n')}\nstderr:\n${stderrChunks.join('')}`;
}

const exitPromise = new Promise((resolveExit, rejectExit) => {
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    rejectExit(new Error(`Timed out after ${timeoutMs}ms.\n${dumpIo()}`));
  }, timeoutMs);

  child.once('error', (error) => {
    clearTimeout(timer);
    rejectExit(error);
  });

  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolveExit({ code, signal });
  });
});

function waitForLine(predicate, label, ms = 15_000) {
  const started = Date.now();
  let cursor = 0;
  return new Promise((resolveWait, rejectWait) => {
    const check = () => {
      while (cursor < stdoutLines.length) {
        const line = stdoutLines[cursor++];
        if (predicate(line)) {
          resolveWait(line);
          return;
        }
      }
      if (Date.now() - started > ms) {
        rejectWait(new Error(`Timed out waiting for ${label}.\n${dumpIo()}`));
        return;
      }
      setTimeout(check, 40);
    };
    check();
  });
}

await new Promise((r) => setTimeout(r, 200));
if (!child.stdin.writable) {
  const { code, signal } = await exitPromise;
  throw new Error(
    `Tray helper exited before accepting stdin (code=${code} signal=${signal}).\n${dumpIo()}`,
  );
}

if (!fullSuite) {
  child.stdin.write(`snapshot\t${encode(emptySnapshot)}\n`);
  await new Promise((r) => setTimeout(r, 400));
  child.stdin.end();

  const { code, signal } = await exitPromise;
  if (!stdoutLines.includes('refresh')) {
    throw new Error(
      `Expected tray helper to emit \`refresh\` under ANYPICK_TRAY_SMOKE.\n${dumpIo()}`,
    );
  }
  if (code !== 0 && code !== null) {
    throw new Error(
      `Tray helper exited with code ${code}${signal ? ` signal=${signal}` : ''}.\n${dumpIo()}`,
    );
  }
  console.log('smoke-tauri-tray[smoke-only]: ok (snapshot → refresh → exit)');
  process.exit(0);
}

// --- full suite (one spawn) ---
// 1) Seed supervisor state (also proves snapshot/status/result are accepted).
child.stdin.write(`snapshot\t${encode(emptySnapshot)}\n`);
child.stdin.write(`status\t0\n`);
child.stdin.write(
  `result\t${encode({ version: 1, requestId: 'probe', status: 'success', message: 'ok' })}\n`,
);

// 2) Multi-command probe.
const expected = [
  { probe: 'refresh', match: (line) => line === 'refresh' },
  { probe: 'logs', match: (line) => line.startsWith('logs\t') },
  { probe: 'mutate', match: (line) => line.startsWith('mutate\t') },
  { probe: 'invoke', match: (line) => line.startsWith('invoke\t') },
  { probe: 'model-roles', match: (line) => line.startsWith('model-roles\t') },
  { probe: 'navigate', match: (line) => line === 'navigate\taccounts' },
];

for (const step of expected) {
  child.stdin.write(`probe\t${step.probe}\n`);
  await waitForLine(step.match, `probe ${step.probe}`);
  console.log(`  ✓ probe ${step.probe}`);
}

// 3) Garbage rejection (no extra UI output).
const beforeGarbage = stdoutLines.length;
child.stdin.write('not-a-protocol-line\n');
child.stdin.write('invoke\tshould-not-pass-from-supervisor\n');
await new Promise((r) => setTimeout(r, 250));
if (stdoutLines.length !== beforeGarbage) {
  throw new Error(`Garbage supervisor lines should not produce UI output.\n${dumpIo()}`);
}
console.log('  ✓ rejects non-supervisor lines');

// 4) Quit.
child.stdin.write('probe\tquit\n');
await waitForLine((line) => line === 'quit', 'quit');
console.log('  ✓ probe quit');

child.stdin.end();
const { code, signal } = await exitPromise;
if (code !== 0 && code !== null) {
  throw new Error(
    `Tray helper exited with code ${code}${signal ? ` signal=${signal}` : ''}.\n${dumpIo()}`,
  );
}

for (const step of expected) {
  if (!stdoutLines.some(step.match)) {
    throw new Error(`Missing expected output for ${step.probe}.\n${dumpIo()}`);
  }
}
if (!stdoutLines.includes('quit')) {
  throw new Error(`Missing quit.\n${dumpIo()}`);
}

console.log('smoke-tauri-tray[full]: ok (seed + multi-command + quit, one spawn)');
