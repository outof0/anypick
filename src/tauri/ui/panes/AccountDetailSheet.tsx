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
import { groupUsageWindows, quotaResetFormatted, quotaWindowLabel } from '../lib/model';
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
  /** Windows the engine reported for this account. Empty means none. */
  usage?: UsageWindow[];
  service: ServicePort;
  paused?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const row = 'ready' in account ? gatewayView(account) : accountView(account);
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
            Remove Account…
          </Button>
          <div className="flex items-center gap-2">
            <Button kind="secondary" testId="account-inspect.edit" disabled={paused} onClick={onEdit}>
              Edit…
            </Button>
            {row.kind === 'account' && !row.active ? (
              <Button
                kind="secondary"
                testId="accounts.inspector.make-current"
                disabled={paused || !row.switchActionId}
                onClick={() => service.invokeAction(row.switchActionId, revision)}
              >
                Make Current
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
              {row.kind === 'gateway' ? 'Test Connection' : 'Refresh Login'}
            </Button>
            <Button kind="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      }
    >
      <Group title="Account" testId="accounts-inspector.identity">
        <Row warning={row.status === 'attention' || row.status === 'unavailable'}>
          <RowText
            title={row.label}
            detail={accountRowSubtitle(row)}
            issue={accountIssue(row)}
          />
          <RowActions>
            {row.active ? <StatusLabel status="ready" /> : <StatusLabel status={row.status} />}
          </RowActions>
        </Row>
        <Row>
          <RowText title="Provider" />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">{row.providerId}</span>
          </RowActions>
        </Row>
        <Row>
          <RowText title="Type" />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {row.kind === 'gateway' ? 'API Gateway' : 'Saved Login'}
            </span>
          </RowActions>
        </Row>
        <Row testId="accounts-inspector.last-used">
          <RowText title="Last Used" />
          <RowActions>
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {row.canRefresh ? 'Yes' : 'Never'}
            </span>
          </RowActions>
        </Row>
      </Group>

      {/* A quota the engine does not report is a different statement from an
          account with no quota. macOS says which, and so does this: asking a
          non-current saved login for quota would report the live login's. */}
      {usage.length > 0 ? (
        <Group title="Remaining Quota" testId="accounts-inspector.usage">
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
                  <RowText title={quotaWindowLabel(window)} />
                  <RowActions>
                    <span className="text-[12px] whitespace-nowrap text-secondary">
                      {window.remainingPercent}% · {quotaResetFormatted(window)}
                    </span>
                  </RowActions>
                </Row>
              ))}
            </div>
          ))}
        </Group>
      ) : row.kind === 'account' && !row.active ? (
        <Group title="Remaining Quota" testId="accounts-inspector.usage.empty">
          <Row>
            <RowText
              title="Quota is reported for the login currently signed in."
              detail="Make this account current to check it."
            />
            <RowActions>
              <Button
                kind="secondary"
                disabled={paused || !row.switchActionId}
                onClick={() => service.invokeAction(row.switchActionId, revision)}
              >
                Make Current to Check Quota
              </Button>
            </RowActions>
          </Row>
        </Group>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Remove ${row.label}?`}
          message={removalMessage(row)}
          confirmTitle="Remove Account"
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
