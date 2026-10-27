import { useEffect, useRef, useState } from 'react';

import type { ProxyRow, Snapshot } from '../lib/contract';
import {
  canRestartProxy,
  disambiguatedProxyNames,
  friendlyProxyStatusSubtitle,
  proxyStatus,
  proxyTokenSubject,
  servicePort,
} from '../lib/model';
import type { ServicePort } from '../lib/service';
import { translate, translateSource } from '../lib/i18n';
import { ProviderIcon } from '../shell/ProviderIcon';
import { ProxyDetailSheet, ProxyGoneSheet } from './ProxyDetailSheet';
import { Symbol } from '../shell/Symbol';
import { Chevron } from '../ui/Chevron';
import { MenuItem, RowMenu } from '../ui/RowMenu';
import {
  Button,
  EmptyState,
  Group,
  Pane,
  PaneActions,
  Row,
  RowActions,
  RowText,
  StatusLabel,
} from '../ui/primitives';
import { mutateAction, proxyBulk, proxyToken } from '../lib/desktop-actions';

/**
 * Proxies: the hub on top, then one relay per saved account.
 *
 * Lifecycle lives in the row that owns the service, not in a pane toolbar, so
 * a list with twenty services below it still shows what each one is doing. The
 * hub is reported separately because it is not one of the per-account relays,
 * and folding it in makes the running count mean two different things.
 */
