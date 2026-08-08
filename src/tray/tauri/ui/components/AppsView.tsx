import type { ReactNode } from 'react';
import type { TrayActionSnapshot, TrayProxySnapshot } from '../../../snapshot-types';
import type { TrayController } from '../hooks/useTrayController';
import { ProviderIcon, providerName } from '../lib/provider';
import { accountLine, modelLine, routeKind } from '../lib/routes';
import { RouteChips, SwitchMenu } from './RoutePicker';
import { EmptyState, SectionHeading, Toggle, UsageMeter } from './ui';

function AppCard({
  clientId,
  client,
  actions,
  ctrl,
}: {
  clientId: string;
  client: string;
  actions: TrayActionSnapshot[];
  ctrl: TrayController;
}) {
  const route = (ctrl.snapshot?.routes ?? []).find(
    (item) => item.clientId === clientId || item.client === client,
  );
  const selected = actions.find((action) => action.selected);
  const config = ctrl.modelConfigFor(clientId, client);
  const identity = accountLine(selected, route);
  const model = modelLine(selected, route, config);
  const key = `client:${clientId}`;
  const attention =
    route?.status === 'attention'
      ? config?.unavailableReason || 'Needs attention'
      : config?.unavailableReason;

  return (
    <article className="app-card route-card">
      <div className="route-row-main">
        <ProviderIcon value={clientId || selected?.sourceId} size="medium" />
        <div className="row-main">
          <div className="row-title">{client}</div>
          <div className="row-detail" title={identity}>
            {identity}
          </div>
          {model && !identity.includes(model) ? (
            <div className="row-model" title={model}>
              {model}
            </div>
          ) : null}
        </div>
        <div className="route-row-trailing">
          <UsageMeter client={client} usage={ctrl.snapshot?.usage} />
          <SwitchMenu
            pickerKey={key}
            actions={actions}
            configureModelsId={config?.clientId || null}
            openLabel="Open App…"
            ctrl={ctrl}
          />
        </div>
      </div>
      <RouteChips pickerKey={key} actions={actions} ctrl={ctrl} />
      {attention ? <p className="app-warning">{attention}</p> : null}
    </article>
  );
}

function RouteRow({
  rowKey,
  title,
  actions,
  sourceId,
  usageClient,
  ctrl,
}: {
  rowKey: string;
  title: string;
  actions: TrayActionSnapshot[];
  sourceId: string;
  usageClient: string;
  ctrl: TrayController;
}) {
  const selected = actions.find((action) => action.selected);
  const identity = accountLine(selected, null);
  return (
    <div className="native-row route-row native-provider-row">
      <div className="route-row-main">
        <ProviderIcon value={sourceId || selected?.sourceId} size="medium" />
        <div className="row-main">
          <div className="row-title">{title}</div>
          <div className="row-detail" title={identity}>
            {identity}
          </div>
        </div>
        <div className="route-row-trailing">
          <UsageMeter client={usageClient || title} usage={ctrl.snapshot?.usage} />
          <SwitchMenu pickerKey={rowKey} actions={actions} openLabel="Show All…" ctrl={ctrl} />
        </div>
      </div>
      <RouteChips pickerKey={rowKey} actions={actions} ctrl={ctrl} />
    </div>
  );
}

