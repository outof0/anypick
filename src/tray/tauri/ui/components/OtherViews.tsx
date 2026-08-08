import type { ReactNode } from 'react';
import type {
  TrayClientModelConfigSnapshot,
  TrayClientModelOptionSnapshot,
  TrayHubConflictSnapshot,
  TrayHubSourceSnapshot,
} from '../../../snapshot-types';
import type { TrayPreferences } from '../../../settings';
import type { TrayController } from '../hooks/useTrayController';
import { ProviderIcon, providerName } from '../lib/provider';
import {
  activityIcon,
  modelOption,
  orderedModelRoles,
} from '../lib/routes';
import type { OverflowItem } from '../lib/types';
import {
  EmptyState,
  InlineEmpty,
  OverflowMenu,
  SectionHeading,
  Toggle,
} from './ui';

export function HubSourcesView({ ctrl }: { ctrl: TrayController }) {
  const sources = ctrl.snapshot?.hubSources ?? [];
  const query = ctrl.hubAccountQuery.trim().toLocaleLowerCase();
  const visible = sources.filter(
    (source) =>
      (ctrl.hubAccountFilter === 'all' || source.enabled) &&
      (!query ||
        [source.label, source.detail, source.providerId, source.name].some((value) =>
          String(value || '')
            .toLocaleLowerCase()
            .includes(query),
        )),
  );
  const grouped = new Map<string, TrayHubSourceSnapshot[]>();
  for (const source of visible) {
    const group = grouped.get(source.providerId) ?? [];
    group.push(source);
    grouped.set(source.providerId, group);
  }

  return (
    <>
      <div className="hub-manager-toolbar">
        <label className="native-search">
          <span>⌕</span>
          <input
            value={ctrl.hubAccountQuery}
            placeholder="Search hub sources"
            onChange={(event) => ctrl.setHubAccountQuery(event.target.value)}
          />
        </label>
        <div className="segmented-filter">
          <button
            type="button"
            data-hub-filter="all"
            className={ctrl.hubAccountFilter === 'all' ? 'active' : ''}
            onClick={() => ctrl.setHubAccountFilter('all')}
          >
            All {sources.length}
          </button>
          <button
            type="button"
            data-hub-filter="enabled"
            className={ctrl.hubAccountFilter === 'enabled' ? 'active' : ''}
            onClick={() => ctrl.setHubAccountFilter('enabled')}
          >
            Enabled {sources.filter((source) => source.enabled).length}
          </button>
        </div>
      </div>
      {visible.length ? (
        [...grouped.entries()]
          .sort(([left], [right]) => providerName(left).localeCompare(providerName(right)))
          .map(([providerId, items]) => (
            <section className="hub-provider-group" key={providerId}>
              <div className="hub-provider-heading">
                <ProviderIcon value={providerId} size="small" />
                <strong>{providerName(providerId)}</strong>
                <span>{items.length}</span>
              </div>
              <div className="group native-group">
                {items
                  .slice()
                  .sort((left, right) => left.label.localeCompare(right.label))
                  .map((source) => {
                    const sourceIndex = sources.findIndex((candidate) => candidate.id === source.id);
                    const unhealthy = source.status === 'unavailable';
                    const status = unhealthy ? 'Unavailable' : source.enabled ? 'Enabled' : 'Off';
                    return (
                      <div className="hub-manager-row" key={source.id}>
                        <ProviderIcon value={source.providerId} size="medium" />
                        <div className="row-main">
                          <div className="row-title">
                            {source.label}
                            <span className={`badge${unhealthy ? ' warn' : ''}`}>{status}</span>
                          </div>
                          <div className="row-detail">{source.detail}</div>
                          {source.warning ? (
                            <div className="source-warning">{source.warning}</div>
                          ) : null}
                        </div>
                        {source.modelCount != null ? (
                          <span className="model-count">
                            {Number(source.modelCount)}
                            <small>models</small>
                          </span>
                        ) : null}
                        <Toggle
                          checked={source.enabled}
                          disabled={ctrl.busy}
                          onChange={(enabled) => {
                            // optimistic local update via mutate only
                            const snap = ctrl.snapshot;
                            if (!snap) return;
                            const target = snap.hubSources[sourceIndex];
                            if (!target) return;
                            ctrl.mutate(
                              'hub-source-toggle',
                              {
                                providerId: target.providerId,
                                name: target.name,
                                enabled,
                              },
                              `updating ${target.label}`,
                            );
                          }}
                        />
                      </div>
                    );
                  })}
              </div>
            </section>
          ))
      ) : (
        <EmptyState
          compact
          symbol="⌕"
          title="No matching hub sources"
          body="Clear the search or show all sources."
        />
      )}
    </>
  );
}

