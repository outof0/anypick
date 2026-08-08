import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// The production tray compiles this Swift source lazily at startup. Compile it
// during a macOS build as well, so a broken copied asset cannot reach users.
if (process.platform === 'darwin') {
  const stage = mkdtempSync(join(tmpdir(), 'anypick-tray-build-'));
  try {
    const nativeDir = resolve('dist/tray/native');
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
    if (names.length === 0) {
      throw new Error('No Swift sources found under dist/tray/native.');
    }
    const sources = names.map((name) => join(nativeDir, name));
    const result = spawnSync(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-parse-as-library',
        ...sources,
        '-o',
        join(stage, 'anypick-tray-build-check'),
        '-framework',
        'AppKit',
        '-framework',
        'SwiftUI',
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error('Native macOS tray compilation failed.');
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
