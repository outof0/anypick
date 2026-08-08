import type { AnyPickApp } from '../../core/app';
import { displayRef, serializeRef } from '../../core/refs';
import type { ProxyHubSourceRef, ProxyHubStatus } from '../../types';

export interface ProxyHubSourceRow {
  ref: ProxyHubSourceRef;
  label: string;
  detail: string;
  enabled: boolean;
  available: boolean;
}

export interface ProxyHubViewModel {
  status: ProxyHubStatus;
  sources: ProxyHubSourceRow[];
  models: string[];
  conflicts: string[];
  unavailable: string[];
}

/**
 * A lightweight Hub editor model. Provider-specific availability stays on the
 * provider contract (`createProxyHubBackend`); this layer only presents the
 * account choices, never decides which providers are supported.
 */
export async function loadProxyHubView(
  app: AnyPickApp,
  name = 'default',
): Promise<ProxyHubViewModel> {
  const [config, status, accounts, preview] = await Promise.all([
    app.hub.get(name),
    app.hub.status(name),
    app.accounts.list(),
    app.hub.preview(name).catch(() => null),
  ]);
  const configured = new Map(
    config.sources.map((source) => [serializeRef(source.ref), source.enabled]),
  );
  const sources: ProxyHubSourceRow[] = [];

  for (const account of accounts) {
    const provider = app.accountRegistry.get(account.provider);
    if (!provider.createProxyHubBackend) {
      continue;
    }
    const ref: ProxyHubSourceRef = {
      kind: 'account',
      provider: account.provider,
      name: account.name,
    };
    const key = serializeRef(ref);
    sources.push({
      ref,
      label: `${provider.shortName ?? provider.name} · ${account.label ?? account.name}`,
      detail: displayRef(ref),
      enabled: configured.get(key) === true,
      available: true,
    });
    configured.delete(key);
  }

  // Residual hub rows after a crash mid-delete (account delete normally calls
  // hub.forgetAccount). Surface them as unavailable so the user can toggle off.
  for (const [key, enabled] of configured) {
    const ref = parseHubSourceRef(key);
    if (!ref) {
      continue;
    }
    sources.push({
      ref,
      label: displayRef(ref),
      detail: 'Saved account is unavailable',
      enabled,
      available: false,
    });
  }

  return {
    status,
    sources: sources.toSorted((left, right) => left.label.localeCompare(right.label)),
    models: preview?.routes.map((route) => route.model) ?? [],
    conflicts: preview?.conflicts.map((conflict) => conflict.model) ?? [],
    unavailable:
      preview?.unavailable.map((entry) => `${displayRef(entry.source)}: ${entry.reason}`) ?? [],
  };
}

function parseHubSourceRef(value: string): ProxyHubSourceRef | undefined {
  const parts = value.split('/');
  if (parts[0] === 'account' && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: 'account', provider: parts[1], name: parts[2] };
  }
  if (parts[0] === 'account-pool' && parts.length === 2 && parts[1]) {
    return { kind: 'account-pool', provider: parts[1] };
  }
  return undefined;
}
