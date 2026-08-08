import {
  defaultModelRolesForProxy,
  modelRolesForClient,
  modelRolesFromClientOptions,
  normalizeModelRoles,
} from '../../clients/model-roles';
import { serializeRef } from '../../core/refs';
import { clampIndex } from '../app-ui-helpers';
import {
  loadCompatibleSources,
  loadHealthModel,
  modelSuggestionsForRoute,
  routeNeedsModelSelection,
  routePlanLines,
} from '../model';
import { AppRoutePreviewScreen } from '../screens/app-route-preview';
import { AppRouteSourceScreen } from '../screens/app-route-source';
import { AppsHomeScreen } from '../screens/apps-home';
import { HealthScreen } from '../screens/health';
import { ProxyModelsScreen } from '../screens/proxy-models';
import { errorText } from '../use-tui-shell';
import type { Route } from './context';

export const appsRoute: Route = (ctx) => {
  const { app, columns, shell, nav, roleEditor, policyLookup, trayRuntime } = ctx;
  const {
    screen,
    go,
    quit,
    selectedIndex,
    setSelectedIndex,
    busy,
    busyLabel,
    error,
    setError,
    receipt,
    setReceipt,
    withBusy,
    reportOk,
    reportFail,
  } = shell;
  const { clientRows, reloadClients, openAccounts, openGateways, openProxy } = nav;

  const openRoute = (clientId: string, clientName: string) => {
    void withBusy('Finding compatible sources', async () => {
      try {
        const sources = await loadCompatibleSources(app, clientId);
        go({
          kind: 'app-route-source',
          clientId,
          clientName,
          sources,
          back: { kind: 'apps', focusClientId: clientId },
        });
        setSelectedIndex(0);
      } catch (err) {
        reportFail(err, 'Could not load compatible sources.');
      }
    });
  };

  if (screen.kind === 'apps') {
    const idx = clampIndex(selectedIndex, clientRows.length);
    return (
      <AppsHomeScreen
        rows={clientRows}
        selectedIndex={idx}
        columns={columns}
        receipt={receipt}
        busy={busy}
        busyLabel={busyLabel}
        onMove={(delta) => setSelectedIndex(clampIndex(idx + delta, clientRows.length))}
        onConfigure={(row) => {
          setReceipt(null);
          openRoute(row.clientId, row.clientName);
        }}
        onAccounts={() => void openAccounts()}
        onGateways={() => void openGateways()}
        onProxies={() => void openProxy()}
        onDiagnose={() => {
          void withBusy('Running diagnostics', async () => {
            try {
              const model = await loadHealthModel(app);
              go({ kind: 'health', model, back: screen });
              setSelectedIndex(0);
            } catch (err) {
              reportFail(err, 'Diagnostics failed.');
            }
          });
        }}
        onHelp={() => go({ kind: 'help', context: 'apps', back: screen })}
        onTray={() => {
          void trayRuntime.open(screen).catch((err: unknown) => {
            reportFail(err, 'Could not open Tray runtime controls.');
          });
        }}
        onDetach={() => {
          void trayRuntime.detach().catch((err: unknown) => {
            reportFail(err, 'Could not detach AnyPick to the Tray.');
          });
        }}
        onQuit={() => quit(0)}
      />
    );
  }

  if (screen.kind === 'app-route-source') {
    const idx = clampIndex(selectedIndex, screen.sources.length);
    return (
      <AppRouteSourceScreen
        clientName={screen.clientName}
        rows={screen.sources}
        selectedIndex={idx}
        columns={columns}
        busy={busy}
        error={error}
        onMove={(delta) => setSelectedIndex(clampIndex(idx + delta, screen.sources.length))}
        onSelect={(source) => {
          if (!routeNeedsModelSelection(source)) {
            void withBusy('Planning native account switch', async () => {
              try {
                const result = await app.bindingService.use(screen.clientId, {
                  with: source.value,
                  dryRun: true,
                  verbose: true,
                });
                go({
                  kind: 'app-route-preview',
                  clientId: screen.clientId,
                  clientName: screen.clientName,
                  source,
                  modelRoles: {},
                  plan: result.plan,
                  lines: routePlanLines(result.plan, {}, { nativeAccount: true }),
                  back: screen,
                });
              } catch (err) {
                setError(errorText(err));
              }
            });
            return;
          }
          void withBusy('Loading models', async () => {
            try {
              const discovered = await modelSuggestionsForRoute(app, source);
              const clientAdapter = app.clients.has(screen.clientId)
                ? app.clients.get(screen.clientId)
                : screen.clientId;
              const defaults = defaultModelRolesForProxy(
                source.providerId,
                clientAdapter,
                policyLookup,
              );
              const current = app.bindings.getGlobal(screen.clientId);
              const sameSource =
                current && serializeRef(current.spec.source) === serializeRef(source.ref);
              const stored = sameSource
                ? modelRolesFromClientOptions(current.spec.clientOptions)
                : undefined;
              const explicit =
                sameSource && current.spec.model.mode === 'explicit'
                  ? current.spec.model.id
                  : discovered.defaultModel;
              const values = normalizeModelRoles(
                { ...(explicit ? { default: explicit } : {}), ...stored },
                defaults,
              );
              go({
                kind: 'app-route-model',
                clientId: screen.clientId,
                clientName: screen.clientName,
                source,
                roles: [...modelRolesForClient(clientAdapter)],
                values,
                suggestions: discovered.suggestions,
                suggestionsSource: discovered.source,
                back: screen,
              });
              setSelectedIndex(0);
              roleEditor.reset();
            } catch (err) {
              setError(errorText(err));
            }
          });
        }}
        onAccounts={() => void openAccounts()}
        onGateways={() => void openGateways()}
        onBack={() => go(screen.back)}
      />
    );
  }

  if (screen.kind === 'app-route-model') {
    const idx = clampIndex(selectedIndex, screen.roles.length);
    return (
      <ProxyModelsScreen
        proxyRef={screen.source.label}
        clientName={screen.clientName}
        roles={screen.roles}
        values={screen.values}
        suggestions={screen.suggestions}
        suggestionsSource={screen.suggestionsSource}
        selectedIndex={idx}
        editingRoleId={roleEditor.editingRoleId}
        editDraft={roleEditor.editDraft}
        editCursor={roleEditor.editCursor}
        suggestionIndex={roleEditor.suggestionIndex}
        columns={columns}
        busy={busy}
        error={error}
        path={['apps', screen.clientName, 'models']}
        confirmLabel="preview route"
        supportHint="enter edit model · a preview route"
        onMove={(delta) => setSelectedIndex(clampIndex(idx + delta, screen.roles.length))}
        {...roleEditor.handlers({
          roles: screen.roles,
          values: screen.values,
          onCommit: (values) => go({ ...screen, values }),
          onSelectRow: setSelectedIndex,
        })}
        onConfirm={() => {
          roleEditor.reset();
          setError(undefined);
          void withBusy('Planning route', async () => {
            try {
              const modelRoles = normalizeModelRoles(screen.values, screen.values);
              const result = await app.bindingService.use(screen.clientId, {
                with: screen.source.value,
                model: modelRoles.default || undefined,
                modelRoles,
                dryRun: true,
                verbose: true,
              });
              go({
                kind: 'app-route-preview',
                clientId: screen.clientId,
                clientName: screen.clientName,
                source: screen.source,
                modelRoles,
                plan: result.plan,
                lines: routePlanLines(result.plan, modelRoles),
                back: screen,
              });
            } catch (err) {
              setError(errorText(err));
            }
          });
        }}
        onCancel={() => {
          roleEditor.reset();
          go(screen.back);
        }}
      />
    );
  }

  if (screen.kind === 'app-route-preview') {
    return (
      <AppRoutePreviewScreen
        clientName={screen.clientName}
        native={screen.source.category === 'native'}
        sourceLabel={screen.source.label}
        lines={screen.lines}
        warnings={screen.plan.warnings.map((warning) => warning.message)}
        columns={columns}
        busy={busy}
        busyLabel={busyLabel}
        error={error}
        onBack={() => go(screen.back)}
        onConfirm={() => {
          setError(undefined);
          void withBusy('Activating route', async () => {
            try {
              const modelRoles = Object.keys(screen.modelRoles).length
                ? screen.modelRoles
                : undefined;
              const result = await app.bindingService.use(screen.clientId, {
                with: screen.source.value,
                model: modelRoles?.default || undefined,
                modelRoles,
              });
              await reloadClients(screen.clientId);
              go({ kind: 'apps', focusClientId: screen.clientId });
              reportOk(
                result.alreadyActive
                  ? `${screen.clientName} already uses ${screen.source.label}`
                  : `${screen.clientName} now uses ${screen.source.label}`,
              );
            } catch (err) {
              setError(errorText(err));
            }
          });
        }}
      />
    );
  }

  if (screen.kind === 'health') {
    const idx = clampIndex(selectedIndex, screen.model.prioritized.length);
    return (
      <HealthScreen
        model={screen.model}
        selectedIndex={idx}
        busy={busy}
        error={error}
        message={screen.message}
        onMove={(delta) =>
          setSelectedIndex(clampIndex(idx + delta, screen.model.prioritized.length))
        }
        onBack={() => go(screen.back)}
        onApplyFixes={() => {
          if (!screen.model.plan) {
            return;
          }
          void withBusy('Applying safe fixes', async () => {
            try {
              const result = await app.doctor.applyFixes(screen.model.plan!, { yes: true });
              const model = await loadHealthModel(app);
              go({
                ...screen,
                model,
                message: `${result.applied.filter((item) => item.ok).length} safe fix(es) applied.`,
              });
              setSelectedIndex(0);
            } catch (err) {
              setError(errorText(err));
            }
          });
        }}
      />
    );
  }

  return null;
};
