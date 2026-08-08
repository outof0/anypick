import type { AnyPickApp } from '../../core/app';
import type { SwitchResult } from '../../core/service';
import type { ProxyStatus } from '../../types';
import { providerCapabilities } from '../../core/capabilities';
import type {
  AccountRow,
  OperationReceipt,
  OperationReceiptLine,
  ProviderPoolModel,
  AnyPickPreviewModel,
} from './types';
import {
  accountDisplayName,
  deriveLiveRelation,
  formatRelativeTime,
  identitiesMatch,
} from './identity';
import { safeCurrent, safeList, liveSummary } from './root';

export async function loadProviderPool(
  app: AnyPickApp,
  providerId: string,
  nowMs = Date.now(),
): Promise<ProviderPoolModel> {
  const provider = app.accounts.provider(providerId);
  const caps = providerCapabilities(provider);
  const cur = await safeCurrent(app, providerId);
  const listed = await safeList(app, providerId);

  if (!cur.ok) {
    return {
      providerId,
      displayName: provider.name,
      ...caps,
      live: {
        present: false,
        activeName: null,
        relation: 'error',
        summary: cur.error,
      },
      accounts: [],
      error: cur.error,
    };
  }

  const { active, live, account, proxy: _proxy } = cur.data;
  const accounts = listed.ok ? listed.data : [];
  const relation = deriveLiveRelation({
    savedCount: accounts.length,
    livePresent: live.present,
    liveIdentity: live.identity,
    activeName: active,
    activeIdentity: account?.meta.identity,
    savedIdentities: accounts.map((a) => a.identity),
  });

  const accountRows: AccountRow[] = accounts.map((a) => {
    const isActive = a.active;
    // Live = identity matches detectLive(), not merely DB active pointer.
    const m = identitiesMatch(live.identity, a.identity);
    const isLiveMatch = m === true;

    let proxyLabel: string | undefined;
    if (caps.canProxy && a.proxyEnabled) {
      proxyLabel = a.proxyRunning ? 'proxy running' : 'proxy enabled';
    }

    return {
      providerId,
      name: a.name,
      label: accountDisplayName({ name: a.name, label: a.label, identity: a.identity }),
      identity: a.identity,
      active: isActive,
      isLiveMatch,
      updatedAt: a.updatedAt,
      updatedRelative: formatRelativeTime(a.updatedAt, nowMs),
      createdAt: a.createdAt,
      proxyEnabled: a.proxyEnabled,
      proxyRunning: a.proxyRunning,
      proxyLabel,
    };
  });

  return {
    providerId,
    displayName: provider.name,
    ...caps,
    live: {
      present: live.present,
      activeName: active,
      identity: live.identity,
      details: live.details,
      relation,
      summary: liveSummary(relation, providerId, active, live),
    },
    accounts: accountRows,
    error: listed.ok ? undefined : listed.error,
  };
}

export async function buildAnyPickPreview(
  app: AnyPickApp,
  providerId: string,
  targetName: string,
): Promise<AnyPickPreviewModel> {
  const provider = app.accounts.provider(providerId);
  const caps = providerCapabilities(provider);
  const cur = await app.accounts.current(providerId);
  const target = await app.accounts.get(providerId, targetName);
  if (!target) {
    throw new Error(`Account ${providerId}/${targetName} not found.`);
  }

  const fromName = cur.active;
  const fromIdentity = cur.account?.meta.identity ?? cur.live.identity;
  const toName = target.meta.name;
  const toIdentity = target.meta.identity;
  const alreadyActive = fromName === toName;

  const willRefreshPrevious =
    !alreadyActive && cur.live.present && fromName != null && fromName !== toName;

  let previousProxy: AnyPickPreviewModel['previousProxy'];
  let targetProxy: AnyPickPreviewModel['targetProxy'];
  let restoreOwner: AnyPickPreviewModel['restoreOwner'];

  if (provider.restoreOwnerStatus) {
    try {
      restoreOwner = (await provider.restoreOwnerStatus(target.snapshotDir)) ?? undefined;
    } catch {
      // Preview remains usable if process discovery is unavailable. The
      // provider's mutation-free preflight still protects the actual switch.
    }
  }

  if (caps.canProxy) {
    if (fromName && fromName !== toName) {
      try {
        const st = await app.proxy.proxyStatus(providerId, fromName);
        previousProxy = {
          enabled: st.enabled,
          running: st.running,
          endpoint: st.endpoint,
        };
      } catch {
        previousProxy = { enabled: false, running: false };
      }
    }
    const tCfg = target.proxy;
    let tStatus: ProxyStatus | null = null;
    try {
      tStatus = await app.proxy.proxyStatus(providerId, toName);
    } catch {
      tStatus = {
        enabled: tCfg.enabled,
        running: false,
        port: tCfg.port,
        host: tCfg.host,
      };
    }
    targetProxy = {
      enabled: tCfg.enabled,
      running: tStatus.running,
      host: tStatus.host ?? tCfg.host ?? '127.0.0.1',
      port: tStatus.port ?? tCfg.port,
      endpoint: tStatus.endpoint,
      willStart: tCfg.enabled && !alreadyActive,
    };
  }

  const before: string[] = [];
  if (willRefreshPrevious && fromName) {
    before.push(`Save refreshed live auth back into ${providerId}/${fromName}`);
  }
  if (previousProxy?.running) {
    before.push(`Stop proxy for ${providerId}/${fromName}`);
  }
  if (before.length === 0) {
    before.push('No pre-switch steps required');
  }

  const switchSteps = [
    `Restore ${providerId}/${toName} into native ${provider.name} auth files`,
    `Update AnyPick's active account record`,
  ];

  const after = ['Verify the live identity'];
  if (targetProxy?.willStart) {
    const port =
      targetProxy.port != null ? ` on ${targetProxy.host ?? '127.0.0.1'}:${targetProxy.port}` : '';
    after.push(`Start proxy for ${providerId}/${toName}${port}`);
  }

  // These notes are independent observations, not alternatives. They were once
  // an if/else-if chain, which silently dropped the "already active" note —
  // the one that changes what the action actually does — whenever a proxy note
  // also applied (i.e. for every provider).
  const notes: string[] = [];
  if (alreadyActive) {
    notes.push('This account is already active. Opening details instead of rotating.');
  }
  if (!caps.canProxy) {
    notes.push(`No proxy action is needed for ${provider.name}.`);
  } else if (targetProxy && !targetProxy.enabled) {
    notes.push(`Proxy is disabled for ${providerId}/${toName}; it will not start.`);
  }

  return {
    providerId,
    displayName: provider.name,
    fromName,
    fromIdentity,
    toName,
    toIdentity,
    alreadyActive,
    willRefreshPrevious,
    canProxy: caps.canProxy,
    previousProxy,
    targetProxy,
    restoreOwner,
    steps: { before, switch: switchSteps, after, notes },
  };
}

export function receiptFromSwitchResult(result: SwitchResult): OperationReceipt {
  const lines: OperationReceiptLine[] = [];
  if (result.proxy?.error) {
    lines.push({
      kind: 'warn',
      text: `${result.providerName} switched to ${result.to}, but its proxy didn't start. Press tab, then l for logs.`,
    });
  } else {
    lines.push({
      kind: 'ok',
      text: `Switched ${result.providerName} to ${result.to}`,
    });
  }
  return {
    title: '',
    lines,
  };
}

/**
 * All accounts on proxy-capable providers (not only enabled/active).
 * Also surfaces multi pools and unsaved live logins so the board is never "empty" when something is usable.
 */
