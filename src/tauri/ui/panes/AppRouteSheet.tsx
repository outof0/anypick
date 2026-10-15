import { useMemo, useState } from 'react';

import type { ActionRow, ClientModelConfig, Snapshot } from '../lib/contract';
import type { ServiceResult } from '../lib/wire';
import { translate, translateSource } from '../lib/i18n';
import {
  APPLY_PROMISES,
  filteredRouteGroups,
  gatewayProviders,
  hasMatchingConnection,
  modelConfigFor,
  modelScopeProviderName,
  needsModelChoice,
  noConnectionCopy,
  offersModelStep,
  primaryDisabled,
  primaryTitle,
  roleOptions,
  routeGroups,
  showsCancel,
  showsConnectionSearch,
  allRouteOptions,
  type RouteOption,
  type RouteStage,
} from '../lib/app-route';
import { cleanModelDisplayName, friendlyRouteKindLabel, nativeProviderName } from '../lib/model';
import type { ServicePort } from '../lib/service';
import { Dialog } from '../ui/Dialog';
import { Button, Group, PaneActions, Row, RowActions, RowText, Select, WarningGlyph } from '../ui/primitives';
import { ProviderIcon } from '../shell/ProviderIcon';

/** The engine's answer to this client's `model-roles` command. */
export type ModelRolesResult = { clientId: string; result: ServiceResult };

/**
 * `AppRouteSheet`. Choose a connection for one coding app, review what will
 * happen, apply it, then choose models for the connection that is now live.
 *
 * The stages are the macOS ones. The model step is last on purpose: model
 * options are published per connection, so a picker shown before the switch
 * would offer a model the new connection cannot serve.
 */
