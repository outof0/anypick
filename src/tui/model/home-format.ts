import type { AccountRow, LiveAccountRelation, ProviderPoolRow } from './types';
import type { HotplugHomeRow, HotplugProviderSummary } from './hotplug';
import { accountDisplayName, identitiesMatch } from './identity';
import { G } from '../components/chrome/status';

export function formatHotplugHomeLine(row: HotplugHomeRow, selected: boolean): string {
  const mark = selected ? G.focus : ' ';
  const name = accountDisplayName(row).padEnd(12);
  const id = (row.identity ?? '').padEnd(22);
  let status: string;
  if (row.isLiveMatch) {
    status = `${G.live} live`;
  } else if (row.statusText === 'changed' || row.statusText.includes('drift')) {
    status = `${G.changed} changed`;
  } else if (row.statusText === 'unavailable') {
    status = `${G.fail} unavailable`;
  } else {
    status = `${G.open} saved`;
  }
  return `${mark} ${name} ${id} ${status}`;
}

/**
 * Group header — tool name only. No ambient right label.
 */
export function providerGroupHeader(p: HotplugProviderSummary): {
  name: string;
  right: string;
} {
  void p.relation;
  void p.livePresent;
  return { name: p.providerName, right: '' };
}

/**
 * Capture live auth to a temp snapshot and fingerprint it.
 * Uses each provider's own backup() path so FakeProvider and real tools both work.
 */
/**
 * Decide row status from real live auth (detectLive), not only the DB active pointer.
 *
 * - ● live   — saved login identity matches what the official tool currently has
 * - ○ saved  — stored, not currently live
 */
export function rowMatchesLive(input: {
  livePresent: boolean;
  liveIdentity?: string;
  accountIdentity?: string;
  active: boolean;
  providerRelation: LiveAccountRelation;
}): { isLiveMatch: boolean; statusText: string } {
  if (input.providerRelation === 'error') {
    return { isLiveMatch: false, statusText: 'unavailable' };
  }

  // Prefer real identity comparison against detectLive().
  const match = identitiesMatch(input.liveIdentity, input.accountIdentity);
  if (match === true) {
    return { isLiveMatch: true, statusText: 'live' };
  }

  // Active pointer disagrees with what is actually on disk.
  if (input.active && input.livePresent && match === false) {
    return { isLiveMatch: false, statusText: 'changed' };
  }

  // Provider-level drift: active row without usable identity still flagged.
  if (
    input.active &&
    input.livePresent &&
    (input.providerRelation === 'drift' || input.providerRelation === 'unsaved-live')
  ) {
    return { isLiveMatch: false, statusText: 'changed' };
  }

  return { isLiveMatch: false, statusText: 'saved' };
}

/**
 * V2 premium row line.
 *   ┌ account-3   dev3@work.com        LIVE
 *   │ account-1   dev1@work.com        saved
 * Selection drawn by the renderer (background + left bar).
 */
export function formatHotplugHomeV2(
  row: HotplugHomeRow,
  _providerId: string,
  _providerName: string,
): { name: string; identity: string; tag: 'LIVE' | 'SAVED' } {
  return {
    name: accountDisplayName(row),
    identity: row.identity ?? '—',
    tag: row.active && row.isLiveMatch ? 'LIVE' : 'SAVED',
  };
}

/** Status dot color for a row (Codex-style: green=live, gray=saved). */
export function hotplugRowColor(row: HotplugHomeRow): 'green' | 'gray' {
  return row.active && row.isLiveMatch ? 'green' : 'gray';
}

/** Legacy flat line (accounts workshop / tests). */
export function formatHotplugHomeFlatLine(row: HotplugHomeRow, selected: boolean): string {
  const mark = selected ? G.focus : ' ';
  const live = row.isLiveMatch ? G.live : row.active ? G.open : '·';
  const id = row.identity ? `  ${row.identity}` : '';
  const proxy = row.proxyLabel ? `  ${row.proxyLabel}` : '';
  return `${mark} ${live} ${row.ref.padEnd(22)} ${row.statusText.padEnd(14)}${id}${proxy}`;
}

export function filterHotplugHomeRows(rows: HotplugHomeRow[], query: string): HotplugHomeRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter((r) => {
    const hay = [r.ref, r.label, r.identity ?? '', r.statusText, r.providerName]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Filter provider rows by free-text query (name, identity, active name). */
export function filterProviderRows(rows: ProviderPoolRow[], query: string): ProviderPoolRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter((r) => {
    const hay = [
      r.providerId,
      r.displayName,
      r.activeName ?? '',
      r.identityLabel,
      r.statusHint,
      r.proxyLabel ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

export function filterAccountRows(rows: AccountRow[], query: string): AccountRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter((r) => {
    const hay = [r.name, r.label, r.identity ?? '', r.proxyLabel ?? ''].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** Ensure view models never embed secret-like fields (test helper). */
export function collectViewModelStrings(value: unknown, out: string[] = []): string[] {
  if (value == null) {
    return out;
  }
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      collectViewModelStrings(v, out);
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // keys that must never carry secrets in VMs
      if (/token|secret|password|auth\.json|bearer/i.test(k) && typeof v === 'string') {
        out.push(v);
      }
      collectViewModelStrings(v, out);
    }
  }
  return out;
}
