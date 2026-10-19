import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Snapshot } from '../lib/contract';
import { createService, type ServicePort } from '../lib/service';
import { AccountsPane, ActivityPane, AppsPane, BackupsPane, OverviewPane, ProxiesPane, ProxyHubPane } from '../panes';
import { FakeBridge, snapshotFixture } from './harness';

/**
 * Behaviour a user can observe: what a pane says, and what it asks the engine
 * to do. The macOS app's copy is the product's copy, so a Linux or Windows user
 * reading a Claude proxy row should read the same words a macOS user does.
 *
 * The panes take a service port, so a test drives the real component against a
 * snapshot the engine really sends and asserts on the commands that came out.
 */

const bridges: FakeBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

// The app list is a local preference, so one test's choice must not leak into
// the next one's pane.
afterEach(() => {
  localStorage.removeItem('anypick.configuredApps');
  localStorage.removeItem('anypick.removedApps');
});

function mount(ui: (props: { service: ServicePort; snapshot: Snapshot }) => React.ReactElement, snapshot: Snapshot = snapshotFixture()) {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  const { port } = createService({ bridge });
  const user = userEvent.setup();
  return { bridge, service: port, user, snapshot, ...render(ui({ service: port, snapshot })) };
}

const navigate = vi.fn();

describe('Overview pane', () => {
  it('leads with the one thing that needs fixing', () => {
    const snapshot = snapshotFixture({
      proxies: [
        {
          id: 'claude/work',
          providerId: 'claude',
          label: 'Claude proxy · Work',
          detail: 'stopped',
          running: false,
          enabled: true,
          toggleActionId: 'act-1',
          restartActionId: 'act-2',
        },
      ],
    });
    mount(({ service, snapshot: s }) => <OverviewPane snapshot={s} />, snapshot);

    // "Claude proxy · Work" resolves to "Work", the same short name the
    // Proxies pane shows, so the two panes never point at different things
    // with the same words.
    expect(screen.getByText('Work is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Apps using Work cannot connect.')).toBeInTheDocument();
  });

  it('does not nag about a service the user turned off', () => {
    // A disabled proxy is a choice, not a fault. Surfacing it as attention is
    // the first-run experience nobody wants.
    const snapshot = snapshotFixture({
      proxies: [
        {
          id: 'codex/team',
          providerId: 'codex',
          label: 'Codex proxy · Team',
          detail: 'stopped',
          running: false,
          enabled: false,
          toggleActionId: 'act-1',
          restartActionId: 'act-2',
        },
      ],
    });
    mount(({ snapshot: s }) => <OverviewPane snapshot={s} />, snapshot);
    expect(screen.queryByText(/is unavailable/)).not.toBeInTheDocument();
  });

  it('counts the hub only when it is real', () => {
    // A hub with no sources and no enablement is a phantom row; counting it
    // would tell a user a service is running that is not. Two account proxies,
    // one running, and no hub must read "1 of 2", not "1 of 3".
    const snapshot = snapshotFixture({
      hubSources: [],
      proxyCount: 2,
      proxies: snapshotFixture().proxies.filter((proxy) => proxy.providerId !== 'proxy-hub'),
    });
    mount(({ snapshot: s }) => <OverviewPane snapshot={s} />, snapshot);
    expect(screen.getByTestId('overview-services-row')).toHaveTextContent('1 of 2 running');
  });

  it('counts a hub that has sources even while it is stopped', () => {
    // The same rule the other way: a configured hub is a real service the user
    // can start, so it belongs in the total.
    mount(({ snapshot: s }) => <OverviewPane snapshot={s} />, snapshotFixture({ proxyCount: 2 }));
    expect(screen.getByTestId('overview-services-row')).toHaveTextContent('1 of 3 running');
  });

  it('shows one row per app from the route that app is using', () => {
    mount(({ snapshot }) => <OverviewPane snapshot={snapshot} />);
    const apps = screen.getAllByTestId(/^overview\.app\./);
    expect(apps).toHaveLength(1);
    expect(within(apps[0]!).getByText('Uses Work')).toBeInTheDocument();
    // The transport word belongs on the trailing edge, and an app AnyPick is
    // proxying is not "Not Configured".
    expect(within(apps[0]!).getByText('AnyPick proxy')).toBeInTheDocument();
    expect(within(apps[0]!).queryByText('Not Configured')).not.toBeInTheDocument();
  });

  it('caps the app list at three and offers the rest', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      id: `act-${index}`,
      clientId: `client${index}`,
      sourceId: 'account/claude/work',
      client: `Client ${index}`,
      label: 'Work',
      kind: 'account',
      presentation: 'native-account',
      selected: true,
      enabled: true,
      routeKind: 'managed-account',
    }));
    mount(
      ({ snapshot }) => <OverviewPane snapshot={snapshot} onNavigate={navigate} />,
      snapshotFixture({ actions: many }),
    );
    expect(screen.getAllByTestId(/^overview\.app\./)).toHaveLength(3);
    expect(screen.getByTestId('overview.apps.see-all')).toHaveTextContent('All Apps (6)…');
  });

  it('renders all four Get Started steps macOS shows', () => {
    // macOS renders four steps (`OverviewView.swift:112-157`): Add a Login,
    // Use an App, Point an App, Set Up Proxy Hub. The pane emitted three, and
    // the parity map hid the missing one by pointing both `use-app` and
    // `choose-route` at `onboarding-choose-route`.
    mount(({ snapshot }) => <OverviewPane snapshot={snapshot} />);
    expect(screen.getByTestId('onboarding-save-login')).toHaveTextContent('Add a Login');
    expect(screen.getByTestId('onboarding-use-app')).toHaveTextContent('Use an App');
    expect(screen.getByTestId('onboarding-choose-route')).toHaveTextContent('Point an App');
    expect(screen.getByTestId('onboarding-hub')).toHaveTextContent('Set Up Proxy Hub (Optional)');
  });

  it('marks Use an App done from the install probe, not the route list', () => {
    // `hasInstalledApp` (`Models.swift:484`, from the install probe) reads
    // whether an app is on the machine. Reading routes instead would call the
    // step incomplete on the one machine that needs it.
    const noInstall = snapshotFixture({
      actions: [],
      accountProviders: snapshotFixture().accountProviders.map((provider) => ({
        ...provider,
        installed: false,
      })),
    });
    const onRefresh = vi.fn();
    const { user, unmount } = mount(
      ({ snapshot }) => <OverviewPane snapshot={snapshot} onRefresh={onRefresh} />,
      noInstall,
    );
    expect(screen.getByTestId('onboarding-use-app')).toHaveTextContent(
      'Install Claude Code or Codex, then refresh.',
    );
    return user.click(screen.getByRole('button', { name: 'Refresh' })).then(() => {
      expect(onRefresh).toHaveBeenCalled();
      unmount();
      mount(({ snapshot }) => <OverviewPane snapshot={snapshot} />, snapshotFixture());
      expect(screen.getByTestId('onboarding-use-app')).toHaveTextContent('Done');
    });
  });

  it('points the attention row at the pane that can fix it', async () => {
    const snapshot = snapshotFixture({
      proxies: [
        {
          id: 'claude/work',
          providerId: 'claude',
          label: 'Claude proxy · Work',
          detail: 'stopped',
          running: false,
          enabled: true,
          toggleActionId: 'act-1',
          restartActionId: 'act-2',
        },
      ],
    });
    const onNavigate = vi.fn();
    const { user } = mount(
      ({ snapshot: s }) => <OverviewPane snapshot={s} onNavigate={onNavigate} />,
      snapshot,
    );
    // The row names its destination, so a user is never told to fix something
    // without a way to get there.
    await user.click(screen.getByRole('button', { name: 'Open Proxies' }));
    expect(onNavigate).toHaveBeenCalledWith('proxies');
  });
});

