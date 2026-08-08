import { randomUUID } from 'node:crypto';
import type { AnyPickApp } from '../core/app';
import { providerCanRefresh } from '../core/capabilities';
import type { ListedAccount } from '../core/service';
import { loadGateways } from '../tui/model';
import { trayLogSourceId } from './protocol';
import {
  accountProviderPriority,
  humanizeSourceId,
  nativeSourceInstalled,
} from './snapshot-helpers';
import type {
  TrayAccountProviderSnapshot,
  TrayActionRegistry,
  TrayActionSnapshot,
  TrayGatewayProviderSnapshot,
  TrayGatewaySnapshot,
  TrayLogSourceSnapshot,
  TrayManagedAccountSnapshot,
  TrayProxySnapshot,
  TrayRouteSnapshot,
  TraySnapshotOptions,
} from './snapshot-types';

type ProxyRow = Awaited<ReturnType<AnyPickApp['proxy']['listProxyRows']>>[number];

export async function buildTrayProxySnapshots(
  app: AnyPickApp,
  routes: readonly TrayRouteSnapshot[],
  registry: TrayActionRegistry | undefined,
): Promise<{ proxies: TrayProxySnapshot[]; hubRunning: boolean; proxyRows: ProxyRow[] }> {
  const proxyRows = await app.proxy.listProxyRows().catch(() => []);
  const proxies = proxyRows.map((row): TrayProxySnapshot => {
    const toggleActionId =
      registry?.register({
        operation: row.status.running ? 'disable' : 'enable',
        providerId: row.provider,
        accountName: row.name,
      }) ?? randomUUID();
    const restartActionId =
      registry?.register({
        operation: 'restart',
        providerId: row.provider,
        accountName: row.name,
      }) ?? randomUUID();
    const provider = app.accountRegistry.get(row.provider);
    return {
      id: trayLogSourceId(row.provider, row.name),
      providerId: row.provider,
      label: `${provider.shortName ?? provider.name} proxy`,
      detail: row.status.running ? `Running · ${row.name}` : `Stopped · ${row.name}`,
      ...(row.status.port != null ? { address: `127.0.0.1:${row.status.port}` } : {}),
      running: row.status.running,
      enabled: row.status.enabled,
      toggleActionId,
      restartActionId,
    };
  });
  const hub = await app.hub.status().catch(() => null);
  if (hub) {
    const address = hub.endpoint ? new URL(hub.endpoint).host : undefined;
    const detail = [
      hub.running ? 'Running' : hub.enabled ? 'Stopped' : 'Disabled',
      `${hub.sourceCount} source${hub.sourceCount === 1 ? '' : 's'}`,
      `${hub.modelCount} model${hub.modelCount === 1 ? '' : 's'}`,
      ...(hub.conflictCount > 0
        ? [`${hub.conflictCount} routing choice${hub.conflictCount === 1 ? '' : 's'}`]
        : []),
    ].join(' · ');
    const toggleActionId =
      registry?.register({
        operation: hub.running ? 'hub-stop' : 'hub-start',
        name: hub.name,
      }) ?? randomUUID();
    const restartActionId =
      registry?.register({ operation: 'hub-restart', name: hub.name }) ?? randomUUID();
    const testActionId =
      registry?.register({ operation: 'hub-test', name: hub.name }) ?? randomUUID();
    proxies.unshift({
      id: trayLogSourceId('proxy-hub', hub.name),
      providerId: 'proxy-hub',
      label: 'Proxy Hub',
      detail,
      ...(address ? { address } : {}),
      running: hub.running,
      enabled: hub.enabled,
      logsAvailable: true,
      sourceCount: hub.sourceCount,
      modelCount: hub.modelCount,
      clientCount: routes.filter((route) => route.source === 'Proxy Hub').length,
      conflictCount: hub.conflictCount,
      toggleActionId,
      restartActionId,
      testActionId,
    });
  }
  return { proxies, hubRunning: Boolean(hub?.running), proxyRows };
}

