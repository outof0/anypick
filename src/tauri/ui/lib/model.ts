/**
 * Display and derivation rules, ported from `src/macos/DesignDisplay.swift` and
 * `AppIcon.swift`.
 *
 * Every function here has a counterpart in the Swift tree and a test that came
 * from the macOS XCTest suite first. The port is not a stylistic choice: the
 * macOS app's copy is the product's copy, so a Linux or Windows user reading a
 * Claude proxy row should read the same words a macOS user reads.
 *
 * These are pure functions over the snapshot. Views must not re-derive this
 * inline, because a rule that lives in two places is a rule that will diverge.
 */

import type {
  AccountRow,
  ActionRow,
  HubSource,
  ProxyRow,
  RouteRow,
  UsageSnapshotRow,
  UsageWindow,
} from './contract';
import { translate, translatePlural } from './i18n';

export type DesignStatus = 'ready' | 'running' | 'attention' | 'unavailable' | 'stopped';

/** `DesignStatus.rawValue`. The label a user reads, verbatim from macOS. */
export const STATUS_LABEL: Record<DesignStatus, string> = {
  ready: 'Ready',
  running: 'Running',
  attention: 'Isn’t working',
  unavailable: 'Not available',
  stopped: 'Stopped',
};

/** `DesignStatus.symbol`. The web UI maps these to its own icon set. */
export const STATUS_SYMBOL: Record<DesignStatus, string> = {
  ready: 'checkmark.circle.fill',
  running: 'checkmark.circle.fill',
  attention: 'exclamationmark.triangle.fill',
  unavailable: 'xmark.circle.fill',
  stopped: 'stop.circle',
};

export const ACTIVITY_CATEGORIES = [
  { id: 'all', label: 'All Events', symbol: 'clock.arrow.circlepath' },
  { id: 'routing', label: 'Routing', symbol: 'arrow.triangle.2.circlepath' },
  { id: 'accounts', label: 'Accounts & APIs', symbol: 'person.crop.circle' },
  { id: 'proxies', label: 'Proxy Hub', symbol: 'network' },
  { id: 'issues', label: 'Issues', symbol: 'exclamationmark.triangle' },
] as const;

export type ActivityCategoryId = (typeof ACTIVITY_CATEGORIES)[number]['id'];

/** `accountIdentityLine`. Joins only when both sides survive the safety check. */
export function accountIdentityLine(provider: string, detail: string): string {
  const left = displaySafeIdentity(provider);
  const right = displaySafeIdentity(detail);
  if (left && right) return `${left} · ${right}`;
  return left || right || '';
}

const OPAQUE_SCALAR = /^[A-Za-z0-9\-_.+=/]+$/u;

/** `looksLikeOpaqueDisplayValue`. Three long dotted parts, or a long token. */
export function looksLikeOpaqueDisplayValue(value: string): boolean {
  const parts = value.split('.');
  if (parts.length === 3 && parts.every((part) => part.length >= 8)) return true;
  // Swift's `split(separator:)` drops empty subsequences, so `a..b` is two
  // parts there and must not be three here.
  const scalars = [...value];
  if (scalars.length < 48) return false;
  if (value.includes('@') || value.includes(':') || /\s/u.test(value)) return false;
  return OPAQUE_SCALAR.test(value);
}

/** `displaySafeIdentity`. Empty means "present but not identified" — keep it. */
export function displaySafeIdentity(value: string): string {
  if (!value) return '';
  if ([...value].length > 160) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\p{Cc}]/u.test(value)) return '';
  if (looksLikeOpaqueDisplayValue(value)) return '';
  return value;
}

/** `displaySafeFeedback`. Engine text shown to a user, bounded and vetted. */
export function displaySafeFeedback(value: string, fallback: string): string {
  if (!value) return fallback;
  if ([...value].length > 512) return fallback;
  for (const chunk of value.split(/\s+/u)) {
    if (chunk && looksLikeOpaqueDisplayValue(chunk)) return fallback;
  }
  return value;
}

