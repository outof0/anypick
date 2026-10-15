import { useEffect, useMemo, useState } from 'react';
import { Symbol } from '../shell/Symbol';

import type { HubConflict, HubSource, ProxyRow, Snapshot } from '../lib/contract';
import { hubSourceChange } from '../lib/desktop-actions';
import {
  catalogModelCount,
  hubProxy,
  hubSourceDetail,
  hubSourceRows,
  isGhost,
  publishedSummary,
  uniqueProviderCandidates,
  type HubRotationRow,
} from '../lib/hub';
import { parseModelIdentity } from '../lib/published';
import type { ServicePort } from '../lib/service';
import type { ServiceResult } from '../lib/wire';
import { translate, translateSource } from '../lib/i18n';
import { ProviderIcon } from '../shell/ProviderIcon';
import { MenuItem, RowMenu } from '../ui/RowMenu';
import { ConfirmDialog } from './ProxiesPane';
import { Dialog } from '../ui/Dialog';
import {
  Button,
  CopyButton,
  EmptyState,
  Group,
  IconButton,
  Pane,
  Row,
  RowActions,
  RowText,
  Select,
  StatusLabel,
  Switch,
  useCopyConfirmation,
  WarningGlyph,
} from '../ui/primitives';
import { SegmentedControl } from '../ui/SegmentedControl';

/** The engine's refusal of a hub source toggle, and which row sent it. */
export type HubRowResult = { operation: string; result: ServiceResult };

/**
 * Proxy Hub: the service, its sources, and what it publishes.
 *
 * The service is a button, not a switch. The README puts lifecycle in the
 * Service row because a hub is started and stopped; a switch said "policy",
 * and the pane this replaced had neither the button nor the address.
 *
 * Every number here comes from the snapshot. macOS compiled its own routing
 * conflicts and published-model list from the catalogs; the Tauri app reads the
 * same fields the engine already publishes, so a conflict resolved in macOS
 * disappears here without a second compiler.
 */
