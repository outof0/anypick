import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MutableRefObject } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from '../App';
import type { ServiceHandle } from '../lib/service';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/primitives';
import { FakeBridge, snapshotFixture } from './harness';

// The webview loads styles.css from main. Vitest does not insert it into jsdom,
// so an assertion about it has to load the file itself or it passes while the
// window is still one stacked column.
//
// jsdom does not run Tailwind's Vite plugin, so `@import 'tailwindcss'` resolves
// to nothing here and every utility class is undefined. This compiles the same
// `@theme` block and the utilities the shell actually uses, which keeps the
// structural assertions below meaningful without asserting pixel values that a
// preflight change would legitimately move.
const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHELL_STYLES = `
  .grid { display: grid; }
  .flex { display: flex; }
  .overflow-hidden { overflow: hidden; }
  .overflow-auto { overflow: auto; }
  .flex-col { flex-direction: column; }
  .items-center { align-items: center; }
  .items-start { align-items: flex-start; }
  .justify-start { justify-content: flex-start; }
  .justify-end { justify-content: flex-end; }
  .flex-none { flex: none; }
  .min-h-0 { min-height: 0; }
  .min-w-0 { min-width: 0; }
  .w-full { width: 100%; }
  .h-\\[100dvh\\] { height: 100dvh; }
  .grid-cols-\\[216px_minmax\\(0\\,1fr\\)\\] { grid-template-columns: 216px minmax(0, 1fr); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
`;

beforeAll(() => {
  const style = document.createElement('style');
  style.dataset.desktopCss = 'shell';
  style.textContent = SHELL_STYLES;
  document.head.appendChild(style);
});

/**
 * The shell: what a user sees before a pane is chosen, and what happens when
 * the service reports a problem.
 *
 * These are the cases the previous single-file UI could not be tested for at
 * all, because it resolved the Tauri bridge at module scope.
 */

const bridges: FakeBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  globalThis.localStorage?.removeItem('anypick.onboardingDismissed');
  globalThis.localStorage?.removeItem('anypick.configuredApps');
  globalThis.localStorage?.removeItem('anypick.removedApps');
});

/**
 * Switch an app to its gateway route, the way a user does now.
 *
 * The Apps row carries no Use button — macOS keeps one row per app and the
 * commands in its menu — so these shell tests drive the staged connection sheet.
 * A helper rather than four copies, because the shell's behaviour under test is
 * the same in all four.
 */
async function switchAppToGateway(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('app.more-claude'));
  await user.click(screen.getByRole('menuitem', { name: 'Change Connection…' }));
  await user.click(screen.getByTestId('app-route.option.act-7-002'));
  // Review first, then apply: the sheet never sends a switch the user has not
  // been shown a summary of.
  await user.click(screen.getByRole('button', { name: 'Review Change' }));
  await user.click(screen.getByRole('button', { name: 'Apply Changes' }));
}

function mount(options: { lastLine?: string } = {}) {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  bridge.lastLine = options.lastLine ?? null;
  const user = userEvent.setup();
  // The shell owns the in-flight set, so a test reads it through the ref the
  // App exposes for exactly that purpose.
  const serviceRef: MutableRefObject<ServiceHandle | null> = { current: null };
  const result = render(<App bridge={bridge} serviceRef={serviceRef} />);
  return {
    bridge,
    user,
    /** Requests the engine has not answered yet. */
    pending: () => serviceRef.current?.pending().size ?? 0,
    ...result,
  };
}

describe('a sheet taller than its window', () => {
  it('keeps the buttons reachable without scrolling the body', () => {
    // macOS pins the sheet's footer outside the scroll view. With everything
    // scrolling, a sheet's Done button could sit below the fold on a short
    // window — the control that closes it was the one you had to hunt for.
    render(
      <Dialog title="Transfer" testId="sheet" actions={<Button>Done</Button>}>
        <div style={{ height: '1200px' }}>tall</div>
      </Dialog>,
    );
    const sheet = screen.getByTestId('sheet');
    const scroller = sheet.querySelector('.overflow-auto') as HTMLElement;
    const done = screen.getByRole('button', { name: 'Done' });

    // Only the body scrolls, so the button is never inside it.
    expect(scroller).not.toContainElement(done);
    expect(sheet.className).toContain('overflow-hidden');
  });
});

