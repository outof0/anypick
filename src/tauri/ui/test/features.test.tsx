import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, useMemo, useState, type MutableRefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { createService, type ServiceHandle } from '../lib/service';
import { AccountsPane, ActivityPane, AppsPane, BackupsPane, ProxiesPane } from '../panes';
import { SettingsPane } from '../panes/SettingsPane';
import type { AccountFlowResult } from '../panes/AddAccountSheet';
import type { GatewayFlowResult } from '../panes/AddGatewaySheet';
import type { Snapshot } from '../lib/contract';
import { FakeBridge, snapshotFixture } from './harness';

const bridges: FakeBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

function mount(
  ui: (props: { service: ReturnType<typeof createService>['port']; snapshot: Snapshot }) => React.ReactElement,
  snapshot: Snapshot = snapshotFixture(),
) {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  const { port } = createService({ bridge });
  const user = userEvent.setup();
  return { bridge, user, port, ...render(ui({ service: port, snapshot })) };
}

/**
 * Build the answer the engine would send for the Nth mutation.
 *
 * Exactly one terminal frame arrives per request, and a sheet that waits for it
 * stays disabled until it does. A test that sends a command and never answers
 * would be asserting a state no real run can reach.
 */
function answerFor(bridge: FakeBridge, index: number, message: string): AccountFlowResult {
  const payload = mutatePayloads(bridge)[index];
  return {
    operation: String(payload?.operation),
    result: { requestId: String(payload?.requestId), status: 'success', message },
  };
}

function mutatePayloads(bridge: FakeBridge) {
  return bridge.commands().filter((entry) => entry.kind === 'mutate').map((entry) => entry.payload);
}

/** What each mutation carried, envelope removed. Compare exactly. */
function mutateBodies(bridge: FakeBridge) {
  return bridge.bodies('mutate');
}

describe('proxy key rotation', () => {
  it('confirms a relay rotation, then invokes the action the snapshot published', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByTestId('proxies.more-claude/work'));
    await user.click(screen.getByRole('menuitem', { name: 'Rotate API Key…' }));

    // Nothing is sent until the user confirms: a rotation drops every app
    // configured with the current key.
    expect(bridge.commandKinds()).not.toContain('invoke');
    const dialog = within(screen.getByTestId('proxies.rotate-confirm-claude/work'));
    expect(dialog.getByText('Rotate API Key for Work?')).toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Rotate Key' }));
    expect(bridge.bodies('invoke')).toEqual([
      { actionId: 'act-7-203', revision: 7 },
    ]);
  });

  it('sends nothing when a relay rotation is cancelled', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByTestId('proxies.more-claude/work'));
    await user.click(screen.getByRole('menuitem', { name: 'Rotate API Key…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.commandKinds()).not.toContain('invoke');
  });

  it('offers no rotation on a stopped relay, and keeps the hub out of this list', () => {
    // A stopped relay has no key to rotate. The hub is not a relay: it is
    // reported in its own group, and its key is minted in the Proxy Hub pane
    // (`ProxiesView.swift:112`).
    mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    expect(
      within(screen.getByTestId('proxy-codex/team')).queryByTestId('proxies.more-codex/team'),
    ).toBeNull();
    expect(within(screen.getByTestId('proxies-list')).queryByTestId('proxy-proxy-hub/default')).toBeNull();
  });
});

