import type { LiveUsageWindow, ProxyStatus } from '../../types';
import { layoutForColumns, type LayoutWidth } from '../../cli/render-util';
import { normalizeSlug } from '../../utils/slug';
import type { AccountRow, LiveAccountRelation, ProviderPoolRow, ProxyStateLabel } from './types';
import { G } from '../components/chrome/status';

export function normalizeIdentity(value: string | undefined | null): string | null {
  if (value == null) {
    return null;
  }
  const t = String(value).trim();
  return t === '' ? null : t.toLowerCase();
}

export function identitiesMatch(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean | null {
  const na = normalizeIdentity(a);
  const nb = normalizeIdentity(b);
  if (na == null || nb == null) {
    return null;
  }
  return na === nb;
}

/**
 * Derive live ↔ active saved-account relationship.
 * Does not invent a match when either identity is missing.
 */
export function deriveLiveRelation(input: {
  savedCount: number;
  livePresent: boolean;
  liveIdentity?: string;
  activeName: string | null;
  activeIdentity?: string;
  savedIdentities?: Array<string | undefined>;
  error?: boolean;
}): LiveAccountRelation {
  if (input.error) {
    return 'error';
  }
  if (!input.livePresent && input.savedCount === 0) {
    return 'empty';
  }
  if (!input.livePresent && input.savedCount > 0) {
    return 'no-live';
  }

  // live present
  const liveNorm = normalizeIdentity(input.liveIdentity);
  const saved = input.savedIdentities ?? [];
  const matchesSaved =
    liveNorm != null &&
    saved.some((id) => {
      const n = normalizeIdentity(id);
      return n != null && n === liveNorm;
    });

  if (!input.activeName) {
    return matchesSaved ? 'unknown' : liveNorm ? 'unsaved-live' : 'unknown';
  }

  const match = identitiesMatch(input.liveIdentity, input.activeIdentity);
  if (match === true) {
    return 'match';
  }
  if (match === false) {
    // Live may still match some other saved account
    if (!matchesSaved && liveNorm) {
      return 'unsaved-live';
    }
    return 'drift';
  }

  // Missing identities — cannot claim match or drift
  if (!matchesSaved && liveNorm) {
    // Check if any saved account has no identity either — stay unknown
    return 'unknown';
  }
  return 'unknown';
}

export function relationStatusHint(relation: LiveAccountRelation): string {
  switch (relation) {
    case 'match':
      return '';
    case 'drift':
      return 'changed';
    case 'unsaved-live':
      return 'save this login';
    case 'no-live':
      return 'signed out';
    case 'empty':
      return 'no saved logins';
    case 'unknown':
      return '';
    case 'error':
      return 'unavailable';
    default: {
      const _exhaustive: never = relation;
      return _exhaustive;
    }
  }
}

// ── Time / slug helpers ──────────────────────────────────────────

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return iso;
  }
  const diff = Math.max(0, nowMs - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) {
    return 'just now';
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 48) {
    return `${hr}h ago`;
  }
  const days = Math.floor(hr / 24);
  if (days < 60) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 24) {
    return `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** Relative "resets in …" phrasing for a usage window reset timestamp. */
export function formatResetIn(resetsAtMs: number | undefined, nowMs = Date.now()): string {
  if (resetsAtMs == null) {
    return '';
  }
  const diff = resetsAtMs - nowMs;
  if (diff <= 0) {
    return 'resets now';
  }
  const min = Math.round(diff / 60_000);
  if (min < 60) {
    return `resets in ${min}m`;
  }
  const hr = Math.round(min / 60);
  if (hr < 48) {
    return `resets in ${hr}h`;
  }
  const days = Math.round(hr / 24);
  return `resets in ${days}d`;
}

/** A textual progress bar for a remaining percentage (0–100). */
export function usageBar(remainingPercent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const filled = Math.round((clamped / 100) * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

/** Full one-line usage window: `5h  ▓▓▓░░ 62%  resets in 2h`. */
export function formatUsageWindow(window: LiveUsageWindow, nowMs = Date.now()): string {
  const reset = formatResetIn(window.resetsAtMs, nowMs);
  const bar = usageBar(window.remainingPercent);
  return `${window.label}  ${bar} ${window.remainingPercent}%${reset ? `  ${reset}` : ''}`;
}

/** Compact usage summary for a single-line rail: `5h 62% · resets in 2h`. */
export function formatUsageSummary(
  windows: LiveUsageWindow[] | undefined,
  nowMs = Date.now(),
): string {
  if (!windows || windows.length === 0) {
    return '';
  }
  // Prefer the window closest to exhaustion (least remaining).
  const tightest = [...windows].toSorted((a, b) => a.remainingPercent - b.remainingPercent)[0];
  const reset = formatResetIn(tightest.resetsAtMs, nowMs);
  return `${tightest.label} ${tightest.remainingPercent}% left${reset ? ` · ${reset}` : ''}`;
}

/** Suggest an account name slug from detected identity (email local-part preferred). */
export function suggestAccountSlug(identity?: string | null): string {
  if (!identity || !String(identity).trim()) {
    return 'main';
  }
  const raw = String(identity).trim();
  const at = raw.indexOf('@');
  const local = at > 0 ? raw.slice(0, at) : raw;
  try {
    return normalizeSlug(local, 'name');
  } catch {
    return 'main';
  }
}

/** Labels that look like file paths / import artifacts — never show in the list. */
function isPathLikeLabel(label: string): boolean {
  return /[~\\/]|\.json\b|^live\s+~|^live\s+\//i.test(label);
}

/**
 * Short list name for a saved login — same style for every tool.
 * Prefer a human label, then account name, then email local-part.
 * Never show "Live ~/.codex/auth.json" style path labels.
 */
export function accountDisplayName(row: {
  name: string;
  label?: string;
  identity?: string;
}): string {
  const label = row.label?.trim();
  if (label && !isPathLikeLabel(label) && label.toLowerCase() !== 'live') {
    return label;
  }
  if (row.name && row.name.toLowerCase() !== 'live') {
    return row.name;
  }
  if (row.identity) {
    return suggestAccountSlug(row.identity);
  }
  return row.name || 'main';
}

// ── Proxy display ────────────────────────────────────────────────

export function proxyStateLabel(status: ProxyStatus): ProxyStateLabel {
  if (status.detail === 'unavailable' || status.detail?.toLowerCase().includes('unavailable')) {
    return 'unavailable';
  }
  if (status.running) {
    return 'running';
  }
  if (status.enabled) {
    return 'enabled-stopped';
  }
  return 'disabled';
}

export function proxyStateText(
  status: ProxyStatus,
  opts: { active?: boolean; detail?: string } = {},
): string {
  const label = proxyStateLabel(status);
  if (label === 'running') {
    return 'running';
  }
  if (label === 'unavailable') {
    return status.detail ?? 'unavailable';
  }
  if (label === 'enabled-stopped') {
    if (opts.active === false) {
      return 'enabled';
    }
    return 'stopped';
  }
  return 'disabled';
}

export function formatProxyEndpoint(status: ProxyStatus): string {
  if (status.endpoint) {
    try {
      const u = new URL(status.endpoint);
      return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
    } catch {
      return status.endpoint;
    }
  }
  const host = status.host ?? '127.0.0.1';
  if (status.port != null) {
    return `${host}:${status.port}`;
  }
  return '—';
}

export function formatProxyPortLabel(status: ProxyStatus | null | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  if (status.running && status.port != null) {
    return `proxy :${status.port}`;
  }
  if (status.running && status.endpoint) {
    try {
      const u = new URL(status.endpoint);
      if (u.port) {
        return `proxy :${u.port}`;
      }
    } catch {
      return 'proxy running';
    }
  }
  if (status.enabled && !status.running) {
    const detail = status.detail?.toLowerCase() ?? '';
    if (detail.includes('kirolink') || detail.includes('missing')) {
      return status.detail ?? 'proxy unavailable';
    }
    return 'proxy stopped';
  }
  return undefined;
}

// ── Row formatting ───────────────────────────────────────────────

export function formatProviderRowLines(
  row: ProviderPoolRow,
  selected: boolean,
  width: LayoutWidth,
): string[] {
  const mark = selected ? G.focus : ' ';
  const name = row.displayName;
  const active = row.activeName ?? '—';
  const id = row.identityLabel;
  const count = row.savedCount === 0 ? 'no saved' : `${row.savedCount} saved`;
  const hint = row.statusHint || row.proxyLabel || '';
  const err = row.error ? 'error' : '';

  if (width === 'narrow') {
    const line1 = `${mark} ${name}  ${active}`;
    const line2 = `  ${id}  ${count}${hint ? `  ${hint}` : ''}${err ? `  ${err}` : ''}`;
    return [line1, line2];
  }

  if (width === 'medium') {
    const extra = hint || err || row.proxyLabel || '';
    return [`${mark} ${name}  ${active}  ${id}  ${count}${extra ? `  ${extra}` : ''}`];
  }

  // wide
  const parts = [`${mark} ${name}`, active, id, count];
  if (row.proxyLabel) {
    parts.push(row.proxyLabel);
  }
  if (row.statusHint && row.statusHint !== row.proxyLabel) {
    parts.push(row.statusHint);
  }
  if (row.error) {
    parts.push('status unavailable');
  }
  return [parts.join('  ')];
}

export function formatAccountRowLines(
  row: AccountRow,
  selected: boolean,
  width: LayoutWidth,
): string[] {
  const sel = selected ? G.focus : ' ';
  const marker = row.isLiveMatch ? G.live : '·';
  const name = row.label || row.name;
  const id = row.identity ?? '—';
  const updated = `updated ${row.updatedRelative}`;

  if (width === 'narrow') {
    return [`${sel} ${marker} ${name}`, `    ${id}  ${updated}`];
  }
  return [`${sel} ${marker} ${name}  ${id}  ${updated}`];
}

export function layoutFromColumns(cols: number): LayoutWidth {
  return layoutForColumns(cols);
}

// ── Loaders ──────────────────────────────────────────────────────
