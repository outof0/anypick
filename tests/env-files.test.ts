import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeClientEnvFiles } from '../src/clients/env-files';
import { pathExists } from '../src/utils/fs';
import { clientEnvPath } from '../src/core/paths';

let root = '';

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = '';
  }
});

describe('client env file safety', () => {
  it('rejects an overlay key that could inject shell syntax', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-env-files-'));

    await expect(
      writeClientEnvFiles(root, 'claude', { 'SAFE; touch /tmp/pwned': 'value' }),
    ).rejects.toMatchObject({ code: 'CLIENT_CONFIG_INVALID' });

    expect(await pathExists(clientEnvPath(root, 'claude'))).toBe(false);
  });
});
