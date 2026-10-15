import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  AccountProviderRow,
  AccountRow as AccountRowContract,
  GatewayProviderRow,
  GatewayRow,
  Snapshot,
} from '../lib/contract';
import {
  clearLiveLogin,
  editAccount,
  editGateway,
  gatewayConnectInvokes,
  gatewayConnectRoutes,
  refreshGateway,
  removeGateway,
} from '../lib/desktop-actions';
import { nativeProviderName, usageForClient } from '../lib/model';
import {
  ALL_PROVIDERS,
  matchesProviderFilter,
  providerFilterLabel,
  providerFilterOptions,
  type ProviderFilter,
} from '../lib/account-filter';
import { accountView, gatewayView } from '../lib/account-row';
import type { ServicePort } from '../lib/service';
import { MenuSelect } from '../ui/MenuSelect';
import { Dialog } from '../ui/Dialog';
import {
  Button,
  CheckRow,
  EmptyState,
  Field,
  Group,
  Pane,
  PaneActions,
  Row,
  RowActions,
  RowText,
  Select,
} from '../ui/primitives';
import { AddAccountSheet, type AccountFlowResult } from './AddAccountSheet';
import { AddGatewaySheet, type GatewayFlowResult } from './AddGatewaySheet';
import { ConfirmDialog } from './ProxiesPane';
import { AccountDetailSheet } from './AccountDetailSheet';
import { AccountRowGrid } from './AccountRow';
import { translate, translateSource } from '../lib/i18n';

/**
 * Accounts and API endpoints.
 *
 * Add, edit, and gateway commands use the same fields the macOS sheets send.
 * A blank optional is left off the wire, because the engine rejects a key
 * that operation does not allow and also rejects an empty required string.
 */
