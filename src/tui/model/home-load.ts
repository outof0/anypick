import type { HotplugApp } from '../../core/app';
import { providerCapabilities } from '../../core/capabilities';
import type { LiveAccountRelation } from './types';
import type {
  HotplugChrome,
  HotplugHomeModel,
  HotplugHomeRow,
  HotplugProviderSummary,
} from './hotplug';
import {
  accountDisplayName,
  deriveLiveRelation,
  formatRelativeTime,
  relationStatusHint,
} from './identity';
import { safeCurrent } from './root';
import { shortToolName } from './names';
import { rowMatchesLive } from './home-format';
import { G } from '../components/chrome/status';

export async function loadHotplugHome(
  app: HotplugApp,
  nowMs = Date.now(),
): Promise<HotplugHomeModel> {
  const listed = await app.accounts.list();
  const rows: HotplugHomeRow[] = [];
  let issueCount = 0;
  let driftCount = 0;
  let proxyRunningCount = 0;

  // Port map from proxy overview (one pass)
  const portByRef = new Map<string, number | undefined>();
  try {
    const proxyRows = await app.proxy.listProxyRows();
    for (const pr of proxyRows) {
      portByRef.set(`${pr.provider}/${pr.name}`, pr.status.port);
    }
  } catch {
    // optional
  }

  // Cache live/active per provider for relation text
  const providerState = new Map<
    string,
    {
      liveIdentity?: string;
      livePresent: boolean;
      activeName: string | null;
      relation: LiveAccountRelation;
    }
  >();
  /** Provider account_id from the live auth material when known. */
  const liveAccountIds = new Map<string, string | null>();

  const providers: HotplugProviderSummary[] = [];

  for (const p of app.accounts.listProviders()) {
    const caps = providerCapabilities(p);
    const cur = await safeCurrent(app, p.id);
    const forProvider = listed.filter((a) => a.provider === p.id);

    // Keep the provider-reported account id for relation/status decisions.
    if (cur.ok) {
      liveAccountIds.set(p.id, cur.data.live.accountId ?? null);
    }

    if (!cur.ok) {
      providerState.set(p.id, {
        livePresent: false,
        activeName: null,
        relation: 'error',
      });
      issueCount += 1;
      driftCount += 1;
      providers.push({
        providerId: p.id,
        providerName: shortToolName(p.id, p.shortName ?? p.name),
        livePresent: false,
        activeName: null,
        relation: 'error',
        summaryLine: `${shortToolName(p.id, p.shortName ?? p.name)}   unavailable`,
        accountCount: forProvider.length,
        ...caps,
      });
      continue;
    }
    const { active, live, account, proxy, liveMatchKnown } = cur.data;
    let relation = deriveLiveRelation({
      savedCount: forProvider.length,
      livePresent: live.present,
      liveIdentity: live.identity,
      activeName: active,
      activeIdentity: account?.meta.identity,
      savedIdentities: forProvider.map((a) => a.identity),
    });
    // Material-level relation: does the active snapshot match the live login?
    const liveAcct = live.accountId ?? liveAccountIds.get(p.id) ?? null;
    if (active && account && cur.data.isLiveMatch) {
      relation = 'match';
    } else if (
      active &&
      account &&
      liveMatchKnown &&
      (live.present || liveAcct) &&
      !cur.data.isLiveMatch
    ) {
      // Live present but this snapshot's material differs → drift.
      relation = relation === 'no-live' || relation === 'empty' ? relation : 'drift';
    }
    if (relation === 'drift' || relation === 'unsaved-live' || relation === 'error') {
      issueCount += 1;
      if (relation === 'drift' || relation === 'unsaved-live') {
        driftCount += 1;
      }
    }
    if (proxy?.enabled && !proxy.running) {
      issueCount += 1;
    }
    // Prefer live.details for mode hint (e.g. chatgpt) when no identity
    let liveIdentity = live.identity?.trim() || undefined;
    if (!liveIdentity && live.present && live.details) {
      liveIdentity = live.details.startsWith('chatgpt') ? 'ChatGPT' : live.details;
    }
    // Prefer the stable provider identity when accountId is available.
    if (live.accountId && live.identity) {
      liveIdentity = live.identity;
    }

    providerState.set(p.id, {
      liveIdentity,
      livePresent: live.present || Boolean(live.accountId),
      activeName: active,
      relation,
    });

    const headerBit = live.present ? liveIdentity || 'signed in' : 'signed out';
    const selectedBit = active ? active : '—';
    const hint = relationStatusHint(relation);
    const hintBit = hint ? ` · ${hint}` : '';

    const displayName = shortToolName(p.id, p.shortName ?? p.name);
    providers.push({
      providerId: p.id,
      providerName: displayName,
      liveIdentity,
      livePresent: live.present,
      activeName: active,
      relation,
      summaryLine: `${displayName}   ${headerBit} · ${selectedBit}${hintBit}`,
      accountCount: forProvider.length,
      ...caps,
    });
  }

  for (const a of listed) {
    let providerName = a.provider;
    let canRefresh = false;
    let canProxy = false;
    try {
      const p = app.accounts.provider(a.provider);
      providerName = shortToolName(p.id, p.shortName ?? p.name);
      const caps = providerCapabilities(p);
      canRefresh = caps.canRefresh;
      canProxy = caps.canProxy;
    } catch {
      // keep id
    }

    const ps = providerState.get(a.provider);
    // Material-level match is computed by the service (provider owns the
    // fingerprint logic); fall back to identity heuristic when no live auth.
    let isLiveMatch = a.isLiveMatch;
    let statusText: string;

    if (isLiveMatch) {
      statusText = 'live';
    } else {
      const liveAccountId = liveAccountIds.get(a.provider) ?? null;
      if (liveAccountId || ps?.livePresent) {
        statusText = a.active && ps?.livePresent ? 'changed' : 'saved';
      } else {
        const liveMatch = rowMatchesLive({
          livePresent: ps?.livePresent ?? false,
          liveIdentity: ps?.liveIdentity,
          accountIdentity: a.identity,
          active: a.active,
          providerRelation: ps?.relation ?? 'unknown',
        });
        isLiveMatch = liveMatch.isLiveMatch;
        statusText = liveMatch.statusText;
      }
    }

    if (a.proxyRunning) {
      proxyRunningCount += 1;
    }

    const port = portByRef.get(`${a.provider}/${a.name}`);
    let proxyLabel: string | undefined;
    if (canProxy && a.proxyEnabled) {
      const portBit = port != null ? ` :${port}` : '';
      proxyLabel = a.proxyRunning ? `proxy ${G.live}${portBit}` : `proxy ${G.open}${portBit}`;
    }

    rows.push({
      providerId: a.provider,
      providerName,
      name: a.name,
      ref: `${a.provider}/${a.name}`,
      label: accountDisplayName({ name: a.name, label: a.label, identity: a.identity }),
      identity: a.identity,
      active: a.active,
      isLiveMatch,
      statusText,
      proxyEnabled: a.proxyEnabled,
      proxyRunning: a.proxyRunning,
      proxyLabel,
      proxyPort: port,
      canRefresh,
      canProxy,
      updatedRelative: formatRelativeTime(a.updatedAt, nowMs),
      liveIdentity: ps?.liveIdentity,
      livePresent: ps?.livePresent ?? false,
      providerActiveName: ps?.activeName ?? null,
      providerRelation: ps?.relation ?? 'unknown',
      rowKind: 'saved',
    });
  }

  // A stale/corrupt human label must not make two different saved accounts
  // appear to be the same row. Fall back to their stable account names when
  // display labels collide within one provider.
  const displayCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.providerId}\0${row.label.trim().toLowerCase()}`;
    displayCounts.set(key, (displayCounts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    const key = `${row.providerId}\0${row.label.trim().toLowerCase()}`;
    if ((displayCounts.get(key) ?? 0) > 1) {
      row.label = row.name;
    }
  }

  // Unsaved live logins — always show so the user can save without hunting Accounts
  for (const p of providers) {
    const shouldOfferSave =
      p.relation === 'unsaved-live' || (p.livePresent && p.accountCount === 0);
    if (!shouldOfferSave) {
      continue;
    }
    const liveId = p.liveIdentity?.toLowerCase();
    const alreadySaved =
      liveId &&
      rows.some(
        (r) =>
          r.providerId === p.providerId &&
          r.rowKind !== 'save-live' &&
          r.identity?.toLowerCase() === liveId,
      );
    if (alreadySaved) {
      continue;
    }
    rows.push({
      providerId: p.providerId,
      providerName: p.providerName,
      name: '',
      ref: `${p.providerId}/__save-live__`,
      label: 'Save current login',
      identity: p.liveIdentity,
      active: false,
      isLiveMatch: false,
      statusText: 'not saved',
      proxyEnabled: false,
      proxyRunning: false,
      canRefresh: p.canRefresh,
      canProxy: p.canProxy,
      updatedRelative: 'now',
      liveIdentity: p.liveIdentity,
      livePresent: true,
      providerActiveName: p.activeName,
      providerRelation: 'unsaved-live',
      rowKind: 'save-live',
    });
  }

  // Stable order: provider registry order, save-live first in group, then active, then name
  const providerRank = new Map(providers.map((p, i) => [p.providerId, i]));
  rows.sort((x, y) => {
    const pc = (providerRank.get(x.providerId) ?? 99) - (providerRank.get(y.providerId) ?? 99);
    if (pc !== 0) {
      return pc;
    }
    if ((x.rowKind === 'save-live') !== (y.rowKind === 'save-live')) {
      return x.rowKind === 'save-live' ? -1 : 1;
    }
    if (x.active !== y.active) {
      return x.active ? -1 : 1;
    }
    return x.name.localeCompare(y.name);
  });

  const providerOrder = providers.map((p) => p.providerId);

  let projectRoot = process.cwd();
  try {
    const { resolveProjectRoot } = await import('../../core/project-root');
    projectRoot = resolveProjectRoot();
  } catch {
    // keep cwd
  }

  const chrome: HotplugChrome = {
    version: '0.8.0',
    projectRoot,
    issueCount,
    driftCount,
    proxyRunningCount,
    totalAccounts: rows.length,
  };

  return {
    rows,
    providers,
    providerOrder,
    chrome,
    issueCount,
    driftCount,
    proxyRunningCount,
    totalAccounts: rows.length,
    loadedAt: nowMs,
  };
}

/**
 * Switch list row (name + identity + status label).
 * Focus mark is owned by the renderer — not included here.
 */
