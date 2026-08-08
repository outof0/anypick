/**
 * Spec §28.2 #40 isolation cleanup after signal-style teardown
 * Spec §28.2 #41 parallel ephemeral does not modify live client config
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  createTempRuntimeRoot,
  makeIsolatedRuntime,
  materializeIsolatablePaths,
} from '../src/clients/isolation';
import { createClaudeCodeClient } from '../src/clients/claude-code';
import { pathExists } from '../src/utils/fs';
import type { SourceAdapter } from '../src/types';
import { accountRef } from '../src/core/refs';

function proxyAdapter(): SourceAdapter {
  return {
    sourceRef: accountRef('grok', 'work'),
    capabilities: {
      sourceKind: 'account',
      provider: 'grok',
      nativeClients: [],
      protocols: ['openai', 'anthropic'],
      canRefresh: false,
      supportsModelDiscovery: false,
      requiresNativeAuthWrite: false,
    },
    transportFor: () => 'managed_builtin_proxy',
  };
}

describe('§28.2 #40 isolated runtime deleted after SIGINT/SIGTERM-style cleanup', () => {
  it('cleanup removes temp runtime (same path as post-signal teardown)', async () => {
    const runtime = await createTempRuntimeRoot('hotplug-sig-');
    const marker = join(runtime, 'marker.txt');
    await writeFile(marker, 'alive', { mode: 0o600 });
    expect(await pathExists(runtime)).toBe(true);

    const isolated = makeIsolatedRuntime(runtime, { HOME: runtime });

    // Simulate primary.ts cleanup after child exit(signal)
    const onSig = async (_signal: NodeJS.Signals) => {
      await isolated.cleanup();
    };
    await onSig('SIGINT');
    expect(await pathExists(runtime)).toBe(false);

    // Second cleanup is idempotent
    await onSig('SIGTERM');
    expect(await pathExists(runtime)).toBe(false);
  });

  it('cleanup after failed materialize does not leave partial live writes', async () => {
    const liveHome = await mkdtemp(join(tmpdir(), 'sig-live-'));
    try {
      await mkdir(join(liveHome, '.claude'), { recursive: true });
      const liveSettings = join(liveHome, '.claude', 'settings.json');
      await writeFile(liveSettings, JSON.stringify({ keep: true }), { mode: 0o600 });
      const before = await readFile(liveSettings, 'utf8');

      const runtime = await createTempRuntimeRoot('hotplug-fail-');
      const isolated = makeIsolatedRuntime(runtime, { HOME: runtime });
      try {
        await materializeIsolatablePaths(runtime, [
          {
            sourcePath: join(liveHome, '.claude', 'settings.json'),
            destinationPath: '.claude/settings.json',
            kind: 'file',
            required: true,
          },
        ]);
      } finally {
        // Always cleanup as SIGINT handler would
        await isolated.cleanup();
      }

      expect(await pathExists(runtime)).toBe(false);
      expect(await readFile(liveSettings, 'utf8')).toBe(before);
    } finally {
      await rm(liveHome, { recursive: true, force: true });
    }
  });
});

describe('§28.2 #41 parallel ephemeral runs do not modify live client config', () => {
  let liveHome: string;

  beforeEach(async () => {
    liveHome = await mkdtemp(join(tmpdir(), 'parallel-live-'));
    await mkdir(join(liveHome, '.claude'), { recursive: true });
    await writeFile(
      join(liveHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { KEEP_ME: 'yes' }, other: true }),
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await rm(liveHome, { recursive: true, force: true });
  });

  it('two concurrent createIsolatedRuntime leave live settings unchanged', async () => {
    const client = createClaudeCodeClient(liveHome);
    const liveBefore = await readFile(join(liveHome, '.claude', 'settings.json'), 'utf8');
    const hotplugRoot = await mkdtemp(join(tmpdir(), 'parallel-hotplug-'));

    try {
      const planBase = {
        clientId: 'claude' as const,
        source: {
          kind: 'account' as const,
          display: 'grok/work',
          adapter: proxyAdapter(),
          ref: accountRef('grok', 'work'),
        },
        transport: {
          capability: 'managed_builtin_proxy' as const,
          protocol: 'anthropic' as const,
          endpoint: 'http://127.0.0.1:18080',
        },
        model: { mode: 'omitted' as const },
        mode: 'ephemeral' as const,
        dryRun: false,
        verbose: false,
        hotplugRoot,
      };

      const paths = await client.listIsolatablePaths!({ home: liveHome });
      const [a, b] = await Promise.all([
        client.createIsolatedRuntime!(
          {
            ...planBase,
            transport: { ...planBase.transport, endpoint: 'http://127.0.0.1:18081' },
          },
          paths,
        ),
        client.createIsolatedRuntime!(
          {
            ...planBase,
            transport: { ...planBase.transport, endpoint: 'http://127.0.0.1:18082' },
          },
          paths,
        ),
      ]);

      expect(a.directory).not.toBe(b.directory);
      expect(await pathExists(a.directory)).toBe(true);
      expect(await pathExists(b.directory)).toBe(true);
      expect(await readFile(join(liveHome, '.claude', 'settings.json'), 'utf8')).toBe(liveBefore);

      // Isolated homes must not be the live home
      expect(a.directory).not.toBe(liveHome);
      expect(b.directory).not.toBe(liveHome);
      expect(a.directory).not.toBe(homedir());

      await a.cleanup();
      await b.cleanup();
      expect(await pathExists(a.directory)).toBe(false);
      expect(await pathExists(b.directory)).toBe(false);
      expect(await readFile(join(liveHome, '.claude', 'settings.json'), 'utf8')).toBe(liveBefore);
    } finally {
      await rm(hotplugRoot, { recursive: true, force: true });
    }
  });
});