describe('accounts and gateways', () => {
  it('saves the current login, detects, and starts a browser sign-in', async () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    // The pane is handed the engine's answer as a prop, so the test owns the
    // routing the App normally does. A ref would not re-render.
    const setFlow: { current: (value: AccountFlowResult | null) => void } = { current: () => {} };
    function Host() {
      const handle = useMemo(() => createService({ bridge }), []);
      const [flow, setAnswer] = useState<AccountFlowResult | null>(null);
      setFlow.current = setAnswer;
      return (
        <AccountsPane
          service={handle.port}
          snapshot={snapshotFixture()}
          accountFlowResult={flow}
          onClearFlowResult={() => setAnswer(null)}
        />
      );
    }
    const user = userEvent.setup();
    render(<Host />);
    const answer = async (index: number, message: string) => {
      await act(async () => {
        setFlow.current(answerFor(bridge, index, message));
      });
    };

    // The sheet is a flow now: one provider, one source. "On This Mac" saves
    // what is already signed in; "New Account" starts a browser sign-in.
    await user.click(screen.getByTestId('accounts-add'));
    await user.type(screen.getByTestId('account-flow.name'), 'Work');
    await user.click(screen.getByRole('button', { name: 'Add Login' }));
    // A successful save closes the sheet.
    expect(screen.queryByTestId('account-flow.provider')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('accounts-add'));
    await user.type(screen.getByTestId('account-flow.name'), 'Work');
    await user.click(screen.getByTestId('account-flow.detect'));
    // The identity the engine reported lands in the identity card, with the app
    // it was read from. Before the answer, the card names what is being read.
    expect(screen.getByTestId('account-flow.identity')).toHaveTextContent('Checking');
    await answer(1, 'Detected alex@studio.example in Claude Code.');
    const card = screen.getByTestId('account-flow.identity');
    expect(card).toHaveTextContent('alex@studio.example');
    expect(card).toHaveTextContent('Claude Code on this Mac');

    // A detect does not close the sheet: the identity it found is what the
    // next command needs, and closing would throw it away.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByTestId('accounts-add'));
    await user.type(screen.getByTestId('account-flow.name'), 'Work');
    await user.click(screen.getByRole('button', { name: 'New Account' }));
    // The primary button names what it will do, not what the sheet is called.
    await user.click(screen.getByRole('button', { name: 'Sign In with Claude' }));
    expect(mutateBodies(bridge)).toEqual([
      // The identity is a display hint; the engine stores what the snapshot says.
      { operation: 'account-save', providerId: 'claude', name: 'Work', identity: 'Current Claude login' },
      { operation: 'account-detect', providerId: 'claude', name: 'detect' },
      { operation: 'account-login', providerId: 'claude', name: 'Work', methodId: 'subscription' },
    ]);
    const login = mutatePayloads(bridge)[2];
    await user.click(screen.getByTestId('accounts-cancel-login'));
    expect(bridge.commands().find((entry) => entry.kind === 'cancel')?.payload?.requestId).toBe(login?.requestId);
  });

  it('edits a label and refreshes a gateway by name alone', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <AccountsPane service={service} snapshot={snapshot} />);
    // Edit and Refresh are row-menu commands now. macOS puts a row's secondary
    // commands behind one control precisely so the row is not four buttons.
    await user.click(screen.getByTestId('accounts.more.claude/work'));
    await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));
    await user.clear(screen.getByTestId('account-edit-label'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByTestId('accounts.more.team'));
    await user.click(screen.getByRole('menuitem', { name: 'Test Connection' }));
    expect(mutateBodies(bridge)[0]).toEqual({ operation: 'account-edit', providerId: 'claude', name: 'work', label: '' });
    expect(mutateBodies(bridge)[1]).toEqual({ operation: 'gateway-refresh', name: 'team' });
    expect(mutateBodies(bridge)[1]).not.toHaveProperty('providerId');
  });

  it('tests a saved gateway by its name and points an app at that route', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <AccountsPane service={service} snapshot={snapshot} />
    ));
    // Test first: the menu command sends `gateway-refresh` for a saved gateway,
    // carrying the name alone because the engine knows its endpoint already.
    await user.click(screen.getByTestId('accounts.more.team'));
    await user.click(screen.getByRole('menuitem', { name: 'Test Connection' }));
    await user.click(screen.getByTestId('accounts.connect.team'));
    await user.click(within(screen.getByTestId('gateway-connect-app-claude')).getByRole('checkbox'));
    await user.click(screen.getByTestId('gateway-connect-submit'));
    expect(mutateBodies(bridge)[0]).toEqual({ operation: 'gateway-refresh', name: 'team' });
    expect(mutateBodies(bridge)[0]).not.toHaveProperty('endpoint');
    expect(mutateBodies(bridge)[0]).not.toHaveProperty('endpoint');
    const invokes = bridge.bodies('invoke');
    // The gateway row the fixture publishes: `gateway/team`, one action per app.
    expect(invokes).toEqual([{ actionId: 'act-7-002', revision: 7 }]);
  });

  it('keeps the saved gateway label until the text changes', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <AccountsPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByTestId('accounts.more.team'));
    await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));
    expect(screen.getByTestId('gateway-edit-label')).toHaveValue('Team gateway');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(screen.getByTestId('gateway-edit-label'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(screen.getByTestId('gateway-edit-label'), 'Lab');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutateBodies(bridge)[0]).toEqual({ operation: 'gateway-edit', name: 'team', label: 'Lab' });
  });

  it('points the second app at the gateway only after the first switch settles', async () => {
    const base = snapshotFixture();
    const snapshot = snapshotFixture({
      actions: [
        ...base.actions,
        {
          id: 'act-team-codex',
          clientId: 'codex',
          sourceId: 'gateway/team',
          client: 'Codex',
          label: 'team',
          kind: 'gateway',
          presentation: 'app-route',
          selected: false,
          enabled: true,
          routeKind: 'gateway',
        },
      ],
    });
    const bridge = new FakeBridge();
    bridges.push(bridge);
    const handleRef: { current: ServiceHandle | null } = { current: null };
    function Host() {
      const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
      const handle = useMemo(() => createService({ bridge, onBusyChange: setBusy }), []);
      handleRef.current = handle;
      return <AccountsPane service={handle.port} snapshot={snapshot} busy={busy} />;
    }
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByTestId('accounts.connect.team'));
    await user.click(within(screen.getByTestId('gateway-connect-app-claude')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('gateway-connect-app-codex')).getByRole('checkbox'));
    await user.click(screen.getByTestId('gateway-connect-submit'));
    const invokes = () => bridge.commands().filter((entry) => entry.kind === 'invoke').map((entry) => entry.payload);
    // The claude row is the one the fixture already publishes for `gateway/team`.
    expect(bridge.bodies('invoke')).toEqual([{ actionId: 'act-7-002', revision: 7 }]);
    const requestId = String(invokes()[0]?.requestId);
    await act(async () => {
      handleRef.current?.settle(requestId);
    });
    expect(bridge.bodies('invoke')).toEqual([
      { actionId: 'act-7-002', revision: 7 },
      { actionId: 'act-team-codex', revision: 7 },
    ]);
  });

  it('probes the endpoint and key already typed, including an account id the endpoint is derived from', async () => {
    const snapshot = snapshotFixture({
      gatewayProviders: [
        {
          id: 'cloudflare',
          label: 'Cloudflare',
          detail: 'Workers AI',
          requiresApiKey: true,
          requiresAccountId: true,
          requiresGatewayId: true,
          kind: 'custom',
        },
      ],
    });
    const bridge = new FakeBridge();
    bridges.push(bridge);
    const setFlow: { current: (value: GatewayFlowResult | null) => void } = { current: () => {} };
    function Host() {
      const handle = useMemo(() => createService({ bridge }), []);
      const [flow, setAnswer] = useState<GatewayFlowResult | null>(null);
      setFlow.current = setAnswer;
      return (
        <AccountsPane service={handle.port} snapshot={snapshot} gatewayFlowResult={flow} />
      );
    }
    const user = userEvent.setup();
    render(<Host />);
    const answer = async (message: string, status: 'success' | 'error' = 'success') => {
      const sent = mutatePayloads(bridge)
        .filter((entry) => entry?.operation === 'gateway-test')
        .at(-1);
      await act(async () => {
        setFlow.current({ operation: 'gateway-test', result: { requestId: String(sent?.requestId), status, message } });
      });
    };

    await user.click(screen.getByTestId('accounts.add-gateway'));
    await user.clear(screen.getByTestId('gateway-flow.name'));
    await user.type(screen.getByTestId('gateway-flow.name'), 'edge');
    await user.type(screen.getByTestId('gateway-flow.api-key'), 'sk-cf');
    // An account-scoped gateway cannot be saved until both halves are named:
    // Cloudflare will not route a request without an account.
    expect(screen.getByTestId('gateway-flow.save')).toBeDisabled();
    await user.type(screen.getByTestId('gateway-flow.account-id'), 'acct-1');
    await user.type(screen.getByTestId('gateway-flow.gateway-id'), 'gw-9');

    // The connection row is the answer, not a second dialog: the endpoint the
    // engine probed is derived from the account id on this sheet.
    await user.click(screen.getByTestId('gateway-flow.test'));
    expect(screen.getByTestId('gateway-flow.testing')).toBeInTheDocument();
    await answer('Connected successfully.');
    expect(screen.getByTestId('gateway-flow.available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Again' })).toBeInTheDocument();

    await user.click(screen.getByTestId('gateway-flow.save'));
    expect(mutateBodies(bridge)).toEqual([
      {
        operation: 'gateway-test',
        name: 'test',
        providerId: 'cloudflare',
        apiKey: 'sk-cf',
        profile: 'acct-1',
      },
      {
        operation: 'gateway-create',
        providerId: 'cloudflare',
        name: 'edge',
        label: 'edge',
        apiKey: 'sk-cf',
        gatewayId: 'gw-9',
        profile: 'acct-1',
      },
    ]);
  });

  it('saves the profile that belongs to the credential kind the user picked', async () => {
    const snapshot = snapshotFixture({
      accountProviders: [
        {
          ...snapshotFixture().accountProviders[0],
          credentialKinds: [
            {
              kind: 'api-key',
              label: 'API key',
              profiles: [
                { id: 'global', label: 'Global' },
                { id: 'us', label: 'US' },
              ],
            },
            {
              kind: 'plan',
              label: 'Plan',
              profiles: [
                { id: 'pro', label: 'Pro' },
                { id: 'team', label: 'Team' },
              ],
            },
          ],
        },
      ],
    });
    const { bridge, user } = mount(
      ({ service, snapshot: current }) => <AccountsPane service={service} snapshot={current} />,
      snapshot,
    );
    await user.click(screen.getByTestId('accounts-add'));
    await user.click(screen.getByRole('button', { name: 'API Key' }));
    // Switching the kind must carry the profile that belongs to the *new* kind.
    await user.selectOptions(screen.getByTestId('account-flow.credential-kind.picker'), 'plan');
    expect(screen.getByTestId('account-flow.credential-profile.picker')).toHaveValue('pro');
    await user.type(screen.getByTestId('account-flow.name'), 'work');
    await user.type(screen.getByTestId('account-flow.api-key.input'), 'sk-plan');
    await user.click(screen.getByTestId('account-flow.save'));
    expect(mutateBodies(bridge)[0]).toEqual({
      operation: 'account-save-input',
      providerId: 'claude',
      name: 'work',
      kind: 'plan',
      profile: 'pro',
      apiKey: 'sk-plan',
    });
  });

  it('creates a gateway with the endpoint and key the user typed', async () => {
    // A provider that publishes no base of its own: the sheet must ask for one.
    const snapshot = snapshotFixture({
      gatewayProviders: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          detail: 'Self-hosted proxy',
          requiresApiKey: true,
          kind: 'custom',
        },
      ],
    });
    const { bridge, user } = mount(
      ({ service, snapshot: current }) => <AccountsPane service={service} snapshot={current} />,
      snapshot,
    );
    await user.click(screen.getByTestId('accounts.add-gateway'));
    await user.clear(screen.getByTestId('gateway-flow.name'));
    await user.type(screen.getByTestId('gateway-flow.name'), 'team');
    await user.type(screen.getByTestId('gateway-flow.endpoint.input'), 'https://openrouter.ai/api/v1');
    await user.type(screen.getByTestId('gateway-flow.api-key'), 'sk-test');
    await user.click(screen.getByTestId('gateway-flow.save'));
    expect(mutateBodies(bridge)[0]).toEqual({
      operation: 'gateway-create',
      providerId: 'litellm',
      name: 'team',
      label: 'team',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    });
  });
});

