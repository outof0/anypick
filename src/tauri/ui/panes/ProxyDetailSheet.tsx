import { useEffect, useState } from 'react';
import { Symbol } from '../shell/Symbol';

import type { ProxyRow, Snapshot } from '../lib/contract';
import { translate, translateSource } from '../lib/i18n';
import {
  proxyClientApps,
  proxyFailure,
  proxyOperation,
  proxyPort,
  proxyPurpose,
  servingAccountLabel,
} from '../lib/proxy-detail';
import { canRestartProxy, nativeProviderName, proxyStatus, proxyTokenSubject } from '../lib/model';
import type { ServicePort } from '../lib/service';
import { ProviderIcon } from '../shell/ProviderIcon';
import { ConfirmDialog } from './ProxiesPane';
import { DisclosureChevron } from '../ui/Chevron';
import { Dialog } from '../ui/Dialog';
import {
  Button,
  CopyButton,
  Group,
  IconButton,
  Row,
  RowActions,
  RowText,
  StatusLabel,
  useCopyConfirmation,
  WarningRow,
} from '../ui/primitives';

/**
 * `ProxyDetailView`. One relay's identity, its endpoint, and who is using it.
 *
 * macOS pushes this onto the detail stack; a webview has no stack, so it is a
 * dialog the Proxies row opens — the same trade `AccountDetailSheet` makes.
 *
 * This is the destination that makes the Proxies pane's own footer true: *"Select
 * a proxy to view its address and API key."* Before it existed the address sat
 * on the list row and the footer was a lie.
 */
