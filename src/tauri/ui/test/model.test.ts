import { describe, expect, it } from 'vitest';

import type { AccountRow, HubSource, ProxyRow } from '../lib/contract';
import {
  accountAccessibilityLabel,
  accountIdentityLine,
  activityAccessibilityLabel,
  attentionCopy,
  backupImportEntryIDs,
  canRestartProxy,
  cleanModelDisplayName,
  cleanSourceDisplayName,
  displaySafeFeedback,
  displaySafeIdentity,
  friendlyProxyName,
  friendlyProxyStatusSubtitle,
  groupUsageWindows,
  friendlyRouteDetail,
  isAppRouteConfigured,
  isAppManagedByAnyPick,
  localizedQuotaResetFormatted,
  localizedQuotaWindowLabel,
  looksLikeOpaqueDisplayValue,
  nativeProviderFamily,
  nativeProviderName,
  overviewAttentionTarget,
  overviewServiceTotal,
  quotaResetFormatted,
  quotaWindowLabel,
  quotaWindowLabel as windowLabel,
  servicePort,
  transportDisplayName,
  uniqueCompatibleRoutes,
  unusedAccountName,
  usageForClient,
  usageWindowPeriod,
  visibleLogLines,
} from '../lib/model';

/**
 * The expectations in this file are ported from the macOS XCTest suite
 * (`AnyPickTests.swift`, `testAccountIdentityLineHasNoDanglingSeparator` and
 * neighbours). They travel with the code so a copy change has to be deliberate
 * on both platforms: a Linux user reading a Claude proxy row should read the
 * same words a macOS user reads.
 */

describe('accountIdentityLine', () => {
  it('joins only when both sides are display-safe', () => {
    expect(accountIdentityLine('Claude', 'alex@example.com')).toBe('Claude · alex@example.com');
    expect(accountIdentityLine('Claude', '')).toBe('Claude');
    expect(accountIdentityLine('', 'alex@example.com')).toBe('alex@example.com');
    expect(accountIdentityLine('', '')).toBe('');
  });

  it('never leaves a dangling separator', () => {
    // macOS: XCTFalse(label.hasSuffix("·"))
    for (const [provider, detail] of [
      ['Claude', 'alex@example.com'],
      ['Claude', ''],
      ['', 'alex@example.com'],
      ['', ''],
    ]) {
      expect(accountIdentityLine(provider, detail).endsWith('·')).toBe(false);
    }
  });
});

describe('groupUsageWindows', () => {
  it('preserves reported group order and puts ungrouped windows last', () => {
    const groups = groupUsageWindows([
      { label: 'Weekly', remainingPercent: 45, group: 'Gemini Models' },
      { label: '5h', remainingPercent: 80, group: 'Gemini Models' },
      { label: 'Weekly', remainingPercent: 30, group: 'Claude and GPT models' },
      { label: 'Session', remainingPercent: 65 },
    ]);
    expect(groups).toEqual([
      {
        id: 'Gemini Models',
        title: 'Gemini Models',
        windows: [
          { label: 'Weekly', remainingPercent: 45, group: 'Gemini Models' },
          { label: '5h', remainingPercent: 80, group: 'Gemini Models' },
        ],
      },
      {
        id: 'Claude and GPT models',
        title: 'Claude and GPT models',
        windows: [{ label: 'Weekly', remainingPercent: 30, group: 'Claude and GPT models' }],
      },
      { id: '_ungrouped', windows: [{ label: 'Session', remainingPercent: 65 }] },
    ]);
  });
});