describe('typed credentials and gateway removal', () => {
  it('saves a typed key, clears the live login, and removes a gateway after confirmation', async () => {
    const snapshot = snapshotFixture({
      accountProviders: [
        {
          ...snapshotFixture().accountProviders[0],
          canClear: true,
          sourceId: 'cli',
          credentialKinds: [{ kind: 'api-key', label: 'API key', profiles: [] }],
        },
      ],
    });
    const { bridge, user } = mount(
      ({ service, snapshot: current }) => <AccountsPane service={service} snapshot={current} />,
      snapshot,
    );
    await user.click(screen.getByTestId('accounts-add'));
    await user.type(screen.getByTestId('account-flow.name'), 'Work');
    // Signing out is destructive, so it asks first and names what it will do.
    await user.click(screen.getByTestId('account-flow.clear'));
    expect(screen.getByTestId('account-flow.sign-out.dialog')).toHaveTextContent(
      'AnyPick backs up this account before signing out on this Mac.',
    );
    await user.click(screen.getByTestId('account-flow.sign-out'));
    // The sheet stays open, and the identity it had is gone.
    expect(screen.getByTestId('account-flow.identity')).toHaveTextContent('No login on this Mac');
    await user.click(screen.getByRole('button', { name: 'API Key' }));
    await user.clear(screen.getByTestId('account-flow.name'));
    await user.type(screen.getByTestId('account-flow.name'), 'work');
    await user.type(screen.getByTestId('account-flow.api-key.input'), 'sk-test');
    await user.click(screen.getByTestId('account-flow.save'));
    await user.click(screen.getByTestId('accounts.more.team'));
    await user.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    await user.click(within(screen.getByTestId('gateway-remove-dialog')).getByRole('button', { name: 'Remove' }));
    expect(mutateBodies(bridge)).toEqual([
      { operation: 'account-clear', name: 'live', providerId: 'claude', sourceId: 'cli' },
      {
        operation: 'account-save-input',
        providerId: 'claude',
        name: 'work',
        kind: 'api-key',
        apiKey: 'sk-test',
        // A provider with one credential kind has no profile preset to send;
        // an empty string would name a profile that does not exist, so the
        // key is absent rather than blank.
      },
      { operation: 'gateway-remove', name: 'team', providerId: 'openrouter' },
    ]);
  });
});

