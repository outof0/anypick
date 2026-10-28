import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ClientModelConfig,
  CodexProfileRow as CodexProfileRowContract,
  Snapshot,
} from '../lib/contract';
import {
  codexAutoProfilesEnabled,
  planAutomaticCodexProfileSync,
  setAutomaticCodexProfileCreation,
} from '../lib/codex-auto-profiles';
import {
  missingCodexProfileSources,
  openCodexProfile,
  removeCodexProfile,
  saveCodexProfile,
  syncCodexProfiles,
  updateCodexProfile,
  validCodexProfileName,
} from '../lib/desktop-actions';
import {
  cleanModelDisplayName,
  friendlyRouteKindLabel,
  groupUsageWindows,
  isAppRouteConfigured,
  localizedQuotaResetFormatted,
  localizedQuotaWindowLabel,
  nativeProviderName,
  quotaWindowLabel,
  transportDisplayName,
  usageForApp,
} from '../lib/model';
import type { ServicePort } from '../lib/service';
import { translate, translateSource } from '../lib/i18n';
import {
  Button,
  CopyButton,
  CheckRow,
  Field,
  Group,
  LabeledRow,
  Pane,
  PaneActions,
  Row,
  RowActions,
  RowText,
  Select,
  Switch,
  WarningGlyph,
} from '../ui/primitives';
import { MenuDivider, MenuItem, RowMenu } from '../ui/RowMenu';
import { ProviderIcon } from '../shell/ProviderIcon';
import type { AppEntry } from '../lib/app-entry';
import { appIssue, appModelConfig, appSubtitle } from '../lib/app-entry';
import type { ModelRolesResult } from './AppRouteSheet';
import { AppRouteSheet } from './AppRouteSheet';
import { CodexProfileSheet } from './CodexProfileSheet';

/**
 * AppDetailPane: mirrors macOS `AppDetailView.swift` line by line.
 *
 * Displays:
 * 1. App Identity Header (icon, title, subtitle)
 * 2. Needs Attention section (if issue)
 * 3. Connection Section (Uses, Identity, Transport, Change… / Disconnect…)
 * 4. Quick Panel toggle
 * 5. Models Section (Default, Overrides, Manage…)
 * 6. Codex Profiles Section (only for codex app)
 * 7. Usage Section (if showQuota is enabled)
 * 8. Bottom Pane Actions (Disconnect AnyPick, Remove App)
 */
