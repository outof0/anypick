/**
 * Antigravity is a second sign-in source for the `gemini` provider whose
 * credential lives in the OS credential store, not under ~/.gemini. Clearing it
 * must therefore never be routed through the CLI-file clear (and vice versa),
 * or "add another account" leaves the chosen source still signed in.
 *
 * The keychain delete is mocked: the real one would wipe the developer's own
 * Antigravity login.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deleteCredential = vi.fn(async () => true);

vi.mock('../src/providers/gemini-antigravity-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/gemini-antigravity-oauth')>()),
  deleteAntigravityOAuthCredential: deleteCredential,
}));

const { GeminiProvider } = await import('../src/providers/gemini');
const { pathExists } = await import('../src/utils/fs');

describe('gemini clearLiveSource', () => {
  let home: string;
  let provider: InstanceType<typeof GeminiProvider>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hotplug-gemini-clear-'));
    provider = new GeminiProvider(home);
    deleteCredential.mockClear();
    const dir = join(home, '.gemini');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'GEMINI_API_KEY=secret\n', { mode: 0o600 });
    await writeFile(join(dir, 'oauth_creds.json'), '{}', { mode: 0o600 });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('antigravity clears the credential store and leaves ~/.gemini alone', async () => {
    await provider.clearLiveSource('antigravity');
    expect(deleteCredential).toHaveBeenCalledTimes(1);
    expect(await pathExists(join(home, '.gemini', 'oauth_creds.json'))).toBe(true);
    expect(await pathExists(join(home, '.gemini', '.env'))).toBe(true);
  });

  it('gemini-cli clears ~/.gemini and leaves the credential store alone', async () => {
    await provider.clearLiveSource('gemini-cli');
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(await pathExists(join(home, '.gemini', 'oauth_creds.json'))).toBe(false);
    expect(await pathExists(join(home, '.gemini', '.env'))).toBe(false);
  });
});