describe('Apps pane', () => {
  it('is one row per app, not one per route', () => {
    // macOS builds one row per app (`AppsView.swift:34` ForEach over filteredApps)
    // and puts the route commands in its context menu. Four rows for one app,
    // each with its own Use and Change…, is what made this pane read as a
    // control panel rather than a list of apps.
    mount(({ service, snapshot }) => <AppsPane service={service} snapshot={snapshot} />);
    expect(screen.getAllByTestId(/^apps-row-/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Use' })).not.toBeInTheDocument();
    expect(screen.queryByText('Selected')).not.toBeInTheDocument();
  });

  it('names the transport in product words, never an internal route kind', () => {
    mount(({ service, snapshot }) => <AppsPane service={service} snapshot={snapshot} />);
    // The selected route is on an account, so the transport reads "AnyPick
    // proxy". The alternative is the engine's "managed-account".
    const row = screen.getByTestId('apps-row-claude');
    expect(within(row).getByText(/AnyPick proxy/)).toBeInTheDocument();
    expect(within(row).queryByText(/managed-account/)).not.toBeInTheDocument();
  });

  it('keeps the app commands in one menu rather than on the row', () => {
    mount(({ service, snapshot }) => <AppsPane service={service} snapshot={snapshot} />);
    // A menu still reaches all of them from the keyboard; a wall of five
    // trailing buttons does not fit a row and is the look the contract bans.
    const row = screen.getByTestId('apps-row-claude');
    expect(within(row).getByTestId('app.more-claude')).toBeInTheDocument();
    expect(within(row).queryByTestId('apps-disconnect-claude')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('app.remove-claude')).not.toBeInTheDocument();
  });

  it('counts the apps in the section header', () => {
    mount(({ service, snapshot }) => <AppsPane service={service} snapshot={snapshot} />);
    expect(screen.getByTestId('apps.list')).toHaveTextContent('Apps (1)');
  });

  it('says Not Configured instead of Direct for an unrouted app', () => {
    const snapshot = snapshotFixture({
      actions: [
        {
          id: 'act-9-001',
          clientId: 'codex',
          sourceId: '',
          client: 'Codex',
          label: 'Codex',
          kind: 'native',
          presentation: 'native-account',
          selected: false,
          enabled: true,
        },
      ],
    });
    mount(({ service, snapshot: s }) => <AppsPane service={service} snapshot={s} />, snapshot);
    expect(screen.getByText('Not Configured')).toBeInTheDocument();
  });

  it('sends every role when one model changes', async () => {
    // The engine requires a complete map with a default key, and it requires
    // all options to come from one connection. Sending only the edited role is
    // rejected as INVALID_SELECTION.
    const { bridge, user } = mount(({ service, snapshot }) => (
      <AppsPane service={service} snapshot={snapshot} />
    ));
    // macOS reaches an app's models through its own detail pane; navigate there
    await user.click(screen.getByTestId('apps-row-claude'));
    await user.click(screen.getByTestId('app.models.manage'));
    await user.selectOptions(screen.getByLabelText('Model for Claude Code · sonnet'), 'act-7-102');

    const roles = bridge.commands().find((entry) => entry.kind === 'model-roles');
    expect(roles?.payload).toMatchObject({
      clientId: 'claude',
      scope: 'connection',
      roleActionIds: { default: 'act-7-101', sonnet: 'act-7-102' },
    });
  });

  it('saves a model choice for every account of the provider when that scope is selected', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <AppsPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByTestId('apps-row-claude'));
    await user.click(screen.getByTestId('app.models.manage'));
    await user.selectOptions(screen.getByLabelText('Applies to Claude Code'), 'provider');
    await user.selectOptions(screen.getByLabelText('Model for Claude Code · sonnet'), 'act-7-102');

    const roles = bridge.commands().find((entry) => entry.kind === 'model-roles');
    expect(roles?.payload).toEqual(
      expect.objectContaining({
        clientId: 'claude',
        scope: 'provider',
        roleActionIds: { default: 'act-7-101', sonnet: 'act-7-102' },
      }),
    );
  });

  it('clears connection pins when the user asks for the provider default', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <AppsPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByTestId('apps-row-claude'));
    await user.click(screen.getByTestId('app.models.manage'));
    await user.click(screen.getByTestId('models-reset-claude'));

    const roles = bridge.commands().find((entry) => entry.kind === 'model-roles');
    expect(roles?.payload).toEqual(
      expect.objectContaining({
        clientId: 'claude',
        scope: 'connection',
        roleActionIds: {},
      }),
    );
  });

  it('shows the reported quota, and hides it when the setting is off', async () => {
    const native = snapshotFixture({ actions: snapshotFixture().actions.map((action) => ({ ...action, selected: false })) });
    const { user } = mount(({ service, snapshot }) => <AppsPane service={service} snapshot={snapshot} />, native);
    await user.click(screen.getByTestId('apps-row-claude'));
    expect(screen.getByTestId('apps-quota-claude-0')).toHaveTextContent('5h');
    expect(screen.getByTestId('apps-quota-claude-0')).toHaveTextContent('42% remaining');
    cleanup();
    const hidden = snapshotFixture({
      settings: { ...snapshotFixture().settings, showQuota: false },
    });
    const { user: user2 } = mount(({ service }) => <AppsPane service={service} snapshot={hidden} />, hidden);
    await user2.click(screen.getByTestId('apps-row-claude'));
    expect(screen.queryByTestId('apps-quota-claude-0')).not.toBeInTheDocument();
  });

  it('keeps vendor quota group headings in the app detail pane', async () => {
    const snapshot = snapshotFixture({
      actions: snapshotFixture().actions.map((action) => ({ ...action, selected: action.clientId === 'claude', sourceId: 'account/gemini/Work', routeKind: 'managed-account' })),
      usage: [
        {
          providerId: 'gemini',
          client: 'Gemini',
          account: 'Work',
          windows: [
            { label: 'Weekly', remainingPercent: 64, limitWindowSeconds: 604800, group: 'Gemini Models' },
            { label: '5h', remainingPercent: 91, limitWindowSeconds: 18000, group: 'Gemini Models' },
            { label: 'Weekly', remainingPercent: 37, limitWindowSeconds: 604800, group: 'Claude and GPT models' },
          ],
        },
      ],
    });
    const { user } = mount(({ service, snapshot: s }) => <AppsPane service={service} snapshot={s} />, snapshot);
    await user.click(screen.getByTestId('apps-row-claude'));
    expect(screen.getByRole('heading', { name: 'Gemini Models' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Claude and GPT models' })).toBeInTheDocument();
    expect(screen.getByTestId('apps-quota-claude-0')).toHaveTextContent('64% remaining');
    expect(screen.getByTestId('apps-quota-claude-2')).toHaveTextContent('37% remaining');
  });

  it('shows why a model cannot be chosen rather than an empty picker', async () => {
    const snapshot = snapshotFixture({
      clientModelConfigs: [
        {
          clientId: 'gemini',
          client: 'Gemini',
          roles: [{ id: 'default', label: 'Default' }],
          modelRoles: {},
          options: [],
          editable: false,
          unavailableReason: 'This connection uses the app’s own model picker.',
        },
      ],
    });
    const withGemini = snapshotFixture({
      actions: [
        ...snapshotFixture().actions,
        {
          id: 'act-gemini',
          clientId: 'gemini',
          sourceId: 'account/gemini/work',
          client: 'Gemini',
          label: 'Work',
          kind: 'account',
          presentation: 'native-account',
          selected: false,
          enabled: true,
        },
      ],
      clientModelConfigs: snapshot.clientModelConfigs,
    });
    // The engine publishes every registered client; which ones are the user's is
    // a local preference, so the test has to say Gemini is on the list.
    localStorage.setItem('anypick.configuredApps', JSON.stringify(['claude', 'gemini']));
    const { user } = mount(({ service, snapshot: s }) => <AppsPane service={service} snapshot={s} />, withGemini);
    await user.click(screen.getByTestId('apps-row-gemini'));
    // The reason appears once, as the row's own detail, and it is reachable: a
    // Manage button disabled behind a collapsed row would hide the only
    // explanation of why the app cannot be configured.
    expect(screen.getAllByText('This connection uses the app’s own model picker.')).toHaveLength(1);
    expect(screen.queryByTestId('app.models.manage')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Model for Gemini/)).not.toBeInTheDocument();
  });
});