describe('pasted auth json', () => {
  it('keeps the sheet open and only offers Replace for ACCOUNT_EXISTS', async () => {
    const snapshot = snapshotFixture({
      accountProviders: [{ ...snapshotFixture().accountProviders[0], acceptsAuthPaste: true }],
    });
    const bridge = new FakeBridge();
    bridges.push(bridge);
    const { port } = createService({ bridge });
    const user = userEvent.setup();
    const view = render(<AccountsPane service={port} snapshot={snapshot} accountFlowResult={null} />);

    await user.click(screen.getByTestId('accounts-add'));
    await user.click(screen.getByRole('button', { name: 'Paste Auth File' }));
    const body = '{"tokens":{"access_token":"paste-secret-token"}}';
    await user.click(screen.getByTestId('account-flow.auth-json.input'));
    await user.paste(body);
    await user.click(screen.getByTestId('account-flow.save'));

    await waitFor(() => expect(mutateBodies(bridge)).toHaveLength(1));
    const first = mutatePayloads(bridge)[0];
    expect(mutateBodies(bridge)[0]).toEqual({
      operation: 'account-save-auth',
      providerId: 'claude',
      path: '/tmp/anypick-auth-paste/paste.json',
    });
    expect(first).not.toHaveProperty('apiKey');
    expect(first).not.toHaveProperty('name');
    expect(first).not.toHaveProperty('overwrite');
    expect(JSON.stringify(first)).not.toContain('paste-secret-token');
    expect(screen.getByTestId('account-flow.provider')).toBeInTheDocument();

    view.rerender(
      <AccountsPane
        service={port}
        snapshot={snapshot}
        accountFlowResult={{
          operation: 'account-save-auth',
          result: {
            requestId: String(first?.requestId),
            status: 'error',
            message: 'The document could not be parsed.',
            code: 'BAD_AUTH_DOCUMENT',
          },
        }}
      />,
    );
    // A document the engine could not read is not an invitation to overwrite
    // the account it could not read.
    expect(screen.getByTestId('account-flow.save')).toHaveTextContent('Add Login');
    expect(screen.getByTestId('account-flow.error')).toHaveTextContent(
      'The document could not be parsed.',
    );

    // A second refusal, this time the collision Replace is for.
    await user.click(screen.getByTestId('account-flow.save'));
    await waitFor(() => expect(mutateBodies(bridge)).toHaveLength(2));
    const refused = mutatePayloads(bridge)[1];
    view.rerender(
      <AccountsPane
        service={port}
        snapshot={snapshot}
        accountFlowResult={{
          operation: 'account-save-auth',
          result: {
            requestId: String(refused?.requestId),
            status: 'error',
            message: 'An account named work already exists.',
            code: 'ACCOUNT_EXISTS',
          },
        }}
      />,
    );
    expect(screen.getByTestId('account-flow.save')).toHaveTextContent('Replace Account');
    await user.click(screen.getByTestId('account-flow.save'));
    await waitFor(() => expect(mutateBodies(bridge)).toHaveLength(3));
    expect(mutateBodies(bridge)[2]).toEqual({
      operation: 'account-save-auth',
      providerId: 'claude',
      path: '/tmp/anypick-auth-paste/paste.json',
      overwrite: true,
    });
    expect(JSON.stringify(mutatePayloads(bridge)[2])).not.toContain('paste-secret-token');
    // Replace sends the document the engine already refused, so it is not
    // staged again. The refusal after the bad document did re-stage it.
    expect(bridge.invokes.filter((entry) => entry.cmd === 'stage_auth_paste')).toHaveLength(2);

    const second = mutatePayloads(bridge)[2];
    view.rerender(
      <AccountsPane
        service={port}
        snapshot={snapshot}
        accountFlowResult={{
          operation: 'account-save-auth',
          result: {
            requestId: String(second?.requestId),
            status: 'success',
            message: 'Saved claude/work.',
          },
        }}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('account-flow.provider')).not.toBeInTheDocument());
    expect(
      bridge.invokes.some(
        (entry) => entry.cmd === 'forget_auth_paste' && entry.args?.path === '/tmp/anypick-auth-paste/paste.json',
      ),
    ).toBe(true);
  });

  it('hides the paste source when the provider does not accept it', async () => {
    const { user } = mount(({ service, snapshot }) => <AccountsPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByTestId('accounts-add'));
    expect(screen.queryByRole('button', { name: 'Paste Auth File' })).not.toBeInTheDocument();
  });
});