export function ProxyHubPane({
  service,
  snapshot,
  query = '',
  busy = new Set<string>(),
  copyKeyResult = null,
  hubRowResult = null,
  onNavigate,
  onOpenModels,
}: {
  service: ServicePort;
  snapshot: Snapshot;
  query?: string;
  busy?: ReadonlySet<string>;
  /** Completion of a protected API-key copy request. */
  copyKeyResult?: { requestId: string; success: boolean | null } | null;
  /** The last refused source toggle, so the row that sent it can say so. */
  hubRowResult?: HubRowResult | null;
  onNavigate?: (destination: 'accounts' | 'proxies') => void;
  /** Opens Published Models, which the hub's own row leads to on macOS. */
  onOpenModels?: () => void;
}) {
  const t = (key: string) =>
    translate(`desktop.hub.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tc = (key: string) =>
    translate(`desktop.common.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tn = (key: string) =>
    translate(`desktop.nav.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const ta = (key: string) =>
    translate(`desktop.accounts.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tr = (source: string) =>
    translateSource(source, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const [copyRequestId, setCopyRequestId] = useState<string | null>(null);
  const copyConfirmation = useCopyConfirmation();
  useEffect(() => {
    if (!copyRequestId) return;
    if (copyKeyResult?.requestId === copyRequestId) {
      if (copyKeyResult.success === null) return;
      copyConfirmation.report(copyKeyResult.success);
      setCopyRequestId(null);
      return;
    }
    if (!busy.has(copyRequestId)) {
      copyConfirmation.report(false);
      setCopyRequestId(null);
    }
  }, [busy, copyKeyResult, copyConfirmation.report, copyRequestId]);

  const needle = query.trim().toLocaleLowerCase();
  const hub = hubProxy(snapshot.proxies);
  const rows = hubSourceRows(snapshot.hubSources);

  const sources = rows.accounts.filter((source) => {
    const haystack = `${source.label} ${source.detail} ${source.name}`.toLocaleLowerCase();
    return !needle || haystack.includes(needle);
  });
  const rotations = rows.rotation.filter((source) => {
    const haystack = `${source.label} ${source.detail}`.toLocaleLowerCase();
    return !needle || haystack.includes(needle);
  });

  const enabledSources = rows.accounts.filter((source) => source.enabled && !isGhost(source));
  const actionable = snapshot.hubConflicts.filter(
    (conflict) => uniqueProviderCandidates(conflict).length >= 2,
  );
  const published = publishedSummary(snapshot.hubPublishedModels, enabledSources.length);
  const publishedSummaryText = snapshot.hubPublishedModels.length > 0
    ? `${t(snapshot.hubPublishedModels.length === 1 ? 'model_count' : 'models_count').replace('{count}', String(snapshot.hubPublishedModels.length))} ${t('models_published')}`
    : enabledSources.length === 0 ? t('no_accounts_on') : t('no_models_published');
  const footer = actionable.length > 0
    ? t('footer_conflicts')
    : !hub?.enabled
      ? t('footer_turn_on')
      : !hub.running
        ? enabledSources.length === 0 ? t('footer_turn_on_start') : t('footer_enabled_not_serving')
        : snapshot.hubPublishedModels.length === 0
          ? t('footer_no_source_serves')
          : snapshot.hubPublishedModels.length === 1
            ? t('footer_one_model')
            : t('footer_models_on_address').replace('{count}', String(snapshot.hubPublishedModels.length));
  const hubSubtitle = !hub
    ? translate('desktop.overview.status_not_set', snapshot.settings.language, snapshot.settings.resolvedLanguage)
    : hub.running
      ? `${translate('desktop.overview.status_running', snapshot.settings.language, snapshot.settings.resolvedLanguage)}${hub.address ? ` · ${hub.address}` : ''}`
      : hub.enabled ? t('status_enabled_not_serving') : translate('desktop.overview.status_stopped', snapshot.settings.language, snapshot.settings.resolvedLanguage);

  const [pendingRotate, setPendingRotate] = useState(false);

  return (
    <Pane title={tn('proxy_hub')} testId="proxy-hub">
      {hub ? (
        <Group title={t('service')} footer={footer} testId="hub.service">
          <Row testId="hub-service-row">
            {/* The same shape as a per-account relay row
                (`ProxyHubView.swift:23`): identity, the service's state in the
                subtitle, one trailing lifecycle button. This row carried a
                status dot *and* a subtitle saying "Running", plus Restart and
                Rotate — four controls where macOS has one and a context menu.
                Rotate also has a home already: the API Key row below. */}
            <ProviderIcon
              provider="proxy-hub"
              fallbackSymbol="point.3.connected.trianglepath.dotted"
              size={22}
              className="mr-1 text-secondary"
            />
            <RowText title={hub.label || tn('proxy_hub')} detail={hubSubtitle} />
            <RowActions>
              {hub.running ? (
                <RowMenu
                  label={ta('more_actions_for').replace('{name}', hub.label || tn('proxy_hub'))}
                  language={snapshot.settings.language}
                  resolvedLanguage={snapshot.settings.resolvedLanguage}
                  testId="hub.more"
                >
                  {(close) => (
                    <MenuItem
                      testId="hub.restart"
                      disabled={!hub.restartActionId || busy.size > 0 || !hub.enabled}
                      onSelect={() => {
                        close();
                        service.invokeAction(hub.restartActionId ?? '', snapshot.revision);
                      }}
                    >
                      {t('restart_hub')}
                    </MenuItem>
                  )}
                </RowMenu>
              ) : null}
              <Button
                kind={hub.running ? 'destructive' : 'secondary'}
                testId="hub.service-actions"
                disabled={!hub.toggleActionId || busy.size > 0}
                ariaLabel={`${hub.running ? tc('stop') : tc('start')} ${hub.label || tn('proxy_hub')}`}
                onClick={() => service.invokeAction(hub.toggleActionId ?? '', snapshot.revision)}
              >
                {hub.running ? tc('stop') : tc('start')}
              </Button>
            </RowActions>
          </Row>

          <Row testId="hub.copy-address">
            <RowText title={tc('address')} detail={hub.address ?? translate('desktop.proxies.not_running', snapshot.settings.language, snapshot.settings.resolvedLanguage)} />
            <RowActions>
              {hub.address ? (
                <CopyButton
                  label={`${tc('copy_address')} ${tn('proxy_hub')}`}
                  testId="hub.copy-address-button"
                  value={hub.address ?? ''}
                  copy={service.copy}
                  language={snapshot.settings.language}
                  resolvedLanguage={snapshot.settings.resolvedLanguage}
                />
              ) : null}
            </RowActions>
          </Row>

          {hub.hasToken ? (
            <Row testId="hub.copy-api-key">
              <RowText
                title={tc('api_key')}
                detail={t('hidden_key')}
              />
              <RowActions>
                <IconButton
                  label={t('copy_key')}
                  language={snapshot.settings.language}
                  resolvedLanguage={snapshot.settings.resolvedLanguage}
                  testId="hub.copy-api-key-button"
                  phase={copyConfirmation.phase}
                  confirmed={<Symbol name="checkmark" size={13} />}
                  disabled={busy.size > 0}
                  onClick={() => {
                    if (!copyConfirmation.begin()) return;
                    setCopyRequestId(copyHubKey(service, hub));
                  }}
                >
                  <Symbol name="doc.on.doc" size={15} />
                </IconButton>
                <IconButton
                  label={t('rotate_key_button')}
                  language={snapshot.settings.language}
                  resolvedLanguage={snapshot.settings.resolvedLanguage}
                  testId="hub-rotate-api-key"
                  onClick={() => setPendingRotate(true)}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                    <path
                      d="M4 12a8 8 0 0 1 14-5 M20 12a8 8 0 0 1-14 5 M18 3v4h-4 M6 21v-4h4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </IconButton>
              </RowActions>
            </Row>
          ) : null}

          <Row
            testId="hub.models"
            onClick={snapshot.hubPublishedModels.length > 0 ? () => onOpenModels?.() : undefined}
          >
            <RowText title={t('published_models')} />
            <RowActions>
              <span className="text-[12px] whitespace-nowrap text-secondary">
                {publishedSummaryText}
                {published.needsChoice > 0 ? (
                  <span className="ml-1 text-[11px] text-tertiary">
                    · {published.needsChoice} {t('need_choice')}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="inline-flex size-5 cursor-default items-center justify-center text-tertiary hover:not-disabled:text-text disabled:opacity-30"
                data-testid="hub-open-models"
                aria-label={t('published_models')}
                title={t('published_models')}
                disabled={snapshot.hubPublishedModels.length === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenModels?.();
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </RowActions>
          </Row>
        </Group>
      ) : (
        <EmptyState
          title={t('unavailable')}
          detail={t('unavailable_detail')}
          testId="proxy-hub-empty"
        />
      )}

      {actionable.length > 0 ? (
        <Group
          title={t('conflicts')}
          footer={t('conflict_footer')}
          testId="hub-conflicts"
        >
          {actionable.map((conflict) => (
            <ConflictRow
              key={conflict.id}
              conflict={conflict}
              t={t}
              tr={tr}
              revision={snapshot.revision}
              service={service}
              busy={busy}
            />
          ))}
        </Group>
      ) : null}

      {rotations.length > 0 ? (
        <Group
          title={t('request_strategy')}
          footer={t('strategy_footer')}
          testId="hub-strategy"
        >
          {rotations.map((rotation) => (
            <StrategyRow
              key={rotation.id}
              rotation={rotation}
              t={t}
              language={snapshot.settings.language}
              resolvedLanguage={snapshot.settings.resolvedLanguage}
              service={service}
              busy={busy}
              error={tr(rowError(hubRowResult, `hub.strategy.${rotation.hub}`) ?? '')}
            />
          ))}
        </Group>
      ) : null}

      {sources.length === 0 && rotations.length === 0 ? (
        <EmptyState
          title={needle ? t('no_results') : t('no_sources')}
          detail={
            needle
              ? t('no_sources_match')
              : t('no_sources_detail')
          }
          actionTitle={needle ? undefined : tn('accounts')}
          onAction={needle ? undefined : () => onNavigate?.('accounts')}
          testId="proxy-hub-no-sources"
        />
      ) : sources.length > 0 ? (
        <Group
          title={t('accounts_enabled').replace('{enabled}', String(enabledSources.length)).replace('{total}', String(rows.accounts.length))}
          footer={t('accounts_footer')}
          testId="proxy-hub-sources"
        >
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              t={t}
              tr={tr}
              language={snapshot.settings.language}
              resolvedLanguage={snapshot.settings.resolvedLanguage}
              catalogs={snapshot.hubCatalogs}
              service={service}
              busy={busy}
              error={tr(rowError(hubRowResult, `hub.account.${source.id}`) ?? '')}
            />
          ))}
        </Group>
      ) : null}

      {pendingRotate && hub?.rotateActionId ? (
        <ConfirmDialog
          title={t('rotate_title')}
          message={t('rotate_message')}
          confirmTitle={tc('rotate_key')}
          cancelTitle={tc('cancel')}
          destructive
          testId="hub-rotate-dialog"
          onCancel={() => setPendingRotate(false)}
          onConfirm={() => {
            setPendingRotate(false);
            service.invokeAction(hub.rotateActionId ?? '', snapshot.revision);
          }}
        />
      ) : null}
    </Pane>
  );
}

/**
 * A hub proxy row has no `status` field of its own: it is the engine's own
 * liveness check against the hub's health echo, published as `running`. A hub
 * that is enabled but not answering is the one case worth a second colour,
 * because Start is the action that fixes it.
 */
function hubStatus(hub: ProxyRow): 'running' | 'attention' | 'stopped' {
  if (hub.running) return 'running';
  return hub.enabled ? 'attention' : 'stopped';
}

function copyHubKey(service: ServicePort, hub: ProxyRow): string {
  // The engine mints the key on request and returns it in the result payload.
  // Nothing here reads or stores it; App copies it and names the action only.
  return service.mutate('proxy-token', { providerId: hub.providerId, name: hub.id.split('/').slice(1).join('/') });
}

/**
 * The refusal for one row, if the last answer belongs to it.
 *
 * A banner would say something failed without saying which switch is now in a
 * state the user did not choose. Each row's id is the row key, so an answer for
 * a source the user cannot see is not shown on one they can.
 */
function rowError(result: HubRowResult | null, rowKey: string): string | undefined {
  if (!result || result.result.status !== 'error') return undefined;
  return result.result.message || undefined;
}

function SourceRow({
  source,
  t,
  tr,
  language,
  resolvedLanguage,
  catalogs,
  service,
  busy,
  error,
}: {
  source: HubSource;
  t: (key: string) => string;
  tr: (source: string) => string;
  language: string;
  resolvedLanguage: string;
  catalogs: Snapshot['hubCatalogs'];
  service: ServicePort;
  busy: ReadonlySet<string>;
  error?: string;
}) {
  const ghost = isGhost(source);
  const rawDetail = hubSourceDetail(source, catalogs);
  const detail = rawDetail === 'Excluded from Hub'
    ? t('excluded')
    : rawDetail.replace(/ · (\d+) models?$/u, (_match, count: string) =>
        ` · ${t(Number(count) === 1 ? 'model_count' : 'models_count').replace('{count}', count)}`,
      );
  const models = catalogModelCount(catalogs, source.id);

  return (
    <Row warning={ghost} testId={`hub.account.${source.id}`}>
      <RowText
        title={source.label || source.name}
        detail={detail === 'Excluded from Hub' ? t('excluded') : tr(detail)}
        issue={ghost ? tr(source.unavailableReason ?? '') : undefined}
        language={language}
        resolvedLanguage={resolvedLanguage}
      />
      {error ? (
        <span className="flex items-center gap-1 text-[12px] text-orange" data-testid={`hub.account.${source.id}.error`}>
          <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
          {tr(error ?? '')}
        </span>
      ) : null}
      <RowActions>
        {models > 0 ? <span className="text-[12px] whitespace-nowrap text-secondary">{models}</span> : null}
        {ghost ? (
          <span className="text-[12px] whitespace-nowrap text-secondary">{t('unavailable_source')}</span>
        ) : (
          <Switch
            checked={source.enabled}
            disabled={busy.size > 0}
            label={`${source.enabled ? t('disable') : t('enable')} ${source.label || source.name}`}
            onChange={(enabled) => {
              const action = hubSourceChange({ hub: source.hub, source, enabled });
              service.mutate(action.operation, action.extra);
            }}
          />
        )}
      </RowActions>
    </Row>
  );
}

function StrategyRow({
  rotation,
  t,
  language,
  resolvedLanguage,
  service,
  busy,
  error,
}: {
  rotation: HubRotationRow;
  t: (key: string) => string;
  language: string;
  resolvedLanguage: string;
  service: ServicePort;
  busy: ReadonlySet<string>;
  error?: string;
}) {
  const count = 'accountCount' in rotation ? (rotation.accountCount as number) : 0;
  return (
    <Row testId={`hub.strategy.${rotation.hub}`} warning={count < 2}>
      <RowText
        title={t('strategy')}
        issue={count < 2 ? t('strategy_needs_accounts') : undefined}
        language={language}
        resolvedLanguage={resolvedLanguage}
      />
      {error ? (
        <span
          className="flex items-center gap-1 text-[12px] text-orange"
          data-testid={`hub.strategy.${rotation.hub}.error`}
        >
          <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
          {error}
        </span>
      ) : null}
      <RowActions>
        <SegmentedControl
          value={rotation.enabled ? 'round-robin' : 'failover'}
          testId={`hub.strategy.${rotation.hub}`}
          disabled={busy.size > 0 || count < 2}
          options={[
            { value: 'failover', label: t('failover') },
            { value: 'round-robin', label: t('round_robin') },
          ]}
          onChange={(value) => {
            const action = hubSourceChange({
              hub: rotation.hub,
              source: rotation,
              enabled: value === 'round-robin',
            });
            service.mutate(action.operation, action.extra);
          }}
        />
      </RowActions>
    </Row>
  );
}

function ConflictRow({
  conflict,
  t,
  tr,
  revision,
  service,
  busy,
}: {
  conflict: HubConflict;
  t: (key: string) => string;
  tr: (source: string) => string;
  revision: number;
  service: ServicePort;
  busy: ReadonlySet<string>;
}) {
  const candidates = uniqueProviderCandidates(conflict);
  const info = useMemo(() => {
    const modelNames = (conflict.models ?? []).map((modelID) =>
      parseModelIdentity(modelID, conflict.candidates[0]?.providerId ?? '').cleanName,
    );
    let title = conflict.title;
    if (modelNames.length === 1) {
      title = t('conflict_two_owners').replace('{model}', modelNames[0]);
    } else if (modelNames.length === 2) {
      title = t('conflict_pair_need_provider')
        .replace('{first}', modelNames[0])
        .replace('{second}', modelNames[1]);
    } else if (modelNames.length > 2) {
      title = t('conflict_many_need_provider')
        .replace('{count}', String(modelNames.length))
        .replace('{first}', modelNames[0])
        .replace('{second}', modelNames[1])
        .replace('{more}', String(modelNames.length - 2));
    }
    const providers = uniqueProviderCandidates(conflict)
      .map((candidate) => candidate.label || candidate.providerId)
      .join(', ');
    return { title, subtitle: providers ? t('available_via').replace('{providers}', providers) : '' };
  }, [conflict, t]);
  const busyHere = busy.size > 0;
  const conflictModelId = conflict.models?.[0] ?? conflict.title;
  const parsed = useMemo(
    () => parseModelIdentity(conflictModelId, conflict.candidates?.[0]?.providerId ?? ''),
    [conflictModelId, conflict.candidates],
  );

  return (
    <Row testId={`hub.conflict.${conflict.id}`}>
      <ProviderIcon provider={parsed.vendorKey} fallbackSymbol="cube.transparent" size={20} className="mr-1 text-secondary" />
      <RowText title={<span className="font-mono text-[12px]">{tr(info.title)}</span>} detail={info.subtitle} />
      <RowActions>
        <Select
          label=""
          testId={`hub.conflict.${conflict.id}.picker`}
          disabled={busyHere || candidates.length === 0}
          value=""
          onChange={(actionId) => {
            // A select that emits its own value as a placeholder would send
            // "Choose provider…" to the engine. The empty value is the
            // unchosen state, so an empty change is ignored instead.
            if (!actionId) return;
            service.invokeAction(actionId, revision);
          }}
          options={[
            { value: '', label: t('select_provider') },
            ...candidates.map((candidate) => ({ value: candidate.actionId, label: candidate.label })),
          ]}
        />
      </RowActions>
    </Row>
  );
}

