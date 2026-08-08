import type { LiveAccountRelation, HotplugPreviewModel } from './types';
import { G } from '../components/chrome/status';

export interface HotplugHomeRow {
  providerId: string;
  providerName: string;
  name: string;
  /** Display `provider/name`. */
  ref: string;
  label: string;
  identity?: string;
  active: boolean;
  isLiveMatch: boolean;
  /** Short status: live · saved · changed · … */
  statusText: string;
  proxyEnabled: boolean;
  proxyRunning: boolean;
  /** e.g. `proxy ● :8080` — not shown on Switch primary list */
  proxyLabel?: string;
  proxyPort?: number;
  canRefresh: boolean;
  canProxy: boolean;
  updatedRelative: string;
  /** Current live login identity for this tool (may differ from selected). */
  liveIdentity?: string;
  livePresent: boolean;
  /** Last selected saved login name for this tool. */
  providerActiveName: string | null;
  providerRelation: LiveAccountRelation;
  /**
   * saved — normal snapshot row (default)
   * save-live — action: save the live login that is not stored yet
   */
  rowKind?: 'saved' | 'save-live';
}

/** Map row flags to design status kind. */
export function accountStatusKind(
  row: Pick<
    HotplugHomeRow,
    'isLiveMatch' | 'active' | 'statusText' | 'providerRelation' | 'rowKind'
  >,
): 'live' | 'saved' | 'changed' | 'unavailable' | 'signed-out' | 'attention' {
  if (row.rowKind === 'save-live') {
    return 'attention';
  }
  if (row.statusText.includes('error') || row.providerRelation === 'error') {
    return 'unavailable';
  }
  if (row.isLiveMatch) {
    return 'live';
  }
  if (
    row.statusText.includes('changed') ||
    row.statusText.includes('drift') ||
    (row.active && row.providerRelation === 'drift')
  ) {
    return 'changed';
  }
  return 'saved';
}

/** Provider summary line for Hotplug home (V2 wireframe). */
export interface HotplugProviderSummary {
  providerId: string;
  providerName: string;
  liveIdentity?: string;
  livePresent: boolean;
  activeName: string | null;
  relation: LiveAccountRelation;
  /** e.g. `live: you@work.com → active: work · proxy ●` */
  summaryLine: string;
  accountCount: number;
  canProxy: boolean;
  canRefresh: boolean;
  canClear: boolean;
}

export interface HotplugChrome {
  version: string;
  projectRoot: string;
  issueCount: number;
  driftCount: number;
  proxyRunningCount: number;
  totalAccounts: number;
}

export interface HotplugHomeModel {
  rows: HotplugHomeRow[];
  /** All registered providers (including empty). */
  providers: HotplugProviderSummary[];
  /** Providers that have at least one saved account, in display order. */
  providerOrder: string[];
  chrome: HotplugChrome;
  issueCount: number;
  /** Count of drift / unsaved / error relations (header badge). */
  driftCount: number;
  proxyRunningCount: number;
  totalAccounts: number;
  loadedAt: number;
}

export type HotplugListItem =
  | { kind: 'provider'; provider: HotplugProviderSummary }
  | { kind: 'account'; row: HotplugHomeRow; accountIndex: number }
  | { kind: 'empty'; providerId: string };

/**
 * Group accounts under provider headers — includes empty providers (V2).
 * accountIndex always indexes into model.rows for selection.
 */
export function groupHotplugHomeRows(
  rows: HotplugHomeRow[],
  providers: HotplugProviderSummary[],
): HotplugListItem[] {
  const out: HotplugListItem[] = [];
  const byProvider = new Map<string, HotplugHomeRow[]>();
  for (const row of rows) {
    const list = byProvider.get(row.providerId) ?? [];
    list.push(row);
    byProvider.set(row.providerId, list);
  }

  // Map row ref → index in flat rows
  const indexByRef = new Map(rows.map((r, i) => [r.ref, i]));

  for (const p of providers) {
    out.push({ kind: 'provider', provider: p });
    const list = byProvider.get(p.providerId) ?? [];
    if (list.length === 0) {
      out.push({ kind: 'empty', providerId: p.providerId });
      continue;
    }
    for (const row of list) {
      out.push({
        kind: 'account',
        row,
        accountIndex: indexByRef.get(row.ref) ?? 0,
      });
    }
  }
  return out;
}

/**
 * Switch screen outcome + support for the bottom rail (DESIGN-TUI §5).
 * Returns [outcome, support].
 */
export function switchOutcome(row: HotplugHomeRow | undefined): {
  outcome: string;
  support: string;
} {
  if (!row) {
    return {
      outcome: 'No saved logins yet',
      support: 'Save a login already on this computer, or add another one.',
    };
  }

  const tool = row.providerName;
  const liveWho = row.livePresent ? row.liveIdentity?.trim() || 'signed in' : null;
  const savedWho = row.identity?.trim() || row.name;

  if (row.rowKind === 'save-live') {
    return {
      outcome: `Save ${liveWho ?? 'this login'} as a ${tool} login`,
      support: 'Stores a snapshot so you can switch back later.',
    };
  }

  // Live match — already using this login
  if (row.active && row.isLiveMatch) {
    return {
      outcome: `${tool} already uses ${row.name}`,
      support: 'No change.',
    };
  }

  // Active but changed (live differs from saved)
  if (
    row.active &&
    (row.providerRelation === 'drift' ||
      row.statusText.includes('changed') ||
      row.statusText.includes('drift'))
  ) {
    return {
      outcome: `This ${tool} login differs from ${row.name}`,
      support: `Live: ${liveWho ?? '—'}   Saved: ${savedWho}`,
    };
  }

  // No live login
  if (!row.livePresent) {
    return {
      outcome: `Sign in to ${tool} with ${row.name}`,
      support: savedWho !== row.name ? savedWho : '',
    };
  }

  // Switch to another saved login
  const fromId = liveWho ?? row.providerActiveName ?? 'current';
  return {
    outcome: `Switch ${tool} to ${row.name}`,
    support: `${fromId}  →  ${savedWho}`,
  };
}

/** Flatten switchOutcome into context lines for the TUI CONTEXT pane. */
export function hotplugContextLines(row: HotplugHomeRow | undefined): string[] {
  const { outcome, support } = switchOutcome(row);
  return support ? [outcome, support] : [outcome];
}

/** Enrich outcome when preview resolves. */
export function hotplugContextFromPreview(
  row: HotplugHomeRow,
  preview: HotplugPreviewModel,
): string[] {
  const tool = row.providerName;
  if (preview.alreadyActive) {
    if (row.isLiveMatch) {
      return [`${tool} already uses ${row.name}`, 'No change.'];
    }
    return switchOutcome(row).support
      ? [switchOutcome(row).outcome, switchOutcome(row).support]
      : [switchOutcome(row).outcome];
  }
  const fromId =
    row.liveIdentity?.trim() || preview.fromIdentity?.trim() || preview.fromName || 'current';
  const toId = preview.toIdentity?.trim() || row.identity?.trim() || preview.toName;
  return [`Switch ${tool} to ${preview.toName}`, `${fromId}  →  ${toId}`];
}

/** Ambient header chip for Switch. */
export function switchAmbient(
  model: Pick<HotplugHomeModel, 'driftCount' | 'proxyRunningCount'>,
): string | undefined {
  if (model.driftCount > 0) {
    return `${G.changed} ${model.driftCount} changed`;
  }
  return undefined;
}