export function ProxiesPane({
  service,
  snapshot,
  query = '',
  busy = new Set<string>(),
  copyKeyResult = null,
  onNavigate,
  onOpenModels,
  onClearQuery,
  proxyResults = {},
}: {
  service: ServicePort;
  snapshot: Snapshot;
  query?: string;
  /** Requests the engine has not answered; the engine is single-flight. */
  busy?: ReadonlySet<string>;
  /** Completion of a protected API-key copy request. */
  copyKeyResult?: { requestId: string; success: boolean | null } | null;
  /**
   * The engine's last answer per relay, when it belonged to that relay.
   *
   * A refused Stop or Rotate changes what the user thought they had set, so it
   * has to land on the destination the command came from — the same rule the hub
   * source rows follow. A pane-level banner would say something failed without
   * saying which relay is now in a state nobody chose.
   */
  proxyResults?: Record<string, { status: string; message: string } | undefined>;
  onNavigate?: (destination: 'accounts' | 'activity') => void;
  /** Reaches Published Models, which is not a sidebar destination on macOS. */
  onOpenModels?: () => void;
  onClearQuery?: () => void;
}) {
  /*
   * Stop and Rotate are confirmed per row; Start is not. macOS keeps the same
   * asymmetry (`ProxiesView.swift:73`, `:90`), so the pane owns both dialogs
   * rather than the row opening one — a confirmation belongs to the surface
   * that can lay it out, not to the control that asked for it.
   */
  const [pendingStop, setPendingStop] = useState<ProxyRow | null>(null);
  /*
   * The detail destination. `ProxyDetailView` on macOS; a dialog here, because a
   * webview has no navigation stack — the same trade `AccountDetailSheet` makes.
   *
   * `null` is the closed state and the id is not, so a relay deleted while its
   * sheet is open reads as "no longer available" rather than as a form of
   * undefined fields.
   */
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [pendingRotate, setPendingRotate] = useState<ProxyRow | null>(null);
  const [pendingStopAll, setPendingStopAll] = useState(false);
  const t = (key: string) =>
    translate(`desktop.proxies.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tc = (key: string) =>
    translate(`desktop.common.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const ta = (key: string) =>
    translate(`desktop.accounts.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const statusLabels = {
    running: translate('desktop.overview.status_running', snapshot.settings.language, snapshot.settings.resolvedLanguage),
    ready: translate('desktop.overview.status_ready', snapshot.settings.language, snapshot.settings.resolvedLanguage),
    attention: translate('desktop.overview.status_attention', snapshot.settings.language, snapshot.settings.resolvedLanguage),
    unavailable: translate('desktop.overview.status_unavailable', snapshot.settings.language, snapshot.settings.resolvedLanguage),
    stopped: translate('desktop.overview.status_stopped', snapshot.settings.language, snapshot.settings.resolvedLanguage),
  };

  const hub = snapshot.proxies.find((proxy) => proxy.providerId === 'proxy-hub');
  const needle = query.trim().toLocaleLowerCase();
  const relays = snapshot.proxies.filter((proxy) => {
    if (proxy.providerId === 'proxy-hub') return false;
    const haystack = `${proxy.label} ${proxy.detail} ${proxy.address ?? ''}`.toLocaleLowerCase();
    return !needle || haystack.includes(needle);
  });
  const names = new Map(
    [...disambiguatedProxyNames(relays)].map(([id, name]) => [
      id,
      translateSource(name, snapshot.settings.language, snapshot.settings.resolvedLanguage),
    ]),
  );

  const runningCount = relays.filter((proxy) => proxy.running).length;
  const stoppedCount = relays.filter((proxy) => !proxy.running).length;
  const hasRunning = runningCount > 0;

  return (
    <Pane title={translate('desktop.nav.proxies', snapshot.settings.language, snapshot.settings.resolvedLanguage)} testId="proxies">
      {hub ? (
        <Group
          title={translate('desktop.nav.proxy_hub', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
          footer={t('hub_footer')}
          testId="proxies-hub-group"
        >
          <Row testId="proxies-hub-summary">
            {/* macOS puts only a `DesignStatusLabel` in this row's `trailing`
                (`ProxiesView.swift:120`) — the hub's own lifecycle lives in the
                Proxy Hub pane it navigates to. Five controls here were the same
                clutter the account rows had. */}
            <span className="text-secondary" aria-hidden="true">
              <Symbol name="point.3.connected.trianglepath.dotted" size={22} />
            </span>
            <RowText
              title={translate('desktop.nav.proxy_hub', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
              detail={
                hub.address
                  ? `${hub.address} · ${translate(
                      `desktop.hub.${snapshot.hubPublishedModels.length === 1 ? 'model_count' : 'models_count'}`,
                      snapshot.settings.language,
                      snapshot.settings.resolvedLanguage,
                    ).replace('{count}', String(snapshot.hubPublishedModels.length))} ${translate(
                      'desktop.hub.models_published',
                      snapshot.settings.language,
                      snapshot.settings.resolvedLanguage,
                    )}`
                  : t('hub_footer')
              }
            />
            <RowActions>
              <StatusLabel status={proxyStatus(hub)} labels={statusLabels} />
              {/*
                Published Models is a destination, not a command, so it wears a
                chevron the way a `NavigationLink` does — macOS reaches it from
                Proxy Hub, and this is the shortcut to that pane.
              */}
              <Button
                kind="quiet"
                testId="proxies-hub-models"
                disabled={snapshot.hubPublishedModels.length === 0}
                onClick={() => onOpenModels?.()}
              >
                {translate('desktop.hub.published_models', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
              </Button>
            </RowActions>
          </Row>
        </Group>
      ) : null}

      {relays.length === 0 ? (
        <EmptyState
          title={needle ? translate('desktop.hub.no_results', snapshot.settings.language, snapshot.settings.resolvedLanguage) : t('no_account_proxies')}
          detail={
            needle
              ? t('no_results_detail')
              : t('no_proxies_detail')
          }
          actionTitle={needle ? tc('clear_search') : translate('desktop.accounts.title', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
          onAction={needle ? onClearQuery : () => onNavigate?.('accounts')}
          testId="proxies-empty"
        />
      ) : (
        <Group
          title={t('account_proxies')}
          footer={t('endpoint_footer')}
          testId="proxies-list"
        >
          {relays.map((proxy) => (
            <ProxyRowView
              key={proxy.id}
              proxy={proxy}
              name={names.get(proxy.id) ?? proxy.label}
              t={t}
              tc={tc}
              ta={ta}
              language={snapshot.settings.language}
              resolvedLanguage={snapshot.settings.resolvedLanguage}
              revision={snapshot.revision}
              service={service}
              busy={busy}
              onStop={setPendingStop}
              onRotate={setPendingRotate}
              onInspect={setInspectingId}
            />
          ))}
        </Group>
      )}

      {relays.length > 0 ? (
        <PaneActions>
          <Button
            kind="secondary"
            testId="proxies-start-all"
            disabled={stoppedCount === 0 || busy.size > 0}
            onClick={() => mutateAction(service, proxyBulk('proxy-start-all'))}
          >
            {runningCount === 0 ? t('start_all') : t('start_remaining')}
          </Button>
          <Button
            kind="secondary"
            testId="proxies-restart"
            disabled={!hasRunning || busy.size > 0}
            onClick={() => mutateAction(service, proxyBulk('proxy-restart-all'))}
          >
            {t('restart_running')}
          </Button>
          <Button
            kind="destructive"
            testId="proxies-stop-all"
            disabled={!hasRunning || busy.size > 0}
            onClick={() => setPendingStopAll(true)}
          >
            {t('stop_all_prompt')}
          </Button>
        </PaneActions>
      ) : null}

      {inspectingId ? (
        (() => {
          const inspected = snapshot.proxies.find((proxy) => proxy.id === inspectingId);
          return inspected ? (
            <ProxyDetailSheet
              proxy={inspected}
              name={
                names.get(inspected.id) ??
                translateSource(inspected.label, snapshot.settings.language, snapshot.settings.resolvedLanguage)
              }
              snapshot={snapshot}
              service={service}
              busy={busy}
              copyKeyResult={copyKeyResult}
              revision={snapshot.revision}
              result={proxyResults[inspected.id] ?? null}
              onNavigate={onNavigate}
              onClose={() => setInspectingId(null)}
            />
          ) : (
            <ProxyGoneSheet
              onClose={() => setInspectingId(null)}
              language={snapshot.settings.language}
              resolvedLanguage={snapshot.settings.resolvedLanguage}
            />
          );
        })()
      ) : null}

      {pendingStop ? (
        <ConfirmDialog
          title={t('stop_proxy_title').replace('{name}', names.get(pendingStop.id) ?? pendingStop.label)}
          message={t('stop_proxy_message')}
          confirmTitle={tc('stop')}
          cancelTitle={tc('cancel')}
          testId={`proxies.stop-confirm-${pendingStop.id}`}
          onCancel={() => setPendingStop(null)}
          onConfirm={() => {
            service.invokeAction(pendingStop.toggleActionId ?? '', snapshot.revision);
            setPendingStop(null);
          }}
        />
      ) : null}

      {pendingRotate ? (
        <ConfirmDialog
          title={t('rotate_key_title').replace('{name}', names.get(pendingRotate.id) ?? pendingRotate.label)}
          message={t('rotate_message')}
          confirmTitle={tc('rotate_key')}
          cancelTitle={tc('cancel')}
          testId={`proxies.rotate-confirm-${pendingRotate.id}`}
          onCancel={() => setPendingRotate(null)}
          onConfirm={() => {
            service.invokeAction(pendingRotate.rotateActionId ?? '', snapshot.revision);
            setPendingRotate(null);
          }}
        />
      ) : null}

      {pendingStopAll ? (
        <ConfirmDialog
          title={t('stop_all_title')}
          message={t('stop_all_message')}
          confirmTitle={t('stop_all_action')}
          cancelTitle={tc('cancel')}
          destructive
          onCancel={() => setPendingStopAll(false)}
          onConfirm={() => {
            setPendingStopAll(false);
            mutateAction(service, proxyBulk('proxy-stop-all'));
          }}
        />
      ) : null}
    </Pane>
  );
}

function copyProxyKey(service: ServicePort, proxy: ProxyRow) {
  const subject = proxyTokenSubject(proxy.id, proxy.providerId);
  if (!subject) return;
  mutateAction(service, proxyToken(subject));
}

function ProxyRowView({
  proxy,
  name,
  t,
  tc,
  ta,
  language,
  resolvedLanguage,
  revision,
  service,
  busy,
  onStop,
  onRotate,
  onInspect,
}: {
  proxy: ProxyRow;
  name: string;
  t: (key: string) => string;
  tc: (key: string) => string;
  ta: (key: string) => string;
  language: string;
  resolvedLanguage: string;
  revision: number;
  service: ServicePort;
  busy: ReadonlySet<string>;
  /** Stop is confirmed; Start is not. The two are not symmetric. */
  onStop: (proxy: ProxyRow) => void;
  onRotate: (proxy: ProxyRow) => void;
  /** Opens the detail destination. */
  onInspect: (proxyId: string) => void;
}) {
  const status = proxyStatus(proxy);
  const port = servicePort(proxy.address ?? proxy.detail) ?? 0;
  const restorable = canRestartProxy(proxy.running, status);
  const running = proxy.running;
  const idle = busy.size === 0;
  const hasRestart = running && Boolean(proxy.restartActionId);

  /*
   * One trailing control, as on macOS: `ProxiesView.swift:143` puts
   * `lifecycleAction(proxy)` alone in `trailing:`, and `:147` puts everything
   * else in the `contextMenu`.
   *
   * This row used to carry six controls — a status dot, the address, two
   * *identical* copy glyphs, Stop, Restart and Rotate. Two adjacent glyphs that
   * look the same and copy different things is the kind of clutter that makes
   * a list unreadable, and macOS never had it.
   *
   * The address has moved to the detail sheet, which is where macOS keeps it
   * (`:86`) and where this pane's own footer always claimed it was. Keeping it
   * on the row was a workaround for a destination that did not exist.
   */
  const showMenu = running && (hasRestart || Boolean(proxy.address) || proxy.hasToken || Boolean(proxy.rotateActionId));

  return (
    <Row
      testId={`proxy-${proxy.id}`}
      warning={proxy.enabled && !proxy.running}
      onClick={() => onInspect(proxy.id)}
    >
      {/* `DesignProviderIcon` (`ProxiesView.swift:141`): the relay wears the
          mark of the provider it fronts, so a stopped row still says whose
          account it belongs to. */}
      <ProviderIcon provider={proxy.providerId} fallbackSymbol="server.rack" size={24} className="mr-1" />
      <RowText
        title={name}
        detail={translateSource(
          friendlyProxyStatusSubtitle(status, port, proxy.detail),
          language,
          resolvedLanguage,
        )}
        issue={proxy.enabled && !proxy.running ? t('proxy_not_running') : undefined}
        language={language}
        resolvedLanguage={resolvedLanguage}
      />
      <RowActions>
        {showMenu ? (
          <RowMenu
            label={ta('more_actions_for').replace('{name}', name)}
            clipboard={service.copy}
            language={language}
            resolvedLanguage={resolvedLanguage}
            testId={`proxies.more-${proxy.id}`}
          >
            {(close, copy) => (
              <>
                {hasRestart ? (
                  <MenuItem
                    testId={`proxies.inspector.restart-${proxy.id}`}
                    disabled={!restorable || !idle}
                    onSelect={() => {
                      close();
                      service.invokeAction(proxy.restartActionId ?? '', revision);
                    }}
                  >
                    {tc('restart')}
                  </MenuItem>
                ) : null}
                {proxy.address ? (
                  <MenuItem
                    testId={`proxies.inspector.copy-${proxy.id}`}
                    onSelect={() => {
                      copy(proxy.address ?? '', tc('address'));
                    }}
                  >
                    {tc('copy_address')}
                  </MenuItem>
                ) : null}
                {/* ADR 0006: the snapshot says a copy is possible, never the
                    value. The key arrives in a result payload, on request. */}
                {proxy.hasToken ? (
                  <MenuItem
                    testId={`proxies.inspector.copy-key-${proxy.id}`}
                    onSelect={() => {
                      close();
                      copyProxyKey(service, proxy);
                    }}
                  >
                    {tc('copy_api_key')}
                  </MenuItem>
                ) : null}
                {proxy.rotateActionId ? (
                  <MenuItem
                    testId={`proxies.inspector.rotate-key-${proxy.id}`}
                    disabled={!idle}
                    onSelect={() => {
                      close();
                      onRotate(proxy);
                    }}
                  >
                    {t('rotate_key_menu')}
                  </MenuItem>
                ) : null}
              </>
            )}
          </RowMenu>
        ) : null}
        {/*
          macOS names this command twice — `proxies.row-action.<id>` on the
          context menu and `proxies.inspector.lifecycle` on the detail — for
          one button. There is one button here, so it carries both ids’
          meaning; the map records that rather than a second control that would
          send the same command twice.
        */}
        <Button
          kind={running ? 'destructive' : 'secondary'}
          testId={`proxies.row-action.${proxy.id}`}
          disabled={!idle || !proxy.toggleActionId}
          ariaLabel={`${running ? tc('stop') : tc('start')} ${name}`}
          title={`${running ? tc('stop') : tc('start')} ${name}`}
          onClick={() =>
            running ? onStop(proxy) : service.invokeAction(proxy.toggleActionId ?? '', revision)
          }
        >
          {running ? tc('stop') : tc('start')}
        </Button>
        {/* The row is a `NavigationLink` on macOS (`ProxiesView.swift:135`), so
            the disclosure chevron sits last, at the trailing edge. */}
        <Chevron />
      </RowActions>
    </Row>
  );
}

/**
 * `confirmationDialog`, not a custom modal card.
 *
 * Destructive work is confirmed before it happens. The confirm button is the
 * one that acts; cancel is inert and closes.
 */
export function ConfirmDialog({
  title,
  message,
  confirmTitle,
  cancelTitle = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
  testId = 'confirm-dialog',
}: {
  title: string;
  message: string;
  confirmTitle: string;
  cancelTitle?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  // Focus starts on the confirmation, not Cancel. This is the one dialog
  // where the safe default is the wrong one: the user asked to destroy
  // something and is confirming a specific action, and macOS's
  // `confirmationDialog` gives the default key equivalent to the button they
  // chose. A stray Return must not land on Cancel.
  const ref = useConfirmFocus();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-[1px]">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="flex w-full max-w-[360px] flex-col gap-2.5 rounded-xl border border-separator-soft bg-canvas px-5 py-4 shadow-[0_16px_48px_rgba(0,0,0,0.36)]"
      >
        <h2 className="text-[13px] font-semibold text-text">{title}</h2>
        <p className="m-0 text-[12px] leading-[1.4] text-secondary">{message}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button kind="secondary" onClick={onCancel}>
            {cancelTitle}
          </Button>
          <Button kind={destructive ? 'destructive' : 'primary'} onClick={onConfirm} data-confirm>
            {confirmTitle}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Focuses the confirming button on mount and restores focus on unmount. */
function useConfirmFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-confirm]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const cancel = ref.current?.querySelectorAll<HTMLElement>('button')[0];
        cancel?.click();
      }
    };
    ref.current?.addEventListener('keydown', onKeyDown);
    return () => {
      ref.current?.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);
  return ref;
}
