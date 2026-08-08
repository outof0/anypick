import { describe, expect, it } from 'vitest';
import { configuredModelCatalog, mergeModelCatalogs } from '../src/core/model-policy';

describe('configuredModelCatalog', () => {
  it('uses only the explicit alias map and preserves its order', () => {
    expect(
      configuredModelCatalog({
        fast: 'provider/fast',
        thorough: 'provider/thorough',
      }),
    ).toEqual([
      { id: 'provider/fast', displayName: 'fast (provider/fast)' },
      { id: 'provider/thorough', displayName: 'thorough (provider/thorough)' },
    ]);
  });

  it('deduplicates ids without replacing the first configured label', () => {
    expect(
      configuredModelCatalog({
        preferred: 'provider/model',
        duplicate: 'provider/model',
      }),
    ).toEqual([{ id: 'provider/model', displayName: 'preferred (provider/model)' }]);
  });
});

describe('mergeModelCatalogs', () => {
  it('keeps configured labels while enriching them with live metadata', () => {
    expect(
      mergeModelCatalogs(
        [{ id: 'provider/model', displayName: 'preferred (provider/model)' }],
        [
          {
            id: 'provider/model',
            displayName: 'Provider Model',
            contextWindow: 200_000,
            supportsParallelToolCalls: true,
          },
        ],
      ),
    ).toEqual([
      {
        id: 'provider/model',
        displayName: 'preferred (provider/model)',
        contextWindow: 200_000,
        supportsParallelToolCalls: true,
      },
    ]);
  });
});