export function AppDetailPane({
  app,
  service,
  snapshot,
  busy = new Set<string>(),
  modelRolesResult = null,
  onBack,
  onReset,
  onRemove,
}: {
  app: AppEntry;
  service: ServicePort;
  snapshot: Snapshot;
  busy?: ReadonlySet<string>;
  modelRolesResult?: ModelRolesResult | null;
  onBack: () => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const language = snapshot.settings.language;
  const resolvedLanguage = snapshot.settings.resolvedLanguage;
  const t = (key: string) => translate(`desktop.app_detail.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  const [changingRoutes, setChangingRoutes] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [quickPanelEnabled, setQuickPanelEnabled] = useState(true);

  const config = appModelConfig(snapshot, app.clientId);
  const isManaged = app.managed;
  const isConfigured = Boolean(app.selected && app.selected.selected && app.selected.routeKind);

  const changingRows = useMemo(
    () => snapshot.actions.filter((row) => row.clientId === app.clientId),
    [app.clientId, snapshot.actions],
  );

  const modelRolesError =
    modelRolesResult !== null &&
    modelRolesResult.clientId === app.clientId &&
    modelRolesResult.result.status === 'error'
      ? modelRolesResult.result.message
      : undefined;

  const usageWindows = usageForApp(snapshot.usage, app.clientId, snapshot.actions)?.windows ?? [];
  const usageGroups = groupUsageWindows(usageWindows).map((group) => ({
    ...group,
    rows: group.windows.map((window) => ({ window, index: usageWindows.indexOf(window) })),
  }));

  return (
    <Pane
      title={app.client}
      testId={`app-detail-${app.clientId}`}
    >
      {/* App Identity Header */}
      <Group>
        <Row>
          <ProviderIcon provider={app.clientId} size={28} className="mr-1.5" />
          <RowText title={app.client} detail={tr(appSubtitle(app))} />
        </Row>
      </Group>

      {/* Needs Attention / Issues */}
      {app.issue ? (
        <Group>
          <Row warning>
            <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
            <RowText title={translate('desktop.common.needs_attention', language, resolvedLanguage)} detail={tr(appIssue(app) ?? '')} />
          </Row>
        </Group>
      ) : null}

      {/* Connection Section */}
      <Group title={t('connection')}>
        <LabeledRow label={t('uses')} value={app.selected?.label || t('not_selected')} />
        {app.selected?.detail ? (
          <LabeledRow label={translate('desktop.account_detail.identity', language, resolvedLanguage)} value={tr(app.selected.detail)} />
        ) : null}
        <LabeledRow
          label={t('transport')}
          value={tr(transportDisplayName(app.selected?.routeKind, isConfigured))}
        />
        <LabeledRow label={t('connection')} testId="app.connection.change">
          <Button
            kind="secondary"
            disabled={busy.size > 0 || changingRows.length === 0}
            onClick={() => setChangingRoutes(true)}
          >
            {t(isConfigured ? 'change' : 'connect')}
          </Button>
          {isManaged ? (
            <Button
              kind="secondary"
              disabled={busy.size > 0}
              testId="app.connection.disconnect"
              onClick={onReset}
            >
              {t('disconnect_action')}
            </Button>
          ) : null}
        </LabeledRow>
      </Group>

      {/* Quick Panel Section */}
      <Group
        footer={t('quick_panel_help')}
      >
        <Row>
          <RowText title={t('show_quick_panel')} />
          <RowActions>
            <Switch
              label={t('show_quick_panel')}
              checked={quickPanelEnabled}
              disabled={busy.size > 0}
              onChange={setQuickPanelEnabled}
            />
          </RowActions>
        </Row>
      </Group>

      {/* Models Section */}
      {config && (isManaged || Boolean(config.unavailableReason)) ? (
        <Group
          title={t('models')}
          footer={!config.editable && config.unavailableReason ? tr(config.unavailableReason) : undefined}
        >
          {isManaged ? (
            <>
              <LabeledRow
                label={t('default')}
                value={cleanModelDisplayName(config.defaultModel ?? '') || t('not_selected')}
              />
              <LabeledRow
                label={t('overrides')}
                value={
                  Object.keys(config.modelRoles).length > 0
                    ? translate('desktop.app_detail.models_pinned', language, resolvedLanguage)
                        .replace('{count}', String(Object.keys(config.modelRoles).length))
                    : t('not_selected')
                }
              />
              <LabeledRow label={t('manage_models')} testId={`app.models.row-${app.clientId}`}>
                <Button
                  kind="secondary"
                  testId="app.models.manage"
                  disabled={busy.size > 0 || !config.editable}
                  ariaLabel={t('manage_models')}
                  onClick={() => setModelsOpen((v) => !v)}
                >
                  {modelsOpen ? translate('desktop.common.done', language, resolvedLanguage) : t('manage')}
                </Button>
              </LabeledRow>
              {modelsOpen ? (
                <ModelEditor
                  config={config}
                  service={service}
                  revision={snapshot.revision}
                  busy={busy}
                  error={modelRolesError}
                  language={language}
                  resolvedLanguage={resolvedLanguage}
                />
              ) : null}
            </>
          ) : null}
        </Group>
      ) : null}

      {/* Codex Profiles Section (ONLY for Codex app) */}
      {app.clientId === 'codex' ? (
        <CodexProfilesBlock
          service={service}
          snapshot={snapshot}
          busy={busy}
          language={language}
          resolvedLanguage={resolvedLanguage}
        />
      ) : null}

      {/* Usage Section */}
      {snapshot.settings.showQuota ? (
        <Group title={translate('desktop.settings.usage', language, resolvedLanguage)}>
          {usageGroups.length > 0 ? (
            usageGroups.map((group) => (
              <div key={group.id}>
                {group.title ? (
                  <h3 className="mb-1 ml-1 mt-2 text-[11px] font-semibold text-secondary">{group.title}</h3>
                ) : null}
                {group.rows.map(({ window, index }) => {
                  const percent = Math.max(0, Math.min(100, window.remainingPercent));
                  const tint =
                    percent <= 5
                      ? 'bg-red'
                      : percent <= 20
                        ? 'bg-orange'
                        : 'bg-accent';
                  const reset = localizedQuotaResetFormatted(window, language, resolvedLanguage);
                  return (
                    <Row
                      key={`${app.clientId}-quota-${index}`}
                      testId={`apps-quota-${app.clientId}-${index}`}
                    >
                      <RowText title={localizedQuotaWindowLabel(window, language, resolvedLanguage)} />
                      <RowActions>
                        <div className="flex items-center gap-3">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-separator-soft">
                            <div
                              className={`h-full rounded-full ${tint}`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                          <span className="w-24 text-right text-[12px] font-mono text-secondary">
                            {translate('desktop.quota.remaining_accessibility', language, resolvedLanguage)
                              .replace('{label}', '')
                              .replace(': ', '')
                              .replace('{percent}', String(window.remainingPercent))}
                          </span>
                          {reset ? (
                            <span className="w-16 text-right text-[12px] text-secondary">
                              {reset}
                            </span>
                          ) : null}
                        </div>
                      </RowActions>
                    </Row>
                  );
                })}
              </div>
            ))
          ) : (
            <Row>
              <RowText detail={t('login_no_usage')} />
            </Row>
          )}
        </Group>
      ) : null}

      {/* Bottom Pane Actions */}
      <PaneActions>
        {isManaged ? (
          <Button
            kind="secondary"
            disabled={busy.size > 0}
            testId="app.reset"
            onClick={onReset}
          >
            {t('disconnect_anypick')}
          </Button>
        ) : null}
        <Button
          kind="secondary"
          disabled={busy.size > 0}
          testId="app.remove"
          onClick={onRemove}
        >
            {t('remove_app')}
        </Button>
      </PaneActions>

      {/* Change Connection Sheet */}
      {changingRoutes && changingRows.length > 0 ? (
        <AppRouteSheet
          clientId={app.clientId}
          rows={changingRows}
          service={service}
          snapshot={snapshot}
          busy={busy}
          modelRolesResult={modelRolesResult}
          onClose={() => setChangingRoutes(false)}
        />
      ) : null}
    </Pane>
  );
}

export function providerLabelFor(config: ClientModelConfig): string {
  const providerId = config.options.find((option) => option.providerId)?.providerId ?? '';
  return providerId ? nativeProviderName(providerId) : '';
}

export function provenanceOf(config: ClientModelConfig): 'custom' | 'inherited' | 'none' {
  if (config.modelRolesSource === 'provider') return 'inherited';
  if (config.modelRolesSource === 'explicit') return 'custom';
  return Object.values(config.modelRoles).some((model) => model) ? 'custom' : 'none';
}

export function modelProvenanceCaption(provenance: 'custom' | 'inherited' | 'none', providerName: string): string {
  if (provenance === 'custom') return 'Custom models for this connection.';
  if (provenance === 'inherited') {
    return providerName ? `Using the ${providerName} default for all accounts.` : 'Using a shared default.';
  }
  return 'No models pinned yet.';
}

export function ModelEditor({
  config,
  service,
  revision,
  busy,
  error,
  language,
  resolvedLanguage,
}: {
  config: ClientModelConfig;
  service: ServicePort;
  revision: number;
  busy: ReadonlySet<string>;
  error?: string;
  language: string;
  resolvedLanguage: string;
}) {
  const t = (key: string) => translate(`desktop.models.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  const providerId = config.options.find((option) => option.providerId)?.providerId ?? '';
  const providerName = providerId ? nativeProviderName(providerId) : '';
  const provenance = provenanceOf(config);
  const [scope, setScope] = useState<'connection' | 'provider'>(
    provenance === 'custom' || !providerName ? 'connection' : 'provider',
  );
  const caption = tr(modelProvenanceCaption(provenance, providerName));

  return (
    <>
      {config.editable && config.options.length > 0 ? (
        <Row testId={`models-scope-${config.clientId}`}>
          <RowText title={t('applies_to')} detail={caption} />
          <RowActions>
            {providerName ? (
              <select
                className="min-h-control max-w-55 min-w-40 rounded-control border border-control-border bg-control px-2 text-[12px] text-text"
                aria-label={tr(`Applies to ${config.client}`)}
                value={scope}
                disabled={busy.size > 0}
                onChange={(event) =>
                  setScope(event.target.value === 'provider' ? 'provider' : 'connection')
                }
              >
                <option value="connection">{t('this_connection')}</option>
                <option value="provider">{t('all_provider_accounts').replace('{provider}', providerName)}</option>
              </select>
            ) : null}
            {provenance === 'custom' && providerName ? (
              <Button
                kind="secondary"
                disabled={busy.size > 0}
                testId={`models-reset-${config.clientId}`}
                onClick={() => service.setModelRoles(config.clientId, {}, revision, 'connection')}
              >
                {tr(`Use ${providerName} Default`)}
              </Button>
            ) : null}
          </RowActions>
        </Row>
      ) : null}
      {modelRows(config).map((row) => (
        <Row key={`${config.clientId}-${row.roleId}`} testId={`model-${config.clientId}-${row.roleId}`}>
          <RowText title={tr(row.title)} detail={tr(row.detail)} />
          <RowActions>
            {row.options.length > 0 ? (
              <select
                className="min-h-control max-w-55 min-w-40 rounded-control border border-control-border bg-control px-2 text-[12px] text-text"
                aria-label={tr(row.selectLabel)}
                value={row.selectedActionId}
                disabled={busy.size > 0}
                onChange={(event) => {
                  const next = roleActionIdsFor(config, row.roleIds, row.roleId, event.target.value);
                  if (next) service.setModelRoles(config.clientId, next, revision, scope);
                }}
              >
                <option value="">{t('choose_model')}</option>
                {row.options.map((option) => (
                  <option key={option.actionId} value={option.actionId}>
                    {cleanModelDisplayName(option.modelId)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[12px] whitespace-nowrap text-secondary">{tr(row.trailing)}</span>
            )}
          </RowActions>
        </Row>
      ))}
      {error ? (
        <Row testId="app-models.error" warning>
          <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
          <RowText detail={tr(error)} />
        </Row>
      ) : null}
    </>
  );
}

function modelRows(config: ClientModelConfig) {
  const roleIds = config.roles.length > 0 ? config.roles.map((role) => role.id) : ['default'];
  const unavailable = config.unavailableReason;
  return roleIds.map((roleId) => {
    const current =
      config.modelRoles[roleId] ?? (roleId === 'default' ? config.defaultModel : undefined) ?? '';
    return {
      roleId,
      roleIds,
      title: roleIds.length > 1 ? `${config.client} · ${roleId}` : config.client,
      detail: unavailable || config.sourceLabel || cleanModelDisplayName(current) || 'No model selected',
      trailing: 'Not configurable',
      selectLabel:
        roleIds.length > 1
          ? `Model for ${config.client} · ${roleId}`
          : `Model for ${config.client}`,
      selectedActionId: config.options.find((option) => option.modelId === current)?.actionId ?? '',
      options: config.editable ? config.options : [],
    };
  });
}

function roleActionIdsFor(
  config: ClientModelConfig,
  roleIds: string[],
  roleId: string,
  actionId: string,
): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const id of roleIds) {
    if (id === roleId) {
      if (actionId) result[id] = actionId;
    } else {
      const current = config.modelRoles[id] ?? (id === 'default' ? config.defaultModel : undefined);
      const matched = config.options.find((option) => option.modelId === current)?.actionId;
      if (matched) result[id] = matched;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function codexProfileSummary(
  profile: CodexProfileRowContract,
  language: string,
  resolvedLanguage: string,
): string {
  const t = (key: string) => translate(`desktop.app_detail.${key}`, language, resolvedLanguage);
  const modelName = profile.modelId ? cleanModelDisplayName(profile.modelId) : t('source_default');
  const transport =
    profile.transportPolicy === 'direct'
      ? t('direct')
      : profile.transportPolicy === 'proxy'
        ? t('proxy')
        : t('automatic');
  return `${profile.sourceLabel || profile.name} · ${modelName} · ${transport}`;
}

function codexProfileProvider(sourceId: string): string {
  if (sourceId.startsWith('account/')) {
    const parts = sourceId.split('/');
    return parts[1] || 'codex';
  }
  return 'codex';
}

/**
 * Codex profiles section and automation inside Codex App detail.
 */
function CodexProfilesBlock({
  service,
  snapshot,
  busy,
  language,
  resolvedLanguage,
}: {
  service: ServicePort;
  snapshot: Snapshot;
  busy: ReadonlySet<string>;
  language: string;
  resolvedLanguage: string;
}) {
  const t = (key: string) => translate(`desktop.app_detail.${key}`, language, resolvedLanguage);
  const missing = missingCodexProfileSources(snapshot);
  const [sheetProfile, setSheetProfile] = useState<CodexProfileRowContract | null | undefined>(undefined);
  const [autoCreate, setAutoCreate] = useState(() => codexAutoProfilesEnabled());

  return (
    <>
      <Group
        title={t('codex_profiles')}
        footer={t('profile_detail')}
        testId="codex-profiles"
      >
        {snapshot.codexProfiles.length === 0 ? (
          <Row>
            <RowText
              detail={
                snapshot.codexProfileSources.length === 0
                  ? t('add_source_for_profile')
                  : t('no_profiles')
              }
            />
          </Row>
        ) : (
          snapshot.codexProfiles.map((profile) => (
            <CodexProfileRow
              key={profile.name}
              profile={profile}
              service={service}
              busy={busy}
              language={language}
              resolvedLanguage={resolvedLanguage}
              onEdit={() => setSheetProfile(profile)}
              onOpen={() => {
                const action = openCodexProfile(profile.name);
                service.mutate(action.operation, action.extra);
              }}
              onRemove={() => {
                const action = removeCodexProfile(profile.name);
                service.mutate(action.operation, action.extra);
              }}
            />
          ))
        )}
        <RowActions>
          <Button
            kind="secondary"
            testId="codex-profile.add"
            disabled={busy.size > 0 || snapshot.codexProfileSources.length === 0}
            onClick={() => setSheetProfile(null)}
          >
            {t('add_profile')}…
          </Button>
        </RowActions>
      </Group>

      {/* Automation Group */}
      <Group
        title={t('automation')}
        footer={t('automation_help')}
      >
        <Row>
          <RowText title={t('create_profiles_automatically')} />
          <RowActions>
            <Switch
              label={t('create_profiles_automatically')}
              checked={autoCreate}
              disabled={busy.size > 0}
              onChange={(enabled) => {
                const profiled = new Set(snapshot.codexProfiles.map((profile) => profile.sourceId));
                const baseline = enabled
                  ? snapshot.codexProfileSources
                      .filter((source) => source.kind === 'account' && profiled.has(source.sourceId))
                      .map((source) => source.sourceId)
                  : [];
                setAutomaticCodexProfileCreation(enabled, baseline);
                setAutoCreate(enabled);
                if (!enabled || busy.size > 0) return;
                const sourceIds = planAutomaticCodexProfileSync(snapshot, false);
                if (sourceIds.length === 0) return;
                const action = syncCodexProfiles(sourceIds);
                service.mutate(action.operation, action.extra);
              }}
            />
          </RowActions>
        </Row>
        {missing.length > 0 ? (
          <Row>
            <RowText
              title={translate('desktop.codex_profile.missing_profiles', language, resolvedLanguage)}
              detail={translate('desktop.codex_profile.missing_profiles_detail', language, resolvedLanguage).replace('{count}', String(missing.length))}
            />
            <RowActions>
              <Button
                kind="secondary"
                disabled={busy.size > 0}
                testId="codex-profile.create-missing"
                onClick={() => {
                  const action = syncCodexProfiles(missing);
                  service.mutate(action.operation, action.extra);
                }}
              >
                {t('create_missing_profiles')}
              </Button>
            </RowActions>
          </Row>
        ) : null}
      </Group>

      {/* Codex Profile Sheet (Modal) */}
      {sheetProfile !== undefined ? (
        <CodexProfileSheet
          profile={sheetProfile}
          sources={snapshot.codexProfileSources}
          existingProfiles={snapshot.codexProfiles}
          busy={busy}
          language={language}
          resolvedLanguage={resolvedLanguage}
          onClose={() => setSheetProfile(undefined)}
          onSave={({ name, sourceId, modelId, transportPolicy, isUpdate }) => {
            if (isUpdate) {
              const action = updateCodexProfile({
                name,
                sourceId,
                modelId,
                transportPolicy,
              });
              service.mutate(action.operation, action.extra);
            } else {
              const action = saveCodexProfile({
                name,
                sourceId,
                modelId,
                transportPolicy,
              });
              service.mutate(action.operation, action.extra);
            }
            setSheetProfile(undefined);
          }}
        />
      ) : null}
    </>
  );
}

function CodexProfileRow({
  profile,
  service,
  busy,
  language,
  resolvedLanguage,
  onEdit,
  onOpen,
  onRemove,
}: {
  profile: CodexProfileRowContract;
  service: ServicePort;
  busy: ReadonlySet<string>;
  language: string;
  resolvedLanguage: string;
  onEdit: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const provider = codexProfileProvider(profile.sourceId);
  const t = (key: string) => translate(`desktop.app_detail.${key}`, language, resolvedLanguage);

  return (
    <Row
      testId={`codex-profile-${profile.name}`}
      data-testid={`codex-profile.row.${profile.name}`}
    >
      <ProviderIcon provider={provider} size={24} className="mr-1.5 flex-none" />
      <RowText title={profile.name} detail={codexProfileSummary(profile, language, resolvedLanguage)} />
      <RowActions>
        <CopyButton
          value={profile.launchCommand}
          label={t('copy_launch_command').replace('{name}', profile.name)}
          copy={service.copy}
          language={language}
          resolvedLanguage={resolvedLanguage}
          disabled={busy.size > 0}
          testId={`codex-profile.copy.${profile.name}`}
        />

        <RowMenu
          label={t('actions_for').replace('{name}', profile.name)}
          language={language}
          resolvedLanguage={resolvedLanguage}
          testId={`codex-profile.more.${profile.name}`}
        >
          {(close) => (
            <>
              {profile.appOpenable ? (
                <MenuItem onSelect={() => {
                    close();
                    onOpen();
                  }}>
                  {t('open_in_codex_app')}
                </MenuItem>
              ) : null}
              <MenuItem onSelect={() => {
                  close();
                  onEdit();
                }}>
                {t('edit_profile')}
              </MenuItem>
              <MenuDivider />
              <MenuItem destructive onSelect={() => {
                  close();
                  onRemove();
                }}>
                {t('remove_profile')}
              </MenuItem>
            </>
          )}
        </RowMenu>
      </RowActions>
    </Row>
  );
}
