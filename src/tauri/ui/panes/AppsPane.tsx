import { useMemo, useState } from 'react';

import type { Snapshot } from '../lib/contract';
import {
  refreshModels,
  resetClient,
} from '../lib/desktop-actions';
import {
  addApp,
  availableAppsToAdd,
  effectiveConfiguredAppIDs,
  removeApp,
  storeConfiguredAppIDs,
  storeRemovedAppIDs,
  storedConfiguredAppIDs,
  storedRemovedAppIDs,
} from '../lib/app-preferences';
import { isAppRouteConfigured } from '../lib/model';
import { translate, translateSource } from '../lib/i18n';
import type { ServicePort } from '../lib/service';
import {
  Button,
  EmptyState,
  Group,
  Pane,
  PaneActions,
  Row,
  RowActions,
  RowText,
} from '../ui/primitives';
import { MenuDivider, MenuItem, RowMenu } from '../ui/RowMenu';
import { ProviderIcon } from '../shell/ProviderIcon';
import {
  appEntries,
  appIssue,
  appSubtitle,
  appTrailing,
  type AppEntry,
} from '../lib/app-entry';
import { ConfirmDialog } from './ProxiesPane';
import { AddAppSheet } from './AddAppSheet';
import type { ModelRolesResult } from './AppRouteSheet';
import { AppRouteSheet } from './AppRouteSheet';
import { AppDetailPane } from './AppDetailPane';