describe('codex profiles', () => {
  it('creates the missing account profile and saves a named one', async () => {
    const snapshot = snapshotFixture({
      actions: [
        ...snapshotFixture().actions,
        {
          id: 'act-codex',
          clientId: 'codex',
          sourceId: 'account/codex/work',
          client: 'Codex',
          label: 'Work',
          detail: 'work@example.com',
          kind: 'native',
          presentation: 'native-account',
          selected: true,
          enabled: true,
          routeKind: 'managed-account',
        },
      ],
      codexProfiles: [
        {
          name: 'work',
          sourceId: 'account/codex/work',
          sourceLabel: 'Work',
          modelId: 'gpt-5',
          transportPolicy: 'proxy',
          launchCommand: 'codex --profile work',
        },
      ],
      codexProfileSources: [
        { sourceId: 'account/codex/work', kind: 'account', label: 'Work', detail: '', selected: true, models: ['gpt-5'] },
        {
          sourceId: 'account/codex/personal',
          kind: 'account',
          label: 'Personal',
          detail: '',
          selected: false,
          models: ['gpt-5'],
        },
      ],
    });
    const { bridge, user } = mount(({ service, snapshot: current }) => <AppsPane service={service} snapshot={current} />, snapshot);
    await user.click(screen.getByTestId('apps-row-codex'));
    await user.click(screen.getByTestId('codex-profile.create-missing'));
    await user.click(screen.getByTestId('codex-profile.add'));
    await user.type(screen.getByTestId('codex-profile-name'), 'personal');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Account or Route' }), 'account/codex/personal');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Transport' }), 'proxy');
    await user.click(screen.getByTestId('codex-profile-save'));
    expect(mutateBodies(bridge)).toEqual([
      { operation: 'codex-profile-sync', sourceIds: ['account/codex/personal'] },
      {
        operation: 'codex-profile-save',
        name: 'personal',
        sourceId: 'account/codex/personal',
        transportPolicy: 'proxy',
      },
    ]);
  });

  it('updates an existing profile from the fields that profile already has', async () => {
    const snapshot = snapshotFixture({
      actions: [
        ...snapshotFixture().actions,
        {
          id: 'act-codex',
          clientId: 'codex',
          sourceId: 'account/codex/work',
          client: 'Codex',
          label: 'Work',
          detail: 'work@example.com',
          kind: 'native',
          presentation: 'native-account',
          selected: true,
          enabled: true,
          routeKind: 'managed-account',
        },
      ],
      codexProfiles: [
        {
          name: 'work',
          sourceId: 'account/codex/work',
          sourceLabel: 'Work',
          modelId: 'gpt-5',
          transportPolicy: 'proxy',
          launchCommand: 'codex --profile work',
        },
      ],
      codexProfileSources: [
        {
          sourceId: 'account/codex/personal',
          kind: 'account',
          label: 'Personal',
          detail: '',
          selected: false,
          models: ['gpt-4.1'],
        },
        { sourceId: 'account/codex/work', kind: 'account', label: 'Work', detail: '', selected: true, models: ['gpt-5'] },
      ],
    });
    const { bridge, user } = mount(
      ({ service, snapshot: current }) => <AppsPane service={service} snapshot={current} />,
      snapshot,
    );
    await user.click(screen.getByTestId('apps-row-codex'));
    await user.click(screen.getByTestId('codex-profile.more.work'));
    await user.click(screen.getByRole('menuitem', { name: 'Edit Profile…' }));
    expect(screen.getByTestId('codex-profile-save')).toHaveTextContent('Save Changes');
    await user.click(screen.getByTestId('codex-profile-save'));
    expect(mutateBodies(bridge)[0]).toEqual({
      operation: 'codex-profile-update',
      name: 'work',
      sourceId: 'account/codex/work',
      defaultModel: 'gpt-5',
      transportPolicy: 'proxy',
    });
  });

  it('keeps automatic profile creation local and syncs with codex-profile-sync', async () => {
    localStorage.removeItem('anypick.codexAutoProfiles');
    localStorage.removeItem('anypick.codexAutoProfileFingerprints');
    const snapshot = snapshotFixture({
      actions: [
        ...snapshotFixture().actions,
        {
          id: 'act-codex',
          clientId: 'codex',
          sourceId: 'account/codex/work',
          client: 'Codex',
          label: 'Work',
          detail: 'work@example.com',
          kind: 'native',
          presentation: 'native-account',
          selected: true,
          enabled: true,
          routeKind: 'managed-account',
        },
      ],
      codexProfiles: [],
      codexProfileSources: [
        {
          sourceId: 'account/codex/personal',
          kind: 'account',
          label: 'Personal',
          detail: '',
          selected: false,
          models: ['gpt-5'],
        },
      ],
    });
    const { bridge, user } = mount(
      ({ service, snapshot: current }) => <AppsPane service={service} snapshot={current} />,
      snapshot,
    );
    await user.click(screen.getByTestId('apps-row-codex'));
    const toggle = screen.getByRole('switch', { name: 'Create profiles automatically' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('anypick.codexAutoProfiles')).toBe('false');
    expect(mutatePayloads(bridge).some((payload) => payload?.operation === 'setting-create-codex-profiles')).toBe(false);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(mutateBodies(bridge)).toEqual([
      { operation: 'codex-profile-sync', sourceIds: ['account/codex/personal'] },
    ]);
    localStorage.removeItem('anypick.codexAutoProfiles');
    localStorage.removeItem('anypick.codexAutoProfileFingerprints');
  });
});

