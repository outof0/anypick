import { describe, expect, it } from 'vitest';

import {
  deriveLiveRelation,
  formatRelativeTime,
  formatResetIn,
  formatUsageSummary,
  formatUsageWindow,
  identitiesMatch,
  layoutFromColumns,
  normalizeIdentity,
  proxyStateLabel,
  proxyStateText,
  suggestAccountSlug,
} from '../src/tui/model';

describe('tui model — identity & relation', () => {
  it('normalizes identity case-insensitively and trims', () => {
    expect(normalizeIdentity('  Erik@Acme.COM ')).toBe('erik@acme.com');
    expect(normalizeIdentity('')).toBeNull();
    expect(normalizeIdentity(undefined)).toBeNull();
  });

  it('identitiesMatch returns null when either side missing', () => {
    expect(identitiesMatch('a@x.com', undefined)).toBeNull();
    expect(identitiesMatch(undefined, 'a@x.com')).toBeNull();
    expect(identitiesMatch('A@x.com', 'a@x.com')).toBe(true);
    expect(identitiesMatch('a@x.com', 'b@x.com')).toBe(false);
  });

  it('derives all saved/live account relations', () => {
    expect(
      deriveLiveRelation({
        savedCount: 2,
        livePresent: true,
        liveIdentity: 'erik@acme.com',
        activeName: 'work',
        activeIdentity: 'Erik@Acme.com',
        savedIdentities: ['erik@acme.com', 'other@x.com'],
      }),
    ).toBe('match');
    expect(
      deriveLiveRelation({
        savedCount: 1,
        livePresent: true,
        liveIdentity: 'new@email.com',
        activeName: 'work',
        activeIdentity: 'old@email.com',
        savedIdentities: ['old@email.com'],
      }),
    ).toBe('unsaved-live');
    expect(
      deriveLiveRelation({
        savedCount: 2,
        livePresent: true,
        liveIdentity: 'personal@x.com',
        activeName: 'work',
        activeIdentity: 'work@x.com',
        savedIdentities: ['work@x.com', 'personal@x.com'],
      }),
    ).toBe('drift');
    expect(
      deriveLiveRelation({
        savedCount: 2,
        livePresent: false,
        activeName: 'work',
        activeIdentity: 'a@x.com',
        savedIdentities: ['a@x.com', 'b@x.com'],
      }),
    ).toBe('no-live');
    expect(
      deriveLiveRelation({
        savedCount: 0,
        livePresent: false,
        activeName: null,
      }),
    ).toBe('empty');
    expect(
      deriveLiveRelation({
        savedCount: 1,
        livePresent: true,
        liveIdentity: undefined,
        activeName: 'work',
        activeIdentity: undefined,
        savedIdentities: [undefined],
      }),
    ).toBe('unknown');
  });
});

describe('tui model — helpers', () => {
  it('suggestAccountSlug uses the email local-part', () => {
    expect(suggestAccountSlug('erik@acme.com')).toBe('erik');
    expect(suggestAccountSlug(undefined)).toBe('main');
  });

  it('formats relative time compactly', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    expect(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3h ago');
  });

  it('calculates proxy state labels and responsive layout', () => {
    expect(proxyStateLabel({ enabled: true, running: true })).toBe('running');
    expect(proxyStateLabel({ enabled: true, running: false })).toBe('enabled-stopped');
    expect(proxyStateLabel({ enabled: false, running: false })).toBe('disabled');
    expect(proxyStateLabel({ enabled: true, running: false, detail: 'unavailable' })).toBe(
      'unavailable',
    );
    expect(proxyStateText({ enabled: true, running: false }, { active: false })).toBe('enabled');
    expect(proxyStateText({ enabled: true, running: false }, { active: true })).toBe('stopped');
    expect(layoutFromColumns(40)).toBe('narrow');
    expect(layoutFromColumns(60)).toBe('medium');
    expect(layoutFromColumns(100)).toBe('wide');
  });

  it('formats usage windows and summary', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const window = { label: '5h', remainingPercent: 62, resetsAtMs: now + 2 * 3600_000 };
    expect(formatResetIn(window.resetsAtMs, now)).toBe('resets in 2h');
    expect(formatUsageWindow(window, now)).toContain('5h');
    expect(formatUsageWindow(window, now)).toContain('62%');
    expect(formatUsageWindow(window, now)).toContain('resets in 2h');
    // Summary picks the tightest (least remaining) window.
    expect(
      formatUsageSummary(
        [
          { label: 'weekly', remainingPercent: 80 },
          { label: '5h', remainingPercent: 20, resetsAtMs: now + 3600_000 },
        ],
        now,
      ),
    ).toBe('5h 20% left · resets in 1h');
    expect(formatUsageSummary([], now)).toBe('');
    expect(formatUsageSummary(undefined, now)).toBe('');
  });
});
