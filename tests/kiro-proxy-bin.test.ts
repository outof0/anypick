import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KIRO_PROXY_BINARIES,
  resolveKiroProxyCommand,
  resolveKiroProxyCommandCached,
  resetKiroProxyDiscoveryCache,
} from '../src/sources/kiro-proxy-bin';

const SAVED = {
  PATH: process.env.PATH,
  KIROLINK_BIN: process.env.KIROLINK_BIN,
  KIROLINK_JS: process.env.KIROLINK_JS,
  PNPM_HOME: process.env.PNPM_HOME,
  npm_config_prefix: process.env.npm_config_prefix,
};

function clearEnv(): void {
  delete process.env.PATH;
  delete process.env.KIROLINK_BIN;
  delete process.env.KIROLINK_JS;
  delete process.env.PNPM_HOME;
  delete process.env.npm_config_prefix;
}

function makeExecutable(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe('Kiro proxy discovery (spec §19.5)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kiro-bin-'));
    clearEnv();
    resetKiroProxyDiscoveryCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetKiroProxyDiscoveryCache();
  });

  it('every shipped binary name resolves — the gate and launcher share one list', () => {
    for (const name of KIRO_PROXY_BINARIES) {
      const dir = mkdtempSync(join(tmpdir(), `kiro-${name}-`));
      const path = makeExecutable(dir, name);
      process.env.PATH = dir;
      resetKiroProxyDiscoveryCache();
      expect(resolveKiroProxyCommand()).toEqual({ kind: 'bin', path });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a binary in a derived pnpm bin dir the tray PATH would miss', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.PNPM_HOME = root;
    const path = makeExecutable(root, 'kirolink');
    expect(resolveKiroProxyCommand()).toEqual({ kind: 'bin', path });
  });

  it('honours KIROLINK_JS as a node entry', () => {
    const entry = join(root, 'kirolink.mjs');
    writeFileSync(entry, 'export {}');
    process.env.KIROLINK_JS = entry;
    expect(resolveKiroProxyCommand()).toEqual({ kind: 'node-entry', entry });
  });

  it('an explicit KIROLINK_BIN that does not exist resolves to null, not a discovered fallback', () => {
    const real = makeExecutable(root, 'kirolink');
    process.env.PATH = root;
    process.env.KIROLINK_BIN = join(root, 'does-not-exist');
    expect(real).toContain('kirolink');
    expect(resolveKiroProxyCommand()).toBeNull();
  });

  it('returns null when nothing is discoverable', () => {
    process.env.PATH = root;
    expect(resolveKiroProxyCommand()).toBeNull();
  });

  it('cache notices a change once its key changes', () => {
    process.env.PATH = root;
    expect(resolveKiroProxyCommandCached()).toBeNull();
    const path = makeExecutable(root, 'kirolink');
    // Same PATH string → cached null until the key changes.
    expect(resolveKiroProxyCommandCached()).toBeNull();
    process.env.PATH = `${root}:/bin`;
    expect(resolveKiroProxyCommandCached()).toEqual({ kind: 'bin', path });
  });
});