function ConflictCandidate({
  candidate,
  sourceChoice,
  busy,
  onPick,
}: {
  candidate: { actionId: string; label: string; detail: string; providerId: string };
  sourceChoice: boolean;
  busy: boolean;
  onPick: (actionId: string, label: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={!candidate.actionId || busy}
      onClick={() =>
        onPick(candidate.actionId, `${sourceChoice ? 'Use' : 'Route'} ${candidate.label}`)
      }
    >
      <ProviderIcon value={candidate.providerId} size="small" />
      <span>
        <strong>{candidate.label}</strong>
        <small>{candidate.detail}</small>
      </span>
      <b>{sourceChoice ? 'Use account' : 'Use provider'}</b>
    </button>
  );
}

function RoutingCandidatePicker({
  conflict,
  sourceChoice,
  ctrl,
}: {
  conflict: TrayHubConflictSnapshot;
  sourceChoice: boolean;
  ctrl: TrayController;
}) {
  if (ctrl.routingCandidateConflictId !== conflict.id) return null;
  const query = ctrl.routingCandidateQuery.trim().toLocaleLowerCase();
  const candidates = (conflict.candidates ?? []).filter((candidate) =>
    [candidate.label, candidate.detail, candidate.providerId].some((value) =>
      String(value || '')
        .toLocaleLowerCase()
        .includes(query),
    ),
  );
  const shown = candidates.slice(0, 20);
  const close = () => {
    ctrl.setRoutingCandidateConflictId(null);
    ctrl.setRoutingCandidateQuery('');
  };
  return (
    <>
      <div className="route-picker-scrim" onClick={close} />
      <div
        className="route-popover routing-candidate-picker"
        role="dialog"
        aria-label="Choose routing source"
      >
        <div className="route-picker-head">
          <div>
            <strong>{sourceChoice ? 'Choose a hub source' : 'Choose a model provider'}</strong>
            <small>{conflict.candidates?.length ?? 0} available</small>
          </div>
          <button type="button" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        <label className="popover-search">
          <span>⌕</span>
          <input
            autoFocus
            value={ctrl.routingCandidateQuery}
            placeholder="Search sources"
            onChange={(event) => ctrl.setRoutingCandidateQuery(event.target.value)}
          />
        </label>
        <div className="picker-results candidate-list">
          {shown.length ? (
            shown.map((candidate) => (
              <ConflictCandidate
                key={candidate.actionId + candidate.label}
                candidate={candidate}
                sourceChoice={sourceChoice}
                busy={ctrl.busy}
                onPick={(actionId, label) => {
                  close();
                  ctrl.runOpaqueAction(actionId, label);
                }}
              />
            ))
          ) : (
            <div className="picker-empty">
              <strong>No matching account</strong>
              <span>Try another name or provider.</span>
            </div>
          )}
          {candidates.length > 20 ? (
            <p className="picker-refine">20 results shown. Type more to narrow the list.</p>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function RoutingIssuesView({ ctrl }: { ctrl: TrayController }) {
  const conflicts = ctrl.snapshot?.hubConflicts ?? [];
  const unavailable = (ctrl.snapshot?.hubSources ?? []).filter(
    (source) => ['unavailable', 'error', 'blocked'].includes(source.status) || source.warning,
  );

  if (!conflicts.length && !unavailable.length) {
    return (
      <EmptyState
        success
        symbol="✓"
        title="No routing issues"
        body="Every model has one clear account owner."
        action={
          <button type="button" onClick={() => ctrl.goBack()}>
            Back to Apps
          </button>
        }
      />
    );
  }

  return (
    <>
      {conflicts.length ? (
        <>
          <SectionHeading
            title="Routing decisions"
            detail={`${conflicts.length} group${conflicts.length === 1 ? '' : 's'}`}
          />
          <div className="conflict-list">
            {conflicts.map((conflict) => {
              const models = conflict.models ?? [];
              const candidates = conflict.candidates ?? [];
              const sample = models.slice(0, 4);
              const sourceChoice = conflict.kind === 'source-choice';
              const title =
                conflict.title ||
                (sourceChoice
                  ? 'Choose one account'
                  : `${models.length} overlapping model${models.length === 1 ? '' : 's'}`);
              return (
                <article
                  key={conflict.id}
                  className={`conflict-card ${sourceChoice ? 'source-choice' : 'model-overlap'}`}
                >
                  <div className="conflict-head">
                    <span>{sourceChoice ? '◎' : '△'}</span>
                    <div>
                      <strong>{title}</strong>
                      <small>
                        {sourceChoice
                          ? 'Select the saved account that should serve these models.'
                          : 'Choose one provider for this whole model group.'}
                      </small>
                    </div>
                  </div>
                  <div className="model-samples">
                    {sample.map((model) => (
                      <code key={model}>{model}</code>
                    ))}
                    {models.length > sample.length ? (
                      <span>+{models.length - sample.length} more</span>
                    ) : null}
                  </div>
                  <div className="candidate-list">
                    {candidates.slice(0, 3).map((candidate) => (
                      <ConflictCandidate
                        key={candidate.actionId + candidate.label}
                        candidate={candidate}
                        sourceChoice={sourceChoice}
                        busy={ctrl.busy}
                        onPick={(actionId, label) => {
                          ctrl.setRoutingCandidateConflictId(null);
                          ctrl.setRoutingCandidateQuery('');
                          ctrl.runOpaqueAction(actionId, label);
                        }}
                      />
                    ))}
                    {candidates.length > 3 ? (
                      <button
                        type="button"
                        className="candidate-more"
                        onClick={() => {
                          ctrl.setRoutingCandidateConflictId(conflict.id);
                          ctrl.setRoutingCandidateQuery('');
                        }}
                      >
                        <span>
                          <strong>
                            Choose from {candidates.length}{' '}
                            {sourceChoice ? 'accounts' : 'providers'}
                          </strong>
                          <small>Search without expanding this page</small>
                        </span>
                        <b>›</b>
                      </button>
                    ) : null}
                  </div>
                  <RoutingCandidatePicker
                    conflict={conflict}
                    sourceChoice={sourceChoice}
                    ctrl={ctrl}
                  />
                </article>
              );
            })}
          </div>
        </>
      ) : null}
      {unavailable.length ? (
        <>
          <SectionHeading title="Unavailable accounts" detail="Blocking model discovery" />
          <div className="group native-group">
            {unavailable.map((source) => (
              <div className="blocking-row" key={source.id}>
                <ProviderIcon value={source.providerId} size="medium" />
                <div className="row-main">
                  <div className="row-title">{source.label}</div>
                  <div className="row-detail">
                    {source.warning || `${source.detail} could not load its model catalog.`}
                  </div>
                </div>
                <button type="button" onClick={() => ctrl.setTab('Hub Sources')}>
                  Hub Sources
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function ProxiesView({ ctrl }: { ctrl: TrayController }) {
  const proxies = (ctrl.snapshot?.proxies ?? []).map((proxy, index) => ({ proxy, index }));
  if (!proxies.length) {
    return (
      <>
        <SectionHeading title="Proxies" />
        <EmptyState
          compact
          symbol="⌁"
          title="No proxy services configured"
          body="Add a proxy-capable native account from Saved accounts."
          action={
            <button type="button" onClick={() => ctrl.setTab('Saved accounts')}>
              Add account
            </button>
          }
        />
      </>
    );
  }

  return (
    <>
      <SectionHeading title="Proxies" />
      <div className="group native-group">
        {proxies.map(({ proxy, index }) => {
          const items: OverflowItem[] = [
            {
              label: 'Restart',
              disabled: ctrl.busy,
              onClick: () =>
                ctrl.runAction({
                  id: proxy.restartActionId,
                  label: proxy.label,
                  enabled: true,
                }),
            },
          ];
          if (proxy.testActionId) {
            items.push({
              label: 'Run check',
              disabled: ctrl.busy,
              title:
                'Checks account catalogs and the owned local listener. Sends no prompt.',
              onClick: () => ctrl.runOpaqueAction(proxy.testActionId, `checking ${proxy.label}`),
            });
          }
          if (proxy.providerId === 'proxy-hub') {
            items.push({
              label: 'Hub sources…',
              onClick: () => ctrl.setTab('Hub Sources'),
            });
          }
          if (proxy.logsAvailable !== false) {
            items.push({
              label: 'View logs',
              onClick: () => {
                const source = ctrl.logSources().find(
                  (candidate) =>
                    candidate.id === proxy.id ||
                    (candidate.providerId === proxy.providerId &&
                      candidate.name === proxy.id.split('/').slice(1).join('/')),
                );
                ctrl.setTab('Logs');
                ctrl.requestLogs(source);
              },
            });
          }
          const address = proxy.address || proxy.detail;
          return (
            <div className="native-row proxy-row" key={proxy.id}>
              <ProviderIcon value={proxy.providerId} />
              <div className="row-main">
                <div className="row-title">{proxy.label}</div>
                <div className="row-detail proxy-status-line">
                  <span
                    className={`status-dot ${proxy.running ? 'on' : 'off'}`}
                    title={proxy.running ? 'Running' : 'Stopped'}
                  />
                  <code title={address || ''}>{address || '—'}</code>
                  {proxy.address ? (
                    <button
                      type="button"
                      className="copy-inline"
                      title="Copy proxy address"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(proxy.address!);
                          ctrl.notify(`Copied ${proxy.address}`);
                        } catch {
                          ctrl.notify(
                            'Could not copy the proxy address. Select it manually instead.',
                            true,
                          );
                        }
                      }}
                    >
                      ▣
                    </button>
                  ) : null}
                </div>
              </div>
              <OverflowMenu
                menuKey={`proxy:${index}`}
                open={ctrl.overflowMenu === `proxy:${index}`}
                busy={ctrl.busy}
                onToggle={(key) =>
                  ctrl.setOverflowMenu(ctrl.overflowMenu === key ? null : key)
                }
                onClose={() => ctrl.setOverflowMenu(null)}
                items={items}
              />
              <Toggle
                checked={Boolean(proxy.running)}
                disabled={ctrl.busy}
                onChange={() =>
                  ctrl.runAction({
                    id: proxy.toggleActionId,
                    label: proxy.label,
                    enabled: true,
                  })
                }
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

function EventsList({
  ctrl,
  limit = 8,
}: {
  ctrl: TrayController;
  limit?: number;
}) {
  const events = (ctrl.snapshot?.activity ?? []).slice(0, limit);
  if (!events.length) {
    return (
      <InlineEmpty
        symbol="◷"
        title="No recent activity"
        detail="Checks, switches, and proxy actions will appear here."
      />
    );
  }
  return (
    <>
      {events.map((event, index) => {
        const date = new Date(event.createdAt);
        const time = Number.isNaN(date.getTime())
          ? '—'
          : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return (
          <div className="row activity-row" key={`${event.createdAt}-${index}`}>
            <span className="activity-time">{time}</span>
            <span
              className={`activity-dot${event.isError ? ' error' : ''}`}
              aria-hidden="true"
            >
              {activityIcon(event)}
            </span>
            <div className="row-main">
              <div className="row-detail activity-message">{event.message}</div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function ActivityView({ ctrl }: { ctrl: TrayController }) {
  return (
    <>
      <SectionHeading
        title="Activity"
        action={
          <button type="button" className="section-action" onClick={() => ctrl.setTab('Logs')}>
            All logs
          </button>
        }
      />
      <div className="group native-group monitor-events">
        <EventsList ctrl={ctrl} limit={8} />
      </div>
    </>
  );
}

export function LogsView({ ctrl }: { ctrl: TrayController }) {
  const sources = ctrl.logSources();
  let selectedId = ctrl.selectedLogSourceId;
  if (!selectedId || !sources.some((source) => source.id === selectedId)) {
    selectedId = sources[0]?.id ?? null;
  }
  const selected = sources.find((source) => source.id === selectedId);
  const text = selected ? ctrl.proxyLogs.get(selected.id) : '';
  const loading = selected ? ctrl.pendingLogSources.has(selected.id) : false;
  const logState = loading
    ? 'loading'
    : selected
      ? ctrl.proxyLogStates.get(selected.id) || (text ? 'ready' : 'loading')
      : 'empty';
  const stateLabel = {
    loading: 'Loading',
    ready: 'Loaded',
    empty: 'No entries',
    'not-running': 'Not running',
    error: 'Read error',
  }[logState];
  const hub = (ctrl.snapshot?.proxies ?? []).find((proxy) => proxy.providerId === 'proxy-hub');

  return (
    <div className="monitor-view">
      <SectionHeading
        title="Logs"
        detail={selected ? 'One destination at a time' : 'Waiting for a service'}
      />
      <div className="group monitor-card">
        <div className="monitor-toolbar">
          {sources.length ? (
            <label className="log-source-select">
              <span>Log source</span>
              <select
                value={selected?.id ?? ''}
                onChange={(event) => {
                  const source = sources.find((candidate) => candidate.id === event.target.value);
                  ctrl.setSelectedLogSourceId(source?.id ?? null);
                  ctrl.requestLogs(source);
                }}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
              <small>{selected?.detail || ''}</small>
            </label>
          ) : (
            <div className="log-source-empty">No log sources are available yet.</div>
          )}
          <div className="monitor-actions">
            <span className={`log-state ${logState}`}>
              <i />
              {stateLabel}
            </span>
            <button
              type="button"
              disabled={!selected || loading}
              onClick={() => ctrl.requestLogs(selected)}
            >
              {loading ? '…' : '↻ Refresh'}
            </button>
            <button
              type="button"
              disabled={!text}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text || '');
                  ctrl.notify('Copied visible logs.');
                } catch {
                  ctrl.notify('Could not copy logs. Select the text manually instead.', true);
                }
              }}
            >
              ▣ Copy
            </button>
            {hub?.testActionId ? (
              <button
                type="button"
                className="primary"
                title="Refreshes account catalogs and verifies the local listener without sending a prompt."
                disabled={ctrl.busy}
                onClick={() => ctrl.runOpaqueAction(hub.testActionId, 'checking Proxy Hub')}
              >
                Run Hub check
              </button>
            ) : null}
          </div>
        </div>
        {hub?.testActionId ? (
          <p className="monitor-check-note">
            Hub check contacts enabled providers, refreshes model catalogs, and verifies the owned
            local listener. It sends no prompt.
          </p>
        ) : null}
        <pre className={`log-viewer ${logState}`} tabIndex={0}>
          {text ||
            (loading
              ? `Loading ${selected?.label || 'service'} logs…`
              : selected
                ? 'No log entries yet.'
                : 'Start a proxy to create a log stream.')}
        </pre>
      </div>
    </div>
  );
}

export function SettingsView({ ctrl }: { ctrl: TrayController }) {
  const settings: Partial<TrayPreferences> = ctrl.snapshot?.settings ?? {};
  const reset = ctrl.clientResetConfirmation;

  const settingRow = (
    title: string,
    detail: string,
    fieldName: string,
    checked: boolean | undefined,
  ) => (
    <div className="row" key={fieldName}>
      <div className="row-main">
        <div className="row-title">{title}</div>
        <div className="row-detail">{detail}</div>
      </div>
      <Toggle
        checked={Boolean(checked)}
        disabled={ctrl.busy}
        onChange={(enabled) =>
          ctrl.mutate(fieldName, { enabled, name: 'settings' }, `updating ${title.toLowerCase()}`)
        }
      />
    </div>
  );

  return (
    <>
      <SectionHeading title="General" detail="Tray behavior" />
      <div className="group native-group">
        {settingRow(
          'Open at Login',
          'Launch the tray when you sign in',
          'setting-launch-at-login',
          settings.launchAtLogin,
        )}
        {settingRow(
          'Show account quota',
          'Fetch remaining usage for Apps rows',
          'setting-show-quota',
          settings.showQuota,
        )}
        {settingRow(
          'Quota Guard',
          'On pooled proxies, switch away after a confirmed provider limit',
          'setting-quota-guard',
          settings.quotaGuardEnabled,
        )}
        {settingRow(
          'Start enabled proxies',
          'When the tray launches, start every proxy left enabled',
          'setting-auto-start-proxies',
          settings.startEnabledProxies,
        )}
      </div>
      <SectionHeading title="Maintenance" detail="Local state" />
      <div className="group native-group">
        <div className="settings-actions">
          <button type="button" onClick={() => void ctrl.send('refresh')}>
            ↻ Refresh now
          </button>
          <button
            type="button"
            onClick={() =>
              ctrl.mutate('proxy-restart-all', { name: 'all' }, 'restarting enabled proxies')
            }
          >
            ϟ Restart proxies
          </button>
        </div>
      </div>
      <SectionHeading title="Client defaults" detail="Remove AnyPick overrides" />
      <div className="group native-group">
        <div className="row">
          <div className="row-main">
            <div className="row-title">Claude Code</div>
            <div className="row-detail">
              Clear managed endpoint, token, models, and global route
            </div>
          </div>
          <button
            type="button"
            disabled={ctrl.busy}
            onClick={() =>
              ctrl.setClientResetConfirmation({ client: 'claude', title: 'Claude Code' })
            }
          >
            Reset…
          </button>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Codex</div>
            <div className="row-detail">
              Clear managed provider profile, catalog, and global route
            </div>
          </div>
          <button
            type="button"
            disabled={ctrl.busy}
            onClick={() => ctrl.setClientResetConfirmation({ client: 'codex', title: 'Codex' })}
          >
            Reset…
          </button>
        </div>
      </div>
      <SectionHeading title="Security" detail="Always enforced" />
      <div className="group native-group">
        <div className="info-row">
          <span>⌑</span>
          <div>
            <strong>Secrets stay in the supervisor</strong>
            <small>Gateway API keys never enter the tray snapshot</small>
          </div>
          <b>✓</b>
        </div>
        <div className="info-row">
          <span>⌁</span>
          <div>
            <strong>Loopback-only proxies</strong>
            <small>Proxy services accept local authenticated traffic only</small>
          </div>
          <b>✓</b>
        </div>
      </div>
      {reset ? (
        <>
          <div
            className="route-picker-scrim"
            onClick={() => ctrl.setClientResetConfirmation(null)}
          />
          <div
            className="route-popover route-reset-confirmation"
            role="alertdialog"
            aria-label="Confirm client reset"
          >
            <div className="reset-confirm-icon">↺</div>
            <strong>Reset {reset.title} defaults?</strong>
            <p>
              Your native login is kept. Only AnyPick-managed endpoint, model, and route settings
              are removed.
            </p>
            <div>
              <button type="button" onClick={() => ctrl.setClientResetConfirmation(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const client = reset.client;
                  const title = client === 'claude' ? 'Claude Code' : 'Codex';
                  ctrl.setClientResetConfirmation(null);
                  ctrl.mutate('client-reset', { name: client }, `resetting ${title} defaults`);
                }}
              >
                Reset overrides
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

function ModelOptionRow({
  option,
  selected,
  busy,
  onSelect,
}: {
  option: TrayClientModelOptionSnapshot;
  selected: boolean;
  busy: boolean;
  onSelect: (actionId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`model-option${selected ? ' active' : ''}`}
      disabled={selected || busy}
      onClick={() => onSelect(option.actionId)}
    >
      <ProviderIcon value={option.providerId} size="small" />
      <span>
        <strong>{option.modelId}</strong>
        <small>
          {[providerName(option.providerId), option.sourceLabel].filter(Boolean).join(' · ')}
        </small>
      </span>
      <b>{selected ? '✓' : ''}</b>
    </button>
  );
}

function ModelPicker({
  config,
  ctrl,
}: {
  config: TrayClientModelConfigSnapshot;
  ctrl: TrayController;
}) {
  const roleId = ctrl.modelPickerRole;
  if (!roleId) return null;
  const role = orderedModelRoles(config).find((item) => item.id === roleId);
  if (!role) return null;
  const selectedActionId = ctrl.modelDraftRoleActions[roleId];
  const options = Array.isArray(config.options) ? config.options : [];
  const query = ctrl.modelQuery.trim().toLocaleLowerCase();

  const close = () => {
    ctrl.setModelPickerRole(null);
    ctrl.setModelQuery('');
    ctrl.setModelGroup(null);
  };

  const selectOption = (actionId: string | null) => {
    const defaultActionId = ctrl.modelDraftRoleActions.default;
    const next = { ...ctrl.modelDraftRoleActions };
    next[roleId] =
      roleId !== 'default' && actionId === defaultActionId ? null : actionId;
    if (roleId === 'default' && actionId) {
      for (const r of orderedModelRoles(config)) {
        if (r.id !== 'default' && next[r.id] === actionId) next[r.id] = null;
      }
    }
    ctrl.setModelDraftRoleActions(next);
    close();
  };

  let results: ReactNode;
  if (query) {
    const matching = options.filter((option) =>
      [option.modelId, option.providerId, option.sourceLabel].some((value) =>
        String(value || '')
          .toLocaleLowerCase()
          .includes(query),
      ),
    );
    const shown = matching.slice(0, 20);
    results = shown.length ? (
      <>
        <section className="model-picker-section">
          <div className="picker-label">
            <span>Search results</span>
            <small>
              {Math.min(matching.length, 20)} of {matching.length}
            </small>
          </div>
          {shown.map((option) => (
            <ModelOptionRow
              key={option.actionId}
              option={option}
              selected={option.actionId === selectedActionId}
              busy={ctrl.busy}
              onSelect={selectOption}
            />
          ))}
        </section>
        {matching.length > 20 ? (
          <p className="picker-refine">20 results shown. Type more to narrow the list.</p>
        ) : null}
      </>
    ) : (
      <div className="picker-empty">
        <strong>No matching model</strong>
        <span>Try a model, provider, or account name.</span>
      </div>
    );
  } else {
    const groups = new Map<
      string,
      { id: string; providerId: string; options: TrayClientModelOptionSnapshot[] }
    >();
    for (const option of options) {
      const id = encodeURIComponent(option.providerId || 'unknown');
      const group = groups.get(id) ?? {
        id,
        providerId: option.providerId || 'proxy-hub',
        options: [] as TrayClientModelOptionSnapshot[],
      };
      group.options.push(option);
      groups.set(id, group);
    }
    const selectedGroup = ctrl.modelGroup ? groups.get(ctrl.modelGroup) : null;
    const groupContent = selectedGroup ? (
      <>
        <button type="button" className="picker-group-back" onClick={() => ctrl.setModelGroup(null)}>
          ‹ All providers
        </button>
        <section className="model-picker-section">
          <div className="picker-label">
            <span>{providerName(selectedGroup.providerId)}</span>
            <small>{selectedGroup.options.length} models across accounts</small>
          </div>
          {selectedGroup.options.slice(0, 12).map((option) => (
            <ModelOptionRow
              key={option.actionId}
              option={option}
              selected={option.actionId === selectedActionId}
              busy={ctrl.busy}
              onSelect={selectOption}
            />
          ))}
        </section>
        {selectedGroup.options.length > 12 ? (
          <p className="picker-refine">12 models shown. Search above for the rest.</p>
        ) : null}
      </>
    ) : (
      [...groups.values()]
        .toSorted((left, right) =>
          providerName(left.providerId).localeCompare(providerName(right.providerId)),
        )
        .map((group) => {
          const accountCount = new Set(
            group.options.map((option) => option.sourceLabel).filter(Boolean),
          ).size;
          return (
            <button
              key={group.id}
              type="button"
              className="picker-group"
              onClick={() => ctrl.setModelGroup(group.id)}
            >
              <ProviderIcon value={group.providerId} size="small" />
              <span>
                <strong>{providerName(group.providerId)}</strong>
                <small>
                  {accountCount} account{accountCount === 1 ? '' : 's'}
                </small>
              </span>
              <b>{group.options.length}</b>
              <i>›</i>
            </button>
          );
        })
    );
    results = (
      <>
        {roleId !== 'default' ? (
          <button
            type="button"
            className={`model-inherit-choice${selectedActionId ? '' : ' active'}`}
            onClick={() => selectOption(null)}
          >
            <span>↳</span>
            <div>
              <strong>Use Default</strong>
              <small>
                Follow{' '}
                {modelOption(config, ctrl.modelDraftRoleActions.default)?.modelId ||
                  'the Default model'}
              </small>
            </div>
            {selectedActionId ? null : <b>✓</b>}
          </button>
        ) : null}
        <section className="model-picker-section">
          <div className="picker-label">
            <span>Models by account</span>
            <small>{options.length} total</small>
          </div>
          {groupContent}
        </section>
      </>
    );
  }

  return (
    <>
      <div className="route-picker-scrim" onClick={close} />
      <div
        className="route-popover model-picker"
        role="dialog"
        aria-label={`Choose ${role.label} model`}
      >
        <div className="route-picker-head">
          <div>
            <strong>{role.label} model</strong>
            <small>
              {roleId === 'default'
                ? 'Required for Claude Code'
                : 'Customize this role or inherit Default'}
            </small>
          </div>
          <button type="button" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        <label className="popover-search">
          <span>⌕</span>
          <input
            autoFocus
            value={ctrl.modelQuery}
            placeholder={`Search ${options.length} models`}
            onChange={(event) => ctrl.setModelQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          />
        </label>
        <div className="picker-results">
          {results || <div className="picker-empty">No models available</div>}
        </div>
      </div>
    </>
  );
}

export function ModelsView({ ctrl }: { ctrl: TrayController }) {
  const config = ctrl.modelConfigFor(ctrl.modelEditorClientId);
  if (!config) {
    return (
      <EmptyState
        symbol="△"
        title="Model settings changed"
        body="Return to Apps and reopen the editor."
        action={
          <button type="button" onClick={() => ctrl.closeModelEditor()}>
            Back to Apps
          </button>
        }
      />
    );
  }
  const roles = orderedModelRoles(config);
  const options = Array.isArray(config.options) ? config.options : [];
  const validActions = new Set(options.map((option) => option.actionId));
  const defaultAction = ctrl.modelDraftRoleActions.default;
  const validDraft =
    Boolean(defaultAction) &&
    Object.values(ctrl.modelDraftRoleActions)
      .filter((actionId): actionId is string => Boolean(actionId))
      .every((actionId) => validActions.has(actionId));
  const optionalRoleCount = Math.max(0, roles.length - 1);

  return (
    <>
      <SectionHeading
        title={`${config.client} models`}
        detail={config.sourceLabel || config.client}
      />
      <div className="model-editor-intro">
        <span>{options.length || roles.length}</span>
        <div>
          {optionalRoleCount === 0 ? (
            <>
              <strong>Choose the default from the route model list</strong>
              <p>
                One default is applied to the app. The full list is published so CLI can switch;
                change the default here anytime.
              </p>
            </>
          ) : config.clientId === 'codex' ? (
            <>
              <strong>
                One required Default, {optionalRoleCount} optional model
                {optionalRoleCount === 1 ? '' : 's'} for the Desktop picker
              </strong>
              <p>
                Codex Desktop only shows about five models. Set Default plus Model 2–5 to pin Hub
                models into those slots. Empty slots auto-fill from the Hub catalog; CLI can still
                pick any Hub model.
              </p>
            </>
          ) : (
            <>
              <strong>
                One required model, {optionalRoleCount} optional override
                {optionalRoleCount === 1 ? '' : 's'}
              </strong>
              <p>Sonnet, Opus, and Haiku follow Default until you customize them.</p>
            </>
          )}
        </div>
      </div>
      {config.unavailableReason ? (
        <div className="model-editor-warning">△ {config.unavailableReason}</div>
      ) : null}
      <div className="group model-role-list">
        {roles.map((role) => {
          const actionId = ctrl.modelDraftRoleActions[role.id];
          const selected = modelOption(config, actionId);
          const inherited = role.id !== 'default' && !actionId;
          const inheritedOption = modelOption(config, defaultAction);
          const visible = selected ?? inheritedOption;
          return (
            <div className="model-role-row" key={role.id}>
              <div className="model-role-name">
                <strong>{role.label}</strong>
                <small>
                  {role.id === 'default'
                    ? 'Required'
                    : inherited
                      ? 'Inherits Default'
                      : 'Customized'}
                </small>
              </div>
              <div className="model-role-value">
                {visible ? (
                  <>
                    <ProviderIcon value={visible.providerId} size="small" />
                    <span>
                      <strong>{visible.modelId}</strong>
                      <small>
                        {inherited
                          ? `Inherited · ${visible.sourceLabel || providerName(visible.providerId)}`
                          : visible.sourceLabel || providerName(visible.providerId)}
                      </small>
                    </span>
                  </>
                ) : (
                  <span>
                    <strong>No model selected</strong>
                    <small>Choose a model to continue</small>
                  </span>
                )}
              </div>
              <div className="model-role-actions">
                {role.id !== 'default' && !inherited ? (
                  <button
                    type="button"
                    onClick={() =>
                      ctrl.setModelDraftRoleActions({
                        ...ctrl.modelDraftRoleActions,
                        [role.id]: null,
                      })
                    }
                  >
                    Use Default
                  </button>
                ) : null}
                <button
                  type="button"
                  className="native-button compact popup"
                  disabled={!config.editable || !options.length || ctrl.busy}
                  onClick={() => {
                    ctrl.setModelPickerRole(role.id);
                    ctrl.setModelQuery('');
                    ctrl.setModelGroup(null);
                  }}
                >
                  <span className="popup-title">{visible ? 'Change' : 'Choose'}</span>
                  <span className="popup-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="model-editor-footer">
        <span>
          {options.length} available model{options.length === 1 ? '' : 's'}
        </span>
        <div>
          <button type="button" onClick={() => ctrl.closeModelEditor()}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!config.editable || !validDraft || ctrl.busy}
            onClick={() => ctrl.applyModelRoles(config)}
          >
            Save models
          </button>
        </div>
      </div>
      <ModelPicker config={config} ctrl={ctrl} />
    </>
  );
}
