import type { ReactNode } from 'react';
import type { TrayController } from '../hooks/useTrayController';
import { ProviderIcon, providerFamily, providerName } from '../lib/provider';
import { Field, InlineEmpty, OverflowMenu, SectionHeading } from './ui';

export function ManageView({ ctrl }: { ctrl: TrayController }) {
  if (ctrl.form?.kind.startsWith('account-')) return <AccountForm ctrl={ctrl} />;
  if (ctrl.form?.kind.startsWith('gateway-')) return <GatewayForm ctrl={ctrl} />;
  return <ManageList ctrl={ctrl} />;
}

function ManageList({ ctrl }: { ctrl: TrayController }) {
  const snapshot = ctrl.snapshot!;
  const providerIds = [
    ...new Set(
      [
        ...(snapshot.accounts ?? []).map((account) => account.providerId),
        ...(snapshot.gateways ?? []).map((gateway) => gateway.providerId),
      ].map(providerFamily),
    ),
  ].sort((left, right) => providerName(left).localeCompare(providerName(right)));

  const accounts = (snapshot.accounts ?? [])
    .map((account, index) => ({ account, index }))
    .filter(
      ({ account }) =>
        (ctrl.manageProvider === 'all' ||
          providerFamily(account.providerId) === ctrl.manageProvider) &&
        ctrl.matches(account.label, account.detail, account.providerId),
    );
  const gateways = (snapshot.gateways ?? [])
    .map((gateway, index) => ({ gateway, index }))
    .filter(
      ({ gateway }) =>
        (ctrl.manageProvider === 'all' ||
          providerFamily(gateway.providerId) === ctrl.manageProvider) &&
        ctrl.matches(gateway.name, gateway.detail, gateway.providerId),
    );

  const emptyDetail = (kind: 'accounts' | 'gateways') => {
    if (ctrl.query.trim()) return 'Try another search or clear the current query.';
    if (ctrl.manageProvider !== 'all') {
      return `No ${kind} are saved for ${providerName(ctrl.manageProvider)}.`;
    }
    return kind === 'accounts'
      ? 'Add a native account from an installed AI client.'
      : 'Add a gateway for Claude Code or Codex.';
  };

  return (
    <>
      <div className="manage-toolbar">
        <label className="native-search">
          <span>⌕</span>
          <input
            value={ctrl.query}
            placeholder="Search accounts and gateways"
            onChange={(event) => ctrl.setQuery(event.target.value)}
          />
        </label>
        <label className="provider-filter">
          <span className="sr-only">Provider</span>
          <select
            value={ctrl.manageProvider}
            onChange={(event) => ctrl.setManageProvider(event.target.value)}
          >
            <option value="all">All providers</option>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {providerName(id)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <SectionHeading
        title="Saved accounts"
        detail="Saved on this device"
        action={
          <button
            type="button"
            className="section-action"
            onClick={() => {
              const provider = (snapshot.accountProviders ?? []).find((item) => item.installed);
              ctrl.setForm({
                kind: 'account-add',
                providerId: provider?.id || '',
                name: '',
                label: '',
                detected: false,
              });
            }}
          >
            ＋ Add
          </button>
        }
      />
      <div className="group native-group">
        {accounts.length ? (
          accounts.map(({ account, index }) => (
            <div className="native-row" key={`account-${index}`}>
              <ProviderIcon value={account.providerId} size="medium" />
              <div className="row-main">
                <div className="row-title">
                  {account.label}
                  {account.active ? <span className="badge">Active</span> : null}
                </div>
                <div className="row-detail">{account.detail}</div>
              </div>
              <button
                type="button"
                className="native-button compact"
                disabled={ctrl.busy}
                onClick={() =>
                  ctrl.setForm({
                    kind: 'account-edit',
                    providerId: account.providerId,
                    name: account.name,
                    label: account.label,
                    detail: account.detail,
                  })
                }
              >
                Edit
              </button>
              <OverflowMenu
                menuKey={`account:${index}`}
                open={ctrl.overflowMenu === `account:${index}`}
                busy={ctrl.busy}
                onToggle={(key) =>
                  ctrl.setOverflowMenu(ctrl.overflowMenu === key ? null : key)
                }
                onClose={() => ctrl.setOverflowMenu(null)}
                items={[
                  {
                    label: 'Refresh saved account',
                    disabled: !account.canRefresh || ctrl.busy,
                    onClick: () =>
                      ctrl.mutate(
                        'account-refresh',
                        { providerId: account.providerId, name: account.name },
                        `refreshing ${account.label}`,
                      ),
                  },
                  {
                    label: 'Edit account',
                    disabled: ctrl.busy,
                    onClick: () =>
                      ctrl.setForm({
                        kind: 'account-edit',
                        providerId: account.providerId,
                        name: account.name,
                        label: account.label,
                        detail: account.detail,
                      }),
                  },
                  {
                    label: 'Remove…',
                    disabled: ctrl.busy,
                    danger: true,
                    onClick: () => {
                      if (
                        window.confirm(
                          `Remove ${account.label}?\n\nThis removes the saved login from AnyPick. The live app login is not signed out.`,
                        )
                      ) {
                        ctrl.mutate(
                          'account-remove',
                          { providerId: account.providerId, name: account.name },
                          `removing ${account.label}`,
                        );
                      }
                    },
                  },
                ]}
              />
            </div>
          ))
        ) : (
          <InlineEmpty
            symbol="＋"
            title={snapshot.accounts.length ? 'No matching accounts' : 'No saved accounts'}
            detail={emptyDetail('accounts')}
          />
        )}
      </div>

      <SectionHeading
        title="Gateways"
        detail="For Claude Code and Codex"
        action={
          <button
            type="button"
            className="section-action"
            onClick={() =>
              ctrl.setForm({
                kind: 'gateway-add',
                providerId: snapshot.gatewayProviders?.[0]?.id || '',
                name: '',
                label: '',
                endpoint: '',
                apiKey: '',
                defaultModel: '',
              })
            }
          >
            ＋ Add
          </button>
        }
      />
      <div className="group native-group">
        {gateways.length ? (
          gateways.map(({ gateway, index }) => (
            <div className="native-row" key={`gateway-${index}`}>
              <ProviderIcon value={gateway.providerId} size="medium" />
              <div className="row-main">
                <div className="row-title">
                  {gateway.name}
                  <span className={`badge${gateway.ready ? '' : ' warn'}`}>
                    {gateway.ready ? 'Ready' : 'Needs key'}
                  </span>
                </div>
                <div className="row-detail">{gateway.detail}</div>
              </div>
              <button
                type="button"
                className="native-button compact"
                disabled={ctrl.busy}
                onClick={() =>
                  ctrl.setForm({
                    kind: 'gateway-edit',
                    providerId: gateway.providerId,
                    name: gateway.name,
                    label: gateway.name,
                    endpoint: '',
                    apiKey: '',
                    defaultModel: gateway.defaultModel || '',
                  })
                }
              >
                Edit
              </button>
              <OverflowMenu
                menuKey={`gateway:${index}`}
                open={ctrl.overflowMenu === `gateway:${index}`}
                busy={ctrl.busy}
                onToggle={(key) =>
                  ctrl.setOverflowMenu(ctrl.overflowMenu === key ? null : key)
                }
                onClose={() => ctrl.setOverflowMenu(null)}
                items={[
                  {
                    label: 'Refresh available models',
                    disabled: !gateway.ready || ctrl.busy,
                    onClick: () =>
                      ctrl.mutate(
                        'gateway-refresh',
                        { name: gateway.name },
                        `refreshing ${gateway.name} models`,
                      ),
                  },
                  {
                    label: 'Edit gateway',
                    disabled: ctrl.busy,
                    onClick: () =>
                      ctrl.setForm({
                        kind: 'gateway-edit',
                        providerId: gateway.providerId,
                        name: gateway.name,
                        label: gateway.name,
                        endpoint: '',
                        apiKey: '',
                        defaultModel: gateway.defaultModel || '',
                      }),
                  },
                  {
                    label: 'Delete…',
                    disabled: ctrl.busy,
                    danger: true,
                    onClick: () => {
                      if (
                        window.confirm(
                          `Delete gateway ${gateway.name}?\n\nSecrets stored for this gateway will be deleted. Apps using it must be switched to another route.`,
                        )
                      ) {
                        ctrl.mutate(
                          'gateway-remove',
                          { name: gateway.name },
                          `removing gateway ${gateway.name}`,
                        );
                      }
                    },
                  },
                ]}
              />
            </div>
          ))
        ) : (
          <InlineEmpty
            symbol="⌁"
            title={snapshot.gateways.length ? 'No matching gateways' : 'No gateways configured'}
            detail={emptyDetail('gateways')}
          />
        )}
      </div>
      <p className="security-note">⌾ Gateway secrets stay in the Node supervisor.</p>
    </>
  );
}

function AccountForm({ ctrl }: { ctrl: TrayController }) {
  const form = ctrl.form!;
  const editing = form.kind === 'account-edit';
  const providers = (ctrl.snapshot?.accountProviders ?? []).filter((provider) => provider.installed);
  const provider = providers.find((item) => item.id === form.providerId);
  const onField = (name: string, value: string) => {
    ctrl.setForm({
      ...form,
      [name]: value,
      ...(name === 'providerId' && form.kind === 'account-add' ? { detected: false } : null),
    });
  };

  let providerState: ReactNode = null;
  if (!editing) {
    if (!ctrl.snapshot?.accountProviders?.length) {
      providerState = (
        <div className="form-unavailable">
          <span>□</span>
          <div>
            <strong>No native providers available</strong>
            <small>Install a supported AI client, sign in, then refresh AnyPick.</small>
          </div>
        </div>
      );
    } else if (!providers.length) {
      providerState = (
        <div className="form-unavailable">
          <span>△</span>
          <div>
            <strong>No supported app is installed</strong>
            <small>
              Install Claude, Codex, Gemini, Antigravity, or Kiro before saving an account.
            </small>
          </div>
        </div>
      );
    }
  }

  return (
    <>
      <SectionHeading
        title={editing ? 'Edit account' : 'Add native account'}
        detail={editing ? 'Update its display name' : 'Detect first, then save'}
      />
      <div className="form-sheet">
        {editing ? (
          <div className="read-only-provider">
            <ProviderIcon value={form.providerId || ''} size="small" />
            <span>{form.detail}</span>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="field-providerId">Provider</label>
            <select
              id="field-providerId"
              value={form.providerId}
              onChange={(event) => onField('providerId', event.target.value)}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.detail}
                </option>
              ))}
            </select>
          </div>
        )}
        {providerState}
        <Field label="Save as" name="name" value={form.name ?? ''} placeholder="work, personal…" onChange={onField} />
        <Field
          label="Display name"
          name="label"
          value={form.label ?? ''}
          placeholder="Optional label"
          onChange={onField}
        />
        {!editing ? (
          <>
            <p className="hint">
              Detect only reads the current login. No account snapshot is written until Save.
            </p>
            <p className={`hint${form.detected ? ' good' : ''}`}>
              {form.detected
                ? '✓ Login found. Ready to save.'
                : provider
                  ? `Ready to check ${provider.label}.`
                  : 'Install a supported app first.'}
            </p>
          </>
        ) : null}
        <div className="form-actions">
          <button type="button" onClick={() => ctrl.setForm(null)}>
            Cancel
          </button>
          {!editing ? (
            <button
              type="button"
              disabled={!provider || ctrl.busy || form.detected}
              onClick={() => {
                if (!provider) return;
                ctrl.mutate(
                  'account-detect',
                  {
                    providerId: provider.providerId,
                    sourceId: provider.sourceId,
                    name: 'detect',
                  },
                  `detecting the current ${provider.label} login`,
                  () => ctrl.setForm((prev) => (prev ? { ...prev, detected: true } : prev)),
                );
              }}
            >
              {form.detected ? 'Detected' : 'Detect login'}
            </button>
          ) : null}
          <span className="spacer" />
          <button
            type="button"
            className="primary"
            disabled={
              !(form.name ?? '').trim() || (!editing && !form.detected) || ctrl.busy
            }
            onClick={() => {
              if (editing) {
                ctrl.mutate(
                  'account-edit',
                  {
                    providerId: form.providerId,
                    name: form.name,
                    label: form.label,
                  },
                  `updating ${form.label || form.name}`,
                  () => ctrl.setForm(null),
                );
                return;
              }
              if (!provider) return;
              ctrl.mutate(
                'account-save',
                {
                  providerId: provider.providerId,
                  sourceId: provider.sourceId,
                  name: form.name,
                  label: form.label,
                },
                `saving ${form.label || form.name}`,
                () => ctrl.setForm(null),
              );
            }}
          >
            {editing ? 'Save changes' : 'Save current login'}
          </button>
        </div>
      </div>
    </>
  );
}

