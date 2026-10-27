import { useEffect, useMemo, useState } from 'react';

import type { AccountRow, GatewayProviderRow } from '../lib/contract';
import {
  TEST_LABEL,
  TEST_STATE_LABEL,
  connectionFooter,
  connectionTestEnabled,
  gatewayCanSave,
  providerSuppliesEndpoint,
  requiresApiKey,
  resolvedEndpoint,
  suggestedGatewayName,
  usesCustomEndpoint,
  type ConnectionState,
} from '../lib/gateway-flow';
import { createGateway, testGateway } from '../lib/desktop-actions';
import type { ServicePort } from '../lib/service';
import type { ServiceResult } from '../lib/wire';
import { translate, translateSource } from '../lib/i18n';
import { Dialog } from '../ui/Dialog';
import { MenuSelect } from '../ui/MenuSelect';
import { Button, Field, Group, Row, RowActions, RowText, StatusLabel } from '../ui/primitives';

/** The answer to a `gateway-test` the sheet asked for. */
export type GatewayFlowResult = { operation: string; result: ServiceResult };

/**
 * `AddGatewaySheet`. A gateway is a provider key plus an endpoint, so it gets
 * its own sheet rather than a block inside Add Account.
 *
 * The shape of the form follows the provider. One supplies its own base URL and
 * shows it read-only; one derives the URL from an account id and asks for that
 * instead; one reads a local login and asks for no key. The sheet this replaces
 * showed all five fields for every provider and disabled Save until the lot was
 * filled in, which asked people to type things the engine already knew.
 */
