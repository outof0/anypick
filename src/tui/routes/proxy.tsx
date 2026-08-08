import { ProxyLogsView } from '../components';
import { ProxyBoardScreen } from '../screens/proxy-board';
import { ManageAppsScreen } from '../screens/manage-apps';
import { ProxyModelsScreen } from '../screens/proxy-models';
import { ProxyHubScreen } from '../screens/proxy-hub';
import { suggestAccountSlug } from '../model';
import { clampIndex, modelSummariesForApps, toggleChecked } from '../app-ui-helpers';
import type { Route } from './context';

export const proxyRoute: Route = (ctx) => {
  const { app, columns, shell, nav, bindings, proxies, roleEditor, trayRuntime } = ctx;
  const { screen, go, quit, selectedIndex, setSelectedIndex, busy, busyLabel, error, receipt } =
    shell;
  const { setReceipt } = shell;
  const { proxyRows, apps, openApps, openProxy, openAccounts } = nav;
  const { bindingWith, resolveProxyRow, openAppChangesConfirm, openModelReedit } = bindings;
  const { editingRoleId, editDraft, editCursor, suggestionIndex } = roleEditor;

  if (screen.kind === 'proxy-logs') {
    return (
      <ProxyLogsView
        app={app}
        providerId={screen.providerId}
        name={screen.name}
        text={screen.text}
        running={screen.running}
        onBack={() => {
          void openProxy(`${screen.providerId}/${screen.name}`);
        }}
        readLogs={() => app.proxy.proxyLogs(screen.providerId, screen.name, 80)}
      />
    );
  }

  if (screen.kind === 'proxy-hub') {
    const idx = clampIndex(selectedIndex, screen.view.sources.length);
    return (
      <ProxyHubScreen
        view={screen.view}
        selectedIndex={idx}
        columns={columns}
        busy={busy}
        busyLabel={busyLabel}
        error={error}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, screen.view.sources.length))}
        onToggle={(index) => {
          const source = screen.view.sources[index];
          if (source) {
            void proxies.doToggleHubSource(source);
          }
        }}
        onStart={() => void proxies.doStartHub()}
        onStop={() => void proxies.doStopHub()}
        onRefresh={() => void proxies.doRefreshHub()}
        onAccounts={() => void openAccounts()}
        onBack={() => {
          void openProxy('hub:default');
        }}
        onHelp={() =>
          go({ kind: 'help', context: 'proxy', back: { kind: 'proxy-hub', view: screen.view } })
        }
        onQuit={() => quit(0)}
      />
    );
  }

  if (screen.kind === 'proxy-models') {
    const roles = screen.roles;
    const idx = clampIndex(selectedIndex, roles.length);
    return (
      <ProxyModelsScreen
        proxyRef={bindingWith(screen.providerId, screen.name)}
        clientName={screen.clientName}
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
        confirmLabel="apply models"
        supportHint="enter edit role · a apply to the app"
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, roles.length))}
        {...roleEditor.handlers({
          roles,
          values: screen.values,
          onCommit: (values) => go({ ...screen, values }),
          onSelectRow: setSelectedIndex,
        })}
        onConfirm={() => bindings.commitProxyModels(screen)}
        onReload={() => {
          bindings.refreshProxyModelSuggestions(screen.providerId, screen.name, true);
        }}
        onCancel={() => bindings.cancelProxyModels(screen)}
      />
    );
  }

  if (screen.kind === 'manage-apps') {
    const list = screen.apps;
    const idx = clampIndex(selectedIndex, list.length);
    const checked = new Set(screen.checked);
    const withSource = bindingWith(screen.providerId, screen.name);
    const summaries = modelSummariesForApps(app, withSource, list);
    return (
      <ManageAppsScreen
        proxyRef={withSource}
        apps={list}
        checked={checked}
        selectedIndex={idx}
        busy={busy}
        modelSummaries={summaries}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, list.length))}
        onToggle={(clientId) => go({ ...screen, checked: toggleChecked(screen.checked, clientId) })}
        onConfirm={() => {
          openAppChangesConfirm(resolveProxyRow(screen.providerId, screen.name), list, checked);
        }}
        onEditModels={(clientId) => {
          openModelReedit({
            providerId: screen.providerId,
            name: screen.name,
            source: withSource,
            apps: list,
            clientId,
          });
        }}
        onCancel={() => {
          void openProxy(withSource);
        }}
      />
    );
  }

  if (screen.kind === 'proxy') {
    const idx = clampIndex(selectedIndex, proxyRows.length);
    return (
      <ProxyBoardScreen
        rows={proxyRows}
        selectedIndex={idx}
        apps={apps}
        columns={columns}
        receipt={receipt}
        busy={busy}
        busyLabel={busyLabel}
        error={error}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, proxyRows.length))}
        onPrimary={(row) => {
          setReceipt(null);
          void proxies.doProxyPrimary(row);
        }}
        onRestart={(row) => {
          setReceipt(null);
          void proxies.doProxyRestart(row);
        }}
        onStop={(row) => {
          setReceipt(null);
          void proxies.doProxyStop(row);
        }}
        onEnableStart={(row) => {
          setReceipt(null);
          void proxies.doProxyEnableStart(row);
        }}
        onDisable={(row) => {
          setReceipt(null);
          void proxies.doProxyDisable(row);
        }}
        onLogs={(row) => {
          setReceipt(null);
          void proxies.doProxyLogs(row);
        }}
        onManageApps={(row) => {
          setReceipt(null);
          void proxies.doManageApps(row);
        }}
        onTogglePoolMulti={(row) => {
          setReceipt(null);
          void proxies.doTogglePoolMulti(row);
        }}
        onToggleMember={(row) => {
          setReceipt(null);
          void proxies.doTogglePoolMember(row);
        }}
        onToggleQuotaGuard={(row) => {
          setReceipt(null);
          void proxies.doToggleQuotaGuard(row);
        }}
        onHub={() => {
          setReceipt(null);
          void proxies.openHub();
        }}
        onSaveUnsaved={(row) => {
          setReceipt(null);
          const slug = suggestAccountSlug(row.identity);
          go({
            kind: 'text-input',
            purpose: 'save-name',
            providerId: row.providerId,
            label: 'Name',
            initial: slug,
            hint: row.identity
              ? `Save ${row.identity} so you can run a proxy.`
              : 'Save this login so you can run a proxy.',
            preview: `Saved as ${row.providerId}/${slug}`,
            back: { kind: 'proxy' },
          });
        }}
        onSwitch={() => {
          setReceipt(null);
          void openApps();
        }}
        onAccounts={() => {
          setReceipt(null);
          void openAccounts();
        }}
        onHelp={() => {
          go({ kind: 'help', context: 'proxy', back: { kind: 'proxy' } });
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
