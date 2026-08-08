import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';

describe('registry lifecycle', () => {
  it('freezes adapter registration once application services are constructed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-registry-'));
    try {
      const app = await createAppReady({ root, skipMigrate: true });
      expect(app.clients.isSealed).toBe(true);
      expect(() =>
        app.clients.register({
          id: 'late-client',
          name: 'Late client',
          description: 'must not be registered at runtime',
          supportedApiStyles: ['openai'],
          async validate() {},
          async apply() {
            return { managedPaths: [], managedEnvKeys: [] };
          },
          async reset() {},
          async inspect() {
            return { installed: false, present: false, configPaths: [] };
          },
        }),
      ).toThrow(/after the application has started/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