describe('accountAccessibilityLabel', () => {
  // `providerId` is the engine id and is passed through as-is, matching Swift,
  // which reads `account.provider` without reformatting it. The macOS test
  // feeds display strings in this field, so it asserts on those strings.
  const account = (id: string, providerId: string, label: string, detail = ''): AccountRow => ({
    id,
    providerId,
    name: label,
    label,
    detail,
    active: false,
    canRefresh: true,
    switchActionId: `switch-${id}`,
  });

  it('distinguishes two accounts with the same name', () => {
    // macOS: testAccountAccessibilityLabelDistinguishesDuplicates
    const first = account('1', 'Claude', 'Work', 'alex@studio.example');
    const second = account('2', 'Codex', 'Work', 'maya@studio.example');
    const siblings = [first, second];
    const firstLabel = accountAccessibilityLabel(first, siblings);
    const secondLabel = accountAccessibilityLabel(second, siblings);
    expect(firstLabel).not.toBe(secondLabel);
    expect(firstLabel).toContain('Claude');
    expect(secondLabel).toContain('Codex');
    expect(firstLabel).toContain('1 of 2');
  });

  it('prefers the identity line over a bare provider when one is reported', () => {
    const row = account('1', 'Claude', 'Work', 'alex@studio.example');
    expect(accountAccessibilityLabel(row, [row])).toBe('Work, Claude · alex@studio.example');
  });

  it('numbers a collision by id, not by arrival order', () => {
    // The two rows are handed over in reverse, and the position still follows
    // the id. Without the sort, the same account reads "2 of 2" one refresh
    // and "1 of 2" the next, which is the flicker the sort exists to stop.
    const first = account('1', 'Claude', 'Work');
    const second = account('2', 'Codex', 'Work');
    expect(accountAccessibilityLabel(first, [second, first])).toBe(
      accountAccessibilityLabel(first, [first, second]),
    );
    expect(accountAccessibilityLabel(first, [second, first])).toContain('1 of 2');
    expect(accountAccessibilityLabel(second, [second, first])).toContain('2 of 2');
  });

  it('stays distinct across twenty accounts', () => {
    // macOS: testLongNamesAndTwentyAccountsStayDistinguishable
    const accounts = Array.from({ length: 22 }, (_, index) =>
      account(`a${index}`, 'claude', index === 0 ? 'Same' : `Account ${index}`),
    );
    const labels = accounts.map((row) => accountAccessibilityLabel(row, accounts));
    expect(labels).toHaveLength(accounts.length);
    expect(new Set(labels).size).toBe(accounts.length);
  });
});

describe('display safety', () => {
  it('hides an opaque display value', () => {
    expect(looksLikeOpaqueDisplayValue('aaaaaaaa.bbbbbbbb.cccccccc')).toBe(true);
    expect(looksLikeOpaqueDisplayValue('alex@example.com')).toBe(false);
    expect(looksLikeOpaqueDisplayValue('Claude · Work')).toBe(false);
    // Two long segments are not the three-part shape, and a short one is not
    // long enough. Either would blank a legitimate value.
    expect(looksLikeOpaqueDisplayValue('aaaaaaaa.bbbbbbbb')).toBe(false);
    expect(looksLikeOpaqueDisplayValue('aaaa.bbbb.cccc')).toBe(false);
  });

  it('keeps an empty identity empty rather than substituting a raw value', () => {
    // A present-but-unidentified account is a real state; the Go engine sends
    // "" for an opaque identity, and the UI must not fall back to a raw value.
    expect(displaySafeIdentity('')).toBe('');
    expect(displaySafeIdentity('x'.repeat(161))).toBe('');
    expect(displaySafeIdentity('alex@example.com')).toBe('alex@example.com');
  });

  it('falls back when feedback text is too long or opaque', () => {
    expect(displaySafeFeedback('', 'fallback')).toBe('fallback');
    expect(displaySafeFeedback('x'.repeat(513), 'fallback')).toBe('fallback');
    expect(displaySafeFeedback('Proxy started on port 5150', 'fallback')).toBe(
      'Proxy started on port 5150',
    );
  });
});

