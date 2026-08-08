import type { LiveAccountRelation, AnyPickPreviewModel } from './types';
import { identityDisplayText } from './identity';
import { G } from '../components/chrome/status';

export interface AnyPickHomeRow {
  providerId: string;
  providerName: string;
  /** Visual group for providers that manage multiple native products. */
  sourceGroupId?: string;
  sourceGroupName?: string;
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
    AnyPickHomeRow,
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

/** Provider summary line for AnyPick home (V2 wireframe). */
export interface AnyPickProviderSummary {
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

export interface AnyPickChrome {
  version: string;
  projectRoot: string;
  issueCount: number;
  driftCount: number;
  proxyRunningCount: number;
  totalAccounts: number;
}

export interface AnyPickHomeModel {
  rows: AnyPickHomeRow[];
  /** All registered providers (including empty). */
  providers: AnyPickProviderSummary[];
  /** Providers that have at least one saved account, in display order. */
  providerOrder: string[];
  chrome: AnyPickChrome;
  issueCount: number;
  /** Count of drift / unsaved / error relations (header badge). */
  driftCount: number;
  proxyRunningCount: number;
  totalAccounts: number;
  loadedAt: number;
}

export type AnyPickListItem =
  | { kind: 'provider'; provider: AnyPickProviderSummary }
  | { kind: 'account'; row: AnyPickHomeRow; accountIndex: number }
  | { kind: 'empty'; providerId: string };

/**
 * Group accounts under provider headers — includes empty providers (V2).
 * accountIndex always indexes into model.rows for selection.
 */
export function groupAnyPickHomeRows(
  rows: AnyPickHomeRow[],
  providers: AnyPickProviderSummary[],
): AnyPickListItem[] {
  const out: AnyPickListItem[] = [];
  // Map row ref → index in flat rows
  const indexByRef = new Map(rows.map((r, i) => [r.ref, i]));

  for (const p of providers) {
    const list = rows.filter((row) => row.providerId === p.providerId);
    if (list.length === 0) {
      out.push({ kind: 'provider', provider: p });
      out.push({ kind: 'empty', providerId: p.providerId });
      continue;
    }

    const sourceGroups = new Map<string, AnyPickHomeRow[]>();
    for (const row of list) {
      const key = row.sourceGroupId ?? row.providerId;
      const group = sourceGroups.get(key) ?? [];
      group.push(row);
      sourceGroups.set(key, group);
    }
    for (const [sourceGroupId, sourceRows] of sourceGroups) {
      const first = sourceRows[0];
      out.push({
        kind: 'provider',
        provider: {
          ...p,
          providerId:
            sourceGroupId === p.providerId ? p.providerId : `${p.providerId}:${sourceGroupId}`,
          providerName: first.sourceGroupName ?? p.providerName,
          accountCount: sourceRows.length,
        },
      });
      for (const row of sourceRows) {
        out.push({
          kind: 'account',
          row,
          accountIndex: indexByRef.get(row.ref) ?? 0,
        });
      }
    }
  }
  return out;
}

/**
 * Switch screen outcome + support for the bottom rail (DESIGN-TUI §5).
 * Returns [outcome, support].
 */
export function switchOutcome(row: AnyPickHomeRow | undefined): {
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
  const liveWho = row.livePresent ? identityDisplayText(row.liveIdentity, 'signed in') : null;
  const savedWho = identityDisplayText(row.identity, row.name);

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
export function anypickContextLines(row: AnyPickHomeRow | undefined): string[] {
  const { outcome, support } = switchOutcome(row);
  return support ? [outcome, support] : [outcome];
}

/** Enrich outcome when preview resolves. */
export function anypickContextFromPreview(
  row: AnyPickHomeRow,
  preview: AnyPickPreviewModel,
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
  const fromId = identityDisplayText(
    row.liveIdentity ?? preview.fromIdentity,
    preview.fromName || 'current',
  );
  const toId = identityDisplayText(preview.toIdentity ?? row.identity, preview.toName);
  return [`Switch ${tool} to ${preview.toName}`, `${fromId}  →  ${toId}`];
}

/** Ambient header chip for Switch. */
export function switchAmbient(
  model: Pick<AnyPickHomeModel, 'driftCount' | 'proxyRunningCount'>,
): string | undefined {
  if (model.driftCount > 0) {
    return `${G.changed} ${model.driftCount} changed`;
  }
  return undefined;
}