export function AddGatewaySheet({
  providers,
  accounts,
  language,
  resolvedLanguage,
  busy = false,
  flowResult,
  onSend,
  onClose,
}: {
  providers: readonly GatewayProviderRow[];
  /** The saved accounts, for a suggested name that is not already taken. */
  accounts: readonly AccountRow[];
  language: string;
  resolvedLanguage: string;
  busy?: boolean;
  flowResult?: GatewayFlowResult | null;
  onSend: (action: { operation: string; extra: Record<string, unknown> }) => void;
  onClose: () => void;
}) {
  const t = (key: string) => translate(`desktop.gateway.${key}`, language, resolvedLanguage);
  const tc = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  const tr = (source: string) => translateSource(source, language, resolvedLanguage);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const provider = providers.find((row) => row.id === providerId);

  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [endpoint, setEndpoint] = useState(provider?.defaultEndpoint ?? '');
  const [apiKey, setApiKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [gatewayId, setGatewayId] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('untested');
  const [message, setMessage] = useState('');

  const needsKey = requiresApiKey(provider);
  const custom = usesCustomEndpoint(provider);

  // Switching provider changes which fields mean anything, so every derived
  // value has to be re-derived: the endpoint and the test result.
  // Leaving a test result from the previous provider on screen would say
  // "Connected" about an endpoint that is no longer on the sheet.
  const [pendingProvider, setPendingProvider] = useState(providerId);
  if (pendingProvider !== providerId) {
    setPendingProvider(providerId);
    setEndpoint(provider?.defaultEndpoint ?? '');
    setConnection('untested');
    setMessage('');
  }

  useEffect(() => {
    if (!nameTouched && name === '') {
      setName(suggestedGatewayName(accounts, provider?.label ?? '', custom));
    }
  }, [accounts, custom, name, nameTouched, provider?.label]);

  // Every answer is matched to the command it answers, so a `gateway-test` from
  // another sheet cannot land on this one's connection row.
  const seenResult = useMemo(() => ({ current: '' }), []);
  useEffect(() => {
    if (!flowResult || flowResult.operation !== 'gateway-test') return;
    if (flowResult.result.requestId === seenResult.current) return;
    seenResult.current = flowResult.result.requestId;
    if (connection !== 'testing') return;
    setConnection(flowResult.result.status === 'success' ? 'available' : 'unavailable');
    setMessage(flowResult.result.message);
  }, [connection, flowResult, seenResult]);

  // Any change to what is being tested makes the previous answer stale.
  const [tested, setTested] = useState('');
  const testKey = `${endpoint}|${apiKey}|${accountId}`;
  if (tested !== testKey) {
    setTested(testKey);
    setConnection((current) => (current === 'testing' ? current : 'untested'));
    setMessage('');
  }

  const canSave = gatewayCanSave({
    provider,
    name,
    apiKey,
    accountId,
    endpoint,
    busy,
  });

  const save = () => {
    if (!provider) return;
    onSend(
      createGateway({
        providerId: provider.id,
        name,
        label: name,
        apiKey: needsKey ? apiKey.trim() : undefined,
        endpoint: custom ? endpoint : undefined,
        // The engine's own default applies when the field is left blank; a
        // prefilled "default" the user cannot see is a value they have to
        // delete before typing their own.
        gatewayId: provider.requiresGatewayId ? gatewayId.trim() || 'default' : undefined,
        // An account-derived gateway is probed and stored by its account
        // id; the engine builds the URL. `accountId` is not a wire field.
        profile: provider.requiresAccountId ? accountId : undefined,
      }),
    );
  };

  const test = () => {
    if (!provider) return;
    setConnection('testing');
    setMessage('');
    onSend(
      testGateway({
        providerId: provider.id,
        endpoint: resolvedEndpoint(provider, endpoint),
        apiKey: needsKey ? apiKey.trim() : undefined,
        // An account-scoped gateway is probed by its account id; the engine
        // derives the URL that goes with it.
        profile: provider.requiresAccountId ? accountId : undefined,
      }),
    );
  };

  return (
    <Dialog
      title={t('add_title')}
      onCancel={onClose}
      testId="gateway-flow.provider.dialog"
      width="form"
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            kind="primary"
            testId="gateway-flow.save"
            disabled={!canSave}
            onClick={save}
          >
            {t('add_action')}
          </Button>
        </>
      }
    >
      <Group
        title={t('gateway')}
        footer={t('provider_fields_help')}
        testId="gateway-flow.gateway"
      >
        <Row>
          <RowText title={tr('Provider')} detail={tr(provider?.detail ?? '')} />
          <RowActions>
            {/* The brand mark leads each item, as `AddGatewaySheet.swift:96`
                passes the provider to `DesignProviderIcon`. */}
            <MenuSelect
              label=""
              ariaLabel={t('provider')}
              title={t('choose_provider_help')}
              value={providerId}
              testId="gateway-flow.provider.picker"
              onChange={setProviderId}
              options={providers.map((row) => ({
                value: row.id,
                label: row.label,
                provider: row.id,
              }))}
            />
          </RowActions>
        </Row>
        <Row>
          <Field
            label={t('name')}
            value={name}
            help={t('name_help')}
            onChange={(value) => {
              setName(value);
              setNameTouched(true);
            }}
            testId="gateway-flow.name"
          />
        </Row>
      </Group>

      <Group title={t('credentials')} footer={tr(connectionFooter({ state: connection, provider, message, endpoint, busy }))}>
        {needsKey ? (
          <Row>
            <Field
              label={tc('api_key')}
              value={apiKey}
              help={t('enter_api_key_help')}
              onChange={setApiKey}
              type={revealKey ? 'text' : 'password'}
              testId="gateway-flow.api-key"
            />
            <RowActions>
              <Button
                kind="secondary"
                ariaLabel={t(revealKey ? 'hide_api_key' : 'show_api_key')}
                testId="gateway-flow.api-key.reveal"
                onClick={() => setRevealKey((current) => !current)}
              >
                {revealKey ? tc('hide') : tc('show')}
              </Button>
            </RowActions>
          </Row>
        ) : (
          <>
            <Row>
              <RowText
                title={t('no_key_needed')}
                detail={providerId === 'grok' ? t('grok_login_help') : undefined}
              />
            </Row>
            <Row>
              <RowText detail={t('grok_setup')} />
            </Row>
          </>
        )}

        {provider?.requiresAccountId ? (
          <Row>
            <Field
              label={t('account_id')}
              value={accountId}
              help={t('account_id_help')}
              onChange={setAccountId}
              testId="gateway-flow.account-id"
            />
          </Row>
        ) : null}

        {provider?.requiresGatewayId ? (
          <Row>
            <Field
              label={t('gateway_id')}
              value={gatewayId}
              help={t('gateway_id_help')}
              onChange={setGatewayId}
              testId="gateway-flow.gateway-id"
            />
          </Row>
        ) : null}

        {providerSuppliesEndpoint(provider) ? (
          // Read-only, not a field. The engine has this value; a text box would
          // invite a user to break it by typing a URL that differs by a slash.
          <Row testId="gateway-flow.endpoint">
            <RowText
              title={t('endpoint')}
              detail={provider?.defaultEndpoint || t('provided_by').replace('{provider}', provider?.label ?? providerId)}
            />
          </Row>
        ) : (
          <Row>
            <Field
              label={t('endpoint')}
              value={endpoint}
              help={t('endpoint_help')}
              onChange={setEndpoint}
              testId="gateway-flow.endpoint.input"
            />
          </Row>
        )}

        <Row testId="gateway-flow.connection">
          <RowText title={t('connection')} />
          <RowActions>
            {/*
              Each state carries its own id rather than one row whose id is
              interpolated from the state: the three states are three
              different answers, and an inventory that only sees
              `gateway-flow.{x}` cannot tell which ones the app can show.
            */}
            {connection === 'testing' ? (
              <span
                className="text-[12px] text-secondary"
                role="status"
                data-testid="gateway-flow.testing"
              >
                {t('testing')}
              </span>
            ) : null}
            {connection === 'available' ? (
              <span className="inline-flex" data-testid="gateway-flow.available">
                <StatusLabel status="ready" language={language} resolvedLanguage={resolvedLanguage} />
              </span>
            ) : null}
            {connection === 'unavailable' ? (
              <span className="inline-flex" data-testid="gateway-flow.unavailable">
                <StatusLabel status="unavailable" language={language} resolvedLanguage={resolvedLanguage} />
              </span>
            ) : null}
            <Button
              kind="secondary"
              testId="gateway-flow.test"
              disabled={connection === 'testing' || !connectionTestEnabled({ provider, apiKey, accountId, busy })}
              onClick={test}
            >
              {tr(TEST_LABEL[connection])}
            </Button>
          </RowActions>
        </Row>
      </Group>
    </Dialog>
  );
}

export { TEST_STATE_LABEL };