export function ProxyDetailSheet({
  proxy,
  name,
  snapshot,
  service,
  busy = new Set<string>(),
  copyKeyResult = null,
  revision,
  result = null,
  onNavigate,
  onClose,
}: {
  proxy: ProxyRow;
  name: string;
  snapshot: Snapshot;
  service: ServicePort;
  busy?: ReadonlySet<string>;
  copyKeyResult?: { requestId: string; success: boolean | null } | null;
  revision: number;
  /** The engine's answer when the last answer belonged to this relay. */
  result?: { status: string; message: string } | null;
  onNavigate?: (destination: 'activity') => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<'stop' | 'rotate' | null>(null);
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

  const status = proxyStatus(proxy);
  const language = snapshot.settings.language;
  const resolvedLanguage = snapshot.settings.resolvedLanguage;
  const t = (key: string) => translate(`desktop.proxy_detail.${key}`, language, resolvedLanguage);
  const tc = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  const port = proxyPort(proxy);
  const running = proxy.running;
  const operation = proxyOperation(proxy, service.inFlight());
  const failure = proxyFailure(proxy, snapshot.degradedConditions);
  const apps = proxyClientApps(proxy, snapshot.actions);
  const idle = busy.size === 0;
  const refused = result && result.status !== 'success' ? result : undefined;

  return (
    <Dialog
      title={name || t('this_proxy')}
      onCancel={onClose}
      testId="proxies-inspector"
      width="form"
      actions={
        <>
          {/* `proxyActions` (`ProxyDetailView.swift:252`): Restart is the pane
              action, trailing, and disabled unless the relay could actually
              restart. */}
          <Button
            kind="secondary"
            testId="proxies.inspector.restart"
            disabled={!idle || !running || !canRestartProxy(running, status) || !proxy.restartActionId}
            onClick={() => service.invokeAction(proxy.restartActionId ?? '', revision)}
          >
            {operation?.verb === 'Restarting' ? tc('restarting') : t('restart_proxy')}
          </Button>
          <Button kind="primary" onClick={onClose}>
            {tc('done')}
          </Button>
        </>
      }
    >
      <Group title={t('service')} testId="proxies-inspector.identity">
        <Row>
          <ProviderIcon provider={proxy.providerId} fallbackSymbol="server.rack" size={26} className="mr-1" />
          <RowText title={name} detail={translateSource(proxyPurpose(proxy), language, resolvedLanguage)} />
        </Row>
        <Row testId="proxies-inspector.status">
          <RowText title={tc('status')} />
          <RowActions>
            {/*
              `ProgressView` + the operation word while a command is in flight,
              and the status label otherwise. macOS reads the two from
              `serviceOperations[proxy.id]` and `proxy.status`, and HIG is
              explicit that the lifecycle button keeps its label and spins inside
              it rather than being swapped for a bare spinner.
            */}
            {operation ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-secondary">
                <Spinner />
                {tc(operation.verb.toLowerCase())}
              </span>
            ) : (
              <StatusLabel
                status={status}
                language={snapshot.settings.language}
                resolvedLanguage={snapshot.settings.resolvedLanguage}
              />
            )}
            <Button
              kind={running ? 'destructive' : 'secondary'}
              testId="proxies.inspector.lifecycle"
              disabled={!idle || !proxy.toggleActionId}
              ariaLabel={`${running ? tc('stop') : tc('start')} ${name}`}
              onClick={() =>
                running ? setConfirming('stop') : service.invokeAction(proxy.toggleActionId ?? '', revision)
              }
            >
              {running ? tc('stop') : tc('start')}
            </Button>
          </RowActions>
        </Row>
        <Row testId="proxies-inspector.provider">
          <RowText title={translate('desktop.account_detail.provider', language, resolvedLanguage)} />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {nativeProviderName(proxy.providerId)}
            </span>
          </RowActions>
        </Row>
        {servingAccountLabel(proxy, snapshot.accounts) ? (
          <Row testId="proxies-inspector.account">
            <RowText title={t('serving_account')} />
            <RowActions>
              <span className="text-[12px] whitespace-nowrap text-secondary">
                {servingAccountLabel(proxy, snapshot.accounts)}
              </span>
            </RowActions>
          </Row>
        ) : null}
      </Group>

      {/*
        A failure and a stopped-but-enabled relay are different statements, and
        macOS gives them different advice (`ProxyDetailView.swift:66`, `:81`):
        one says fix the configuration, the other says press Start.
      */}
      {failure ? (
        <Group testId="proxies-inspector.failure">
          <WarningRow title={t('service_error')} detail={translateSource(failure, language, resolvedLanguage)} />
        </Group>
      ) : proxy.enabled && !running ? (
        <Group testId="proxies-inspector.attention">
          <WarningRow
            title={tc('needs_attention')}
            detail={t('enabled_not_running')}
          />
        </Group>
      ) : null}

      {/*
        A refused command belongs to the row that sent it. A banner over the pane
        would say something failed without saying which relay is now in a state
        the user did not choose — the same rule the hub source rows follow.
      */}
      {refused ? (
        <Group testId="proxies-inspector.error">
          <WarningRow title={tc('command_refused')} detail={translateSource(refused.message, language, resolvedLanguage)} />
        </Group>
      ) : null}

      <Group title={t('endpoint')} testId="proxies-inspector.endpoint">
        <Row testId="proxies.inspector.address-row">
          <RowText title={tc('address')} />
          <RowActions>
            {port > 0 ? (
              <>
                {/* Monospaced and selectable, as on macOS: this is a value to
                    paste into a client's config, not a sentence. */}
                <span className="select-all font-mono text-[12px] text-secondary">
                  http://127.0.0.1:{port}
                </span>
                <CopyButton
                  label={tc('copy_address')}
                  testId="proxies.inspector.copy"
                  value={`http://127.0.0.1:${port}`}
                  copy={service.copy}
                  language={language}
                  resolvedLanguage={resolvedLanguage}
                />
              </>
            ) : (
              <span className="text-[12px] whitespace-nowrap text-secondary" data-testid="proxies.inspector.address">
                {t('not_running')}
              </span>
            )}
          </RowActions>
        </Row>
        {port > 0 && proxy.hasToken ? (
          <Row testId="proxies.inspector.api-key">
            <RowText title={tc('api_key')} />
            <RowActions>
              {/*
                ADR 0006: the snapshot says a copy is possible, never the value.
                The bearer arrives in a result payload, on request, so this row
                can only ever say that.
              */}
              <span className="text-[12px] whitespace-nowrap text-secondary">{t('hidden_until_copied')}</span>
              <IconButton
                label={tc('copy_api_key')}
                language={language}
                resolvedLanguage={resolvedLanguage}
                testId="proxies.inspector.copy-key"
                phase={copyConfirmation.phase}
                confirmed={<Symbol name="checkmark" size={13} />}
                disabled={!idle}
                onClick={() => {
                  if (!copyConfirmation.begin()) return;
                  const subject = proxyTokenSubject(proxy.id, proxy.providerId);
                  if (subject) setCopyRequestId(service.mutate('proxy-token', subject));
                  else copyConfirmation.report(false);
                }}
              >
                <Symbol name="doc.on.doc" size={15} />
              </IconButton>
              {running ? (
                <IconButton
                  label={tc('rotate_key')}
                  language={language}
                  resolvedLanguage={resolvedLanguage}
                  testId="proxies.inspector.rotate-key"
                  onClick={() => setConfirming('rotate')}
                >
                  <RotateGlyph />
                </IconButton>
              ) : null}
            </RowActions>
          </Row>
        ) : null}
        {port > 0 ? (
          <Row testId="proxies-inspector.port">
            <RowText title={t('port')} />
            <RowActions>
              <span className="text-[12px] whitespace-nowrap text-secondary">{port}</span>
            </RowActions>
          </Row>
        ) : null}
        <Row testId="proxies-inspector.security">
          <RowText title={t('security')} />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {t('loopback_authenticated')}
            </span>
          </RowActions>
        </Row>
        <Row testId="proxies-inspector.activity">
          <RowText title={t('activity_logs')} />
          <RowActions>
            {/* A destination, so it wears a chevron the way a `NavigationLink`
                does rather than sitting in the pane's action row. */}
            <button
              type="button"
              className="inline-flex cursor-default items-center gap-1 border-0 bg-transparent text-[12px] text-accent"
              title={t('open_activity_help')}
              onClick={() => onNavigate?.('activity')}
            >
              {t('view_in_activity')}
              <DisclosureChevron />
            </button>
          </RowActions>
        </Row>
      </Group>

      {/*
        The reason this destination exists and a list row does not: which apps
        you will disconnect if you stop this relay. Stopping is confirmed, and
        the confirmation cannot name the apps from a menu item's context.
      */}
      {apps.length > 0 ? (
        <Group title={t('client_apps')} testId="proxies-inspector.apps">
          {apps.map((app) => (
            <Row key={app.clientId} testId={`proxies-inspector.app.${app.clientId}`}>
              <ProviderIcon provider={app.clientId} size={20} className="mr-1" />
              <RowText title={app.client} />
              <RowActions>
                <span className="text-[12px] whitespace-nowrap text-tertiary">
                  {nativeProviderName(app.clientId)}
                </span>
              </RowActions>
            </Row>
          ))}
        </Group>
      ) : null}

      {confirming === 'stop' ? (
        <ConfirmDialog
          title={t('stop_title').replace('{name}', name || t('this_proxy'))}
          message={t('stop_message')}
          confirmTitle={t('stop_proxy')}
          cancelTitle={tc('cancel')}
          testId="proxies.inspector.stop-confirm"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            service.invokeAction(proxy.toggleActionId ?? '', revision);
          }}
        />
      ) : null}

      {confirming === 'rotate' ? (
        <ConfirmDialog
          title={t('rotate_title').replace('{name}', name || t('this_proxy'))}
          message={t('rotate_message')}
          confirmTitle={tc('rotate_key')}
          cancelTitle={tc('cancel')}
          testId="proxies.inspector.rotate-confirm"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            service.invokeAction(proxy.rotateActionId ?? '', revision);
          }}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * The proxy is gone from the snapshot.
 *
 * A detail destination for a row that no longer exists has to say so rather than
 * render an empty form of undefined fields — the relay is stopped and deleted
 * while its sheet is open often enough to be worth a branch.
 */
export function ProxyGoneSheet({
  onClose,
  language,
  resolvedLanguage,
}: {
  onClose: () => void;
  language: string;
  resolvedLanguage: string;
}) {
  const t = (key: string) => translate(`desktop.proxy_detail.${key}`, language, resolvedLanguage);
  const tc = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  return (
    <Dialog
      title={t('unavailable')}
      testId="proxies-inspector.gone"
      onCancel={onClose}
      width="form"
      actions={
        <Button kind="quiet" onClick={onClose}>
          {tc('done')}
        </Button>
      }
    >
      <Group testId="proxies-inspector.gone-body">
        <Row>
          <RowText detail={t('unavailable_detail')} />
        </Row>
      </Group>
    </Dialog>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" focusable="false" className="animate-spin">
      <path
        d="M12 3a9 9 0 0 1 9 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}


function RotateGlyph() {
  return (
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
  );
}

