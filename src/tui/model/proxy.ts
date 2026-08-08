import type { HotplugApp } from '../../core/app';
import type { ProxyStatus } from '../../types';
import type { ProxyRow, ProxyStateLabel } from './types';
import { formatProxyEndpoint, proxyStateLabel, proxyStateText } from './identity';
import { shortToolName } from './names';
import { providerCanProxy } from '../../core/capabilities';

export async function loadProxyOverview(app: HotplugApp): Promise<ProxyRow[]> {
  const out: ProxyRow[] = [];
  const seen = new Set<string>();

  const proxyProviders = app.accounts.listProviders().filter((p) => providerCanProxy(p));

  const providerNameOf = (providerId: string): string => {
    try {
      const p = app.accounts.provider(providerId);
      return shortToolName(providerId, p.shortName ?? p.name);
    } catch {
      return shortToolName(providerId, providerId);
    }
  };

  const compatibilityOf = (providerId: string, status?: ProxyStatus): string =>
    status?.compatibility ??
    (() => {
      try {
        return app.accounts.provider(providerId).proxyCompatibility;
      } catch {
        return undefined;
      }
    })() ??
    '—';

  const pushAccount = (
    providerId: string,
    name: string,
    active: boolean,
    status: ProxyStatus,
    extra?: Partial<ProxyRow>,
  ) => {
    const key = extra?.displayRef ?? `${providerId}/${name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const stateLabel = proxyStateLabel(status);
    const inactiveEnabled = status.enabled && !active && extra?.rowKind !== 'pool';
    out.push({
      providerId,
      providerName: providerNameOf(providerId),
      name,
      active,
      status,
      stateLabel,
      stateText:
        inactiveEnabled && stateLabel === 'enabled-stopped'
          ? 'enabled'
          : proxyStateText(status, { active }),
      endpointText: formatProxyEndpoint(status),
      compatibilityText: compatibilityOf(providerId, status),
      detailText: status.detail,
      inactiveEnabled,
      rowKind: 'account',
      ...extra,
    });
  };

  for (const p of proxyProviders) {
    let listed: Awaited<ReturnType<HotplugApp['accounts']['list']>> = [];
    try {
      listed = await app.accounts.list(p.id);
    } catch {
      listed = [];
    }

    let pool: Awaited<ReturnType<typeof app.proxy.getPool>> | null = null;
    try {
      pool = await app.proxy.getPool(p.id);
    } catch {
      pool = null;
    }

    if (pool?.mode === 'multi') {
      let poolStatus: ProxyStatus;
      try {
        poolStatus = await app.proxy.poolProxyStatus(p.id);
      } catch {
        poolStatus = {
          enabled: pool.enabled,
          running: false,
          port: pool.port,
          host: pool.host,
        };
      }
      const enabledCount = pool.members.filter((m) => m.enabled).length;
      pushAccount(p.id, '*', true, poolStatus, {
        rowKind: 'pool',
        displayRef: `pool:${p.id}`,
        name: 'pool',
        detailText: `${enabledCount} of ${pool.members.length} accounts enabled`,
        stateText: poolStatus.running ? 'running' : pool.enabled ? 'stopped' : 'off',
      });
      for (const m of pool.members) {
        const acc = listed.find((a) => a.name === m.account);
        pushAccount(
          p.id,
          m.account,
          Boolean(acc?.active),
          {
            enabled: m.enabled,
            running: false,
            detail: m.enabled ? 'in pool' : 'paused',
          },
          {
            rowKind: 'member',
            indent: true,
            memberEnabled: m.enabled,
            identity: acc?.identity,
            displayRef: `${p.id}/${m.account}`,
            stateText: m.enabled ? 'in pool' : 'paused',
          },
        );
      }
    } else {
      for (const a of listed) {
        let status: ProxyStatus;
        try {
          status = await app.proxy.proxyStatus(p.id, a.name);
        } catch {
          status = {
            enabled: a.proxyEnabled,
            running: a.proxyRunning,
          };
        }
        const keyGate = await proxyApiKeyGate(app, p.id, a.name);
        pushAccount(p.id, a.name, a.active, status, {
          identity: a.identity,
          needsApiKey: keyGate.needsApiKey,
          attentionHint: keyGate.hint,
          ...(keyGate.needsApiKey
            ? {
                detailText: keyGate.hint,
                stateText: 'needs key',
                stateLabel: 'unavailable' as ProxyStateLabel,
              }
            : {}),
        });
      }
    }

    // Live but nothing saved — show so the user can save, then enable proxy
    if (listed.length === 0) {
      try {
        const cur = await app.accounts.current(p.id);
        if (cur.live.present) {
          pushAccount(
            p.id,
            '__unsaved__',
            false,
            { enabled: false, running: false, detail: 'not saved' },
            {
              rowKind: 'unsaved',
              displayRef: `${p.id} (not saved)`,
              identity: cur.live.identity,
              stateText: 'not saved',
              detailText: cur.live.identity
                ? `Save ${cur.live.identity} to run a proxy`
                : 'Save this login to run a proxy',
            },
          );
        }
      } catch {
        // ignore
      }
    }
  }

  out.sort((a, b) => {
    if (a.providerId !== b.providerId) {
      return a.providerId.localeCompare(b.providerId);
    }
    // pool header first, then members, then accounts, unsaved last
    const rank = (r: ProxyRow) => {
      if (r.rowKind === 'pool') {
        return 0;
      }
      if (r.rowKind === 'member') {
        return 1;
      }
      if (r.rowKind === 'unsaved') {
        return 3;
      }
      return 2;
    };
    const rc = rank(a) - rank(b);
    if (rc !== 0) {
      return rc;
    }
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Check whether a saved account can start its compatibility proxy.
 *
 * The provider decides both whether a key is required (`proxyRequiresApiKey`)
 * and whether its snapshot carries one (`proxyApiKeyStatus`), so this stays free
 * of provider-specific file knowledge.
 */
export async function proxyApiKeyGate(
  app: HotplugApp,
  providerId: string,
  accountName: string,
): Promise<{ needsApiKey: boolean; hint?: string }> {
  let provider;
  try {
    provider = app.accounts.provider(providerId);
  } catch {
    return { needsApiKey: false };
  }
  if (!provider.proxyRequiresApiKey) {
    return { needsApiKey: false };
  }
  try {
    const account = await app.accounts.get(providerId, accountName);
    if (!account) {
      return {
        needsApiKey: true,
        hint: `Save a ${provider.shortName ?? provider.name} login with an API key first`,
      };
    }
    if (!provider.proxyApiKeyStatus) {
      return { needsApiKey: false };
    }
    const status = await provider.proxyApiKeyStatus(account.snapshotDir);
    return status.present ? { needsApiKey: false } : { needsApiKey: true, hint: status.hint };
  } catch {
    return {
      needsApiKey: true,
      hint: `Could not read the API key for this ${provider.shortName ?? provider.name} login`,
    };
  }
}

// ── Gateways (runtime profiles) ──────────────────────────────────
