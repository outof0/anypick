import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { GatewaysHomeScreen } from '../src/tui/screens/gateways-home';
import { HelpScreen } from '../src/tui/screens/help';
import { ManageAppsScreen } from '../src/tui/screens/manage-apps';

function compact(frame: string | undefined): string {
  return (frame ?? '').replace(/\s+/g, ' ').trim();
}

const app = {
  clientId: 'claude',
  clientName: 'Claude',
  bound: false,
};

describe('TUI source consistency', () => {
  it('lets each source give the shared manage-apps screen its own breadcrumb', () => {
    const common = {
      proxyRef: 'openrouter-work',
      apps: [app],
      checked: new Set<string>(),
      selectedIndex: 0,
      onMove: () => {},
      onToggle: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    };

    const gateway = render(
      <ManageAppsScreen {...common} path={['gateways', 'openrouter-work', 'apps']} />,
    );
    expect(compact(gateway.lastFrame())).toContain('AnyPick / gateways / openrouter-work / apps');
    gateway.unmount();

    const proxy = render(<ManageAppsScreen {...common} />);
    expect(compact(proxy.lastFrame())).toContain('AnyPick / proxy / apps');
    proxy.unmount();
  });

  it('advertises and dispatches the implemented gateway keys', async () => {
    const onUseApps = vi.fn();
    const onEditModels = vi.fn();
    const onDelete = vi.fn();
    const onQuit = vi.fn();
    const row = {
      name: 'openrouter-work',
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1',
      endpointShort: 'openrouter.ai/api/v1',
      hasApiKey: true,
      defaultModel: 'anthropic/claude-sonnet-4',
      modelSummary: 'anthropic/claude-sonnet-4',
      usedByApps: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedRelative: 'now',
    };
    const ui = render(
      <GatewaysHomeScreen
        rows={[row]}
        selectedIndex={0}
        columns={180}
        onMove={() => {}}
        onAdd={() => {}}
        onUseApps={onUseApps}
        onEditModels={onEditModels}
        onEditEndpoint={() => {}}
        onDelete={onDelete}
        onSwitch={() => {}}
        onQuit={onQuit}
      />,
    );

    const frame = compact(ui.lastFrame());
    expect(frame).toContain('enter manage apps');
    expect(frame).toContain('m model defaults');
    expect(frame).not.toContain('m manage apps');
    expect(frame).toContain('q quit UI; proxies stay running');

    ui.stdin.write('m');
    ui.stdin.write('d');
    ui.stdin.write('\r');
    ui.stdin.write('q');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEditModels).toHaveBeenCalledWith(row);
    expect(onDelete).toHaveBeenCalledWith(row);
    expect(onUseApps).toHaveBeenCalledWith(row);
    expect(onQuit).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('gives an exact recovery command when a gateway has no API key', () => {
    const ui = render(
      <GatewaysHomeScreen
        rows={[
          {
            name: 'openrouter-work',
            providerId: 'openrouter',
            providerName: 'OpenRouter',
            endpointShort: 'openrouter.ai/api/v1',
            hasApiKey: false,
            usedByApps: [],
            updatedAt: '2026-08-01T00:00:00.000Z',
            updatedRelative: 'now',
          },
        ]}
        selectedIndex={0}
        columns={180}
        onMove={() => {}}
        onAdd={() => {}}
        onUseApps={() => {}}
        onEditModels={() => {}}
        onEditEndpoint={() => {}}
        onDelete={() => {}}
        onSwitch={() => {}}
        onQuit={() => {}}
      />,
    );

    expect(compact(ui.lastFrame())).toContain(
      'anypick gateway edit openrouter-work --api-key <key>',
    );
    ui.unmount();
  });

  it('keeps contextual help aligned with gateway and supervisor behavior', () => {
    const gateways = render(<HelpScreen context="gateways" onBack={() => {}} />);
    const gatewayFrame = compact(gateways.lastFrame());
    expect(gatewayFrame).toContain('m edit gateway model defaults');
    expect(gatewayFrame).toContain('d delete gateway');
    expect(gatewayFrame).toContain('close UI; supervisor and proxies keep running');
    expect(gatewayFrame).not.toContain('d edits gateway-wide role defaults');
    gateways.unmount();

    const proxy = render(<HelpScreen context="proxy" onBack={() => {}} />);
    expect(compact(proxy.lastFrame())).toContain(
      'To stop the supervisor and every proxy: anypick tray stop.',
    );
    proxy.unmount();
  }, 15_000);
});