describe('Proxies pane', () => {
  it('offers Start on a stopped proxy and Stop on a running one', () => {
    // The accessible name names the service the button acts on, so a screen
    // reader user hears which of several rows they are about to stop.
    mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);

    const running = within(screen.getByTestId('proxy-claude/work'));
    expect(running.getByRole('button', { name: 'Stop Work' })).toBeEnabled();

    const stopped = within(screen.getByTestId('proxy-codex/team'));
    expect(stopped.getByRole('button', { name: 'Start Team' })).toBeEnabled();
  });

  it('offers Restart only on a running proxy', async () => {
    // Restart implies a running service, so offering it on a stopped proxy is
    // a command that can only fail. It lives in the row menu, as on macOS
    // (`ProxiesView.swift:153` sits in the `contextMenu`, not the row).
    const { user } = mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByTestId('proxies.more-claude/work'));
    expect(screen.getByRole('menuitem', { name: 'Restart' })).toBeEnabled();
  });

  it('leaves a stopped proxy with only Start, and no menu to open', () => {
    // A stopped relay has no address to copy, no key to copy and nothing to
    // rotate, so its macOS menu holds exactly one item (`ProxiesView.swift:171`)
    // and that item is already the row's own button. An empty ⋯ menu beside it
    // is a control that opens nothing.
    mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    const stopped = within(screen.getByTestId('proxy-codex/team'));
    expect(stopped.getByRole('button', { name: 'Start Team' })).toBeInTheDocument();
    expect(stopped.queryByTestId('proxies.more-codex/team')).toBeNull();
  });

  it('keeps one trailing control per row and the rest in the menu', async () => {
    // macOS: `trailing: { lifecycleAction(proxy) }` and a `contextMenu`
    // (`ProxiesView.swift:143`, `:147`). This row used to carry six controls,
    // two of them identical copy glyphs that copied different things.
    const { user } = mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    const row = within(screen.getByTestId('proxy-claude/work'));
    expect(row.getAllByRole('button')).toHaveLength(2); // the row menu + Stop

    await user.click(screen.getByTestId('proxies.more-claude/work'));
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual(['Restart', 'Copy Address', 'Copy API Key', 'Rotate API Key…']);
  });

  it('hides the composite provider id from the proxy name', () => {
    mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    const list = screen.getByTestId('proxies-list');
    // The engine sends "Claude proxy · Work"; the user should read "Work", and
    // the raw composite ref must not surface anywhere in the pane.
    expect(within(list).getByText('Work')).toBeInTheDocument();
    expect(within(list).getByText('Team')).toBeInTheDocument();
    expect(list.textContent).not.toContain('claude/work');
    expect(list.textContent).not.toContain('Claude proxy · Work');
  });

  it('qualifies a name that two providers would otherwise share', () => {
    // Both engines send "… proxy · Work". Two identical rows with no way to
    // tell them apart is a bug a user cannot work around, so a colliding name
    // carries its provider.
    const snapshot = snapshotFixture({
      proxies: [
        {
          id: 'claude/work',
          providerId: 'claude',
          label: 'Claude proxy · Work',
          detail: 'running on port 5150',
          running: true,
          enabled: true,
          toggleActionId: 'act-1',
          restartActionId: 'act-2',
        },
        {
          id: 'codex/work',
          providerId: 'codex',
          label: 'Codex proxy · Work',
          detail: 'running on port 5151',
          running: true,
          enabled: true,
          toggleActionId: 'act-3',
          restartActionId: 'act-4',
        },
      ],
    });
    mount(({ service, snapshot: s }) => <ProxiesPane service={service} snapshot={s} />, snapshot);
    const list = screen.getByTestId('proxies-list');
    expect(within(list).getByText('Claude Work')).toBeInTheDocument();
    expect(within(list).getByText('OpenAI Work')).toBeInTheDocument();
  });

  it('keeps the short name when nothing collides', () => {
    const snapshot = snapshotFixture({
      proxies: [
        {
          id: 'claude/work',
          providerId: 'claude',
          label: 'Claude proxy · Work',
          detail: 'running on port 5150',
          running: true,
          enabled: true,
          toggleActionId: 'act-1',
          restartActionId: 'act-2',
        },
      ],
    });
    mount(({ service, snapshot: s }) => <ProxiesPane service={service} snapshot={s} />, snapshot);
    // Qualification is a last resort. With no collision the short name stands.
    expect(within(screen.getByTestId('proxies-list')).getByText('Work')).toBeInTheDocument();
  });

  it('never renders a bearer, only the fact that one can be copied', async () => {
    // ADR 0006: the token never enters a snapshot. hasToken says a copy is
    // possible; the value arrives in a result payload, on request.
    const { user } = mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByTestId('proxies.more-claude/work'));
    expect(screen.getByRole('menuitem', { name: 'Copy API Key' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sk-|Bearer /);
  });

  it('asks for a key by mutation, never by reading the snapshot', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxiesPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByTestId('proxies.more-claude/work'));
    await user.click(screen.getByRole('menuitem', { name: 'Copy API Key' }));
    const mutate = bridge.commands().find((entry) => entry.kind === 'mutate');
    expect(mutate?.payload).toMatchObject({ operation: 'proxy-token', providerId: 'claude' });
  });

  it('reports the hub separately from the account proxies', () => {
    // The hub is not one of the per-account relays. Listing it among them
    // makes the running count mean two different things in two places.
    mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    expect(screen.getByTestId('proxies-hub-summary')).toBeInTheDocument();
    const list = screen.getByTestId('proxies-list');
    expect(within(list).getAllByTestId(/^proxy-/)).toHaveLength(2);
    expect(within(list).queryByTestId('proxy-proxy-hub/default')).not.toBeInTheDocument();
  });

  it('confirms before stopping every service', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxiesPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByRole('button', { name: 'Stop All…' }));

    // Nothing is sent until the user confirms: a destructive batch that fires
    // on the opening click cannot be taken back.
    expect(bridge.commandKinds()).not.toContain('mutate');
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop All' }));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument());
    expect(bridge.commands().find((entry) => entry.kind === 'mutate')?.payload).toMatchObject({
      operation: 'proxy-stop-all',
      name: 'all',
    });
  });

  it('sends nothing when the destructive confirmation is cancelled', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxiesPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByRole('button', { name: 'Stop All…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.commandKinds()).not.toContain('mutate');
  });

  it('disables the batch actions when there is nothing to act on', () => {
    // "Stop All" with nothing running and "Restart Running" with nothing
    // running are buttons that can only fail, so they are disabled rather
    // than left looking available.
    const snapshot = snapshotFixture({
      proxies: snapshotFixture().proxies.filter((proxy) => !proxy.running),
    });
    mount(({ service, snapshot: s }) => <ProxiesPane service={service} snapshot={s} />, snapshot);
    expect(screen.getByRole('button', { name: 'Stop All…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart Running Proxies' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Start All Proxies$/ })).toBeEnabled();
  });

  it('starts the stopped account proxies with the bulk operation the engine accepts', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxiesPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByRole('button', { name: 'Start Remaining Proxies' }));
    expect(bridge.commands().find((entry) => entry.kind === 'mutate')?.payload).toMatchObject({
      operation: 'proxy-start-all',
      name: 'all',
    });
  });

  it('leaves the hub row to a status label, its commands to the Proxy Hub pane', () => {
    // macOS's hub row is a `NavigationLink` whose trailing is a
    // `DesignStatusLabel` and nothing else (`ProxiesView.swift:113-122`). Five
    // controls here duplicated what Proxy Hub already offers, one level deeper.
    mount(({ service, snapshot }) => <ProxiesPane service={service} snapshot={snapshot} />);
    const row = within(screen.getByTestId('proxies-hub-summary'));
    expect(row.getByText('Running')).toBeInTheDocument();
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual(['Published Models']);
  });
});