export async function buildTrayGateways(app: AnyPickApp): Promise<TrayGatewaySnapshot[]> {
  return (await loadGateways(app).catch(() => [])).map(
    (gateway): TrayGatewaySnapshot => ({
      id: gateway.name,
      providerId: gateway.providerId,
      name: gateway.name,
      detail: [gateway.providerName, gateway.modelSummary].filter(Boolean).join(' · '),
      ready: gateway.hasApiKey,
      defaultModel: gateway.defaultModel,
    }),
  );
}

export async function buildTrayAccountProviders(
  app: AnyPickApp,
  opts: TraySnapshotOptions,
): Promise<TrayAccountProviderSnapshot[]> {
  return (
    await Promise.all(
      app.accountRegistry.list().flatMap((provider) => {
        const client = app.clients.list().find((candidate) => candidate.id === provider.id);
        const probes = client?.nativeInstallations ?? [];
        // Providers without a client install probe (Grok, OpenCode, …) still save
        // from live credential files. Mark them available when detectLive sees a login.
        if (probes.length === 0) {
          return [
            (async (): Promise<TrayAccountProviderSnapshot> => {
              const live = await provider.detectLive().catch(() => ({ present: false as const }));
              return {
                id: provider.id,
                providerId: provider.id,
                ...(client ? { clientId: client.id } : {}),
                label: provider.shortName ?? provider.name,
                detail: live.present
                  ? (live.identity ?? provider.description)
                  : provider.description,
                installed: live.present,
                // clearLive wipes the only live store this row represents.
                canClear: typeof provider.clearLive === 'function',
              };
            })(),
          ];
        }
        return probes.map(async (probe): Promise<TrayAccountProviderSnapshot> => {
          // Source-scoped clear only when the provider exposes it; otherwise a
          // multi-source provider (Gemini + Antigravity) would wipe the wrong store.
          const canClear = provider.detectLiveSource
            ? typeof provider.clearLiveSource === 'function'
            : typeof provider.clearLive === 'function';
          return {
            id: `${provider.id}:${probe.sourceId}`,
            providerId: provider.id,
            ...(client ? { clientId: client.id } : {}),
            ...(provider.detectLiveSource ? { sourceId: probe.sourceId } : {}),
            label: humanizeSourceId(probe.sourceId),
            detail: provider.shortName ?? provider.name,
            installed: client
              ? await (opts.isNativeSourceInstalled ?? nativeSourceInstalled)(
                  client,
                  probe.sourceId,
                )
              : false,
            canClear,
          };
        });
      }),
    )
  ).toSorted(
    (left, right) =>
      Number(right.installed) - Number(left.installed) ||
      accountProviderPriority(left) - accountProviderPriority(right) ||
      left.label.localeCompare(right.label),
  );
}

export async function buildTrayManagedAccounts(
  app: AnyPickApp,
  listedAccounts: readonly ListedAccount[],
): Promise<TrayManagedAccountSnapshot[]> {
  return Promise.all(
    listedAccounts.map(async (account): Promise<TrayManagedAccountSnapshot> => {
      const provider = app.accountRegistry.get(account.provider);
      const saved = await app.accounts.get(account.provider, account.name).catch(() => null);
      const source =
        saved && provider.accountSource
          ? await provider.accountSource(saved.snapshotDir).catch(() => null)
          : null;
      return {
        id: `${account.provider}/${account.name}`,
        providerId: account.provider,
        ...(source ? { sourceId: source.id } : {}),
        name: account.name,
        label: account.label ?? account.name,
        detail: [source?.name ?? provider.shortName ?? provider.name, account.identity]
          .filter(Boolean)
          .join(' · '),
        active: account.isLiveMatch,
        canRefresh: providerCanRefresh(provider),
      };
    }),
  );
}