describe('backups', () => {
  it('exports the checked accounts to the path the user typed', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <BackupsPane service={service} snapshot={snapshot} />);
    expect(screen.getByText(/temporary file/)).toBeInTheDocument();
    expect(screen.queryByText(/~\/\.anypick\/backups/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export Accounts…' }));
    await user.type(screen.getByTestId('backup-export-path'), '/tmp/accounts.anypick-backup');
    await user.click(screen.getByTestId('backup-export-submit'));
    expect(mutateBodies(bridge)[0]).toEqual({
      operation: 'account-backup-export',
      path: '/tmp/accounts.anypick-backup',
      overwrite: false,
      accounts: [
        { provider: 'claude', name: 'work' },
        { provider: 'claude', name: 'personal' },
      ],
    });
  });

  it('reviews a file, then imports only the entries that are not replacements', async () => {
    const snapshot = snapshotFixture();
    const { bridge, user } = mount(({ service }) => (
      <BackupsPane
        service={service}
        snapshot={snapshot}
        preview={{
          requestId: 'rev-1',
          status: 'ready',
          inspectionId: 'insp-1',
          createdAt: '2026-09-30T00:00:00Z',
          entries: [
            { id: 'a', providerId: 'claude', name: 'new', label: 'New', disposition: 'new', reason: '' },
            { id: 'b', providerId: 'claude', name: 'work', label: 'Work', disposition: 'replace', reason: '' },
          ],
        }}
      />
    ));
    await user.click(within(screen.getByTestId('backup-entry-a')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('backup-entry-b')).getByRole('checkbox'));
    await user.click(screen.getByTestId('backup-import-submit'));
    expect(mutateBodies(bridge)[0]).toEqual({
      operation: 'account-backup-import',
      inspectionId: 'insp-1',
      entryIds: ['a'],
      overwriteConfirmed: false,
    });
  });

  it('allows picking a backup file with the Choose button', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <BackupsPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByRole('button', { name: 'Review Backup…' }));
    expect(screen.getByTestId('backup-choose-file')).toBeInTheDocument();

    const fileInput = screen.getByTestId('backup-file-picker');
    const fakeFile = new File(['{"version":1}'], 'accounts.anypick-backup', { type: 'application/json' });
    Object.defineProperty(fakeFile, 'path', { value: '/Users/erik/Desktop/accounts.anypick-backup' });

    await user.upload(fileInput, fakeFile);

    expect(screen.getByTestId('backup-import-path')).toHaveValue('/Users/erik/Desktop/accounts.anypick-backup');
    expect(bridge.bodies('backup-inspect')).toEqual([{ path: '/Users/erik/Desktop/accounts.anypick-backup' }]);
  });

  it('never reviews a bare filename when the picker cannot report a path', async () => {
    // On Windows and Linux a webview `File` has no `.path`, and the packaged
    // app has no `/_api/stage-file` route to turn its bytes into one. The old
    // fallback handed the engine `file.name`, which is not a path, so the
    // review silently inspected the wrong file. The honest answer is an error.
    const { bridge, user } = mount(({ service, snapshot }) => (
      <BackupsPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByRole('button', { name: 'Review Backup…' }));

    const fileInput = screen.getByTestId('backup-file-picker');
    const fakeFile = new File(['{"version":1}'], 'accounts.anypick-backup', { type: 'application/json' });
    expect((fakeFile as unknown as { path?: string }).path).toBeUndefined();

    await user.upload(fileInput, fakeFile);

    expect(await screen.findByTestId('backup-pick-error')).toBeInTheDocument();
    expect(screen.queryByText('accounts.anypick-backup')).toBeNull();
    const inspect = bridge.commands().find((entry) => entry.kind === 'backup-inspect');
    expect(inspect).toBeUndefined();
  });
});