const FRIENDLY_ROUTE_KIND: Record<string, string> = {
  'direct-account': 'Direct account',
  'managed-account': 'AnyPick proxy',
  account: 'Saved account',
  pool: 'Shared models',
  hub: 'Proxy Hub',
  gateway: 'API gateway',
  native: 'Available route',
};

/**
 * `friendlyRouteDetail`. Internal route kinds are not user vocabulary, and a
 * raw ref leaks a provider id into the UI.
 */
export function friendlyRouteDetail(detail: string, routeKind: string): string {
  if (!routeKind) return detail;
  if (['direct-account', 'managed-account', 'account', 'pool'].includes(routeKind)) return '';
  return FRIENDLY_ROUTE_KIND[routeKind] ?? detail;
}

export function friendlyRouteKindLabel(routeKind: string): string {
  return FRIENDLY_ROUTE_KIND[routeKind] ?? '';
}

/** `friendlyProxyName`. Strips the composite `provider/internal-id` id form. */
export function friendlyProxyName(label: string, providerId: string): string {
  const suffix = label.split(/ · | • /u)[1];
  if (suffix) return suffix;
  if (label.includes('/')) return `${nativeProviderName(providerId)} proxy`;
  return label;
}

export function friendlyProxyStatusSubtitle(
  status: DesignStatus,
  port: number,
  detail: string,
): string {
  if (status === 'running') return port > 0 ? `Running · Port ${port}` : 'Running';
  if (status === 'stopped') return 'Stopped';
  if (status === 'attention') return 'Needs attention';
  if (status === 'unavailable') return 'Unavailable';
  if (status === 'ready') return 'Ready';
  return detail;
}

/** `servicePort`. Accepts a URL, `host:port`, and bracketed IPv6. */
export function servicePort(detail: string): number | null {
  if (!detail) return null;
  const url = detail.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu);
  const authority = url ? url[0].replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '') : detail.split('/')[0] ?? '';
  const bracketed = authority.match(/^\[[^\]]*\]:(\d+)$/u);
  if (bracketed) return Number(bracketed[1]);
  const tail = authority.match(/:(\d+)$/u);
  if (tail) return Number(tail[1]);
  return null;
}

const PRESERVED_MODEL_NAMES = new Set(['Direct account', 'Same as Default']);

/** `cleanModelDisplayName`. Keeps the two product phrases, else drops the prefix. */
export function cleanModelDisplayName(value: string): string {
  if (!value) return '';
  if (PRESERVED_MODEL_NAMES.has(value)) return value;
  const slash = value.indexOf('/');
  return slash < 0 ? value : value.slice(slash + 1);
}

/** `cleanSourceDisplayName`. Strips through the LAST slash, not the first. */
export function cleanSourceDisplayName(value: string): string {
  if (!value) return '';
  const slash = value.lastIndexOf('/');
  return slash < 0 ? value : value.slice(slash + 1);
}