export function AccountsPane({
  service,
  snapshot,
  query = '',
  busy = new Set<string>(),
  accountFlowResult = null,
  onClearFlowResult,
  gatewayFlowResult = null,
}: {
  service: ServicePort;
  snapshot: Snapshot;
  query?: string;
  busy?: ReadonlySet<string>;
  /** The Add Account sheet's last answer. The sheet stays open until it succeeds. */
  accountFlowResult?: AccountFlowResult | null;
  /**
   * Drops the held answer once no sheet is showing.
   *
   * Without this the next Add Account would replay the previous sheet's
   * detection: a fresh sheet would open already showing an identity nobody
   * asked it to read, and its primary button would say Add Account rather than
   * what it would actually do.
   */
  onClearFlowResult?: () => void;
  /** The Add API Gateway sheet's last `gateway-test` answer. */
  gatewayFlowResult?: GatewayFlowResult | null;
}) {
  const t = (key: string) => {
    const accountMessage = `desktop.accounts.${key}`;
    const accountText = translate(accountMessage, snapshot.settings.language, snapshot.settings.resolvedLanguage);
    return accountText === accountMessage
      ? translate(`desktop.common.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage)
      : accountText;
  };
  const tr = (source: string) =>
    translateSource(source, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const [pendingRemove, setPendingRemove] = useState<AccountRowContract | null>(null);
  const [pendingGatewayRemove, setPendingGatewayRemove] = useState<GatewayRow | null>(null);
  // The row's Show Details target. A dialog rather than an inline expansion,
  // because expanding a row resizes the very reserved columns that make the
  // list line up.
  const [inspecting, setInspecting] = useState<AccountRowContract | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingGateway, setAddingGateway] = useState(false);
  const [editing, setEditing] = useState<AccountRowContract | null>(null);
  const [editingGateway, setEditingGateway] = useState<GatewayRow | null>(null);
  const [connecting, setConnecting] = useState<GatewayRow | null>(null);
  const [connectQueue, setConnectQueue] = useState<string[]>([]);
  const closeSheet = () => {
    setAdding(false);
    onClearFlowResult?.();
  };
  const [loginRequest, setLoginRequest] = useState('');
  const [pasteFlight, setPasteFlight] = useState<{ requestId: string; path: string } | null>(null);
  /*
   * Two different narrowings. The search box matches text across every
   * provider — a user typing "work" wants the ones called Work from all of them.
   * The filter names one provider, which is what someone with six providers and
   * fourteen accounts actually wants when they only care about one.
   */
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(ALL_PROVIDERS);
  const providers = useMemo(
    () => providerFilterOptions(snapshot.accounts, snapshot.gateways),
    [snapshot.accounts, snapshot.gateways],
  );
  // A filter naming a provider whose last account was removed would show an
  // empty pane with no way back except the picker.
  const activeFilter =
    providerFilter.kind === 'provider' && !providers.includes(providerFilter.provider)
      ? ALL_PROVIDERS
      : providerFilter;
  const groups = useMemo(
    () => groupAccounts(snapshot.accounts, query, activeFilter),
    [activeFilter, query, snapshot.accounts],
  );
  const gateways = useMemo(
    () => filterGateways(snapshot.gateways, query, activeFilter),
    [activeFilter, query, snapshot.gateways],
  );
  const paused = busy.size > 0 || connectQueue.length > 0;

  // Each accepted route switch publishes a new snapshot. An invoke more than
  // one revision behind is rejected, so the next app waits until the in-flight
  // switch settles and the pane is holding the revision that switch published.
  useEffect(() => {
    if (busy.size > 0 || connectQueue.length === 0) return;
    const [next, ...rest] = connectQueue;
    if (next) service.invokeAction(next, snapshot.revision);
    setConnectQueue(rest);
  }, [busy.size, connectQueue, service, snapshot.revision]);

  const send = (action: { operation: string; extra: Record<string, unknown> }) => {
    const requestId = service.mutate(action.operation, action.extra);
    if (action.operation === 'account-login') {
      setLoginRequest(requestId);
      return;
    }
    if (action.operation === 'account-save-auth') {
      setPasteFlight({
        requestId,
        path: typeof action.extra.path === 'string' ? action.extra.path : '',
      });
      return;
    }
    // Every other command here writes an account row, and the refreshed
    // snapshot is the proof. A sign-in does not: it opens a browser, so the
    // sheet stays open until the engine says it landed.
    if (action.operation !== 'account-detect' && action.operation !== 'account-clear') {
      closeSheet();
    }
  };

  useEffect(() => {
    if (!pasteFlight || !accountFlowResult) return;
    if (accountFlowResult.result.requestId !== pasteFlight.requestId) return;
    if (accountFlowResult.result.status !== 'success') return;
    void service.forgetAuthPaste(pasteFlight.path);
    setPasteFlight(null);
    closeSheet();
    // `closeSheet` is a fresh closure each render; depending on it would
    // re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountFlowResult, pasteFlight, service]);

  return (
    <Pane title={t('title')} testId="accounts">
      {providers.length > 0 || loginRequest ? (
        <div className="flex items-center justify-end gap-2 px-0.5 pb-1">
          {providers.length > 0 ? (
            <MenuSelect
              label=""
              ariaLabel={t('filter_provider')}
              value={activeFilter.kind === 'all' ? '' : activeFilter.provider}
              testId="accounts.filter"
              onChange={(value) => setProviderFilter(value === '' ? ALL_PROVIDERS : { kind: 'provider', provider: value })}
              options={[
                { value: '', label: t('all_providers') },
                ...providers.map((provider) => ({
                  value: provider,
                  label: nativeProviderName(provider),
                  provider,
                })),
              ]}
            />
          ) : null}
          {loginRequest ? (
            <Button
              kind="quiet"
              testId="accounts-cancel-login"
              onClick={() => {
                service.cancel(loginRequest);
                setLoginRequest('');
              }}
            >
              {t('cancel_signin')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {groups.length === 0 && gateways.length === 0 ? (
        <EmptyState
          title={t(query ? 'no_results' : 'no_saved_accounts')}
          detail={t(query ? 'no_accounts_match' : 'saved_logins_here')}
          testId="accounts-empty"
        />
      ) : null}

      {groups.map(([providerId, accounts]) => (
        <Group key={providerId} title={nativeProviderName(providerId)} testId={`accounts-${providerId}`}>
          {accounts.map((account) => (
            <Row
              key={account.id}
              testId={`accounts.row.${account.id}`}
              onClick={() => setInspecting(account)}
            >
                <AccountRowGrid
                row={accountView(account)}
                  t={t}
                  tr={tr}
                  language={snapshot.settings.language}
                  resolvedLanguage={snapshot.settings.resolvedLanguage}
                service={service}
                paused={paused}
                revision={snapshot.revision}
                onEdit={() => setEditing(account)}
                onRemove={() => setPendingRemove(account)}
                onDetails={() => setInspecting(account)}
              />
            </Row>
          ))}
        </Group>
      ))}

      {gateways.length > 0 ? (
        <Group title={t('api_gateways')} testId="accounts-gateways">
          {gateways.map((gateway) => (
            <Row
              key={gateway.id}
              testId={`accounts.row.${gateway.id}`}
              onClick={() => setConnecting(gateway)}
            >
              <AccountRowGrid
                  row={gatewayView(gateway)}
                t={t}
                  tr={tr}
                language={snapshot.settings.language}
                resolvedLanguage={snapshot.settings.resolvedLanguage}
                  service={service}
                  paused={paused}
                  revision={snapshot.revision}
                  onEdit={() => setEditingGateway(gateway)}
                  onRemove={() => setPendingGatewayRemove(gateway)}
                  onDetails={() => setConnecting(gateway)}
                />
            </Row>
          ))}
        </Group>
      ) : null}

      <PaneActions>
        <Button kind="secondary" disabled={paused} testId="accounts-add" onClick={() => setAdding(true)}>
          {t('add_login')}
        </Button>
        {snapshot.gatewayProviders.length > 0 ? (
          <Button
            kind="secondary"
            disabled={paused}
            testId="accounts.add-gateway"
            onClick={() => setAddingGateway(true)}
          >
            {t('add_gateway')}
          </Button>
        ) : null}
      </PaneActions>

      {inspecting ? (
        <AccountDetailSheet
          account={inspecting}
          usage={
            // Quota is reported per app, not per account, so the card is found
            // by whichever client uses this login. A saved account no app uses
            // has no card, and the sheet says so rather than showing zeros.
            usageForClient(snapshot.usage, inspecting.providerId)?.windows ?? []
          }
          service={service}
          paused={paused}
          revision={snapshot.revision}
          language={snapshot.settings.language}
          resolvedLanguage={snapshot.settings.resolvedLanguage}
          onEdit={() => {
            setEditing(inspecting);
            setInspecting(null);
          }}
          onRemove={() => {
            setPendingRemove(inspecting);
            setInspecting(null);
          }}
          onClose={() => setInspecting(null)}
        />
      ) : null}

      {/* Two sheets, two buttons, as on macOS. A gateway is a provider key plus
          an endpoint; it is not something AnyPick reads off this Mac, and there
          is no identity to detect. Rendering both in one scroll meant the
          provider picker changed meaning halfway down. */}
      {adding ? (
        <AddAccountSheet
          providers={snapshot.accountProviders}
          language={snapshot.settings.language}
          resolvedLanguage={snapshot.settings.resolvedLanguage}
          service={service}
          busy={paused}
          flowResult={accountFlowResult}
          onSend={send}
          onClear={(providerId, sourceId) => {
            const action = clearLiveLogin(providerId, sourceId);
            service.mutate(action.operation, action.extra);
          }}
          onClose={closeSheet}
        />
      ) : null}

      {addingGateway ? (
        <AddGatewaySheet
          providers={snapshot.gatewayProviders}
          language={snapshot.settings.language}
          resolvedLanguage={snapshot.settings.resolvedLanguage}
          accounts={snapshot.accounts}
          busy={paused}
          flowResult={gatewayFlowResult}
          onSend={send}
          onClose={() => setAddingGateway(false)}
        />
      ) : null}

      {editing ? (
        <LabelSheet
          title={t('edit_title').replace('{name}', editing.label)}
          t={t}
          initial={editing.label}
          allowClear
          testId="account-edit-label"
          onCancel={() => setEditing(null)}
          onSave={(label) => {
            const action = editAccount(editing, label);
            service.mutate(action.operation, action.extra);
            setEditing(null);
          }}
        />
      ) : null}

      {editingGateway ? (
        <LabelSheet
          title={t('edit_title').replace('{name}', editingGateway.name)}
          t={t}
          initial={gatewayEditLabel(editingGateway)}
          testId="gateway-edit-label"
          onCancel={() => setEditingGateway(null)}
          onSave={(label) => {
            const action = editGateway(editingGateway.name, label);
            service.mutate(action.operation, action.extra);
            setEditingGateway(null);
          }}
        />
      ) : null}

      {connecting ? (
        <ConnectSheet
          gateway={connecting}
          snapshot={snapshot}
          t={t}
          busy={paused}
          onCancel={() => setConnecting(null)}
          onConnect={(clientIds) => {
            const gateway = connecting;
            setConnecting(null);
            setConnectQueue(gatewayConnectInvokes(snapshot, gateway.name, clientIds));
          }}
        />
      ) : null}

      {pendingRemove ? (
        <ConfirmDialog
          title={t('remove_title').replace('{name}', pendingRemove.label)}
          message={t('account_remove_message')}
          confirmTitle={t('remove')}
          destructive
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const account = pendingRemove;
            setPendingRemove(null);
            service.mutate('account-remove', { providerId: account.providerId, name: account.name });
          }}
        />
      ) : null}

      {pendingGatewayRemove ? (
        <ConfirmDialog
          title={t('gateway_remove_title').replace('{name}', pendingGatewayRemove.name)}
          message={t('gateway_remove_message')}
          confirmTitle={t('remove')}
          destructive
          testId="gateway-remove-dialog"
          onCancel={() => setPendingGatewayRemove(null)}
          onConfirm={() => {
            const gateway = pendingGatewayRemove;
            setPendingGatewayRemove(null);
            const action = removeGateway(gateway.name, gateway.providerId);
            service.mutate(action.operation, action.extra);
          }}
        />
      ) : null}
    </Pane>
  );
}

function LabelSheet({
  title,
  t,
  initial,
  allowClear = false,
  testId,
  onCancel,
  onSave,
}: {
  title: string;
  t: (key: string) => string;
  initial: string;
  /** An account label may be cleared. A gateway label may not. Saving the text already shown would store it again. */
  allowClear?: boolean;
  testId: string;
  onCancel: () => void;
  onSave: (label: string) => void;
}) {
  const [label, setLabel] = useState(initial);
  const cleaned = label.trim();
  const unchanged = cleaned === initial.trim();
  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      width="form"
      widthTestId="account-edit.error"
      actions={
        <>
          <Button kind="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button kind="primary" disabled={unchanged || (!allowClear && cleaned === '')} onClick={() => onSave(label)}>
            {t('save')}
          </Button>
        </>
      }
    >
      <Field label={t('label')} value={label} onChange={setLabel} testId={testId} />
    </Dialog>
  );
}

/** The row detail is the saved label, unless the engine fell back to the provider id. */
function gatewayEditLabel(gateway: GatewayRow): string {
  if (gateway.detail && gateway.detail !== gateway.providerId) return gateway.detail;
  return gateway.name;
}

function ConnectSheet({
  gateway,
  snapshot,
  t,
  busy,
  onCancel,
  onConnect,
}: {
  gateway: GatewayRow;
  snapshot: Snapshot;
  t: (key: string) => string;
  busy: boolean;
  onCancel: () => void;
  onConnect: (clientIds: string[]) => void;
}) {
  const routes = gatewayConnectRoutes(snapshot, gateway.name);
  const [chosen, setChosen] = useState<string[]>(() => routes.filter((route) => route.using).map((route) => route.clientId));
  const invokes = gatewayConnectInvokes(snapshot, gateway.name, chosen);
  return (
    <Dialog
      title={t('connect_title').replace('{name}', gateway.name)}
      onCancel={onCancel}
      testId="gateway-connect-dialog"
      width="form"
      widthTestId="gateway-connect.app"
      actions={
        <>
          <Button kind="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            kind="primary"
            disabled={busy || invokes.length === 0}
            testId="gateway-connect-submit"
            onClick={() => onConnect(chosen)}
          >
            {t('connect')}
          </Button>
        </>
      }
    >
      {routes.length === 0 ? (
        <Row>
          <RowText
            title={t('no_compatible_apps')}
            detail={t('compatible_detail')}
          />
        </Row>
      ) : (
        routes.map((route) => (
          <Row key={route.clientId} testId={`gateway-connect-app-${route.clientId}`}>
            <CheckRow
              label={route.client}
              checked={chosen.includes(route.clientId)}
              onChange={(checked) =>
                setChosen((current) =>
                  checked ? [...current, route.clientId] : current.filter((id) => id !== route.clientId),
                )
              }
            />
          </Row>
        ))
      )}
    </Dialog>
  );
}

function groupAccounts(
  accounts: AccountRowContract[],
  query: string,
  filter: ProviderFilter,
): Array<[string, AccountRowContract[]]> {
  const needle = query.trim().toLocaleLowerCase();
  const grouped = new Map<string, AccountRowContract[]>();
  for (const account of accounts) {
    if (!matchesProviderFilter(account.providerId, filter)) continue;
    const haystack = `${account.label} ${account.detail} ${account.name} ${account.providerId}`.toLocaleLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    grouped.set(account.providerId, [...(grouped.get(account.providerId) ?? []), account]);
  }
  return [...grouped.entries()];
}

function filterGateways(gateways: GatewayRow[], query: string, filter: ProviderFilter): GatewayRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return gateways.filter((gateway) => {
    if (!matchesProviderFilter(gateway.providerId, filter)) return false;
    if (!needle) return true;
    return `${gateway.name} ${gateway.detail} ${gateway.providerId}`.toLocaleLowerCase().includes(needle);
  });
}
