import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuotaGuard, readQuotaGuardState } from '../src/providers/quota-guard';

describe('Quota Guard', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('only changes ordering when explicitly enabled and persists no credential material', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-quota-guard-'));
    const statePath = join(root, 'pool-runtime', 'quota-guard.json');
    const guard = new QuotaGuard({
      enabled: true,
      cooldownMs: 60_000,
      statePath,
      providerId: 'gemini',
    });
    const accounts = [{ accountName: 'one' }, { accountName: 'two' }];
    await guard.exhausted('one', 'two');
    expect((await guard.ordered(accounts)).map((entry) => entry.accountName)).toEqual(['two']);
    const state = await readQuotaGuardState(statePath);
    expect(state.events[0]).toMatchObject({ providerId: 'gemini', from: 'one', to: 'two' });
    expect(JSON.stringify(state)).not.toContain('apiKey');
    expect(JSON.stringify(state)).not.toContain('token');
  });

  it('is inert by default', async () => {
    const guard = new QuotaGuard({ enabled: false, cooldownMs: 60_000 });
    const accounts = [{ accountName: 'one' }, { accountName: 'two' }];
    await guard.exhausted('one', 'two');
    expect(await guard.ordered(accounts)).toEqual(accounts);
  });
});
