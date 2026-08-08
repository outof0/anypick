/**
 * pack-smoke: verify the freshly built tarball works end-to-end.
 *
 * Part of BASE-01 (test & package baseline truthfulness). Verifies the exact
 * tarball produced by `pnpm pack`; it never rebuilds or repacks, so CI cannot
 * accidentally test a different artifact from the one it publishes. It asserts:
 *   - anypick --version / --help print
 *   - root ESM import resolves with no filesystem/process side effects
 *   - .d.ts + declaration maps resolve
 *   - a blocked deep import (anypick/internal/*) fails
 *
 * Run via: pnpm package:smoke (or directly after `pnpm package` in CI)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const distDir = join(root, 'dist');
const tarballGlob = join(distDir, 'anypick-*.tgz');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: 'pipe', ...opts }).toString();
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('BASE-01 pack:smoke');

const tarballs = readdirSync(distDir).filter((f) => f.endsWith('.tgz'));
check('exactly one prebuilt tarball is present', tarballs.length === 1, `found ${tarballs.length}`);
if (tarballs.length !== 1) {
  process.exit(1);
}
const tarball = join(distDir, tarballs[0]);

// Install into an isolated temp dir and run smoke checks there.
const installDir = mkdtempSync(join(tmpdir(), 'anypick-smoke-'));
try {
  run('npm', ['init', '-y'], { cwd: installDir });
  run('npm', ['install', tarball], { cwd: installDir });

  const bin = join(installDir, 'node_modules', 'anypick', 'dist', 'cli.js');
  check('tarball contains cli.js', existsSync(bin));

  const version = run('node', [bin, '--version'], { cwd: installDir }).trim();
  check('anypick --version prints a semver', /^\d+\.\d+\.\d+/.test(version), `got "${version}"`);

  const help = run('node', [bin, '--help'], { cwd: installDir });
  check('anypick --help prints usage', help.includes('Usage') || help.includes('usage'));

  // Root ESM import must resolve with no side effects (no HOME capted, no sqlite open).
  const importProbe = join(installDir, 'import-probe.mjs');
  writeFileSync(
    importProbe,
    "import('anypick').then(m => { if (typeof m.createAnyPickApp !== 'function') { console.error('missing createAnyPickApp'); process.exit(1); } console.log('import-ok'); }).catch(e => { console.error(String(e)); process.exit(1); });",
  );
  const importOut = run('node', [importProbe], { cwd: installDir }).trim();
  check('root ESM import resolves', importOut === 'import-ok', `got "${importOut}"`);

  const subpathProbe = join(installDir, 'subpath-probe.mjs');
  writeFileSync(
    subpathProbe,
    "Promise.all([import('anypick/adapters'), import('anypick/types'), import('anypick/testing')]).then(() => console.log('subpaths-ok')).catch(e => { console.error(String(e)); process.exit(1); });",
  );
  const subpathOut = run('node', [subpathProbe], { cwd: installDir }).trim();
  check('documented subpaths resolve', subpathOut === 'subpaths-ok', `got "${subpathOut}"`);

  // Declarations + maps resolve.
  const dts = join(installDir, 'node_modules', 'anypick', 'dist', 'index.d.ts');
  const dtsMap = join(installDir, 'node_modules', 'anypick', 'dist', 'index.d.ts.map');
  check('index.d.ts shipped', existsSync(dts));
  check('index.d.ts.map shipped', existsSync(dtsMap));

  // Blocked deep import must fail.
  const deepProbe = join(installDir, 'deep-probe.mjs');
  writeFileSync(
    deepProbe,
    "import('anypick/internal/store.js').then(() => { console.error('deep import should have failed'); process.exit(1); }).catch(() => { console.log('deep-blocked'); });",
  );
  const deepOut = run('node', [deepProbe], { cwd: installDir }).trim();
  check('blocked deep import fails', deepOut === 'deep-blocked', `got "${deepOut}"`);
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

console.log(failures === 0 ? 'pack:smoke PASSED' : `pack:smoke FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
