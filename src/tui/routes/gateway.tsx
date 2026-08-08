import { CLAUDE_MODEL_ROLES } from '../../clients/model-roles';
import { GatewaysHomeScreen } from '../screens/gateways-home';
import { GatewayPickProviderScreen } from '../screens/gateway-pick-provider';
import { GatewayConnectionFormScreen } from '../screens/gateway-connection-form';
import { ManageAppsScreen } from '../screens/manage-apps';
import { ProxyModelsScreen } from '../screens/proxy-models';
import { clampIndex, modelSummariesForApps, toggleChecked } from '../app-ui-helpers';
import { filterGatewaysByProvider, gatewayProviderFilterOptions } from '../model';
import type { Route } from './context';

export const gatewayRoute: Route = (ctx) => {
  const {
    app,
    columns,
    shell,
    nav,
    bindings,
    gateways,
    roleEditor,
    gatewayProviderFilter,
    trayRuntime,
  } = ctx;
  const { screen, go, quit, selectedIndex, setSelectedIndex, busy, busyLabel, error, receipt } =
    shell;
  const { setReceipt } = shell;
  const { gatewayRows, catalogPicks, openApps, openGateways, openProxy } = nav;
  const { openModelReedit } = bindings;
  const { editingRoleId, editDraft, editCursor, suggestionIndex } = roleEditor;

  if (screen.kind === 'gateway-pick-provider') {
    const idx = clampIndex(selectedIndex, catalogPicks.length);
    return (
      <GatewayPickProviderScreen
        rows={catalogPicks}
        selectedIndex={idx}
        columns={columns}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, catalogPicks.length))}
        onSelect={(row) => {
          go({
            kind: 'text-input',
            purpose: 'gateway-name',
            label: 'Gateway name',
            initial: `${row.id}-work`,
            hint: `Provider ${row.name}`,
            gatewayDraft: {
              providerId: row.id,
              providerName: row.name,
              defaultEndpoint: row.defaultEndpoint,
            },
            back: { kind: 'gateway-pick-provider' },
          });
        }}
        onCancel={() => {
          void openGateways();
        }}
      />
    );
  }

  if (screen.kind === 'gateway-connection') {
    return (
      <GatewayConnectionFormScreen
        providerName={screen.providerName}
        gatewayName={screen.name}
        initialEndpoint={screen.endpoint}
        initialApiKey={screen.apiKey}
        error={error}
        onCancel={() => go(screen.back)}
        onSubmit={(form) => gateways.submitGatewayConnection(screen, form)}
      />
    );
  }

  if (screen.kind === 'gateway-models') {
    const roles = CLAUDE_MODEL_ROLES;
    const idx = clampIndex(selectedIndex, roles.length);
    return (
      <ProxyModelsScreen
        path={['gateways', screen.name, 'models']}
        proxyRef={screen.name}
        clientName="Gateway"
        roles={roles}
        values={screen.values}
        suggestions={screen.suggestions}
        suggestionsSource={screen.suggestionsSource}
        selectedIndex={idx}
        editingRoleId={editingRoleId}
        editDraft={editDraft}
        editCursor={editCursor}
        suggestionIndex={suggestionIndex}
        columns={columns}
        busy={busy}
        confirmLabel={gateways.hasPendingGatewayCreate ? 'create gateway' : 'save models'}
        supportHint="Claude role models stored on this gateway (default / sonnet / opus / haiku)."
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, roles.length))}
        {...roleEditor.handlers({
          roles,
          values: screen.values,
          onCommit: (values) => go({ ...screen, values }),
          onSelectRow: setSelectedIndex,
        })}
        onConfirm={() => gateways.commitGatewayModels(screen)}
        onReload={() => {
          void gateways.refreshGatewayModelSuggestions(screen.name, true);
        }}
        onCancel={() => gateways.cancelGatewayModels(screen)}
      />
    );
  }

  if (screen.kind === 'gateway-apps') {
    const list = screen.apps;
    const idx = clampIndex(selectedIndex, list.length);
    const checked = new Set(screen.checked);
    const summaries = modelSummariesForApps(app, screen.name, list);
    return (
      <ManageAppsScreen
        proxyRef={screen.name}
        path={['gateways', screen.name, 'apps']}
        apps={list}
        checked={checked}
        selectedIndex={idx}
        busy={busy}
        modelSummaries={summaries}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, list.length))}
        onToggle={(clientId) => go({ ...screen, checked: toggleChecked(screen.checked, clientId) })}
        onConfirm={() => {
          void gateways.applyGatewayAppChanges(screen.name, list, checked);
        }}
        onEditModels={(clientId) => {
          openModelReedit({
            providerId: 'gateway',
            name: screen.name,
            source: screen.name,
            apps: list,
            clientId,
          });
        }}
        onCancel={() => {
          void openGateways(screen.name);
        }}
      />
    );
  }

  if (screen.kind === 'gateways') {
    const providerOptions = gatewayProviderFilterOptions(gatewayRows);
    const filteredRows = filterGatewaysByProvider(gatewayRows, gatewayProviderFilter.selectedId);
    const idx = clampIndex(selectedIndex, filteredRows.length);
    return (
      <GatewaysHomeScreen
        rows={filteredRows}
        selectedIndex={idx}
        columns={columns}
        receipt={receipt}
        busy={busy}
        busyLabel={busyLabel}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, filteredRows.length))}
        providerFilterId={gatewayProviderFilter.selectedId}
        providerFilterLabel={gatewayProviderFilter.label(providerOptions)}
        providerFilterOptions={providerOptions}
        onCycleProvider={() => gatewayProviderFilter.cycle(providerOptions)}
        onClearProvider={gatewayProviderFilter.clear}
        onAdd={() => {
          setReceipt(null);
          gateways.startGatewayCreate();
        }}
        onUseApps={(row) => {
          setReceipt(null);
          void gateways.openGatewayApps(row.name);
        }}
        onEditModels={(row) => {
          setReceipt(null);
          void gateways.openGatewayModels(row.name);
        }}
        onEditEndpoint={gateways.startEditEndpoint}
        onDelete={gateways.confirmDeleteGateway}
        onSwitch={() => {
          setReceipt(null);
          void openApps();
        }}
        onNextSection={() => {
          setReceipt(null);
          void openProxy();
        }}
        onHelp={() => {
          go({ kind: 'help', context: 'gateways', back: { kind: 'gateways' } });
        }}
        onTray={() => {
          void trayRuntime.open(screen).catch((err: unknown) => {
            shell.reportFail(err, 'Could not open Tray runtime controls.');
          });
        }}
        onDetach={() => {
          void trayRuntime.detach().catch((err: unknown) => {
            shell.reportFail(err, 'Could not detach AnyPick to the Tray.');
          });
        }}
        onQuit={() => quit(0)}
      />
    );
  }

  return null;
};