function GatewayForm({ ctrl }: { ctrl: TrayController }) {
  const form = ctrl.form!;
  const editing = form.kind === 'gateway-edit';
  const providers = ctrl.snapshot?.gatewayProviders ?? [];
  const onField = (name: string, value: string) => ctrl.setForm({ ...form, [name]: value });

  return (
    <>
      <SectionHeading
        title={editing ? 'Edit gateway' : 'Add gateway'}
        detail="Secrets are kept by the Node supervisor"
      />
      <div className="form-sheet">
        {editing ? (
          <div className="read-only-provider">
            <ProviderIcon value={form.providerId || ''} size="small" />
            <span>{providerName(form.providerId || '')}</span>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="field-providerId">Provider</label>
            <select
              id="field-providerId"
              value={form.providerId}
              onChange={(event) => onField('providerId', event.target.value)}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {!editing && !providers.length ? (
          <div className="form-unavailable">
            <span>⌁</span>
            <div>
              <strong>No gateway providers available</strong>
              <small>Refresh AnyPick and try again. No gateway can be saved yet.</small>
            </div>
          </div>
        ) : null}
        <Field label="Name" name="name" value={form.name ?? ''} placeholder="work" onChange={onField} />
        <Field
          label="Display name"
          name="label"
          value={form.label ?? ''}
          placeholder="Optional label"
          onChange={onField}
        />
        <Field
          label="Endpoint"
          name="endpoint"
          value={form.endpoint ?? ''}
          placeholder={editing ? 'Leave blank to keep current URL' : 'Provider default'}
          onChange={onField}
        />
        <Field
          label="API key"
          name="apiKey"
          value={form.apiKey ?? ''}
          placeholder={editing ? 'Leave blank to keep current key' : 'Required by most gateways'}
          type="password"
          onChange={onField}
        />
        <Field
          label="Default model"
          name="defaultModel"
          value={form.defaultModel ?? ''}
          placeholder="Optional model ID"
          onChange={onField}
        />
        <div className="form-actions">
          <button type="button" onClick={() => ctrl.setForm(null)}>
            Cancel
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="primary"
            disabled={!(form.name ?? '').trim() || ctrl.busy}
            onClick={() =>
              ctrl.mutate(
                editing ? 'gateway-edit' : 'gateway-create',
                {
                  providerId: form.providerId,
                  name: form.name,
                  label: form.label,
                  endpoint: form.endpoint,
                  apiKey: form.apiKey,
                  defaultModel: form.defaultModel,
                },
                `${editing ? 'updating' : 'adding'} ${form.name}`,
                () => ctrl.setForm(null),
              )
            }
          >
            {editing ? 'Save changes' : 'Add gateway'}
          </button>
        </div>
      </div>
    </>
  );
}
