import type { HotplugApp } from '../../core/app';
import type { LiveAuthStatus } from '../../types';
import { providerCapabilities } from '../../core/capabilities';
import type { LiveAccountRelation, ProviderPoolRow, RootModel } from './types';
import { deriveLiveRelation, formatProxyPortLabel, relationStatusHint } from './identity';

export async function safeCurrent(
  app: HotplugApp,
  providerId: string,
): Promise<
  | {
      ok: true;
      data: Awaited<ReturnType<HotplugApp['accounts']['current']>>;
    }
  | { ok: false; error: string }
> {
  try {
    const data = await app.accounts.current(providerId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function safeList(
  app: HotplugApp,
  providerId: string,
): Promise<
  | { ok: true; data: Awaited<ReturnType<HotplugApp['accounts']['list']>> }
  | { ok: false; error: string }
> {
  try {
    const data = await app.accounts.list(providerId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function identityLabelFor(
  relation: LiveAccountRelation,
  live: LiveAuthStatus | undefined,
  activeIdentity?: string,
): string {
  if (relation === 'error') {
    return '—';
  }
  if (relation === 'empty' || relation === 'no-live') {
    return 'signed out';
  }
  if (live?.present) {
    return live.identity?.trim() || activeIdentity?.trim() || 'signed in';
  }
  return 'signed out';
}

export function liveSummary(
  relation: LiveAccountRelation,
  providerId: string,
  activeName: string | null,
  live?: LiveAuthStatus,
): string {
  switch (relation) {
    case 'match':
      return activeName ? `Uses ${providerId}/${activeName}.` : 'Live login matches a saved login.';
    case 'drift':
      return activeName
        ? `Saved login is ${providerId}/${activeName}, but the live login differs.`
        : 'Live login differs from the saved login.';
    case 'unsaved-live':
      return live?.identity
        ? `Live login (${live.identity}) is not saved yet.`
        : 'Live login is not saved yet.';
    case 'no-live':
      return 'Signed out. Switch to a saved login or sign in with the official tool.';
    case 'empty':
      return 'No saved logins yet. Sign in with the official tool, then save it.';
    case 'error':
      return "Couldn't read tool status.";
    case 'unknown':
    default:
      if (activeName) {
        return `Selected: ${providerId}/${activeName}.`;
      }
      if (live?.present) {
        return 'Signed in.';
      }
      return 'Signed out.';
  }
}

export async function loadRootModel(app: HotplugApp): Promise<RootModel> {
  const providers = app.accounts.listProviders();
  const rows: ProviderPoolRow[] = [];
  let totalAccounts = 0;
  let proxiesEnabled = 0;
  let issueCount = 0;

  for (const p of providers) {
    const caps = providerCapabilities(p);
    const cur = await safeCurrent(app, p.id);
    const listed = await safeList(app, p.id);

    if (!cur.ok || !listed.ok) {
      issueCount += 1;
      rows.push({
        providerId: p.id,
        displayName: p.name,
        activeName: null,
        identityLabel: '—',
        savedCount: listed.ok ? listed.data.length : 0,
        relation: 'error',
        statusHint: 'status unavailable',
        canRefresh: caps.canRefresh,
        canProxy: caps.canProxy,
        canClear: caps.canClear,
        error: !cur.ok ? cur.error : !listed.ok ? listed.error : undefined,
      });
      if (listed.ok) {
        totalAccounts += listed.data.length;
        proxiesEnabled += listed.data.filter((a) => a.proxyEnabled).length;
      }
      continue;
    }

    const { active, live, account, proxy } = cur.data;
    const accounts = listed.data;
    totalAccounts += accounts.length;
    proxiesEnabled += accounts.filter((a) => a.proxyEnabled).length;

    const relation = deriveLiveRelation({
      savedCount: accounts.length,
      livePresent: live.present,
      liveIdentity: live.identity,
      activeName: active,
      activeIdentity: account?.meta.identity,
      savedIdentities: accounts.map((a) => a.identity),
    });

    if (relation === 'drift' || relation === 'unsaved-live' || relation === 'error') {
      issueCount += 1;
    }
    if (proxy?.enabled && !proxy.running) {
      issueCount += 1;
    }
    if (proxy?.detail && /missing|unavailable|kirolink/i.test(proxy.detail)) {
      issueCount += 1;
    }

    const proxyLabel = caps.canProxy ? formatProxyPortLabel(proxy) : undefined;
    // Prefer status detail like "kirolink missing" when present
    let resolvedProxyLabel = proxyLabel;
    if (proxy?.detail && /kirolink|missing/i.test(proxy.detail) && !proxy.running) {
      resolvedProxyLabel = proxy.detail;
    }

    const statusHint = relationStatusHint(relation);

    rows.push({
      providerId: p.id,
      displayName: p.name,
      activeName: active,
      identityLabel: identityLabelFor(relation, live, account?.meta.identity),
      savedCount: accounts.length,
      relation,
      statusHint,
      proxyLabel: resolvedProxyLabel,
      canRefresh: caps.canRefresh,
      canProxy: caps.canProxy,
      canClear: caps.canClear,
      liveIdentity: live.identity,
      activeIdentity: account?.meta.identity,
    });
  }

  return {
    providers: rows,
    totalAccounts,
    proxiesEnabled,
    issueCount,
    loadedAt: Date.now(),
  };
}