describe('Accounts pane', () => {
  it('refreshes the account the button names, and does not refresh the snapshot', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <AccountsPane service={service} snapshot={snapshot} />
    ));
    // Refresh lives in the row menu, which is how macOS puts it: a row with
    // four buttons is the control-panel look the contract bans.
    await user.click(screen.getByTestId('accounts.more.claude/personal'));
    await user.click(screen.getByRole('menuitem', { name: 'Refresh Login' }));
    expect(bridge.commands().find((entry) => entry.kind === 'mutate')?.payload).toMatchObject({
      operation: 'account-refresh',
      providerId: 'claude',
      name: 'personal',
    });
    expect(bridge.commandKinds()).not.toContain('refresh');
  });

  it('removes an account only after confirmation', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <AccountsPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByTestId('accounts.more.claude/personal'));
    await user.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    expect(bridge.commandKinds()).not.toContain('mutate');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(bridge.commands().find((entry) => entry.kind === 'mutate')?.payload).toMatchObject({
      operation: 'account-remove',
      providerId: 'claude',
      name: 'personal',
    });
  });
});

describe('Proxy Hub pane', () => {
  it('sends hub-rotation for the rotation row and hub-source-toggle for an account', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxyHubPane service={service} snapshot={snapshot} />
    ));
    // Rotation is a segmented Failover/Round Robin control, not a switch:
    // the hub always has a strategy, and a switch would render "on" as
    // round-robin with no way to express which one is selected.
    await user.click(screen.getByRole('button', { name: 'Round Robin' }));
    await user.click(screen.getByRole('switch', { name: 'Disable Work' }));
    const mutations = bridge.commands().filter((entry) => entry.kind === 'mutate').map((entry) => entry.payload);
    expect(mutations[0]).toMatchObject({ operation: 'hub-rotation', name: 'default', enabled: true });
    expect(mutations[0]).not.toHaveProperty('providerId');
    expect(mutations[1]).toMatchObject({
      operation: 'hub-source-toggle',
      name: 'default',
      providerId: 'claude',
      sourceId: 'work',
      enabled: false,
    });
  });

  it('offers a lifecycle button and the address, not just a source list', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxyHubPane service={service} snapshot={snapshot} />
    ));
    expect(screen.getByTestId('hub.service')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:5200')).toBeInTheDocument();
    // A running hub is stopped by a button. A hub is a service; a switch said
    // "policy" and there was no way to restart one.
    await user.click(screen.getByTestId('hub.service-actions'));
    expect(bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.actionId).toBe(
      'act-7-221',
    );
  });

  it('gives protected API-key copy the same working and confirmed icon phases', async () => {
    const busy = new Set<string>();
    const harness = mount(({ service, snapshot }) => {
      vi.spyOn(service, 'mutate').mockImplementation(() => {
        busy.add('copy-key-1');
        return 'copy-key-1';
      });
      return <ProxyHubPane service={service} snapshot={snapshot} busy={busy} />;
    });

    await harness.user.click(screen.getByTestId('hub.copy-api-key-button'));
    const working = screen.getByRole('button', { name: /Copy Proxy Hub API key.*Working/ });
    expect(working).toBeDisabled();
    expect(working).toHaveAttribute('aria-busy', 'true');

    busy.delete('copy-key-1');
    harness.rerender(
      <ProxyHubPane
        service={harness.service}
        snapshot={harness.snapshot}
        busy={busy}
        copyKeyResult={{ requestId: 'copy-key-1', success: null }}
      />,
    );
    expect(screen.getByRole('button', { name: /Copy Proxy Hub API key.*Working/ })).toBeDisabled();

    harness.rerender(
      <ProxyHubPane
        service={harness.service}
        snapshot={harness.snapshot}
        busy={busy}
        copyKeyResult={{ requestId: 'copy-key-1', success: true }}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveAttribute('title', 'Copied');
  });

  it('keeps one trailing control on the service row and Restart in its menu', async () => {
    // macOS: `trailing: { hubLifecycleButton }` plus a `.contextMenu` holding
    // Restart Hub (`ProxyHubView.swift:28`, `:31`). This row carried a status
    // dot duplicating its own subtitle, Restart *and* Rotate — and Rotate also
    // had a second button on the API Key row below.
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxyHubPane service={service} snapshot={snapshot} />
    ));
    const row = within(screen.getByTestId('hub-service-row'));
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual(['', 'Stop']);

    await user.click(screen.getByTestId('hub.more'));
    await user.click(screen.getByRole('menuitem', { name: 'Restart Hub' }));
    expect(bridge.commands().filter((entry) => entry.kind === 'invoke').map((e) => e.payload?.actionId)).toEqual([
      'act-7-222',
    ]);
  });

  it('confirms a key rotation before sending it', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => (
      <ProxyHubPane service={service} snapshot={snapshot} />
    ));
    await user.click(screen.getByTestId('hub-rotate-api-key'));
    const dialog = within(screen.getByTestId('hub-rotate-dialog'));
    expect(dialog.getByText('Rotate Proxy Hub API Key?')).toBeInTheDocument();
    // Nothing is sent until the user confirms: a rotation drops every app
    // configured with the current key.
    expect(bridge.commands().filter((entry) => entry.kind === 'invoke')).toHaveLength(0);

    await user.click(dialog.getByRole('button', { name: 'Rotate Key' }));
    expect(bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.actionId).toBe(
      'act-7-223',
    );
  });

  it('offers a provider picker for a routing conflict and invokes the candidate', async () => {
    const conflict = {
      id: 'overlap-1',
      kind: 'model-overlap',
      title: 'claude-sonnet',
      models: ['claude-sonnet'],
      candidates: [
        { id: 'c1', providerId: 'claude', label: 'Claude', detail: 'Work', actionId: 'act-c1', providerChoice: true },
        { id: 'c2', providerId: 'openai', label: 'OpenAI', detail: 'Team', actionId: 'act-c2', providerChoice: true },
      ],
    };
    const { bridge, user } = mount(
      ({ service, snapshot }) => <ProxyHubPane service={service} snapshot={snapshot} />,
      snapshotFixture({ hubConflicts: [conflict] }),
    );
    expect(screen.getByTestId('hub-conflicts')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('hub.conflict.overlap-1.picker'), 'act-c2');
    expect(bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.actionId).toBe('act-c2');
  });

  it('hides a conflict with fewer than two candidates rather than offering a dead picker', () => {
    const conflict = {
      id: 'overlap-1',
      kind: 'model-overlap',
      title: 'claude-sonnet',
      models: ['claude-sonnet'],
      candidates: [
        { id: 'c1', providerId: 'claude', label: 'Claude', detail: 'Work', actionId: 'act-c1', providerChoice: true },
      ],
    };
    mount(
      ({ service, snapshot }) => <ProxyHubPane service={service} snapshot={snapshot} />,
      snapshotFixture({ hubConflicts: [conflict] }),
    );
    expect(screen.queryByTestId('hub-conflicts')).toBeNull();
  });
});

describe('Activity and backups', () => {
  it('shows the event the engine recorded', () => {
    mount(({ snapshot }) => <ActivityPane snapshot={snapshot} />, snapshotFixture());
    expect(screen.getByText('Claude Code now uses Work.')).toBeInTheDocument();
  });

  it('creates a backup with an empty path so the engine chooses the file', async () => {
    const { bridge, user } = mount(({ service, snapshot }) => <BackupsPane service={service} snapshot={snapshot} />);
    await user.click(screen.getByRole('button', { name: 'Create Backup' }));
    expect(bridge.commands().find((entry) => entry.kind === 'mutate')?.payload).toMatchObject({
      operation: 'account-backup-all',
      path: '',
    });
  });
});