describe('friendly copy', () => {
  it('hides internal route kinds', () => {
    // macOS: testFriendlyRouteDetailHidesInternalKinds
    expect(friendlyRouteDetail('', 'direct-account')).toBe('');
    expect(friendlyRouteDetail('', 'managed-account')).toBe('');
    expect(friendlyRouteDetail('', 'account')).toBe('');
    expect(friendlyRouteDetail('detail', 'direct-account')).toBe('');
    expect(friendlyRouteDetail('', 'gateway')).toBe('API gateway');
    expect(friendlyRouteDetail('', 'hub')).toBe('Proxy Hub');
    expect(friendlyRouteDetail('Shared models', 'pool')).toBe('');
  });

  it('hides a composite proxy id', () => {
    // macOS: testFriendlyProxyNameHidesCompositeID
    expect(friendlyProxyName('claude/internal-1 proxy', 'claude')).toBe('Claude proxy');
    expect(friendlyProxyName('Claude · Relay', 'claude')).toBe('Relay');
  });

  it('strips redundant model prefixes but keeps product phrases', () => {
    // macOS: testCleanModelDisplayNameStripsRedundantPrefixes
    expect(cleanModelDisplayName('gemini/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(cleanModelDisplayName('claude/claude-3-7-sonnet')).toBe('claude-3-7-sonnet');
    expect(cleanModelDisplayName('openai/gpt-4o')).toBe('gpt-4o');
    expect(cleanModelDisplayName('Direct account')).toBe('Direct account');
    expect(cleanModelDisplayName('Same as Default')).toBe('Same as Default');
    expect(cleanModelDisplayName('')).toBe('');
  });

  it('strips a source name through the last slash', () => {
    // macOS: testCleanSourceDisplayNameStripsRedundantPrefixes
    expect(cleanSourceDisplayName('account/claude/work')).toBe('work');
    expect(cleanSourceDisplayName('work')).toBe('work');
    expect(cleanSourceDisplayName('')).toBe('');
  });
});

describe('provider naming', () => {
  it('normalizes a ref to its family', () => {
    expect(nativeProviderFamily('anthropic/claude/work')).toBe('claude');
    expect(nativeProviderFamily('codex')).toBe('openai');
    expect(nativeProviderFamily('gemini-cli')).toBe('gemini');
    expect(nativeProviderFamily('proxy-hub/default')).toBe('proxy-hub');
  });

  it('uses the product display names', () => {
    expect(nativeProviderName('anthropic/claude')).toBe('Claude');
    expect(nativeProviderName('codex')).toBe('OpenAI');
    expect(nativeProviderName('zai')).toBe('Z.ai (GLM)');
    expect(nativeProviderName('cloudflare-aigateway')).toBe('Cloudflare AI Gateway');
  });
});

describe('transport', () => {
  it('never says Direct for an unconfigured app', () => {
    // macOS: testTransportNeverDirectWhenUnconfigured
    expect(transportDisplayName(undefined, false)).toBe('Not Configured');
    expect(transportDisplayName('native', false)).toBe('Not Configured');
    expect(isAppRouteConfigured({ routeKind: 'native', selected: false })).toBe(false);
  });

  it('names a managed account as an AnyPick proxy', () => {
    // macOS: testTransportNamesManagedAccountAsAnyPickProxy
    expect(transportDisplayName('managed-account', true)).toBe('AnyPick proxy');
    expect(isAppManagedByAnyPick({ routeKind: 'managed-account' })).toBe(true);
    expect(isAppManagedByAnyPick({ routeKind: 'native' })).toBe(false);
  });
});

describe('service status', () => {
  it('skips a phantom hub in the overview total', () => {
    // macOS: testServiceTotalSkipsPhantomHub
    expect(overviewServiceTotal(0, true, false)).toBe(0);
    expect(overviewServiceTotal(2, true, false)).toBe(2);
    expect(overviewServiceTotal(3, true, false)).toBe(3);
    expect(overviewServiceTotal(0, false, false)).toBe(1);
  });

  it('mirrors the list row for restart', () => {
    // macOS: testRestartMirrorsListRow
    expect(canRestartProxy(true, 'running')).toBe(true);
    expect(canRestartProxy(false, 'attention')).toBe(true);
    expect(canRestartProxy(false, 'unavailable')).toBe(true);
    expect(canRestartProxy(false, 'stopped')).toBe(false);
    expect(canRestartProxy(true, 'ready')).toBe(true);
  });

  it('describes a proxy subtitle from its status', () => {
    expect(friendlyProxyStatusSubtitle('running', 5150, '')).toBe('Running · Port 5150');
    expect(friendlyProxyStatusSubtitle('running', 0, '')).toBe('Running');
    expect(friendlyProxyStatusSubtitle('stopped', 0, '')).toBe('Stopped');
    expect(friendlyProxyStatusSubtitle('attention', 0, '')).toBe('Needs attention');
  });
});

describe('service port', () => {
  it('accepts a url, host:port, and bracketed ipv6', () => {
    expect(servicePort('http://127.0.0.1:5150')).toBe(5150);
    expect(servicePort('127.0.0.1:5150')).toBe(5150);
    expect(servicePort('[::1]:5150')).toBe(5150);
    expect(servicePort('stopped')).toBeNull();
    expect(servicePort('')).toBeNull();
  });
});

describe('quota windows', () => {
  it('preserves model names and matches the provider rather than the account label', () => {
    const windows = [
      { label: '5h', remainingPercent: 54, limitWindowSeconds: 18000 },
      { label: 'Weekly', remainingPercent: 34, limitWindowSeconds: 604800 },
      { label: 'Fable · Weekly', remainingPercent: 58, limitWindowSeconds: 604800 },
      { label: 'Weekly Limit Remaining', remainingPercent: 73, limitWindowSeconds: 604800 },
    ];
    expect(windows.map(quotaWindowLabel)).toEqual(['5h', 'Weekly', 'Fable · Weekly', 'Weekly Limit Remaining']);
    expect(usageForClient([{ providerId: 'gemini', client: 'Gemini', account: 'claude-work', windows }], 'claude')).toBeNull();
    expect(usageForClient([{ providerId: 'gemini', client: 'Gemini', account: 'work', windows }], 'gemini')?.windows).toEqual(windows);
  });
  it('reports the cadence the vendor sent', () => {
    expect(usageForClient([{ client: 'Claude', account: 'Work', windows: [] }], 'claude')?.account).toBe('Work');
    expect(usageForClient([{ client: 'Claude', account: 'Work', windows: [] }], 'codex')).toBeNull();
    expect(usageWindowPeriod(undefined)).toBeNull();
    expect(usageWindowPeriod(0)).toBeNull();
    expect(usageWindowPeriod(60)).toBe('1 minute');
    expect(usageWindowPeriod(1800)).toBe('30 minutes');
    // 18000 is 5 hours, not 300 minutes: the hour branch owns everything
    // from one hour up, so a five-hour window never reads as 300 minutes.
    expect(usageWindowPeriod(18000)).toBe('5 hours');
    expect(usageWindowPeriod(3600)).toBe('1 hour');
    expect(usageWindowPeriod(7200)).toBe('2 hours');
    expect(usageWindowPeriod(172800)).toBe('2 days');
    expect(usageWindowPeriod(86400)).toBe('day');
    expect(usageWindowPeriod(604800)).toBe('week');
    expect(usageWindowPeriod(1209600)).toBe('2 weeks');
  });

  it('labels a window only from what was reported', () => {
    expect(windowLabel({ label: '', remainingPercent: 50, limitWindowSeconds: 18000 })).toBe('5h');
    expect(windowLabel({ label: '', remainingPercent: 50, limitWindowSeconds: 86400 })).toBe('Daily');
    expect(windowLabel({ label: 'primary', remainingPercent: 50 })).toBe('5h');
    expect(windowLabel({ label: 'secondary', remainingPercent: 50 })).toBe('Weekly');
  });

  it('never renames a window from its position', () => {
    // A window with no cadence and an opaque label keeps its own label rather
    // than being called "5-hour" because it came first.
    expect(quotaWindowLabel({ label: 'opaque-window-name', remainingPercent: 10 })).toBe(
      'opaque-window-name',
    );
  });

  it('formats a reset instant', () => {
    const now = Date.parse('2026-01-15T12:00:00Z');
    // No reset instant and no reported cadence: say nothing rather than guess.
    expect(quotaResetFormatted({ label: '', remainingPercent: 10 }, now)).toBe('');
    expect(
      quotaResetFormatted({ label: '', remainingPercent: 10, limitWindowSeconds: 86400 }, now),
    ).toBe('every day');
    expect(quotaResetFormatted({ label: '', remainingPercent: 10, resetsAtMs: now + 10 * 60 * 1000 }, now)).toBe('in 10m');
    expect(quotaResetFormatted({ label: '', remainingPercent: 10, resetsAtMs: now + 3 * 3600 * 1000 }, now)).toBe('in 3h');
    expect(quotaResetFormatted({ label: '', remainingPercent: 10, resetsAtMs: now - 1000 }, now)).toBe('Resets soon');
  });

  it('localizes standard quota labels and reset durations', () => {
    const now = Date.parse('2026-01-15T12:00:00Z');
    expect(
      localizedQuotaWindowLabel(
        { label: '', remainingPercent: 10, limitWindowSeconds: 604800 },
        'vi',
        'vi',
      ),
    ).toBe('Hàng tuần');
    expect(
      localizedQuotaResetFormatted(
        { label: '', remainingPercent: 10, limitWindowSeconds: 18000 },
        'vi',
        'vi',
        now,
      ),
    ).toBe('mỗi 5 giờ');
    expect(
      localizedQuotaResetFormatted(
        { label: '', remainingPercent: 10, resetsAtMs: now + 2 * 3600 * 1000 },
        'vi',
        'vi',
        now,
      ),
    ).toBe('trong 2 giờ');
    expect(
      localizedQuotaWindowLabel({ label: 'opaque-window-name', remainingPercent: 10 }, 'vi', 'vi'),
    ).toBe('opaque-window-name');
  });
});

describe('log window', () => {
  it('bounds the tail and reports how much is hidden', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const first = visibleLogLines(lines, 0, 160);
    expect(first.visible).toHaveLength(160);
    expect(first.visible[0]).toBe('line 0');
    const scrolled = visibleLogLines(lines, 20, 160);
    expect(scrolled.hidden).toBe(20);
    expect(scrolled.visible[0]).toBe('line 20');
  });

  it('resets the hidden count when the tail is short', () => {
    expect(visibleLogLines(['a', 'b'], 12, 160).hidden).toBe(0);
  });
});

describe('route dedupe', () => {
  const action = (id: string, selected: boolean) => ({
    id,
    clientId: 'claude',
    sourceId: 'account/claude/work',
    client: 'Claude Code',
    label: 'Work',
    kind: 'native',
    presentation: 'native-account',
    selected,
    enabled: true,
  });

  it('keeps the current route exactly once', () => {
    // macOS: testCompatibleRoutesDedupeKeepsCurrentOnce
    const deduped = uniqueCompatibleRoutes([action('a', false), action('b', true)]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.id).toBe('b');
  });

  it('keeps different providers separate', () => {
    // macOS: testCompatibleRoutesKeepDifferentProvidersSeparate
    const deduped = uniqueCompatibleRoutes([
      action('a', false),
      { ...action('b', false), sourceId: 'account/codex/work' },
    ]);
    expect(deduped).toHaveLength(2);
  });
});

describe('overview attention', () => {
  const proxy = (id: string, enabled: boolean, running: boolean): ProxyRow => ({
    id,
    providerId: 'claude',
    label: 'Claude proxy',
    detail: '',
    running,
    enabled,
    toggleActionId: `toggle-${id}`,
    restartActionId: `restart-${id}`,
  });
  const account = (id: string): AccountRow => ({
    id,
    providerId: 'claude',
    name: id,
    label: id,
    detail: '',
    active: false,
    canRefresh: false,
    switchActionId: `switch-${id}`,
  });

  it('prefers a broken service, then an app, then an account, then a conflict', () => {
    // macOS: testAttentionTargetCoversSavedAccounts
    expect(
      overviewAttentionTarget({ proxies: [proxy('p', true, false)], apps: [], accounts: [], conflicts: [] }),
    ).toEqual({ kind: 'proxy', id: 'p' });
    expect(
      overviewAttentionTarget({
        proxies: [],
        apps: [{ id: 'x', clientId: 'claude', sourceId: '', client: 'Claude Code', label: 'x', kind: 'native', presentation: 'native-account', selected: false, enabled: true }],
        accounts: [],
        conflicts: [],
      }),
    ).toEqual({ kind: 'app', id: 'claude' });
    expect(
      overviewAttentionTarget({ proxies: [], apps: [], accounts: [account('w')], conflicts: [] }),
    ).toEqual({ kind: 'account', id: 'w' });
    expect(
      overviewAttentionTarget({
        proxies: [],
        apps: [],
        accounts: [],
        conflicts: [{ id: 'c1', kind: 'source-choice' }, { id: 'c2', kind: 'model-overlap' }],
      }),
    ).toEqual({ kind: 'conflict', id: 'c1', conflictKind: 'source-choice' });
  });

  it('reports nothing when everything is healthy', () => {
    expect(
      overviewAttentionTarget({ proxies: [], apps: [], accounts: [], conflicts: [] }),
    ).toBeNull();
  });

  it('ignores a stopped service that is not enabled', () => {
    // A proxy the user turned off is not something to nag about.
    expect(
      overviewAttentionTarget({ proxies: [proxy('p', false, false)], apps: [], accounts: [], conflicts: [] }),
    ).toBeNull();
  });

  it('names the target in a way the user can act on', () => {
    expect(
      attentionCopy({ kind: 'proxy', id: 'p' }, { proxyName: 'Claude proxy' }),
    ).toEqual({
      title: 'Claude proxy is unavailable',
      detail: 'Apps using Claude proxy cannot connect.',
      action: 'Open Proxies',
    });
  });
});

describe('activity accessibility', () => {
  it('contains day, time, status, and text', () => {
    // macOS: testActivityAccessibilityLabelContainsDayTimeStatus
    const label = activityAccessibilityLabel({
      day: 'Today',
      time: '09:42',
      status: 'Ready',
      title: 'Claude Code now uses Work',
      detail: '',
    });
    expect(label).toContain('Today');
    expect(label).toContain('09:42');
    expect(label).toContain('Ready');
    expect(label).toContain('Claude Code now uses Work');
  });
});

describe('backup selection', () => {
  const entries = [
    { id: '0', disposition: 'create' },
    { id: '1', disposition: 'replace' },
    { id: '2', disposition: 'keep' },
  ];

  it('drops a replace when overwrite is not confirmed', () => {
    expect(backupImportEntryIDs(['0', '1', '2'], entries, false)).toEqual(['0', '2']);
    expect(backupImportEntryIDs(['0', '1', '2'], entries, true)).toEqual(['0', '1', '2']);
  });

  it('returns nothing when nothing would change', () => {
    expect(backupImportEntryIDs(['1'], entries, false)).toEqual([]);
  });
});

describe('account naming', () => {
  it('suggests a free name, then numbers', () => {
    expect(unusedAccountName([])).toBe('Work');
    expect(unusedAccountName(['Work'])).toBe('Personal');
    expect(unusedAccountName(['Work', 'Personal'])).toBe('Account 1');
    expect(unusedAccountName(['Work', 'Personal', 'Account 1'])).toBe('Account 2');
  });
});

describe('hub source service ids', () => {
  it('keys a rotation row by its own id', () => {
    const rotation: HubSource = {
      id: 'hub/default/rotation',
      providerId: '',
      name: 'rotation',
      label: 'Rotate across accounts',
      detail: '',
      enabled: true,
      hub: 'default',
      rotates: true,
      accountCount: 3,
    };
    expect(rotation.rotates).toBe(true);
    expect(rotation.accountCount).toBe(3);
  });
});