export function buildProviderSwitchActions(
  app: AnyPickApp,
  listedAccounts: readonly ListedAccount[],
  managedAccounts: readonly TrayManagedAccountSnapshot[],
  registry: TrayActionRegistry | undefined,
): TrayActionSnapshot[] {
  // Providers without a client adapter (Grok, OpenCode, …) never appear in the
  // client loop above. Surface their saved logins under Other CLI so the tray
  // can switch the live credential file the same way the TUI does.
  const clientIds = new Set(app.clients.list().map((client) => client.id));
  return managedAccounts
    .filter((account) => !clientIds.has(account.providerId))
    .map((account) => {
      const provider = app.accountRegistry.get(account.providerId);
      const client = provider.shortName ?? provider.name;
      // Prefer live-match when known; otherwise fall back to the DB active pointer
      // so Grok/OpenCode still show a selected account after accounts.use.
      const listed = listedAccounts.find(
        (row) => row.provider === account.providerId && row.name === account.name,
      );
      const selected = Boolean(listed?.isLiveMatch || listed?.active);
      const id =
        registry?.register({
          operation: 'account-switch',
          providerId: account.providerId,
          accountName: account.name,
        }) ?? randomUUID();
      return {
        id,
        clientId: account.providerId,
        sourceId: account.providerId,
        client,
        label: `${client} · ${account.name}`,
        detail: account.detail,
        kind: 'native' as const,
        presentation: 'native-account' as const,
        selected,
        enabled: true,
        routeKind: 'direct-account' as const,
        upstreamProviderId: account.providerId,
        upstreamSourceLabel: account.label,
      };
    });
}

export function buildTrayLogSources(
  app: AnyPickApp,
  hubConfig: { name: string } | null,
  proxyRows: Awaited<ReturnType<AnyPickApp['proxy']['listProxyRows']>>,
): TrayLogSourceSnapshot[] {
  return [
    ...(hubConfig
      ? [
          {
            id: trayLogSourceId('proxy-hub', hubConfig.name),
            label: 'Proxy Hub',
            detail: 'Unified model router',
            providerId: 'proxy-hub',
            name: hubConfig.name,
          },
        ]
      : []),
    ...proxyRows.map((row) => {
      const provider = app.accountRegistry.get(row.provider);
      return {
        id: trayLogSourceId(row.provider, row.name),
        label: `${provider.shortName ?? provider.name} proxy`,
        detail: row.name,
        providerId: row.provider,
        name: row.name,
      };
    }),
    {
      id: trayLogSourceId('tray-supervisor', 'main'),
      label: 'Tray supervisor',
      detail: 'Tray startup and command diagnostics',
      providerId: 'tray-supervisor',
      name: 'main',
    },
  ];
}

export function buildTrayGatewayProviders(app: AnyPickApp): TrayGatewayProviderSnapshot[] {
  const gateways = app.catalog.list().map(
    (provider): TrayGatewayProviderSnapshot => ({
      id: provider.id,
      label: provider.name,
      detail: provider.description,
      kind: 'gateway',
    }),
  );

  // Account providers that accept a typed API key (currently Kiro) are offered
  // here too: the tray's only api-key field lives on this form. A selection is
  // saved as a proxy-only account, not a gateway (see snapshot-types). Driven by
  // the provider's own credentialInputs — no switch (providerId).
  const apiKeyAccounts = app.accountRegistry
    .list()
    .filter((provider) => provider.credentialInputs?.includes('api-key'))
    .map((provider): TrayGatewayProviderSnapshot => {
      const region = provider
        .credentialInputFields?.('api-key')
        .find((field) => field.name === 'region');
      return {
        id: provider.id,
        label: provider.shortName ?? provider.name,
        detail: provider.description,
        kind: 'account-api-key',
        ...(region ? { regions: [...region.choices] } : {}),
        ...(region?.default ? { regionDefault: region.default } : {}),
      };
    });

  return [...gateways, ...apiKeyAccounts];
}