describe('App shell', () => {
  it('shows the sidebar destinations the macOS app has, in order', () => {
    mount();
    const nav = screen.getByRole('navigation', { name: 'AnyPick sections' });
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent);
    // macos/DesignTypes.swift DesignDestination.allCases. The order is the
    // sidebar order, so it is part of the contract with the native app.
    expect(labels).toEqual([
      'Overview',
      'Apps',
      'Accounts & APIs',
      'Proxy Hub',
      'Proxies',
      'Activity',
      'Backups',
      'Settings',
    ]);
  });

  it('keeps the sidebar in a column beside the page', async () => {
    const { container, bridge, user } = mount();
    bridge.push('snapshot', snapshotFixture());
    await user.click(within(screen.getByRole('navigation', { name: 'AnyPick sections' })).getByRole('button', { name: 'Apps' }));

    // Structural, not pixel. A single grid track is the full-width blue bar
    // with the pane stacked under it, which is the failure this asserts.
    const shell = container.firstElementChild as HTMLElement;
    const shellStyle = getComputedStyle(shell);
    expect(shellStyle.display).toBe('grid');
    expect(shellStyle.gridTemplateColumns).toBe('216px minmax(0, 1fr)');
    // `100dvh`, not `100%`: a percentage becomes `auto` when the webview's
    // parent height is indefinite, which collapses both columns.
    expect(shellStyle.height).toBe('100dvh');
    expect(shellStyle.overflow).toBe('hidden');

    const sidebar = screen.getByTestId('sidebar-navigation');
    const main = screen.getByRole('main');
    expect(getComputedStyle(sidebar).flexDirection).toBe('column');
    expect(getComputedStyle(main).flexDirection).toBe('column');
    expect(shell.firstElementChild).toBe(sidebar);
    expect(sidebar.nextElementSibling).toBe(main);
    expect(getComputedStyle(main.lastElementChild as HTMLElement).overflow).toBe('auto');

    // The search label is spoken, not drawn. Without this it wraps inside the
    // 22px field and paints over the pane title.
    const searchLabel = screen.getByText('Search Apps');
    expect(getComputedStyle(searchLabel).position).toBe('absolute');
    expect(getComputedStyle(searchLabel).overflow).toBe('hidden');

    const summary = screen.getByTestId('sidebar-service-status');
    expect(getComputedStyle(summary).display).toBe('flex');
    const sidebarSettings = screen.getByTestId('sidebar-settings');
    expect(sidebarSettings.closest('[data-testid="sidebar-navigation"]')).toBe(sidebar);
    expect(sidebarSettings.closest('nav')).not.toBeNull();
    await user.click(sidebarSettings);
    const settingsPane = await screen.findByTestId('settings-pane');
    expect(settingsPane.closest('main')).toBe(main);
    expect(sidebarSettings).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-startup')).toBeInTheDocument();
    expect(screen.getByTestId('settings-usage')).toBeInTheDocument();
    expect(screen.getByTestId('settings-getting-started')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Checklist' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Proxies|Manage Backups|Check Now/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-settings')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('sidebar-proxies'));
    expect(screen.getByTestId('sidebar-proxies')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('settings-pane')).not.toBeInTheDocument();

    bridge.pushEvent('open-settings');
    expect(await screen.findByTestId('settings-pane')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-settings')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('waits for a snapshot instead of rendering an empty window', () => {
    // An empty pane looks like "you have no accounts". Saying nothing until
    // the engine has spoken is the difference between those two.
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to the service…');
    expect(screen.queryByTestId('overview')).not.toBeInTheDocument();
  });

  it('replaces quota from a usage frame and ignores an older reading', async () => {
    const { bridge, user } = mount();
    bridge.push('snapshot', snapshotFixture());
    await user.click(within(screen.getByRole('navigation', { name: 'AnyPick sections' })).getByRole('button', { name: 'Apps' }));
    await user.click(screen.getByTestId('apps-row-claude'));
    expect(await screen.findByTestId('apps-quota-claude-0')).toHaveTextContent('42% remaining');
    bridge.push('usage-event', {
      protocolVersion: 2,
      revision: 7,
      usage: [
        {
          client: 'Claude',
          account: 'Work',
          windows: [{ label: '', remainingPercent: 11, limitWindowSeconds: 18000, resetsAtMs: 0 }],
        },
      ],
    });
    expect(screen.getByTestId('apps-quota-claude-0')).toHaveTextContent('11% remaining');
    bridge.push('usage-event', {
      protocolVersion: 2,
      revision: 6,
      usage: [
        {
          client: 'Claude',
          account: 'Work',
          windows: [{ label: '', remainingPercent: 99, limitWindowSeconds: 18000, resetsAtMs: 0 }],
        },
      ],
    });
    expect(screen.getByTestId('apps-quota-claude-0')).toHaveTextContent('11% remaining');
  });

  it('renders the pane once the first snapshot arrives', async () => {
    const { bridge } = mount();
    bridge.push('snapshot', snapshotFixture());
    expect(await screen.findByTestId('overview')).toBeInTheDocument();
  });

  it('replays the last service line the listener missed', async () => {
    // The service can emit the only full snapshot before the UI listener is
    // attached. Without the replay the window sits on "connecting" until the
    // next mutation, which looks like a hang.
    const snapshot = snapshotFixture();
    const line = `snapshot\t${Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64')}`;
    const { bridge } = mount({ lastLine: line });
    expect(await screen.findByTestId('overview')).toBeInTheDocument();
    expect(bridge.commandKinds()).not.toContain('refresh');
  });

  it('navigates to a pane and renders it', async () => {
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');

    await user.click(screen.getByTestId('sidebar-proxies'));
    expect(await screen.findByTestId('proxies')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation')).getByTestId('sidebar-proxies')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('clears the search box when the pane changes', async () => {
    // The search box belongs to the pane that owns it. Carrying a query across
    // a navigation is how "no results" appears for a list never searched.
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');

    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');
    await user.type(screen.getByTestId('toolbar-search'), 'claude');
    expect(screen.getByTestId('toolbar-search')).toHaveValue('claude');

    await user.click(screen.getByTestId('sidebar-proxies'));
    await screen.findByTestId('proxies');
    expect(screen.getByTestId('toolbar-search')).toHaveValue('');
  });

  it('offers a search field only where a list is long enough to need one', async () => {
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    // Overview has no search field: it is a summary, not a collection.
    expect(screen.queryByTestId('toolbar-search')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');
    expect(screen.getByTestId('toolbar-search')).toBeInTheDocument();
  });

  it('releases a control on the engine’s answer, not on a timer', async () => {
    // Action ids are revision-scoped and the engine guarantees exactly one
    // terminal frame per request. A timeout would re-enable a button whose
    // mutation had not landed yet.
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');

    await switchAppToGateway(user);
    // Still outstanding: the engine has not answered, so the slot stays held.
    expect(pending()).toBe(1);

    const requestId = bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.requestId;
    expect(requestId).toBeTruthy();
    bridge.push('result', { version: 1, requestId, status: 'success', message: 'Switched.' });
    await waitFor(() => expect(pending()).toBe(0));
  });

  it('shows a failure with the engine’s own recovery suggestion', async () => {
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');

    const requestId = bridge.commands().length; // any id; the pane has not sent yet
    void requestId;
    bridge.push('result', {
      version: 1,
      requestId: 'unknown-1',
      status: 'error',
      message: 'account not found: work is no longer available.',
      code: 'ACCOUNT_NOT_FOUND',
      suggestions: [{ text: 'Refresh your accounts list or re-add it.' }],
    });

    const notice = await screen.findByTestId('notice');
    expect(notice).toHaveTextContent('account not found: work is no longer available.');
    // The engine already knows the recovery step; a user should not have to
    // guess it.
    expect(notice).toHaveTextContent('Refresh your accounts list or re-add it.');
  });

  it('stays silent on success', async () => {
    // macOS shows failures in an alert and keeps success silent, because a
    // success toast duplicates the row's own state and can fire before the
    // snapshot confirms anything.
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');
    await switchAppToGateway(user);

    const requestId = bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.requestId;
    bridge.push('result', { version: 1, requestId, status: 'success', message: 'Switched to Team gateway.' });
    // Asserted after a render, not inside waitFor: waitFor returns as soon as
    // its condition holds, so a condition that already holds before React
    // re-renders would pass against a banner that is about to appear.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('notice')).not.toBeInTheDocument();
    expect(pending()).toBe(0);
  });

  it('does not report a user cancellation as a failure', async () => {
    // result.go clears code, suggestions and mutated on cancel. Treating a
    // cancel as an error nags the user about their own decision.
    const { bridge } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    bridge.push('result', { version: 1, requestId: 'login-1', status: 'cancelled', message: 'Sign-in cancelled.' });
    // Asserted after a render, not inside waitFor: waitFor returns as soon as
    // its condition holds, so a condition that holds before React re-renders
    // would pass against a banner that is about to appear.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('notice')).not.toBeInTheDocument();
  });

  it('holds every action control while a request is outstanding', async () => {
    // The engine accepts one mutation at a time, and macOS is single-flight
    // with `model.isBusy` disabling the controls. A second click would send a
    // command the engine then refuses, so the buttons are held, not merely
    // tracked.
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');

    await switchAppToGateway(user);
    expect(pending()).toBe(1);
    // Every action control, not just the one that was pressed: the engine would
    // reject a second mutation of any kind while the first is running.
    for (const button of screen.getAllByRole('button', { name: 'Add App…' })) {
      expect(button).toBeDisabled();
    }

    const requestId = bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.requestId;
    bridge.push('result', { version: 1, requestId, status: 'success', message: 'ok' });
    await waitFor(() => expect(pending()).toBe(0));
    // The control the user can reach is re-enabled once the engine answers.
    await user.click(screen.getByTestId('apps-row-claude'));
    expect(screen.getByTestId('app.models.manage')).toBeEnabled();
  });

  it('keeps the newer snapshot when an older one arrives later', async () => {
    // last_service_line can replay after a live frame. Applying it blindly
    // points the window at accounts the engine has already replaced.
    const { bridge } = mount();
    bridge.push('snapshot', snapshotFixture({ revision: 7 }));
    expect(await screen.findByText('A login is saved on this Mac.')).toBeInTheDocument();

    bridge.push('snapshot', snapshotFixture({ revision: 3, accounts: [] }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('A login is saved on this Mac.')).toBeInTheDocument();
    expect(screen.queryByText('Use a login already on this Mac.')).not.toBeInTheDocument();
  });

  it('copies an API key from the proxy-token result and never renders it', async () => {
    const { bridge, user } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-proxies'));
    // The relay's copy lives in its row menu, as on macOS (`ProxiesView.swift:164`).
    await user.click(await screen.findByTestId('proxies.more-claude/work'));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy API Key' }));

    const mutate = bridge.commands().find((entry) => entry.kind === 'mutate');
    expect(mutate?.payload).toMatchObject({
      operation: 'proxy-token',
      providerId: 'claude',
      name: 'work',
    });
    const secret = 'sk-test-secret-not-for-display';
    bridge.push('result', {
      version: 1,
      requestId: mutate?.payload?.requestId,
      status: 'success',
      message: 'API key ready.',
      payload: { apiKey: secret },
    });

    // userEvent.setup() replaces navigator.clipboard, so the log in setup.ts
    // is not the clipboard this write lands on.
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(secret);
    });
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.getByTestId('notice')).toHaveTextContent('Copied API key.');
    expect(screen.getByTestId('notice')).not.toHaveTextContent(secret);
  });

  it('retries a foreign-config refusal only after the user confirms that action', async () => {
    const { bridge, user } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-apps'));
    await switchAppToGateway(user);

    const first = bridge.commands().find((entry) => entry.kind === 'invoke');
    bridge.push('result', {
      version: 1,
      requestId: first?.payload?.requestId,
      status: 'error',
      code: 'CLIENT_CONFIG_FOREIGN',
      message: 'Claude has settings AnyPick does not own.',
    });

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Claude has settings AnyPick does not own.');
    expect(bridge.commands().filter((entry) => entry.kind === 'invoke')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Manage with AnyPick' }));
    const invokes = bridge.commands().filter((entry) => entry.kind === 'invoke');
    expect(invokes).toHaveLength(2);
    expect(invokes[1]?.payload).toMatchObject({
      actionId: 'act-7-002',
      revision: 7,
      allowForeignConfig: true,
    });
  });

  it('shows the path a backup was written to', async () => {
    const { bridge, user } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-backups'));
    await user.click(await screen.findByRole('button', { name: 'Create Backup' }));
    const mutate = bridge.commands().find((entry) => entry.kind === 'mutate');
    bridge.push('result', {
      version: 1,
      requestId: mutate?.payload?.requestId,
      status: 'success',
      message: 'Saved 2 accounts to /tmp/anypick-backup.anypick-backup. The file contains account credentials.',
    });
    expect(await screen.findByTestId('notice')).toHaveTextContent('/tmp/anypick-backup.anypick-backup');
    expect(screen.getByTestId('notice')).toHaveTextContent('account credentials');
  });

  it('hides getting started instead of opening Accounts', async () => {
    const { bridge, user } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview-get-started');
    await user.click(screen.getByRole('button', { name: 'Hide Getting Started' }));
    expect(screen.queryByTestId('overview-get-started')).not.toBeInTheDocument();
    expect(screen.getByTestId('overview')).toBeInTheDocument();

    await user.click(screen.getByTestId('sidebar-settings'));
    await user.click(await screen.findByRole('button', { name: 'Show Checklist' }));
    expect(await screen.findByTestId('overview-get-started')).toBeInTheDocument();
  });

  it('runs Doctor from Overview and releases its request when the report arrives', async () => {
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');

    await user.click(screen.getByTestId('overview.run-doctor'));
    expect(pending()).toBe(1);
    const command = bridge.commands().find((entry) => entry.kind === 'doctor');
    const requestId = command?.payload?.requestId;
    expect(typeof requestId).toBe('string');

    bridge.push('doctor', {
      version: 1,
      requestId,
      status: 'degraded',
      findings: [{ check: 'permissions', status: 'warn', detail: 'One file needs safer permissions.' }],
    });

    expect(await screen.findByText('One file needs safer permissions.')).toBeInTheDocument();
    await waitFor(() => expect(pending()).toBe(0));
  });

  it('uses the current language for an event callback registered before the locale changed', async () => {
    const originalLanguages = Object.getOwnPropertyDescriptor(navigator, 'languages');
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      value: ['de-DE'],
    });

    try {
      const { bridge, user } = mount();
      const initial = snapshotFixture();
      bridge.push('snapshot', snapshotFixture({
        ...initial,
        settings: { ...initial.settings, language: 'de', resolvedLanguage: 'de' },
      }));
      await screen.findByTestId('overview');

      bridge.push('snapshot', snapshotFixture({
        ...initial,
        revision: initial.revision + 1,
        settings: { ...initial.settings, language: 'vi', resolvedLanguage: 'vi' },
      }));
      expect(await screen.findByText('Cài đặt')).toBeInTheDocument();

      await user.click(screen.getByTestId('overview.run-doctor'));
      const command = bridge.commands().find((entry) => entry.kind === 'doctor');
      bridge.push('doctor', {
        version: 1,
        requestId: command?.payload?.requestId,
        status: 'ok',
        findings: [],
      });

      expect(await screen.findByTestId('notice')).toHaveTextContent(
        'Tất cả kiểm tra đều đạt. Không có vấn đề nào cần xử lý.',
      );
    } finally {
      if (originalLanguages) {
        Object.defineProperty(navigator, 'languages', originalLanguages);
      } else {
        Reflect.deleteProperty(navigator, 'languages');
      }
    }
  });

  it('shows Doctor request failures on Overview', async () => {
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('overview.run-doctor'));
    const command = bridge.commands().find((entry) => entry.kind === 'doctor');
    const requestId = command?.payload?.requestId;
    expect(typeof requestId).toBe('string');

    bridge.push('result', {
      version: 1,
      requestId,
      status: 'error',
      message: 'Doctor could not read the local database.',
    });

    expect(await screen.findByTestId('overview.doctor-error')).toHaveTextContent(
      'Doctor could not read the local database.',
    );
    await waitFor(() => expect(pending()).toBe(0));
  });

  it('ignores an answer to a request nobody is waiting for', async () => {
    // A result is matched by request id. Releasing on any result would free a
    // control whose own mutation is still in flight.
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('sidebar-apps'));
    await screen.findByTestId('apps');

    await switchAppToGateway(user);
    expect(pending()).toBe(1);

    bridge.push('result', { version: 1, requestId: 'someone-elses-request', status: 'success', message: 'ok' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pending()).toBe(1);
    // The slot is still held, so the controls the user can reach are still off.
    await user.click(screen.getByTestId('apps-row-claude'));
    expect(screen.getByTestId('app.models.manage')).toBeDisabled();
  });

  it('ignores a frame kind it does not understand', async () => {
    // The engine may add frames. Dropping one is correct; rendering it as an
    // empty state is not.
    const { bridge } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    bridge.push('something-new', { unexpected: true });
    bridge.push('protocol-error', {
      protocolVersion: 2,
      code: 'MALFORMED_FRAME',
      message: 'malformed frame',
    });
    expect(await screen.findByTestId('notice')).toHaveTextContent('malformed frame');
  });

  it('reports the service state the host announces', async () => {
    const { bridge } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');

    bridge.pushServiceState('degraded', 'AnyPick service is unavailable.');
    expect(await screen.findByTestId('notice')).toHaveTextContent('AnyPick service is unavailable.');
    // The sidebar footer is the persistent answer to "is this thing working".
    // A user who scrolled away from the banner still needs to know.
    expect(screen.getByText('Service needs attention')).toBeInTheDocument();
  });

  it('refreshes on demand without reloading the window', async () => {
    const { bridge, user, pending } = mount();
    bridge.push('snapshot', snapshotFixture());
    await screen.findByTestId('overview');
    await user.click(screen.getByTestId('toolbar-refresh'));
    expect(bridge.commandKinds()).toEqual(['refresh']);
  });

  it('leaves Connecting when Try Again cannot reach the service', async () => {
    // The sidecar stopped is exactly when a user reaches for Try Again, and
    // Rust answers `send_command` with an error. Without a handler the refresh
    // rejection was unhandled, the state stayed `starting`, and the window sat
    // on "Connecting to the service" with no way out.
    const { bridge, user } = mount();
    bridge.pushServiceState('stopped');
    await screen.findByTestId('state.error');

    bridge.sendCommandError = 'AnyPick core is stopped. Restart the app to try again.';
    await user.click(screen.getByRole('button', { name: 'Try Again' }));

    expect(await screen.findByTestId('notice')).toHaveTextContent(
      'AnyPick core is stopped. Restart the app to try again.',
    );
    // The retry's own error state, not the spinner: a second Try Again is
    // offered rather than a "Connecting" that never resolves.
    expect(await screen.findByTestId('state.error')).toBeInTheDocument();
    expect(screen.queryByTestId('state.loading')).toBeNull();
  });
});
