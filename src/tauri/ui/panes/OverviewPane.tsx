import { useState } from 'react';

import type { Destination, Snapshot } from '../lib/contract';
import type { DoctorFrame } from '../lib/wire';
import {
  isOnboardingCoreComplete,
  overviewApps,
  overviewTransportLabel,
} from '../lib/overview';
import {
  disambiguatedProxyNames,
  overviewAttentionTarget,
  overviewServiceTotal,
  proxyStatus,
} from '../lib/model';
import { translate, translateSource } from '../lib/i18n';
import { Chevron } from '../ui/Chevron';
import { ProviderIcon } from '../shell/ProviderIcon';
import { Symbol } from '../shell/Symbol';
import { Button, Group, Pane, PaneActions, Row, RowActions, RowText, WarningGlyph } from '../ui/primitives';

export const ONBOARDING_KEY = 'anypick.onboardingDismissed';

type OverviewMessage = (key: string) => string;
type OverviewAppRow = ReturnType<typeof overviewApps>['listed'][number];

function localizedConnectionSummary(
  app: OverviewAppRow,
  t: OverviewMessage,
  tr: (source: string) => string,
): string {
  if (app.selected?.label) return t('uses_account').replace('{name}', app.selected.label);
  if (app.selected?.detail) return tr(app.selected.detail);
  return t('no_login_chosen');
}

function localizedTransportLabel(label: string, t: OverviewMessage): string {
  const key = label === 'Not Configured'
    ? 'not_configured'
    : label === 'Gateway'
    ? 'gateway'
    : label === 'Proxy Hub'
    ? 'hub_transport'
    : label === 'AnyPick proxy'
    ? 'anypick_proxy'
    : label === 'Direct'
    ? 'direct'
    : null;
  return key ? t(key) : label;
}

function localizedStatusLabel(status: string, t: OverviewMessage): string {
  const key = status === 'running'
    ? 'status_running'
    : status === 'attention'
    ? 'status_attention'
    : status === 'unavailable'
    ? 'status_unavailable'
    : status === 'stopped'
    ? 'status_stopped'
    : 'status_ready';
  return t(key);
}

function localizedDoctorStatusLabel(status: string, t: OverviewMessage): string {
  const key = status === 'ok'
    ? 'status_ok'
    : status === 'degraded'
    ? 'status_warn'
    : status === 'unhealthy'
    ? 'status_fail'
    : status === 'not-set'
    ? 'status_not_set'
    : null;
  return key ? t(key) : status;
}

function localizedDoctorCheck(check: string, t: OverviewMessage): string {
  const keys: Record<string, string> = {
    client: 'check_client',
    route: 'check_route',
    proxy: 'check_proxy',
    'proxy-environment': 'check_proxy_environment',
    database: 'check_database',
    permissions: 'check_permissions',
    'active-binding': 'check_active_binding',
    'duplicate-snapshot': 'check_duplicate_snapshot',
    'named-profile': 'check_named_profile',
    'plugin-host': 'check_plugin_host',
  };
  const key = keys[check];
  if (key) return t(key);
  if (check.startsWith('plugin:')) return t('check_plugin').replace('{name}', check.slice('plugin:'.length));
  return check.replaceAll('-', ' ');
}

/**
 * Overview: attention first, then the checklist, then a summary.
 *
 * The pane's job is to name the single most useful next action, not to
 * summarize everything. `overviewAttentionTarget` picks that one thing in a
 * fixed order, so the call to action never contradicts itself between
 * refreshes.
 *
 * Diagnostics are the one engine request on this pane; they are read-only and
 * stay here so Settings remains a preferences pane.
 */