export function AppsPane({
  service,
  snapshot,
  query = '',
  busy = new Set<string>(),
  modelRolesResult = null,
  onClearQuery,
  selectedClientId: propSelectedClientId,
  onSelectClient,
}: {
  service: ServicePort;
  snapshot: Snapshot;
  query?: string;
  busy?: ReadonlySet<string>;
  modelRolesResult?: ModelRolesResult | null;
  onClearQuery?: () => void;
  selectedClientId?: string | null;
  onSelectClient?: (clientId: string | null) => void;
}) {
  const allAppIds = useMemo(() => uniqueClientIds(snapshot.actions), [snapshot.actions]);
  const t = (key: string) =>
    translate(`desktop.apps.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tc = (key: string) =>
    translate(`desktop.common.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tr = (source: string) =>
    translateSource(source, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const [preferences, setPreferences] = useState(() => ({
    configured: storedConfiguredAppIDs(),
    removed: storedRemovedAppIDs(),
  }));
  const configured = useMemo(
    () =>
      effectiveConfiguredAppIDs({
        allAppIds,
        actions: snapshot.actions,
        stored: preferences.configured,
        removed: preferences.removed,
      }),
    [allAppIds, preferences, snapshot.actions],
  );
  const addable = useMemo(() => availableAppsToAdd(allAppIds, configured), [allAppIds, configured]);
  const visible = useMemo(
    () => snapshot.actions.filter((action) => configured.includes(action.clientId)),
    [configured, snapshot.actions],
  );
  const needle = query.trim().toLocaleLowerCase();
  const entries = useMemo(
    () =>
      appEntries(visible).filter((app) => {
        if (!needle) return true;
        const haystack = `${app.client} ${appSubtitle(app)}`.toLocaleLowerCase();
        return haystack.includes(needle);
      }),
    [needle, visible],
  );

  const [internalSelectedClientId, setInternalSelectedClientId] = useState<string | null>(null);
  const selectedClientId =
    propSelectedClientId !== undefined ? propSelectedClientId : internalSelectedClientId;

  const selectClient = (id: string | null) => {
    setInternalSelectedClientId(id);
    onSelectClient?.(id);
  };

  const [resetClientId, setResetClientId] = useState<string | null>(null);
  const [changingClientId, setChangingClientId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingClientId, setRemovingClientId] = useState<string | null>(null);

  const applyPreferences = (next: { configured: string[]; removed: string[] }) => {
    storeConfiguredAppIDs(next.configured);
    storeRemovedAppIDs(next.removed);
    setPreferences(next);
  };

  const changingRows = useMemo(
    () => (changingClientId ? snapshot.actions.filter((row) => row.clientId === changingClientId) : []),
    [changingClientId, snapshot.actions],
  );

  if (selectedClientId) {
    const selectedApp =
      entries.find((app) => app.clientId === selectedClientId) ??
      appEntries(snapshot.actions).find((app) => app.clientId === selectedClientId);

    if (selectedApp) {
      return (
        <AppDetailPane
          app={selectedApp}
          service={service}
          snapshot={snapshot}
          busy={busy}
          modelRolesResult={modelRolesResult}
          onBack={() => selectClient(null)}
          onReset={() => setResetClientId(selectedApp.clientId)}
          onRemove={() => setRemovingClientId(selectedApp.clientId)}
        />
      );
    }
  }

  return (
    <Pane title={t('title')} testId="apps">
      {entries.length === 0 ? (
        <EmptyState
          title={needle ? t('no_results') : t('no_apps')}
          detail={
            needle
              ? translate('desktop.apps.no_apps_match', snapshot.settings.language, snapshot.settings.resolvedLanguage)
              : t('empty_detail')
          }
          actionTitle={needle ? t('clear_search') : undefined}
          onAction={needle ? onClearQuery : undefined}
          testId="apps-empty"
          actions={
            needle || addable.length === 0 ? null : (
              <Button kind="primary" testId="apps.empty.add" onClick={() => setAdding(true)}>
                {t('add_app')}
              </Button>
            )
          }
        />
      ) : null}

      {entries.length > 0 ? (
        <Group
          title={translate(
            `desktop.apps.${needle ? 'matching_apps_count' : 'apps_count'}`,
            snapshot.settings.language,
            snapshot.settings.resolvedLanguage,
          ).replace('{count}', String(entries.length))}
          testId="apps.list"
        >
          {entries.map((app) => (
            <AppListRow
              key={app.clientId}
              app={app}
              t={t}
              tr={tr}
              language={snapshot.settings.language}
              resolvedLanguage={snapshot.settings.resolvedLanguage}
              busy={busy}
              service={service}
              onClick={() => selectClient(app.clientId)}
              onChangeConnection={() => setChangingClientId(app.clientId)}
              onReset={() => setResetClientId(app.clientId)}
              onRemove={() => setRemovingClientId(app.clientId)}
            />
          ))}
        </Group>
      ) : null}

      <PaneActions>
        <Button
          kind="secondary"
          disabled={busy.size > 0}
          testId="apps.add"
          onClick={() => setAdding(true)}
        >
          {t('add_app')}
        </Button>
      </PaneActions>

      {changingClientId && changingRows.length > 0 ? (
        <AppRouteSheet
          clientId={changingClientId}
          rows={changingRows}
          service={service}
          snapshot={snapshot}
          busy={busy}
          modelRolesResult={modelRolesResult}
          onClose={() => setChangingClientId(null)}
        />
      ) : null}

      {adding ? (
        <AddAppSheet
          available={addable}
          snapshot={snapshot}
          onClose={() => setAdding(false)}
          onAdd={(clientId) => {
            applyPreferences(addApp(preferences.configured ?? configured, preferences.removed, clientId));
            setAdding(false);
          }}
        />
      ) : null}

      {removingClientId ? (
        <ConfirmDialog
          title={t('remove_title').replace('{name}', clientName(snapshot.actions, removingClientId))}
          message={t('remove_message')}
          confirmTitle={t('remove_app')}
          cancelTitle={tc('cancel')}
          destructive
          testId="app.remove.dialog"
          onCancel={() => setRemovingClientId(null)}
          onConfirm={() => {
            const next = removeApp(preferences.configured ?? configured, preferences.removed, removingClientId);
            applyPreferences(next);
            setRemovingClientId(null);
          }}
        />
      ) : null}

      {resetClientId ? (
        <ConfirmDialog
          title={t('disconnect_title').replace('{name}', resetClientId)}
          message={t('disconnect_message')}
          confirmTitle={translate('desktop.apps.disconnect_anypick', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
          cancelTitle={tc('cancel')}
          destructive
          testId="apps-disconnect-dialog"
          onCancel={() => setResetClientId(null)}
          onConfirm={() => {
            const action = resetClient(resetClientId);
            setResetClientId(null);
            service.mutate(action.operation, action.extra);
          }}
        />
      ) : null}
    </Pane>
  );
}

function AppListRow({
  app,
  t,
  tr,
  language,
  resolvedLanguage,
  busy,
  service,
  onClick,
  onChangeConnection,
  onReset,
  onRemove,
}: {
  app: AppEntry;
  t: (key: string) => string;
  tr: (source: string) => string;
  language: string;
  resolvedLanguage: string;
  busy: ReadonlySet<string>;
  service: ServicePort;
  onClick: () => void;
  onChangeConnection: () => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const [refreshOpen, setRefreshOpen] = useState(false);
  const disabled = Boolean(app.issue) && app.issue !== 'No login chosen for this app.';
  const refresh = refreshModels(app.selected?.sourceId ?? '');
  const trailing = appTrailing(app);
  const isManaged = app.managed;
  const isConfigured = Boolean(app.selected && app.selected.selected && app.selected.routeKind);

  return (
    <>
      <Row
        testId={`apps-row-${app.clientId}`}
        warning={disabled}
        onClick={onClick}
      >
        <ProviderIcon provider={app.clientId} size={26} className="mr-1.5" />
        <RowText
          title={app.client}
          detail={tr(appSubtitle(app))}
          issue={tr(appIssue(app) ?? '')}
          language={language}
          resolvedLanguage={resolvedLanguage}
        />
        <RowActions>
          {isManaged ? (
            <span className="rounded-control bg-badge px-1.5 py-0.5 text-[11px] font-medium text-secondary">
            {t('anypick_proxy')}
            </span>
          ) : !isConfigured ? (
            <span className="flex items-center gap-1.5 text-[12px] text-secondary">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {t('set_up')}
            </span>
          ) : (
            <span className="text-[12px] text-secondary">{t('direct')}</span>
          )}

          <RowMenu
            label={t('actions_for').replace('{name}', app.client)}
            language={language}
            resolvedLanguage={resolvedLanguage}
            testId={`app.more-${app.clientId}`}
          >
            {(close) => (
              <>
                <MenuItem
                  testId="app.connection.change-menu"
                  onSelect={() => {
                    close();
                    onChangeConnection();
                  }}
                >
                  {t('change_connection')}
                </MenuItem>
                <MenuItem
                  testId="apps-refresh-menu"
                  disabled={busy.size > 0 || !refresh}
                  onSelect={() => {
                    close();
                    setRefreshOpen((current) => !current);
                    if (refresh) service.mutate(refresh.operation, refresh.extra);
                  }}
                >
                  {t('refresh_models')}
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  testId="app.disconnect-menu"
                  destructive
                  disabled={busy.size > 0 || !app.managed}
                  onSelect={() => {
                    close();
                    onReset();
                  }}
                >
                  {t('disconnect_anypick')}
                </MenuItem>
                <MenuItem
                  testId="app.remove-menu"
                  destructive
                  disabled={busy.size > 0}
                  onSelect={() => {
                    close();
                    onRemove();
                  }}
                >
                  {t('remove_app')}
                </MenuItem>
              </>
            )}
          </RowMenu>

          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            aria-hidden="true"
            focusable="false"
            className="text-tertiary"
          >
            <path
              d="M9 5l7 7-7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </RowActions>
      </Row>
      {refreshOpen ? (
        <Row testId={`apps-refresh-note-${app.clientId}`}>
          <RowText detail={t('models_refreshed')} />
        </Row>
      ) : null}
    </>
  );
}

function uniqueClientIds(actions: Snapshot['actions']): string[] {
  return [...new Set(actions.map((action) => action.clientId).filter(Boolean))];
}

function clientName(actions: Snapshot['actions'], clientId: string): string {
  return actions.find((action) => action.clientId === clientId)?.client ?? clientId;
}