export function AppRouteSheet({
  clientId,
  rows,
  service,
  snapshot,
  busy = new Set<string>(),
  modelRolesResult = null,
  onClose,
}: {
  clientId: string;
  /** Every action row for this client, from the Apps pane's group. */
  rows: readonly ActionRow[];
  service: ServicePort;
  snapshot: Snapshot;
  busy?: ReadonlySet<string>;
  modelRolesResult?: ModelRolesResult | null;
  onClose: () => void;
}) {
  const language = snapshot.settings.language;
  const resolvedLanguage = snapshot.settings.resolvedLanguage;
  const t = (key: string) => translate(`desktop.app_route.${key}`, language, resolvedLanguage);
  const tc = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  // A gateway ref names the gateway, not the vendor behind it, so the brand a
  // gateway row wears is resolved here from the snapshot rather than guessed.
  const gateways = useMemo(() => gatewayProviders(snapshot.gateways), [snapshot.gateways]);
  const groups = useMemo(() => routeGroups(rows, (id) => gateways.get(id)), [rows, gateways]);
  const config = modelConfigFor(snapshot, clientId);
  const showModels = offersModelStep(config);

  const [stage, setStage] = useState<RouteStage>('connection');
  const [routeId, setRouteId] = useState('');
  const [needle, setNeedle] = useState('');
  const [scope, setScope] = useState<'connection' | 'provider'>('connection');
  const [values, setValues] = useState<Record<string, string>>({});

  const selected = groups.current?.id === routeId
    ? groups.current
    : allRouteOptions(groups).find((option) => option.id === routeId) ?? null;
  const providerName = modelScopeProviderName(selected);
  const needsModels = needsModelChoice(config);

  const advance = () => {
    if (stage === 'connection') {
      // Review first, always. An apply button on the selection step would let
      // one click rewrite an app's settings with no summary of what changes.
      setStage('review');
      return;
    }
    if (stage === 'models') {
      saveModels();
      return;
    }
    if (stage === 'review' || stage === 'recovery') {
      setStage('applying');
      // The engine answers with a snapshot; the result frame carries success.
      // A failure returns the user to Try Again rather than closing on a lie.
      service.invokeAction(routeId, snapshot.revision);
      return;
    }
    onClose();
  };

  /*
   * The sheet closes on the engine's answer, not on the click. Closing first
   * would leave the user mid-flow with a choice on screen and no word about a
   * command the engine had refused — and the choice they made would look
   * applied, which is the one thing it is not.
   */
  const savingModels = modelRolesResult?.clientId === clientId;
  const modelError =
    savingModels && modelRolesResult?.result.status === 'error' ? modelRolesResult.result.message : '';

  const saveModels = () => {
    if (!config) return;
    // The engine requires a complete map, not one role: sending only the role
    // the user touched would clear every other pin. An empty role falls back to
    // whatever the connection already had.
    const roleActionIds: Record<string, string> = {};
    for (const role of config.roles) {
      const chosen = values[role.id] ?? config.modelRoles[role.id] ?? '';
      if (chosen) roleActionIds[role.id] = chosen;
    }
    if (Object.keys(roleActionIds).length > 0 && !roleActionIds.default) return;
    service.setModelRoles(clientId, roleActionIds, snapshot.revision, scope);
  };

  const disabled = primaryDisabled({
    routeId,
    currentRouteId: groups.current?.id ?? '',
    stage,
    busy: busy.size > 0,
    applying: stage === 'applying',
    awaitingModelSave: stage === 'models' && savingModels,
  });

  return (
    <Dialog
      title={t('change_title').replace(
        '{app}',
        rows[0]?.client ?? translate('desktop.app_detail.the_app', language, resolvedLanguage),
      )}
      onCancel={onClose}
      testId={`app-route.stage.${stage}`}
      width="form"
      actions={
        <>
          {showsCancel(stage) ? (
            <Button kind="secondary" onClick={onClose}>
              {tc('cancel')}
            </Button>
          ) : null}
          <Button
            kind="primary"
            testId={`app-route.primary.${stage}`}
            disabled={disabled}
            onClick={advance}
          >
            {savingModels && stage === 'models'
              ? translate('desktop.codex_profile.saving', language, resolvedLanguage)
              : tr(primaryTitle(stage, needsModels && stage === 'success'))}
          </Button>
        </>
      }
    >
      {stage === 'connection' ? (
        <ConnectionStage
          groups={groups}
          filtered={filteredRouteGroups(groups, needle)}
          routeId={routeId}
          onPick={setRouteId}
          needle={needle}
          onNeedle={setNeedle}
          showSearch={showsConnectionSearch(groups)}
          busy={busy.size > 0}
          language={language}
          resolvedLanguage={resolvedLanguage}
        />
      ) : null}

      {stage === 'review' ? (
        <ReviewStage from={groups.current} to={selected} language={language} resolvedLanguage={resolvedLanguage} />
      ) : null}

      {stage === 'applying' ? (
        <Group title={t('applying')}>
          <Row>
            <RowText
              title={t('applying')}
              detail={t('keep_open_help')}
            />
          </Row>
        </Group>
      ) : null}

      {stage === 'models' && config ? (
        <ModelStage
          config={config}
          values={values}
          onValue={(roleId, value) => setValues((current) => ({ ...current, [roleId]: value }))}
          scope={scope}
          onScope={setScope}
          providerName={providerName}
          publishedBy={selected?.label ?? t('current_connection')}
          error={modelError}
          language={language}
          resolvedLanguage={resolvedLanguage}
        />
      ) : null}
    </Dialog>
  );
}