describe('activity', () => {
  it('clears the visible list without sending a command', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ActivityPane snapshot={snapshot} service={service} />
    ));
    expect(screen.getByText('Claude Code now uses Work.')).toBeInTheDocument();
    await user.click(screen.getByTestId('activity-clear-events'));
    expect(screen.queryByText('Claude Code now uses Work.')).toBeNull();
    expect(screen.getByText('Cleared the visible activity list. Supervisor history is unchanged.')).toBeInTheDocument();
    expect(bridge.sent).toEqual([]);
  });

  it('filters events by category', async () => {
    const { user } = mount(({ service, snapshot }) => (
      <ActivityPane snapshot={snapshot} service={service} />
    ));
    expect(screen.getByText('Claude Code now uses Work.')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('activity.logs.filter'), 'proxies');
    expect(screen.queryByText('Claude Code now uses Work.')).toBeNull();
    await user.selectOptions(screen.getByTestId('activity.logs.filter'), 'all');
    expect(screen.getByText('Claude Code now uses Work.')).toBeInTheDocument();
  });

  it('asks for the log tail of the selected source, and keeps asking while live', async () => {
    // The Live Logs tab polls. A log view that reads once is a snapshot
    // wearing the word "live", which is what the pane used to render.
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ActivityPane snapshot={snapshot} service={service} />
    ));
    await user.click(screen.getByRole('button', { name: 'Live Logs' }));
    await waitFor(() => expect(bridge.commands().length).toBeGreaterThan(0));
    expect(bridge.commandKinds()[0]).toBe('logs');
    expect(bridge.bodies('logs')[0]).toEqual({ providerId: 'claude', name: 'work', lines: 200 });
    await waitFor(() => expect(bridge.commands().length).toBeGreaterThan(1), { timeout: 4000 });
  });

  it('shows the events well again when the mode flips back', async () => {
    const { user } = mount(({ service, snapshot }) => (
      <ActivityPane snapshot={snapshot} service={service} />
    ));
    await user.click(screen.getByRole('button', { name: 'Live Logs' }));
    expect(screen.queryByTestId('activity-list')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Events' }));
    expect(screen.getByTestId('activity-list')).toBeInTheDocument();
  });
});

describe('apps', () => {
  it('refreshes the selected account route and disconnects the client', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <AppsPane service={service} snapshot={snapshot} />);
    // Both commands live in the row's menu, as on macOS.
    await user.click(screen.getByTestId('app.more-claude'));
    await user.click(screen.getByTestId('apps-refresh-menu'));
    await user.click(screen.getByTestId('app.more-claude'));
    await user.click(screen.getByTestId('app.disconnect-menu'));
    await user.click(within(screen.getByTestId('apps-disconnect-dialog')).getByRole('button', { name: 'Disconnect from AnyPick' }));
    expect(mutateBodies(bridge)).toEqual([
      { operation: 'account-refresh', providerId: 'claude', name: 'work' },
      { operation: 'client-reset', name: 'claude', providerId: 'claude' },
    ]);
  });

  it('refreshes models for a selected gateway route by gateway name', async () => {
    const snapshot = snapshotFixture({
      actions: [
        {
          id: 'act-gw',
          clientId: 'claude',
          sourceId: 'gateway/team',
          client: 'Claude Code',
          label: 'team',
          kind: 'gateway',
          presentation: 'app-route',
          selected: true,
          enabled: true,
          routeKind: 'gateway',
        },
      ],
    });
    const { bridge, user } = mount(
      ({ service, snapshot: current }) => <AppsPane service={service} snapshot={current} />,
      snapshot,
    );
    await user.click(screen.getByTestId('app.more-claude'));
    await user.click(screen.getByTestId('apps-refresh-menu'));
    expect(mutateBodies(bridge)[0]).toEqual({ operation: 'gateway-refresh', name: 'team' });
    expect(mutateBodies(bridge)[0]).not.toHaveProperty('providerId');
  });
});