function HubRow({ hub, ctrl }: { hub: TrayProxySnapshot; ctrl: TrayController }) {
  const hubSources = ctrl.snapshot?.hubSources ?? [];
  const enabledSources = hubSources.filter((source) => source.enabled);
  const conflicts = ctrl.snapshot?.hubConflicts ?? [];
  const sourceChoiceCount = conflicts.filter((conflict) => conflict.kind === 'source-choice')
    .length;
  const overlapCount = conflicts.length - sourceChoiceCount;
  const unavailable = hubSources.filter(
    (source) => ['unavailable', 'error', 'blocked'].includes(source.status) || source.warning,
  );
  const issueCount = overlapCount + unavailable.length;
  const appsOnHub = new Set(
    (ctrl.snapshot?.actions ?? [])
      .filter((action) => action.selected && routeKind(action) === 'hub')
      .map((action) => action.clientId || action.client),
  ).size;
  const detail = `${enabledSources.length} source${enabledSources.length === 1 ? '' : 's'} · ${Number(hub.modelCount ?? 0)} model${Number(hub.modelCount ?? 0) === 1 ? '' : 's'} · ${appsOnHub} app${appsOnHub === 1 ? '' : 's'}`;

  let callout: ReactNode = null;
  if (enabledSources.length === 0) {
    callout = (
      <div className="attention-callout info">
        <div>
          <strong>Enable hub sources, then assign apps</strong>
        </div>
        <button type="button" className="primary" onClick={() => ctrl.setTab('Hub Sources')}>
          Set up
        </button>
      </div>
    );
  } else if (issueCount > 0 || sourceChoiceCount > 0) {
    const title =
      issueCount > 0
        ? `${issueCount} routing issue${issueCount === 1 ? '' : 's'} — pick a source or fix unavailable accounts`
        : `Choose ${sourceChoiceCount} hub source${sourceChoiceCount === 1 ? '' : 's'} for overlapping models`;
    callout = (
      <div className={`attention-callout ${issueCount > 0 ? 'warning' : 'info'}`}>
        <div>
          <strong>{title}</strong>
        </div>
        <button type="button" onClick={() => ctrl.setTab('Routing Issues')}>
          Fix
        </button>
      </div>
    );
  }

  const hubIndex = (ctrl.snapshot?.proxies ?? []).findIndex((proxy) => proxy.id === hub.id);
  const control =
    enabledSources.length === 0 ? (
      <button type="button" className="primary" onClick={() => ctrl.setTab('Hub Sources')}>
        Set up
      </button>
    ) : (
      <Toggle
        checked={Boolean(hub.running)}
        disabled={ctrl.busy}
        title={`${hub.running ? 'Stop' : 'Start'} Proxy Hub`}
        onChange={() =>
          ctrl.runAction({ id: hub.toggleActionId, label: hub.label, enabled: true })
        }
      />
    );

  return (
    <>
      <SectionHeading
        title="Proxy Hub"
        action={
          <button
            type="button"
            className="section-action"
            onClick={() => ctrl.setTab('Hub Sources')}
          >
            Sources…
          </button>
        }
      />
      <div className="group hub-compact-row">
        <div className="route-row-main">
          <ProviderIcon value="proxy-hub" size="medium" />
          <div className="row-main">
            <div className="row-title">Proxy Hub</div>
            <div className="row-detail">{detail}</div>
          </div>
          {control}
        </div>
        {callout}
      </div>
      {/* keep hubIndex referenced so future toggles stay index-stable */}
      <span className="hidden" data-hub-index={hubIndex} />
    </>
  );
}

export function AppsView({ ctrl }: { ctrl: TrayController }) {
  const all = (ctrl.snapshot?.actions ?? []).filter((action) => action.enabled);
  const routes = all.filter((action) => action.presentation === 'app-route');
  const nativeOnly = all.filter((action) => action.presentation === 'native-account');
  const clients = [
    ...new Map(routes.map((action) => [action.clientId || action.client, action.client])).entries(),
  ].slice(0, 8);
  const totalClients = new Set(routes.map((action) => action.clientId || action.client)).size;
  const nativeSources = [...new Set(nativeOnly.map((action) => action.sourceId))].slice(0, 4);
  const totalNative = new Set(nativeOnly.map((action) => action.sourceId)).size;
  const hub = (ctrl.snapshot?.proxies ?? []).find((proxy) => proxy.providerId === 'proxy-hub');
  const hubSection = hub ? <HubRow hub={hub} ctrl={ctrl} /> : null;

  if (!routes.length && !nativeOnly.length) {
    return (
      <>
        <EmptyState
          symbol="＋"
          title="No configured apps"
          body="Connect an installed client from Accounts."
          action={
            <button type="button" onClick={() => ctrl.setTab('Saved accounts')}>
              Add account
            </button>
          }
        />
        {hubSection}
      </>
    );
  }

  return (
    <>
      {clients.length ? (
        <>
          <SectionHeading
            title="Apps"
            action={
              <button
                type="button"
                className="section-action"
                onClick={() => ctrl.setTab('Saved accounts')}
              >
                Accounts…
              </button>
            }
          />
          <div className="app-card-list group native-group">
            {clients.map(([clientId, client]) => (
              <AppCard
                key={clientId}
                clientId={clientId}
                client={client}
                actions={routes.filter(
                  (action) => (action.clientId || action.client) === clientId,
                )}
                ctrl={ctrl}
              />
            ))}
            {totalClients > clients.length ? (
              <button
                type="button"
                className="more-link"
                onClick={() => ctrl.setTab('Saved accounts')}
              >
                {totalClients - clients.length} more…
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {hubSection}
      {nativeSources.length ? (
        <>
          <SectionHeading title="Other CLIs" />
          <div className="group native-group">
            {nativeSources.map((sourceId) => {
              const actions = nativeOnly.filter((action) => action.sourceId === sourceId);
              return (
                <RouteRow
                  key={sourceId}
                  rowKey={`native:${sourceId}`}
                  title={providerName(sourceId)}
                  actions={actions}
                  sourceId={sourceId}
                  usageClient={providerName(sourceId)}
                  ctrl={ctrl}
                />
              );
            })}
            {totalNative > nativeSources.length ? (
              <button
                type="button"
                className="more-link"
                onClick={() => ctrl.setTab('Saved accounts')}
              >
                {totalNative - nativeSources.length} more…
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
