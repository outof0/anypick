import { useState } from 'react';

import type { UsageWindow } from '../lib/contract';
import {
  accountIssue,
  accountRowSubtitle,
  accountView,
  gatewayView,
  removalMessage,
} from '../lib/account-row';
import type { AccountRow, GatewayRow } from '../lib/contract';
import { translate, translateSource } from '../lib/i18n';
import {
  groupUsageWindows,
  localizedQuotaResetFormatted,
  localizedQuotaWindowLabel,
  quotaWindowLabel,
} from '../lib/model';
import type { ServicePort } from '../lib/service';
import { ConfirmDialog } from './ProxiesPane';
import { Dialog } from '../ui/Dialog';
import { Button, Group, Row, RowActions, RowText, StatusLabel } from '../ui/primitives';

/**
 * `AccountDetailView`. One account's identity, its quota, and its commands.
 *
 * macOS pushes this onto the detail stack; a webview has no stack, so it is a
 * dialog the row's Show Details opens. A dialog rather than an inline expansion
 * because expanding a row would resize the very reserved columns that make the
 * list line up.
 */
export function AccountDetailSheet({
  account,
  usage = [],
  service,
  paused = false,
  revision,
  language,
  resolvedLanguage,
  onEdit,
  onRemove,
  onClose,
}: {
  account: AccountRow | GatewayRow;
  /**
   * The snapshot revision the Switch action belongs to. Action ids are
   * revision-scoped, so a stale one is refused.
   */
  revision: number;
  language: string;
  resolvedLanguage: string;
  /** Windows the engine reported for this account. Empty means none. */
  usage?: UsageWindow[];
  service: ServicePort;
  paused?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const row = 'ready' in account ? gatewayView(account) : accountView(account);
  const issue = accountIssue(row);
  const t = (key: string) => translate(`desktop.account_detail.${key}`, language, resolvedLanguage);
  const tc = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  const [confirming, setConfirming] = useState(false);
  const usageGroups = groupUsageWindows(usage);

  return (
    <Dialog
      title={row.label}
      onCancel={onClose}
      testId="accounts-inspector"
      width="inspector"
      actions={
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            kind="destructive"
            testId="accounts.inspector.remove"
            disabled={paused}
            onClick={() => setConfirming(true)}
          >
            {t('remove_account')}
          </Button>
          <div className="flex items-center gap-2">
            <Button kind="secondary" testId="account-inspect.edit" disabled={paused} onClick={onEdit}>
              {tc('edit')}
            </Button>
            {row.kind === 'account' && !row.active ? (
              <Button
                kind="secondary"
                testId="accounts.inspector.make-current"
                disabled={paused || !row.switchActionId}
                onClick={() => service.invokeAction(row.switchActionId, revision)}
              >
                {t('make_current')}
              </Button>
            ) : null}
            <Button
              kind="secondary"
              testId="accounts.inspector.test"
              disabled={paused || !row.canRefresh}
              onClick={() => {
                service.mutate(
                  row.kind === 'gateway' ? 'gateway-refresh' : 'account-refresh',
                  row.kind === 'gateway'
                    ? { name: row.name }
                    : { providerId: row.providerId, name: row.name },
                );
              }}
            >
              {tc(row.kind === 'gateway' ? 'test_connection' : 'refresh_login')}
            </Button>
            <Button kind="primary" onClick={onClose}>
              {tc('done')}
            </Button>
          </div>
        </div>
      }
    >
      <Group title={t('account')} testId="accounts-inspector.identity">
        <Row warning={row.status === 'attention' || row.status === 'unavailable'}>
          <RowText
            title={row.label}
            detail={translateSource(accountRowSubtitle(row), language, resolvedLanguage)}
            issue={issue ? translateSource(issue, language, resolvedLanguage) : undefined}
            language={language}
            resolvedLanguage={resolvedLanguage}
          />
          <RowActions>
            {row.active
              ? <StatusLabel status="ready" language={language} resolvedLanguage={resolvedLanguage} />
              : <StatusLabel status={row.status} language={language} resolvedLanguage={resolvedLanguage} />}
          </RowActions>
        </Row>
        <Row>
          <RowText title={t('provider')} />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">{row.providerId}</span>
          </RowActions>
        </Row>
        <Row>
          <RowText title={t('type')} />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {t(row.kind === 'gateway' ? 'api_gateway' : 'saved_login')}
            </span>
          </RowActions>
        </Row>
        <Row testId="accounts-inspector.last-used">
          <RowText title={t('last_used')} />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {tc(row.canRefresh ? 'yes' : 'never')}
            </span>
          </RowActions>
        </Row>
      </Group>

      {/* A quota the engine does not report is a different statement from an
          account with no quota. macOS says which, and so does this: asking a
          non-current saved login for quota would report the live login's. */}
      {usage.length > 0 ? (
        <Group title={t('remaining_quota')} testId="accounts-inspector.usage">
          {usageGroups.map((group) => (
            <div key={group.id}>
              {group.title ? (
                <h3 className="mb-1 ml-1 mt-2 text-[11px] font-semibold text-secondary">{group.title}</h3>
              ) : null}
              {group.windows.map((window, index) => (
                <Row
                  key={quotaWindowLabel(window) + index}
                  testId={`accounts-inspector.usage.${quotaWindowLabel(window)}`}
                >
                  <RowText title={localizedQuotaWindowLabel(window, language, resolvedLanguage)} />
                  <RowActions>
                    <span className="text-[12px] whitespace-nowrap text-secondary">
                      {window.remainingPercent}% · {localizedQuotaResetFormatted(window, language, resolvedLanguage)}
                    </span>
                  </RowActions>
                </Row>
              ))}
            </div>
          ))}
        </Group>
      ) : row.kind === 'account' && !row.active ? (
        <Group title={t('remaining_quota')} testId="accounts-inspector.usage.empty">
          <Row>
            <RowText
              title={t('live_quota_active')}
              detail={t('make_current_check_quota_help')}
            />
            <RowActions>
              <Button
                kind="secondary"
                disabled={paused || !row.switchActionId}
                onClick={() => service.invokeAction(row.switchActionId, revision)}
              >
                {t('make_current_check_quota')}
              </Button>
            </RowActions>
          </Row>
        </Group>
      ) : row.kind === 'account' ? (
        <Group title={t('remaining_quota')} testId="accounts-inspector.usage.unavailable">
          <Row><RowText detail={t('provider_no_quota')} /></Row>
        </Group>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={t('remove_title').replace('{name}', row.label)}
          message={translateSource(removalMessage(row), language, resolvedLanguage)}
          confirmTitle={t('remove_account_title')}
          cancelTitle={tc('cancel')}
          destructive
          testId="accounts-remove-confirm"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onRemove();
          }}
        />
      ) : null}
    </Dialog>
  );
}