describe('settings', () => {
  it('updates preferences and reopens Getting Started without linking to other panes', async () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    const { port } = createService({ bridge });
    const user = userEvent.setup();
    const onShowGettingStarted = vi.fn();
    render(
      <SettingsPane
        settings={snapshotFixture().settings}
        service={port}
        onShowGettingStarted={onShowGettingStarted}
      />,
    );
    expect(screen.getByTestId('settings.language')).toHaveValue('auto');
    await user.click(screen.getByRole('switch', { name: 'Show Usage Remaining' }));
    await user.click(screen.getByRole('switch', { name: 'Skip Accounts That Reach Their Usage Limit' }));
    await user.click(screen.getByRole('button', { name: 'Show Checklist' }));
    expect(onShowGettingStarted).toHaveBeenCalledOnce();
    await user.selectOptions(screen.getByTestId('settings.language'), 'vi');
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('aria-label', 'Cài đặt');
    expect(screen.getByTestId('settings-startup')).toHaveTextContent('Khởi động');
    expect(screen.getByTestId('settings-usage')).toHaveTextContent('Mức sử dụng');
    expect(screen.getByTestId('settings-getting-started')).toHaveTextContent('Bắt đầu');
    expect(screen.queryByRole('button', { name: /Open Proxies|Manage Backups|Check AnyPick/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Credentials')).not.toBeInTheDocument();
    expect(screen.queryByText('Not encrypted')).not.toBeInTheDocument();
    expect(screen.queryByText('Check AnyPick')).not.toBeInTheDocument();
    expect(mutateBodies(bridge)[0]).toEqual({ operation: 'setting-show-quota', name: 'settings', enabled: false });
    expect(mutateBodies(bridge)[1]).toEqual({ operation: 'setting-quota-guard', name: 'settings', enabled: true });
    expect(mutateBodies(bridge)[2]).toEqual({ operation: 'setting-language', name: 'settings', language: 'vi' });
  });
});

describe('the shell applies log and backup frames', () => {
  it('shows the log text for the request it sent, and the reviewed backup entries', async () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    const serviceRef: MutableRefObject<ServiceHandle | null> = { current: null };
    const user = userEvent.setup();
    render(<App bridge={bridge} serviceRef={serviceRef} />);
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');

    await user.click(screen.getByTestId('sidebar-activity'));
    await user.click(screen.getByRole('button', { name: 'Live Logs' }));
    const logs = bridge.commands().find((entry) => entry.kind === 'logs');
    bridge.push('logs', {
      requestId: logs?.payload?.requestId,
      proxyId: 'claude/work',
      state: 'ready',
      text: 'listening on 127.0.0.1:5150',
    });
    expect(await screen.findByText('listening on 127.0.0.1:5150')).toBeInTheDocument();

    await user.click(screen.getByTestId('sidebar-backups'));
    await user.click(screen.getByRole('button', { name: 'Review Backup…' }));
    await user.type(screen.getByTestId('backup-import-path'), '/tmp/accounts.anypick-backup');
    await user.click(screen.getByTestId('backup-review'));
    const inspect = bridge.commands().find((entry) => entry.kind === 'backup-inspect');
    bridge.push('backup-preview', {
      requestId: inspect?.payload?.requestId,
      status: 'ready',
      inspectionId: 'insp-9',
      createdAt: '2026-09-30T00:00:00Z',
      entries: [{ id: 'a', providerId: 'claude', name: 'work', label: 'Work', disposition: 'new', reason: '' }],
    });
    expect(await screen.findByTestId('backup-entry-a')).toBeInTheDocument();
  });
});

describe('activity logs', () => {
  // `POLL_MS` in panes/ActivityPane.tsx. A test that waits for a second
  // reading without allowing longer than the interval times out on the
  // interval, not on a bug.
  const POLL_WAIT_MS = 3000;
  it('hides a cleared log without sending a command', async () => {
    // Clearing is local: the engine keeps the log file, exactly as the events
    // list does. A command here would delete history the user can still want.
    const bridge = new FakeBridge();
    bridges.push(bridge);
    bridge.lastLine = null;
    const user = userEvent.setup();
    render(<App bridge={bridge} serviceRef={{ current: null }} />);
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-activity'));
    await user.click(screen.getByRole('button', { name: 'Live Logs' }));
    await waitFor(() => expect(bridge.commands().some((c) => c.kind === 'logs')).toBe(true));

    const logs = bridge.commands().filter((c) => c.kind === 'logs').at(-1);
    bridge.push('logs', {
      requestId: logs?.payload?.requestId,
      proxyId: 'claude/work',
      state: 'ready',
      text: 'listening on 127.0.0.1:5150',
    });
    expect(await screen.findByText('listening on 127.0.0.1:5150')).toBeInTheDocument();

    await user.click(screen.getByTestId('activity-clear-log'));
    expect(screen.queryByText('listening on 127.0.0.1:5150')).toBeNull();
    expect(screen.getByText('Cleared the visible log')).toBeInTheDocument();
    expect(bridge.commands().filter((c) => c.kind === 'mutate')).toEqual([]);
  });

  it('keeps the cleared log hidden when a poll arrives', async () => {
    // A live pane re-reads every 1.75s. If the clear only blanked the view,
    // the next reading would put the whole log back with no user action.
    const bridge = new FakeBridge();
    bridges.push(bridge);
    bridge.lastLine = null;
    const user = userEvent.setup();
    render(<App bridge={bridge} serviceRef={{ current: null }} />);
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-activity'));
    await user.click(screen.getByRole('button', { name: 'Live Logs' }));

    // Answer the first request the pane makes. The service releases a request
    // only on the engine's own terminal frame, so an unanswered one leaves the
    // pane busy and the poll does not start.
    const logsCommand = () => bridge.commands().filter((c) => c.kind === 'logs').at(-1);
    await waitFor(() => expect(logsCommand()).toBeDefined());
    bridge.push('logs', {
      requestId: logsCommand()?.payload?.requestId,
      proxyId: 'claude/work',
      state: 'ready',
      text: 'first reading',
    });
    expect(await screen.findByText('first reading')).toBeInTheDocument();

    await user.click(screen.getByTestId('activity-clear-log'));
    expect(screen.queryByText('first reading')).toBeNull();

    // Answer the next poll. The interval is 1.75s, so the default 1s waitFor
    // timeout is shorter than the thing being waited for.
    await waitFor(
      () => expect(bridge.commands().filter((c) => c.kind === 'logs').length).toBeGreaterThan(1),
      { timeout: POLL_WAIT_MS },
    );
    bridge.push('logs', {
      requestId: logsCommand()?.payload?.requestId,
      proxyId: 'claude/work',
      state: 'ready',
      text: 'second reading',
    });
    expect(screen.queryByText('second reading')).toBeNull();
  });
});
