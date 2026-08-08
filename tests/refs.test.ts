import { describe, expect, it } from 'vitest';
import {
  displayRef,
  parseNativeAccountShorthand,
  parseRef,
  resolveSourceRef,
  serializeRef,
  accountRef,
  gatewayRef,
  presetRef,
} from '../src/core/refs';
import { isAnyPickError } from '../src/utils/errors';

describe('parseRef', () => {
  it('parses provider/account as account', () => {
    expect(parseRef('grok/work')).toEqual(accountRef('grok', 'work'));
    expect(parseRef('codex/personal')).toEqual(accountRef('codex', 'personal'));
  });

  it('parses fully qualified account/', () => {
    expect(parseRef('account/grok/work')).toEqual(accountRef('grok', 'work'));
  });

  it('parses plain name as gateway', () => {
    expect(parseRef('openrouter-work')).toEqual(gatewayRef('openrouter-work'));
  });

  it('parses gateway/ prefix', () => {
    expect(parseRef('gateway/openrouter-work')).toEqual(gatewayRef('openrouter-work'));
  });

  it('parses @preset and preset/', () => {
    expect(parseRef('@work-grok')).toEqual(presetRef('work-grok'));
    expect(parseRef('preset/work-grok')).toEqual(presetRef('work-grok'));
  });

  it('rejects empty and invalid forms', () => {
    expect(() => parseRef('')).toThrow();
    expect(() => parseRef('@')).toThrow();
    expect(() => parseRef('unknown-provider/foo')).toThrow();
  });

  it('serializes and displays refs', () => {
    expect(serializeRef(accountRef('grok', 'work'))).toBe('account/grok/work');
    expect(displayRef(accountRef('grok', 'work'))).toBe('grok/work');
    expect(displayRef(presetRef('x'))).toBe('@x');
    expect(displayRef(gatewayRef('g'))).toBe('g');
  });
});

describe('resolveSourceRef', () => {
  it('suggests @preset when gateway missing but preset exists', async () => {
    try {
      await resolveSourceRef('work-grok', {
        gatewayExists: () => false,
        presetExists: (n) => n === 'work-grok',
      });
      expect.unreachable();
    } catch (e) {
      expect(isAnyPickError(e)).toBe(true);
      if (isAnyPickError(e)) {
        expect(e.exitCode).toBe(3);
        expect(e.code).toBe('RESOURCE_NOT_FOUND');
        expect(e.suggestions.some((s) => s.includes('@work-grok'))).toBe(true);
      }
    }
  });

  it('does not auto-resolve plain name to preset', async () => {
    await expect(
      resolveSourceRef('work-grok', {
        gatewayExists: () => false,
        presetExists: () => true,
      }),
    ).rejects.toThrow(/was not found/);
  });

  it('returns gateway when it exists even if preset shares name', async () => {
    const ref = await resolveSourceRef('work-grok', {
      gatewayExists: () => true,
      presetExists: () => true,
    });
    expect(ref).toEqual(gatewayRef('work-grok'));
  });
});

describe('parseNativeAccountShorthand', () => {
  const opts = {
    accountProviders: new Set(['codex', 'grok', 'kiro']),
    clientIds: new Set(['claude', 'codex', 'kiro']),
  };

  it('accepts native same-provider client shorthand', () => {
    expect(parseNativeAccountShorthand('codex/personal', opts)).toEqual({
      client: 'codex',
      source: accountRef('codex', 'personal'),
    });
  });

  it('rejects cross-client account inference (grok is not a client)', () => {
    expect(parseNativeAccountShorthand('grok/work', opts)).toBeNull();
  });

  it('rejects plain gateway names', () => {
    expect(parseNativeAccountShorthand('openrouter-work', opts)).toBeNull();
  });
});