export function OverviewPane({
  snapshot,
  onNavigate,
  onRefresh,
  doctor,
  doctorError,
  onRunDoctor,
  busy,
}: {
  snapshot: Snapshot;
  onNavigate?: (destination: Destination) => void;
  /** Ask the engine for a fresh snapshot. */
  onRefresh?: () => void;
  /** Latest read-only installation diagnosis, if one has been run. */
  doctor?: DoctorFrame | null;
  /** Failure returned by the engine for the latest Doctor request. */
  doctorError?: string | null;
  /** Ask the engine to diagnose the local installation. */
  onRunDoctor?: () => void;
  /** Any command in flight; the Refresh greys rather than spinning. */
  busy?: ReadonlySet<string>;
}) {
  const t = (key: string) =>
    translate(`desktop.overview.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tr = (source: string) =>
    translateSource(source, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const activityKindLabel = (kind: string) =>
    translate(`desktop.activity.kind_${kind}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => globalThis.localStorage?.getItem(ONBOARDING_KEY) === '1',
  );
  const apps = overviewApps(snapshot.actions);
  // `hasInstalledApp` (`Models.swift:484` -> `TrayStore+Snapshots.swift:89`)
  // reads the install probe on the provider rows, not the route actions: a
  // fresh install has no routes to look at yet, which is exactly when this
  // step matters. macOS also requires `clientId != nil`, which the engine
  // always satisfies — `nativeClientIDOf` falls back to the provider id.
  const installedApp = snapshot.accountProviders.some((provider) => provider.installed);
  const hub = snapshot.proxies.find((proxy) => proxy.providerId === 'proxy-hub');
  const accountProxies = snapshot.proxies.filter((proxy) => proxy.providerId !== 'proxy-hub');
  const target = overviewAttentionTarget({
    proxies: accountProxies,
    apps: snapshot.actions,
    accounts: snapshot.accounts,
    conflicts: snapshot.hubConflicts,
  });

  const running = accountProxies.filter((proxy) => proxy.running).length;
  // A hub with no sources and no enablement is a phantom row; counting it
  // would tell a user a service is running that is not.
  const total = overviewServiceTotal(
    snapshot.proxyCount,
    snapshot.hubSources.length === 0,
    Boolean(hub?.running),
  );

  // Named the same way the Proxies pane names it, so the two panes never point
  // at different things with the same words.
  const proxyNames = new Map(
    [...disambiguatedProxyNames(accountProxies)].map(([id, name]) => [id, tr(name)]),
  );

  const attention = target
    ? (() => {
        const name = target.kind === 'proxy'
          ? proxyNames.get(target.id) ?? tr('A service')
          : target.kind === 'app'
          ? snapshot.actions.find((row) => row.clientId === target.id)?.client ?? tr('An app')
          : target.kind === 'account'
          ? snapshot.accounts.find((row) => row.id === target.id)?.label ?? tr('An account')
          : snapshot.hubConflicts.find((row) => row.id === target.id)?.title ?? tr('A model');
        const prefix = target.kind === 'proxy'
          ? 'attention_proxy'
          : target.kind === 'app'
          ? 'attention_app'
          : target.kind === 'account'
          ? 'attention_account'
          : 'attention_conflict';
        const actionKey = target.kind === 'proxy'
          ? 'open_proxies'
          : target.kind === 'app'
          ? 'open_apps'
          : target.kind === 'account'
          ? 'open_accounts'
          : 'open_proxy_hub';
        const titleKey = `${prefix}_title`;
        const detailKey = target.kind === 'conflict' ? 'attention_conflict_detail' : `${prefix}_detail`;
        return {
          title: t(titleKey).replace('{name}', name),
          detail: t(detailKey).replace('{name}', name),
          action: t(actionKey),
        };
      })()
    : null;

  const attentionDestination: Destination = target?.kind === 'proxy'
    ? 'proxies'
    : target?.kind === 'app'
    ? 'apps'
    : target?.kind === 'account'
    ? 'accounts'
    : 'proxyHub';

  return (
    <Pane title={translate('desktop.nav.overview', snapshot.settings.language, snapshot.settings.resolvedLanguage)} testId="overview">
      {snapshot.degradedConditions.length > 0 ? (
        <Group title={t('needs_attention')} testId="overview-degraded">
          {snapshot.degradedConditions.map((condition) => (
            <Row key={condition.id} warning testId={`degraded-${condition.id}`}>
              <WarningGlyph language={snapshot.settings.language} resolvedLanguage={snapshot.settings.resolvedLanguage} />
              <RowText title={tr(condition.title)} detail={tr(condition.detail)} />
            </Row>
          ))}
        </Group>
      ) : null}

      {attention ? (
        <Group testId="overview-attention">
          <Row warning testId="overview-attention-row">
            <WarningGlyph language={snapshot.settings.language} resolvedLanguage={snapshot.settings.resolvedLanguage} />
            <RowText title={attention.title} detail={attention.detail} />
            <RowActions>
              <Button onClick={() => onNavigate?.(attentionDestination)}>
                {attention.action}
              </Button>
            </RowActions>
          </Row>
        </Group>
      ) : null}

      <Group
        title={t('installation_health')}
        footer={t('doctor_footer')}
        testId="overview-doctor"
      >
        <Row>
          <RowText
            title={t('check_installation')}
            detail={doctor
              ? t('doctor_last_check').replace('{status}', localizedDoctorStatusLabel(doctor.status, t))
              : t('doctor_help')}
          />
          <RowActions>
            <Button
              testId="overview.run-doctor"
              onClick={onRunDoctor}
              disabled={(busy?.size ?? 0) > 0 || !onRunDoctor}
            >
              {t('run_doctor')}
            </Button>
          </RowActions>
        </Row>
        {doctorError ? (
          <Row warning testId="overview.doctor-error">
            <WarningGlyph language={snapshot.settings.language} resolvedLanguage={snapshot.settings.resolvedLanguage} />
            <RowText title={tr(doctorError)} />
          </Row>
        ) : null}
        {doctor?.findings.length === 0 ? (
          <Row testId="overview.doctor-summary">
            <RowText title={t('all_checks_passed')} />
          </Row>
        ) : null}
        {doctor?.findings.map((finding, index) => (
          <Row key={`${finding.check}-${index}`} testId={`overview.doctor-finding.${finding.check}`}>
              <RowText title={localizedDoctorCheck(finding.check, t)} detail={tr(finding.detail || finding.status)} />
            <RowActions>
              <span className={`text-[12px] whitespace-nowrap ${finding.status === 'fail' ? 'text-red' : finding.status === 'warn' ? 'text-orange' : 'text-secondary'}`}>
                {t(finding.status === 'fail' ? 'status_fail' : finding.status === 'warn' ? 'status_warn' : 'status_ok')}
              </span>
            </RowActions>
          </Row>
        ))}
      </Group>

      {onboardingDismissed ? null : (
      <Group
        title={t('get_started')}
        footer={t(isOnboardingCoreComplete(snapshot) ? 'footer_complete' : 'footer_incomplete')}
        testId="overview-get-started"
      >
        <Row testId="onboarding-save-login">
          <RowText
            title={t('add_login')}
            detail={
              snapshot.accounts.length > 0
                ? t('login_saved')
                : t('use_existing_login')
            }
          />
          <RowActions>
            {snapshot.accounts.length > 0 ? (
              <span className="text-[12px] whitespace-nowrap text-secondary">{t('done')}</span>
            ) : (
              <Button onClick={() => onNavigate?.('accounts')}>{t('add_login_action')}</Button>
            )}
          </RowActions>
        </Row>
        <Row testId="onboarding-use-app">
          <RowText
            title={t('use_app')}
            detail={
              installedApp
                ? t('app_available')
                : t('install_clients')
            }
          />
          <RowActions>
            {installedApp ? (
              <span className="text-[12px] whitespace-nowrap text-secondary">{t('done')}</span>
            ) : (
              <Button onClick={() => onRefresh?.()} disabled={(busy?.size ?? 0) > 0}>
                {t('refresh')}
              </Button>
            )}
          </RowActions>
        </Row>
        <Row testId="onboarding-choose-route">
          <RowText
            title={t('point_app')}
            detail={
              snapshot.actions.some((row) => row.selected)
                ? t('app_using_login')
                : t('point_client')
            }
          />
          <RowActions>
              <Button onClick={() => onNavigate?.('apps')}>{t('choose')}</Button>
          </RowActions>
        </Row>
        <Row testId="onboarding-hub">
          <RowText
            title={t('hub_optional')}
            detail={
              snapshot.hubPublishedModels.length > 0
                ? t('hub_sources_ready')
                : t('hub_endpoint_detail')
            }
          />
          <RowActions>
              <Button onClick={() => onNavigate?.('proxyHub')}>{t('set_up')}</Button>
          </RowActions>
        </Row>
        <PaneActions>
          <Button
            quiet
            testId="overview.hide-onboarding"
            onClick={() => {
              globalThis.localStorage?.setItem(ONBOARDING_KEY, '1');
              setOnboardingDismissed(true);
            }}
          >
            {t('hide_getting_started')}
          </Button>
        </PaneActions>
      </Group>
      )}

      {/*
        Three rows, then a way to the rest. Listing every app makes Overview a
        second Apps pane, and pushes the app that needs attention off the screen
        behind the ones that are already fine.
      */}
      {apps.listed.length > 0 ? (
        <Group
          title={t(apps.title === 'Active Apps' ? 'active_apps' : 'apps')}
          footer={apps.footer ? t('choose_login_each_app') : undefined}
          testId="overview-apps"
        >
          {apps.listed.map((app) => (
            <Row key={app.clientId} testId={`overview.app.${app.clientId}`}>
              {/* `DesignProviderIcon` (`OverviewView.swift:180`): the app's own
                  mark, so three rows of names read as three apps rather than
                  three more text lines. */}
              <ProviderIcon provider={app.clientId} size={24} className="mr-1" />
              <RowText
                title={app.client}
                detail={localizedConnectionSummary(app, t, tr)}
                issue={app.needsAttention ? t('needs_login_before_run') : undefined}
                language={snapshot.settings.language}
                resolvedLanguage={snapshot.settings.resolvedLanguage}
              />
              <RowActions>
                <span
                  className={`text-[12px] whitespace-nowrap ${
                    app.needsAttention ? 'text-orange' : 'text-secondary'
                  }`}
                >
                  {localizedTransportLabel(overviewTransportLabel(app), t)}
                </span>
              </RowActions>
            </Row>
          ))}
          {apps.hasMore ? (
            <Row testId="overview.apps.see-all" onClick={() => onNavigate?.('apps')}>
              <RowText title={t('all_apps').replace('{count}', String(apps.total))} />
              <RowActions>
                <Chevron />
              </RowActions>
            </Row>
          ) : null}
        </Group>
      ) : (
        <Group title={t('apps')} testId="overview-apps">
          <Row>
            <RowText detail={t('no_routes')} />
          </Row>
        </Group>
      )}

      <Group title={t('services')} testId="overview-services">
        <Row testId="overview-services-row" onClick={() => onNavigate?.('proxies')}>
          <span
            className={`mr-2.5 flex-none ${
              running === 0 ? 'text-secondary' : 'text-accent'
            }`}
            aria-hidden="true"
          >
            <Symbol name="server.rack" size={18} />
          </span>
          <RowText
            title={t('proxies')}
            detail={
              running === 0
                ? t('services_stopped')
                : t(running === 1 ? 'services_one_running' : 'services_many_running').replace('{count}', String(running))
            }
          />
          <RowActions>
            <div className="flex items-center gap-1.5">
              {running > 0 ? (
                <span className="inline-block size-[7px] rounded-full bg-green flex-none" />
              ) : null}
              <span className="text-[12px] whitespace-nowrap text-secondary font-mono">
                {t('services_ratio').replace('{running}', String(running)).replace('{total}', String(total))}
              </span>
              <Chevron />
            </div>
          </RowActions>
        </Row>
      </Group>

      {snapshot.activity.length > 0 ? (
        <Group title={t('recent_activity')} testId="overview-activity">
          {snapshot.activity.slice(0, 3).map((event) => (
            <Row key={event.id} testId={`overview-activity-${event.id}`}>
              {/* macOS wears the event's provider mark at 18pt
                  (`OverviewView.swift:261`), and falls back to the status symbol
                  when the event names no provider. */}
              {event.provider ? (
                <ProviderIcon provider={event.provider} size={18} className="mr-1" />
              ) : (
                <span className="mr-1 flex-none text-secondary" aria-hidden="true">
                  <Symbol name="clock.arrow.circlepath" size={15} />
                </span>
              )}
              <RowText title={tr(event.message)} detail={activityKindLabel(event.kind)} />
            </Row>
          ))}
        </Group>
      ) : null}

      {hub ? (
        <Group title={t('hub_transport')} testId="overview-hub">
          <Row onClick={() => onNavigate?.('proxyHub')}>
            <span className="mr-2.5 flex-none text-accent" aria-hidden="true">
              <Symbol name="point.3.connected.trianglepath.dotted" size={18} />
            </span>
            <RowText title={t('hub_transport')} detail={tr(hub.address ?? hub.detail ?? '')} />
            <RowActions>
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] whitespace-nowrap text-secondary">
                  {localizedStatusLabel(proxyStatus(hub), t)}
                </span>
                <Chevron />
              </div>
            </RowActions>
          </Row>
        </Group>
      ) : null}
    </Pane>
  );
}