function ConnectionStage({
  groups,
  filtered,
  routeId,
  onPick,
  needle,
  onNeedle,
  showSearch,
  busy,
  language,
  resolvedLanguage,
}: {
  groups: ReturnType<typeof routeGroups>;
  filtered: ReturnType<typeof routeGroups>;
  routeId: string;
  onPick: (id: string) => void;
  needle: string;
  onNeedle: (value: string) => void;
  showSearch: boolean;
  busy: boolean;
  language: string;
  resolvedLanguage: string;
}) {
  const t = (key: string) => translate(`desktop.app_route.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  const total = allRouteOptions(groups).length;
  return (
    <>
      {showSearch ? (
        <Group title={translate('desktop.common.search', language, resolvedLanguage)}>
          <Row>
            <RowText title={t('search_connections')} />
            <RowActions>
              <input
                className="min-h-control max-w-55 min-w-40 rounded-control border border-control-border bg-field px-2 text-[12px] text-text"
                type="search"
                value={needle}
                aria-label={t('search_connections')}
                data-testid="app-route.search"
                onChange={(event) => onNeedle(event.target.value)}
              />
            </RowActions>
          </Row>
        </Group>
      ) : null}

      {filtered.current ? (
        <Group
          title={t('current_connection')}
          footer={t('choose_source_help')}
        >
          <RouteRow
            option={filtered.current}
            selected={routeId === filtered.current.id}
            current
            disabled={busy}
            onPick={onPick}
            language={language}
            resolvedLanguage={resolvedLanguage}
          />
        </Group>
      ) : null}

      {filtered.accounts.length > 0 ? (
        <Group title={translate('desktop.accounts.accounts', language, resolvedLanguage)}>
          {filtered.accounts.map((option) => (
            <RouteRow
              key={option.id}
              option={option}
              selected={routeId === option.id}
              disabled={busy || !option.enabled}
              onPick={onPick}
              language={language}
              resolvedLanguage={resolvedLanguage}
            />
          ))}
        </Group>
      ) : null}

      {filtered.hub ? (
        <Group title={t('proxy_hub')}>
          <RouteRow
            option={filtered.hub}
            selected={routeId === filtered.hub.id}
            disabled={busy || !filtered.hub.enabled}
            onPick={onPick}
            language={language}
            resolvedLanguage={resolvedLanguage}
          />
        </Group>
      ) : null}

      {filtered.gateways.length > 0 ? (
        <Group title={t('api_gateways')}>
          {filtered.gateways.map((option) => (
            <RouteRow
              key={option.id}
              option={option}
              selected={routeId === option.id}
              disabled={busy || !option.enabled}
              onPick={onPick}
              language={language}
              resolvedLanguage={resolvedLanguage}
            />
          ))}
        </Group>
      ) : null}

      {!hasMatchingConnection(filtered) ? (
        <Group title={t('no_connections')}>
          <Row>
            <RowText detail={tr(noConnectionCopy({ totalOptions: total, needle }))} />
          </Row>
        </Group>
      ) : null}
    </>
  );
}

/**
 * The glyph each kind of source wears.
 *
 * macOS draws the real provider brand here (`DesignProviderIcon`). A webview
 * has no brand asset for a provider the app was never built with, and falling
 * back to one generic circle for all three kinds makes the groups
 * indistinguishable. The hub's own dotted triangle is exact, so it is used; the
 * other two take the destination glyphs the sidebar already ships, which is the
 * honest approximation rather than a wrong brand mark.
 */
const SYMBOL_FOR_KIND: Record<RouteOption['kind'], string> = {
  hub: 'point.3.connected.trianglepath.dotted',
  account: 'person.2',
  gateway: 'network',
};

/** One connection option. macOS renders it as a plain button, not a switch. */
function RouteRow({
  option,
  selected,
  current = false,
  disabled,
  onPick,
  language,
  resolvedLanguage,
}: {
  option: RouteOption;
  selected: boolean;
  current?: boolean;
  disabled: boolean;
  onPick: (id: string) => void;
  language: string;
  resolvedLanguage: string;
}) {
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  const currentLabel = translate('desktop.common.current', language, resolvedLanguage);
  return (
    // The whole row is the target, not just the radio. macOS uses a
    // `.radioGroup` inside a `Form`, where the row and its control are one
    // thing; leaving only the 14px dot clickable made picking a connection a
    // precision task for no reason.
    <Row
      testId={`app-route.option.${option.id}`}
      warning={Boolean(option.disabledReason)}
      onClick={disabled ? undefined : () => onPick(option.id)}
    >
      {/*
        The provider's own mark where there is one, and the kind's glyph where
        the source is not a provider (the hub). macOS does exactly this:
        `DesignProviderIcon(provider:fallbackSymbol:)`, where the fallback is
        the kind's symbol.
      */}
      <span className="grid size-[22px] flex-none place-items-center text-secondary">
        <ProviderIcon provider={option.providerId ?? ''} fallbackSymbol={SYMBOL_FOR_KIND[option.kind]} size={18} />
      </span>
      <RowText
        title={tr(option.label)}
        detail={tr(option.detail)}
        issue={tr(option.disabledReason ?? '')}
        language={language}
        resolvedLanguage={resolvedLanguage}
      />
      <RowActions>
        {current ? (
          <span className="text-[12px] whitespace-nowrap text-secondary">{currentLabel}</span>
        ) : (
          <span className="text-[12px] whitespace-nowrap text-secondary">
            {tr(friendlyRouteKindLabel(option.kind === 'hub' ? 'hub' : option.kind === 'gateway' ? 'gateway' : 'account'))}
          </span>
        )}
        <input
          type="radio"
          name="app-route"
          className="m-0 size-[14px] accent-accent"
          checked={selected}
          disabled={disabled}
          aria-label={option.detail ? tr(`${option.label}, ${option.detail}`) : tr(option.label)}
          onChange={() => onPick(option.id)}
        />
      </RowActions>
    </Row>
  );
}

function ReviewStage({
  from,
  to,
  language,
  resolvedLanguage,
}: {
  from: RouteOption | null;
  to: RouteOption | null;
  language: string;
  resolvedLanguage: string;
}) {
  const t = (key: string) => translate(`desktop.app_route.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  return (
    <>
      <Group title={translate('desktop.app_detail.connection', language, resolvedLanguage)}>
        <Row>
          <RowText title={t('from')} detail={from?.label ?? translate('desktop.app_detail.not_selected', language, resolvedLanguage)} />
        </Row>
        <Row>
          <RowText title={t('to')} detail={to?.label ?? translate('desktop.app_detail.not_selected', language, resolvedLanguage)} />
        </Row>
      </Group>
      <Group title={t('anypick_will')}>
        {APPLY_PROMISES.map((promise) => (
          <Row key={promise.title} testId={`app-route.apply-error.${promise.title}`}>
            <RowText title={tr(promise.title)} detail={tr(promise.detail)} />
          </Row>
        ))}
      </Group>
      <Group title={translate('desktop.app_detail.models', language, resolvedLanguage)}>
        <Row>
          <RowText detail={t('models_preserved')} />
        </Row>
      </Group>
    </>
  );
}

function ModelStage({
  config,
  values,
  onValue,
  scope,
  onScope,
  providerName,
  publishedBy,
  error,
  language,
  resolvedLanguage,
}: {
  config: ClientModelConfig;
  values: Record<string, string>;
  onValue: (roleId: string, value: string) => void;
  scope: 'connection' | 'provider';
  onScope: (value: 'connection' | 'provider') => void;
  providerName: string | null;
  publishedBy: string;
  /** The engine's refusal, shown in place rather than as a banner. */
  error?: string;
  language: string;
  resolvedLanguage: string;
}) {
  const t = (key: string) => translate(`desktop.app_route.${key}`, language, resolvedLanguage);
  const tm = (key: string) => translate(`desktop.models.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  return (
    <Group
      title={translate('desktop.app_detail.models', language, resolvedLanguage)}
      footer={t('models_published_by').replace('{route}', publishedBy)}
      testId="app-route.models"
    >
      {providerName ? (
        <Row testId="models.scope">
          <RowText title={tm('applies_to')} />
          <RowActions>
            <Select
              label=""
              value={scope}
              testId="app-route.models.scope"
              onChange={(value) => onScope(value === 'provider' ? 'provider' : 'connection')}
              options={[
                { value: 'connection', label: tm('this_connection') },
                { value: 'provider', label: tm('all_provider_accounts').replace('{provider}', providerName) },
              ]}
            />
          </RowActions>
        </Row>
      ) : null}
      {config.roles.map((role) => (
        <Row key={role.id} testId={`app-route.option.model.${role.id}`}>
          <RowText title={role.label} />
          <RowActions>
            <Select
              label=""
              value={values[role.id] ?? config.modelRoles[role.id] ?? ''}
              testId={`app-route.models.${role.id}`}
              onChange={(value) => onValue(role.id, value)}
              options={roleOptions(config, role.id).map((option) => ({
                ...option,
                label: option.value === '' ? tr(option.label) : cleanModelDisplayName(option.label),
              }))}
            />
          </RowActions>
        </Row>
      ))}
      {/* The refusal sits under the pickers it is about, not in a banner over
          them: a toast over a dialog covers the fields the user has to fix. */}
      {error ? (
        <Row testId="app-route.models.error" warning>
          <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
          <RowText detail={tr(error)} />
        </Row>
      ) : null}
    </Group>
  );
}
