import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/core/app';
import type { HotplugApp } from '../src/core/app';

describe('ProfileService', () => {
  let root: string;
  let app: HotplugApp;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-profile-'));
    app = createApp({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores models on the profile at create time', async () => {
    const created = await app.profiles.create('Kiro Key - 1k', {
      provider: 'custom',
      endpoint: 'https://api.example.com',
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-5',
      sonnetModel: 'claude-sonnet-5',
      opusModel: 'claude-opus-4-8',
      haikuModel: 'claude-haiku-4-5',
    });

    expect(created.meta.name).toBe('kiro-key-1k');
    expect(created.meta.label).toBe('Kiro Key - 1k');
    expect(created.meta.defaultModel).toBe('claude-sonnet-5');
    expect(created.meta.sonnetModel).toBe('claude-sonnet-5');
    expect(created.meta.opusModel).toBe('claude-opus-4-8');
    expect(created.meta.haikuModel).toBe('claude-haiku-4-5');
    expect(created.secrets.apiKey).toBe('sk-test');
  });

  it('edits models simply', async () => {
    await app.profiles.create('p1', {
      provider: 'custom',
      endpoint: 'https://x',
      apiKey: 'k',
      defaultModel: 'a',
    });
    const edited = await app.profiles.edit('p1', {
      defaultModel: 'b',
      sonnetModel: 's',
    });
    expect(edited.meta.defaultModel).toBe('b');
    expect(edited.meta.sonnetModel).toBe('s');
  });

  it('rejects unknown catalog provider', async () => {
    await expect(app.profiles.create('x', { provider: 'nope', apiKey: 'k' })).rejects.toThrow(
      /Unknown catalog provider/,
    );
  });
});
