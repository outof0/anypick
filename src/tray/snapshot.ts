import type { AnyPickApp } from '../core/app';
import { buildTrayClientSnapshots } from './snapshot-client-routes';
import { accountProviderPriority } from './snapshot-helpers';
import { buildHubConflictGroups, buildTrayHubSources } from './snapshot-hub';
import {
  buildProviderSwitchActions,
  buildTrayAccountProviders,
  buildTrayGateways,
  buildTrayGatewayProviders,
  buildTrayLogSources,
  buildTrayManagedAccounts,
  buildTrayProxySnapshots,
} from './snapshot-resources';
import type { TrayActionRegistry, TraySnapshot, TraySnapshotOptions } from './snapshot-types';

export { accountProviderPriority };

/** Glanceable tray state. Only loopback proxy addresses cross; credentials, remote endpoints, and proxy tokens never do. */
export async function buildTraySnapshot(
  app: AnyPickApp,
  proxyCount: number,
  registry?: TrayActionRegistry,
  opts: TraySnapshotOptions = {},
): Promise<TraySnapshot> {
  // A native login can be live before AnyPick has a global binding. Keep the
  // account checkmark and route label truthful in that state too; the binding
  // is only the persistent selection, not proof of what is on disk right now.
  const listedAccounts = await app.accounts.list().catch(() => []);
  const hubConfig = await app.hub.get().catch(() => null);
  // Route metadata, source health, and conflicts must describe one versioned
  // catalog view. Executable refs remain behind opaque supervisor action ids.
  const hubPreview = hubConfig ? await app.hub.preview(hubConfig.name).catch(() => null) : null;

  const clients = await buildTrayClientSnapshots(app, listedAccounts, hubPreview, registry, opts);
  const routes = clients.map((client) => client.route);
  const { proxies, hubRunning, proxyRows } = await buildTrayProxySnapshots(app, routes, registry);
  const gateways = await buildTrayGateways(app);
  const accountProviders = await buildTrayAccountProviders(app, opts);
  const managedAccounts = await buildTrayManagedAccounts(app, listedAccounts);
  const providerSwitchActions = buildProviderSwitchActions(
    app,
    listedAccounts,
    managedAccounts,
    registry,
  );
  const hubSources = buildTrayHubSources(app, managedAccounts, hubConfig, hubPreview);
  const hubConflicts = buildHubConflictGroups(app, listedAccounts, hubPreview, registry);
  const logSources = buildTrayLogSources(app, hubConfig, proxyRows);

  return {
    proxyCount: proxyCount + Number(hubRunning),
    revision: registry?.revision ?? 0,
    routes,
    // A tray menu is a control surface, not a capability report. Entries that
    // still need model selection belong in the full AnyPick picker and should
    // not arrive at macOS as greyed-out menu rows.
    actions: [...clients.flatMap((client) => client.actions), ...providerSwitchActions].filter(
      (action) => action.enabled,
    ),
    clientModelConfigs: clients.flatMap((client) =>
      client.modelConfig ? [client.modelConfig] : [],
    ),
    usage: opts.usage ?? [],
    proxies,
    accounts: managedAccounts,
    hubSources,
    hubConflicts,
    logSources,
    gateways,
    accountProviders,
    gatewayProviders: buildTrayGatewayProviders(app),
    settings: opts.settings ?? {
      launchAtLogin: false,
      startEnabledProxies: true,
      showQuota: true,
      quotaGuardEnabled: false,
    },
    activity: opts.activity ?? [],
  };
}
