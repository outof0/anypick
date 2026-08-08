import {
  appsUsingProxy,
  proxyBindingRef,
  proxyOutcome,
  proxyRowLabel,
  type AppBindingRow,
  type ProxyRow,
} from '../model';
import { G, type StatusKind } from '../components/chrome';

export function proxyStatusKind(row: ProxyRow): StatusKind {
  if (row.needsApiKey) {
    return 'attention';
  }
  if (row.rowKind === 'unsaved') {
    return 'attention';
  }
  if (row.rowKind === 'member') {
    return row.memberEnabled ? 'using' : 'off';
  }
  if (row.stateLabel === 'unavailable') {
    return 'unavailable';
  }
  if (row.status.running) {
    return 'running';
  }
  if (row.status.enabled) {
    return 'stopped';
  }
  return 'off';
}

export function usedByLabel(row: ProxyRow, apps: AppBindingRow[]): string {
  if (row.rowKind === 'member') {
    return row.memberEnabled ? 'in pool' : 'paused';
  }
  if (row.rowKind === 'unsaved') {
    return row.identity ?? 'save to use';
  }
  const ref = proxyBindingRef(row);
  const using = appsUsingProxy(apps, ref);
  // Also match account form when apps bound to account while viewing pool
  if (row.rowKind === 'pool') {
    const providerApps = apps.filter(
      (a) =>
        a.bound && (a.sourceDisplay === ref || a.sourceDisplay?.startsWith(`${row.providerId}/`)),
    );
    if (providerApps.length) {
      return providerApps.map((a) => a.clientName).join(', ');
    }
  }
  return using.length ? using.join(', ') : G.dash;
}

export function boardOutcome(
  selected: ProxyRow | undefined,
  usedBy: string | null,
): { outcome: string; support: string } {
  if (!selected) {
    return {
      outcome: 'No saved logins can run a proxy yet',
      support: 'Add a Grok, OpenCode, Gemini, or Kiro login in Accounts.',
    };
  }
  if (selected.needsApiKey) {
    return {
      outcome: `${proxyRowLabel(selected)} needs an API key`,
      support:
        selected.attentionHint ??
        'Put GEMINI_API_KEY in ~/.gemini/.env, save this login again, then turn the proxy on.',
    };
  }
  if (selected.rowKind === 'unsaved') {
    return {
      outcome: `Save ${selected.identity ?? 'this login'} to run a ${selected.providerName} proxy`,
      support: 'enter save this login',
    };
  }
  if (selected.rowKind === 'hub') {
    if (selected.status.running) {
      return {
        outcome: 'Proxy Hub is routing selected models',
        support: 'enter configure sources and review model routes',
      };
    }
    return {
      outcome: selected.status.enabled ? 'Start Proxy Hub' : 'Configure Proxy Hub',
      support: 'enter choose sources and start one local endpoint',
    };
  }
  if (selected.rowKind === 'member') {
    return {
      outcome: selected.memberEnabled
        ? `Pause ${selected.providerId}/${selected.name} in the pool`
        : `Enable ${selected.providerId}/${selected.name} in the pool`,
      support: 'space toggle   p pool settings',
    };
  }
  if (selected.rowKind === 'pool') {
    const ref = `pool:${selected.providerId}`;
    if (selected.status.running) {
      return {
        outcome: usedBy ? `Manage apps using ${ref}` : `${ref} is running`,
        support: usedBy
          ? `${usedBy} · enter/m manage apps   p single-account mode`
          : 'enter/m pick apps   p single-account mode',
      };
    }
    return {
      outcome: selected.status.enabled
        ? `Start ${ref}`
        : `Turn on multi pool for ${selected.providerName}`,
      support: selected.detailText ?? 'p toggles multi-account pool',
    };
  }
  return proxyOutcome(selected, usedBy);
}