/** `usageWindowPeriod`. The cadence the vendor reported, never inferred. */
export function usageWindowPeriod(limitWindowSeconds?: number): string | null {
  if (limitWindowSeconds === undefined || limitWindowSeconds <= 0) return null;
  if (limitWindowSeconds < 3600) {
    const minutes = Math.max(1, Math.round(limitWindowSeconds / 60));
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  const hours = Math.floor(limitWindowSeconds / 3600);
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.floor(limitWindowSeconds / 86400);
  if (days === 1) return 'day';
  if (days === 7) return 'week';
  if (days % 7 === 0) return `${days / 7} weeks`;
  return `${days} days`;
}

const EXACT_WINDOW_LABELS: Record<number, string> = {
  18000: '5h',
  3600: '1h',
  86400: 'Daily',
  604800: 'Weekly',
};

/** `quotaWindowLabel`. Never renames a window from its position alone. */
export function quotaWindowLabel(window: UsageWindow): string {
  const vendorLabel = (window.label ?? "").trim();
  if (!["", "primary", "secondary", "5h", "weekly", "daily", "monthly", "session", "quota"].includes(vendorLabel.toLowerCase())) return vendorLabel;
  const seconds = window.limitWindowSeconds;
  if (seconds !== undefined && seconds > 0) {
    const exact = EXACT_WINDOW_LABELS[seconds];
    if (exact) return exact;
    if (seconds >= 2419200 && seconds <= 2678400) return 'Monthly';
    const hours = Math.floor(seconds / 3600);
    if (hours > 0 && hours < 24) return `${hours}h`;
    const days = Math.floor(seconds / 86400);
    if (days > 0 && days < 7) return `${days}d`;
  }
  const label = (window.label ?? '').trim();
  if (label.toLowerCase() === 'primary') return '5h';
  if (label.toLowerCase() === 'secondary') return 'Weekly';
  // An unreported cadence keeps the vendor's own label. Calling a window
  // "5-hour" because it happened to be first is a claim the payload never made.
  return label || 'Quota';
}

/** Localize the standard quota labels while preserving provider-specific text. */
export function localizedQuotaWindowLabel(
  window: UsageWindow,
  language: string,
  resolvedLanguage: string,
): string {
  const label = quotaWindowLabel(window);
  if (label.toLowerCase().includes('limit remaining')) return label;
  const keys: Record<string, string> = {
    daily: 'desktop.quota.label_daily',
    monthly: 'desktop.quota.label_monthly',
    quota: 'desktop.quota.quota',
    session: 'desktop.quota.label_session',
    weekly: 'desktop.quota.label_weekly',
  };
  const key = keys[label.toLowerCase()];
  return key ? translate(key, language, resolvedLanguage) : label;
}

/** Localize the compact quota reset string shown beside an account or app. */
export function localizedQuotaResetFormatted(
  window: UsageWindow,
  language: string,
  resolvedLanguage: string,
  now: number = Date.now(),
): string {
  const locale = language === 'auto' ? resolvedLanguage : language;
  const resetsAt = window.resetsAtMs;
  if (resetsAt === undefined) {
    const period = localizedUsageWindowPeriod(window.limitWindowSeconds, language, resolvedLanguage);
    return period
      ? translate('desktop.quota.every_period', language, resolvedLanguage).replace('{period}', period)
      : '';
  }
  const delta = resetsAt - now;
  if (delta <= 0) return translate('desktop.quota.reset_soon', language, resolvedLanguage);
  if (delta < 60 * 60 * 1000) {
    const count = Math.max(1, Math.round(delta / 60000));
    return translatePlural('desktop.quota.in_minutes_short', count, language, resolvedLanguage);
  }
  if (delta < 24 * 60 * 60 * 1000) {
    const count = Math.round(delta / 3600000);
    return translatePlural('desktop.quota.in_hours_short', count, language, resolvedLanguage);
  }
  const when = new Date(resetsAt);
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return when.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function localizedUsageWindowPeriod(
  limitWindowSeconds: number | undefined,
  language: string,
  resolvedLanguage: string,
): string | null {
  if (limitWindowSeconds === undefined || limitWindowSeconds <= 0) return null;
  if (limitWindowSeconds < 3600) {
    const count = Math.max(1, Math.round(limitWindowSeconds / 60));
    return translatePlural('desktop.quota.minutes', count, language, resolvedLanguage);
  }
  const hours = Math.floor(limitWindowSeconds / 3600);
  if (hours < 24) return translatePlural('desktop.quota.hours', hours, language, resolvedLanguage);
  const days = Math.floor(limitWindowSeconds / 86400);
  if (days === 1) return translate('desktop.quota.day', language, resolvedLanguage);
  if (days === 7) return translate('desktop.quota.week', language, resolvedLanguage);
  if (days % 7 === 0) {
    return translatePlural('desktop.quota.weeks', days / 7, language, resolvedLanguage);
  }
  return translatePlural('desktop.quota.days', days, language, resolvedLanguage);
}

export type UsageWindowGroup = {
  id: string;
  title?: string;
  windows: UsageWindow[];
};

/** Preserve vendor group order and keep ungrouped quota rows together at the end. */
export function groupUsageWindows(windows: readonly UsageWindow[]): UsageWindowGroup[] {
  const titles: string[] = [];
  const grouped = new Map<string, UsageWindow[]>();
  const ungrouped: UsageWindow[] = [];
  for (const window of windows) {
    const title = (window.group ?? '').trim();
    if (!title) {
      ungrouped.push(window);
      continue;
    }
    if (!grouped.has(title)) {
      titles.push(title);
      grouped.set(title, []);
    }
    grouped.get(title)?.push(window);
  }
  const result: UsageWindowGroup[] = titles.map((title) => ({ id: title, title, windows: grouped.get(title) ?? [] }));
  if (ungrouped.length > 0) result.push({ id: '_ungrouped', windows: ungrouped });
  return result;
}

/**
 * `Store.usage(for:)`. Match a usage card to an app by its id, its display
 * name, or the account the card names.
 */
export function usageForClient(usage: readonly UsageSnapshotRow[], clientId: string): UsageSnapshotRow | null {
  const needle = clientId.trim().toLowerCase();
  if (!needle) return null;
  const display = anypickDisplayName(clientId).trim().toLowerCase();
  for (const card of usage) {
    if (card.providerId) {
      if (nativeProviderFamily(card.providerId) === nativeProviderFamily(needle)) return card;
      continue;
    }
    const client = card.client.trim().toLowerCase();
    if (client === needle || client === display) return card;
  }
  return null;
}

/** Quota belongs to the selected source, rather than the client carrying it. */
export function usageForApp(usage: readonly UsageSnapshotRow[], clientId: string, actions: readonly ActionRow[]): UsageSnapshotRow | null {
  const selected = actions.find((action) => action.clientId === clientId && action.selected);
  if (selected?.routeKind === 'gateway' || selected?.routeKind === 'hub') return null;
  const source = selected?.sourceId.split('/');
  if (source?.[0] === 'account' && source.length >= 3) {
    const card = usageForClient(usage, source[1]);
    return card?.account === source.slice(2).join('/') ? card : null;
  }
  return usageForClient(usage, clientId);
}

export function usageForAccount(usage: readonly UsageSnapshotRow[], account: AccountRow): UsageSnapshotRow | null {
  if (!account.active) return null;
  const card = usageForClient(usage, account.providerId);
  return card?.account === account.name ? card : null;
}

/** `quotaResetFormatted`. "Resets soon", a relative span, or a date. */
export function quotaResetFormatted(window: UsageWindow, now: number = Date.now()): string {
  const resetsAt = window.resetsAtMs;
  if (resetsAt === undefined) {
    const period = usageWindowPeriod(window.limitWindowSeconds);
    return period ? `every ${period}` : '';
  }
  const delta = resetsAt - now;
  if (delta <= 0) return 'Resets soon';
  if (delta < 60 * 60 * 1000) return `in ${Math.max(1, Math.round(delta / 60000))}m`;
  if (delta < 24 * 60 * 60 * 1000) return `in ${Math.round(delta / 3600000)}h`;
  const when = new Date(resetsAt);
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** `visibleLogLines`. Keeps the tail bounded and the hidden count honest. */
export function visibleLogLines(
  lines: string[],
  hiddenCount: number,
  limit = 160,
): { visible: string[]; hidden: number } {
  if (lines.length <= limit) return { visible: lines, hidden: 0 };
  const hidden = Math.min(hiddenCount, lines.length - limit);
  return { visible: lines.slice(hidden, hidden + limit), hidden };
}

/** `overviewServiceTotal`. A hub with no sources and no enablement is a phantom. */
export function overviewServiceTotal(
  proxyCount: number,
  hubSourcesEmpty: boolean,
  hubEnabled: boolean,
): number {
  return proxyCount + (hubSourcesEmpty && !hubEnabled ? 0 : 1);
}

/**
 * The `proxy-token` name is the account (or hub) after `providerId/`.
 * A slash inside the account name stays. An id that is not that provider's
 * row is refused rather than sent as a guess.
 */
export function proxyTokenSubject(
  id: string,
  providerId: string,
): { providerId: string; name: string } | null {
  const prefix = `${providerId}/`;
  if (!providerId || !id.startsWith(prefix)) return null;
  const name = id.slice(prefix.length);
  return name ? { providerId, name } : null;
}

/** `canRestartProxy`. Mirrors what the list row offers. */
export function canRestartProxy(isRunning: boolean, status: DesignStatus): boolean {
  return isRunning || status === 'attention' || status === 'unavailable';
}

const TRANSPORT_LABEL: Record<string, string> = {
  hub: 'Proxy Hub',
  gateway: 'Gateway',
  account: 'AnyPick proxy',
  native: 'Direct',
};

/** `transportDisplayName`. Never says "Direct" for an unconfigured app. */
export function transportDisplayName(routeKind: string | undefined, configured: boolean): string {
  if (!routeKind) return 'Not Configured';
  if (!configured && routeKind === 'native') return 'Not Configured';
  return TRANSPORT_LABEL[routeKind] ?? 'AnyPick proxy';
}

export function isAppRouteConfigured(action: Pick<ActionRow, 'routeKind' | 'selected'>): boolean {
  return Boolean(action.routeKind) && action.selected;
}

export function isAppManagedByAnyPick(action: Pick<ActionRow, 'routeKind'>): boolean {
  return Boolean(action.routeKind) && action.routeKind !== 'native';
}

/** `routeDedupeKey`. Two rows are the same route when the whole identity matches. */
export function routeDedupeKey(provider: string, name: string, detail: string): string {
  return `${provider.toLowerCase()}|${name.toLowerCase()}|${detail.toLowerCase()}`;
}

/** `uniqueCompatibleRoutes`. Keeps the selected row exactly once. */
export function uniqueCompatibleRoutes(actions: ActionRow[]): ActionRow[] {
  const seen = new Set<string>();
  const out: ActionRow[] = [];
  for (const action of actions) {
    const key = routeDedupeKey(action.sourceId, action.label, action.detail ?? '');
    if (seen.has(key)) {
      const existing = out.find((row) => routeDedupeKey(row.sourceId, row.label, row.detail ?? '') === key);
      if (existing && !existing.selected && action.selected) Object.assign(existing, action);
      continue;
    }
    seen.add(key);
    out.push(action);
  }
  return out;
}

const PROVIDER_DISPLAY: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  kiro: 'Kiro',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
  grok: 'Grok',
  workbuddy: 'WorkBuddy',
  zai: 'Z.ai (GLM)',
  cline: 'Cline',
  cloudflare: 'Cloudflare AI Gateway',
  'proxy-hub': 'Proxy Hub',
};

const PROVIDER_FAMILY: Record<string, string> = {
  anthropic: 'claude',
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'openai',
  openai: 'openai',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  antigravity: 'gemini',
  grok: 'grok',
  xai: 'grok',
  'x-ai': 'grok',
  cloudflare: 'cloudflare',
  'cloudflare-aigateway': 'cloudflare',
  'proxy-hub': 'proxy-hub',
  hub: 'proxy-hub',
};

/**
 * `normalize`. Lowercase, then the first `/`- or `:`-delimited segment.
 *
 * Dashes are deliberately preserved: Swift splits only on `/` and `:`, so
 * `gemini-cli` and `cloudflare-aigateway` must survive as themselves to reach
 * their family entries. Stripping punctuation here would collapse them into
 * keys the map does not contain.
 */
function normalize(value: string): string {
  return (value.toLowerCase().split(/[/:]/u)[0] ?? value.toLowerCase()).trim();
}

export function nativeProviderFamily(value: string): string {
  const key = normalize(value);
  return PROVIDER_FAMILY[key] ?? key;
}

export function nativeProviderName(value: string): string {
  const key = normalize(value);
  if (PROVIDER_DISPLAY[key]) return PROVIDER_DISPLAY[key];
  const family = nativeProviderFamily(key);
  if (PROVIDER_DISPLAY[family]) return PROVIDER_DISPLAY[family];
  return (family || 'Provider')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

const CLIENT_DISPLAY: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini',
  kiro: 'Kiro',
  workbuddy: 'WorkBuddy',
  codebuddy: 'WorkBuddy',
  zcode: 'ZCode',
  commandcode: 'Command Code',
  'command-code': 'Command Code',
  pi: 'Pi',
  omp: 'Omp',
  cline: 'Cline',
};

export function anypickDisplayName(value: string): string {
  const key = normalize(value);
  return CLIENT_DISPLAY[key] ?? value;
}

/** `nativeProviderPriority`. macOS orders the picker by owner, not alphabetically. */
export function nativeProviderPriority(provider: string): number {
  const key = normalize(provider);
  if (key === 'claude') return 0;
  if (key === 'codex' || key === 'openai') return 1;
  if (key === 'gemini' || key === 'google') return 2;
  if (key === 'kiro') return 3;
  if (key === 'grok') return 4;
  if (key === 'opencode') return 5;
  if (key === 'workbuddy' || key === 'codebuddy') return 6;
  return 7;
}

/**
 * Give every proxy in a list a name a user can tell apart.
 *
 * `friendlyProxyName` deliberately drops the provider, because "Claude proxy ·
 * Work" reads better than the composite id. But two providers can both own an
 * account called "Work", and then the list shows two identical rows with no way
 * to tell them apart. So a colliding name is qualified with its provider, and
 * only when it collides: the common case keeps the short form.
 */
export function disambiguatedProxyNames(
  proxies: Array<{ id: string; label: string; providerId: string }>,
): Map<string, string> {
  const short = new Map(proxies.map((proxy) => [proxy.id, friendlyProxyName(proxy.label, proxy.providerId)]));
  const counts = new Map<string, number>();
  for (const name of short.values()) counts.set(name, (counts.get(name) ?? 0) + 1);

  const resolved = new Map<string, string>();
  for (const proxy of proxies) {
    const name = short.get(proxy.id) as string;
    resolved.set(
      proxy.id,
      (counts.get(name) ?? 0) > 1 ? `${nativeProviderName(proxy.providerId)} ${name}` : name,
    );
  }
  return resolved;
}

/** `accountAccessibilityLabel`. Disambiguates two accounts with the same name. */
export function accountAccessibilityLabel(account: AccountRow, siblings: AccountRow[]): string {
  const identity = accountIdentityLine(account.providerId, account.detail);
  let base: string;
  if (!identity || identity === account.label) {
    base = `${account.label}, ${account.providerId}`;
  } else if (!account.label) {
    base = identity;
  } else {
    base = `${account.label}, ${identity}`;
  }
  // Swift sorts the colliding rows by id before taking the index, so "1 of 2"
  // is stable no matter what order the snapshot arrived in.
  const sameName = siblings
    .filter((row) => row.label === account.label)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (sameName.length < 2) return base;
  const index = sameName.findIndex((row) => row.id === account.id);
  if (index < 0) return base;
  return `${base} (${index + 1} of ${sameName.length})`;
}

/** `activityAccessibilityLabel`. Reads day, time, status, then the text. */
export function activityAccessibilityLabel(parts: {
  day: string;
  time: string;
  status: string;
  title: string;
  detail: string;
}): string {
  return [parts.day, parts.time, parts.status, parts.title, parts.detail]
    .filter(Boolean)
    .join(', ');
}

export type AttentionTarget =
  | { kind: 'proxy'; id: string }
  | { kind: 'app'; id: string }
  | { kind: 'account'; id: string }
  | { kind: 'conflict'; id: string; conflictKind: string };

/**
 * `overviewAttentionTarget`. One primary thing to fix, chosen in a fixed order,
 * so the Overview's call to action never disagrees with itself.
 */
export function overviewAttentionTarget(input: {
  proxies: ProxyRow[];
  apps: ActionRow[];
  accounts: AccountRow[];
  conflicts: Array<{ id: string; kind: string }>;
}): AttentionTarget | null {
  const brokenProxy = input.proxies.find((proxy) => proxy.enabled && !proxy.running);
  if (brokenProxy) return { kind: 'proxy', id: brokenProxy.id };
  const unconfigured = input.apps.find((action) => !isAppRouteConfigured(action));
  if (unconfigured) return { kind: 'app', id: unconfigured.clientId };
  const inactive = input.accounts.find((account) => !account.active && account.canRefresh === false);
  if (inactive) return { kind: 'account', id: inactive.id };
  const sourceChoice = input.conflicts.find((conflict) => conflict.kind === 'source-choice');
  if (sourceChoice) return { kind: 'conflict', id: sourceChoice.id, conflictKind: sourceChoice.kind };
  const overlap = input.conflicts.find((conflict) => conflict.kind === 'model-overlap');
  if (overlap) return { kind: 'conflict', id: overlap.id, conflictKind: overlap.kind };
  return null;
}

export function attentionCopy(target: AttentionTarget, lookup: {
  proxyName?: string;
  appName?: string;
  accountName?: string;
  conflictTitle?: string;
}): { title: string; detail: string; action: string } {
  if (target.kind === 'proxy') {
    const name = lookup.proxyName ?? 'A service';
    return { title: `${name} is unavailable`, detail: `Apps using ${name} cannot connect.`, action: 'Open Proxies' };
  }
  if (target.kind === 'app') {
    const name = lookup.appName ?? 'An app';
    return { title: `${name} doesn’t have a working login`, detail: 'Choose a login on Apps.', action: 'Open Apps' };
  }
  if (target.kind === 'account') {
    const name = lookup.accountName ?? 'An account';
    return { title: `${name} isn’t working`, detail: 'Check the login on Accounts & APIs.', action: 'Open Accounts' };
  }
  const title = lookup.conflictTitle ?? 'A model';
  return {
    title: `Model conflict: ${title}`,
    detail: 'Multiple providers offer the same model id. Choose one to route requests.',
    action: 'Open Proxy Hub',
  };
}

export function proxyStatus(proxy: Pick<ProxyRow, 'running' | 'enabled'>): DesignStatus {
  if (proxy.running) return 'running';
  return proxy.enabled ? 'attention' : 'stopped';
}

export function accountStatus(account: Pick<AccountRow, 'active'>): DesignStatus {
  return account.active ? 'ready' : 'stopped';
}

export function routeStatus(route: RouteRow): DesignStatus {
  if (route.status === 'ready') return 'ready';
  if (route.status === 'native') return 'ready';
  return 'attention';
}

export function activityMatchesCategory(
  category: ActivityCategoryId,
  event: { message: string; kind: string; isError: boolean },
): boolean {
  if (category === 'all') return true;
  if (category === 'issues') return event.isError;
  if (event.kind === 'activation') return category === 'routing';
  if (['account', 'gateway', 'quota'].includes(event.kind)) return category === 'accounts';
  if (event.kind === 'proxy') return category === 'proxies';
  if (event.kind === 'settings') return false;
  const haystack = `${event.message} ${event.kind}`.toLowerCase();
  if (category === 'routing') return /uses|routing|switched|route/u.test(haystack);
  if (category === 'accounts') return /account|login|gateway|backup/u.test(haystack);
  if (category === 'proxies') return /proxy|hub|service|port/u.test(haystack);
  return true;
}

/** `backupImportEntryIDs`. A replace without confirmation is not selectable. */
export function backupImportEntryIDs(
  selectedIds: string[],
  entries: Array<{ id: string; disposition: string }>,
  overwrite: boolean,
): string[] {
  if (overwrite) return selectedIds;
  const replaceable = new Set(entries.filter((entry) => entry.disposition === 'replace').map((entry) => entry.id));
  return selectedIds.filter((id) => !replaceable.has(id));
}

const NAME_CANDIDATES = ['Work', 'Personal'];

/** `unusedAccountName`. The Add Account sheet's first free suggestion. */
export function unusedAccountName(existing: string[]): string {
  for (const candidate of NAME_CANDIDATES) {
    if (!existing.includes(candidate)) return candidate;
  }
  let index = 1;
  while (existing.includes(`Account ${index}`)) index += 1;
  return `Account ${index}`;
}

export function isRotationSource(source: HubSource): source is Extract<HubSource, { rotates: true }> {
  return 'rotates' in source && source.rotates === true;
}

export function isGhostSource(source: HubSource): boolean {
  return 'ghost' in source && (source as { ghost?: boolean }).ghost === true;
}

export function hubSourceServiceID(source: HubSource): string {
  return `hub-source/${source.id}`;
}

export function hubConflictServiceID(id: string): string {
  return `hub-conflict/${id}`;
}
