import React from 'react';
import type { AnyPickApp } from '../core/app';
import { buildClientRows, type ClientRow } from '../cli/launcher-model';
import {
  buildAnyPickPreview,
  formatUsageSummary,
  anypickContextFromPreview,
  anypickContextLines,
  loadAppBindings,
  loadGateways,
  loadAnyPickHome,
  loadProxyOverview,
  loadProxyHubView,
  type AccountDetailModel,
  type AppBindingRow,
  type GatewayRow,
  type AnyPickHomeModel,
  type AnyPickPreviewModel,
  type ProxyRow,
} from './model';
import type { CatalogPickRow } from './screens/gateway-pick-provider';
import { clampIndex, indexOfProxy, indexOfRef } from './app-ui-helpers';
import { errorText, type TuiShell } from './use-tui-shell';

/**
 * The screen models every domain reads, plus the four `open*` entry points that
 * load a board and navigate to it.
 *
 * Domain hooks depend on this and never on each other's loaders, which is what
 * keeps them acyclic: a gateway action can refresh the proxy board without the
 * proxy hook having to know gateways exist.
 */
export interface TuiNav {
  clientRows: ClientRow[];
  home: AnyPickHomeModel | null;
  proxyRows: ProxyRow[];
  gatewayRows: GatewayRow[];
  catalogPicks: CatalogPickRow[];
  setCatalogPicks: React.Dispatch<React.SetStateAction<CatalogPickRow[]>>;
  apps: AppBindingRow[];
  setApps: React.Dispatch<React.SetStateAction<AppBindingRow[]>>;
  preview: AnyPickPreviewModel | null;
  setPreview: React.Dispatch<React.SetStateAction<AnyPickPreviewModel | null>>;
  accountDetail: AccountDetailModel | null;
  setAccountDetail: React.Dispatch<React.SetStateAction<AccountDetailModel | null>>;
  liveUsageSummary: string | undefined;
  contextLines: string[] | undefined;
  reloadHome: (focusRef?: string) => Promise<AnyPickHomeModel>;
  reloadClients: (focusClientId?: string) => Promise<ClientRow[]>;
  reloadProxies: (focusRef?: string) => Promise<ProxyRow[]>;
  openSwitch: (focusRef?: string) => Promise<void>;
  openApps: (focusClientId?: string) => Promise<void>;
  openProxy: (focusRef?: string) => Promise<void>;
  openAccounts: (focusRef?: string) => Promise<void>;
  openGateways: (focusName?: string) => Promise<void>;
}

function appRoutingRows(app: AnyPickApp, rows: ClientRow[]): ClientRow[] {
  const routeClientIds = new Set(
    app.clients
      .list()
      .filter((client) => client.routingSurfacePolicy === 'all-compatible')
      .map((client) => client.id),
  );
  return rows.filter((row) => routeClientIds.has(row.clientId));
}

export function useTuiNav(app: AnyPickApp, shell: TuiShell): TuiNav {
  const { screen, go, busy, withBusy, selectedIndex, setSelectedIndex } = shell;

  const [home, setHome] = React.useState<AnyPickHomeModel | null>(null);
  const [clientRows, setClientRows] = React.useState<ClientRow[]>([]);
  const [proxyRows, setProxyRows] = React.useState<ProxyRow[]>([]);
  const [gatewayRows, setGatewayRows] = React.useState<GatewayRow[]>([]);
  const [catalogPicks, setCatalogPicks] = React.useState<CatalogPickRow[]>([]);
  const [apps, setApps] = React.useState<AppBindingRow[]>([]);
  const [preview, setPreview] = React.useState<AnyPickPreviewModel | null>(null);
  const [accountDetail, setAccountDetail] = React.useState<AccountDetailModel | null>(null);
  const [liveUsageSummary, setLiveUsageSummary] = React.useState<string | undefined>();
  const [contextLines, setContextLines] = React.useState<string[] | undefined>();

  const reloadHome = React.useCallback(
    async (focusRef?: string) => {
      const model = await loadAnyPickHome(app);
      setHome(model);
      setSelectedIndex(indexOfRef(model.rows, focusRef));
      return model;
    },
    [app, setSelectedIndex],
  );

  const reloadClients = React.useCallback(
    async (focusClientId?: string) => {
      const rows = appRoutingRows(app, await buildClientRows(app));
      setClientRows(rows);
      const idx = focusClientId ? rows.findIndex((row) => row.clientId === focusClientId) : 0;
      setSelectedIndex(idx >= 0 ? idx : 0);
      return rows;
    },
    [app, setSelectedIndex],
  );

  // Preserve selection across quiet live re-probes
  const homeRef = React.useRef(home);
  const selectedIndexRef = React.useRef(selectedIndex);
  homeRef.current = home;
  selectedIndexRef.current = selectedIndex;

  /** Quiet re-probe of live auth (detectLive) without busy chrome. */
  const syncLive = React.useCallback(async () => {
    try {
      const prev = homeRef.current;
      const prevRef = prev?.rows[selectedIndexRef.current]?.ref;
      const model = await loadAnyPickHome(app);
      setHome(model);
      if (prevRef) {
        setSelectedIndex(indexOfRef(model.rows, prevRef));
      } else {
        setSelectedIndex((i) => clampIndex(i, model.rows.length));
      }
    } catch {
      // keep last good frame
    }
  }, [app, setSelectedIndex]);

  const reloadProxies = React.useCallback(
    async (focusRef?: string) => {
      const rows = await loadProxyOverview(app);
      setProxyRows(rows);
      setApps(loadAppBindings(app));
      setSelectedIndex(indexOfProxy(rows, focusRef));
      return rows;
    },
    [app, setSelectedIndex],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const requested = process.env.ANYPICK_TUI_SCREEN;
        const [model, clients, initialProxies, initialGateways, initialHub] = await Promise.all([
          loadAnyPickHome(app),
          buildClientRows(app),
          requested === 'proxy' ? loadProxyOverview(app) : Promise.resolve([]),
          requested === 'gateways' || requested === 'add-gateway'
            ? loadGateways(app)
            : Promise.resolve([]),
          requested === 'proxy-hub' ? loadProxyHubView(app) : Promise.resolve(null),
        ]);
        if (cancelled) {
          return;
        }
        setHome(model);
        setClientRows(appRoutingRows(app, clients));
        if (requested === 'accounts' || requested === 'add-account') {
          go({ kind: 'accounts' });
        } else if (requested === 'gateways' || requested === 'add-gateway') {
          setGatewayRows(initialGateways);
          setApps(loadAppBindings(app));
          go({ kind: 'gateways' });
        } else if (requested === 'proxy') {
          setProxyRows(initialProxies);
          setApps(loadAppBindings(app));
          go({ kind: 'proxy' });
        } else if (requested === 'proxy-hub' && initialHub) {
          go({ kind: 'proxy-hub', view: initialHub });
        } else {
          go({ kind: 'apps' });
        }
        setSelectedIndex(0);
      } catch (err) {
        if (cancelled) {
          return;
        }
        go({
          kind: 'message',
          msg: `Failed to load: ${errorText(err)}`,
          back: { kind: 'apps' },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, go, setSelectedIndex]);

  // Re-run detectLive while browsing Switch/Accounts so status tracks the
  // real tool login, not a stale DB snapshot.
  React.useEffect(() => {
    if (screen.kind !== 'anypick' && screen.kind !== 'accounts') {
      return;
    }
    if (busy) {
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) {
        return;
      }
      void syncLive();
    };
    const id = setInterval(tick, 2500);
    // One immediate re-probe when entering the screen
    const first = setTimeout(tick, 400);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(first);
    };
  }, [screen.kind, busy, syncLive]);

  // Load live usage for the account currently serving (active + live match).
  // Keyed by provider so moving the cursor between rows doesn't refetch; only a
  // change of which provider is live triggers a new fetch.
  const liveProviderId =
    screen.kind === 'anypick'
      ? home?.rows.find((r) => r.active && r.isLiveMatch)?.providerId
      : undefined;
  React.useEffect(() => {
    if (!liveProviderId) {
      setLiveUsageSummary(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const usage = await app.accounts.liveUsage(liveProviderId);
        if (!cancelled) {
          setLiveUsageSummary(formatUsageSummary(usage?.windows) || undefined);
        }
      } catch {
        if (!cancelled) {
          setLiveUsageSummary(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, liveProviderId]);

  // Debounced plan preview into CONTEXT pane (V2 progressive disclosure)
  React.useEffect(() => {
    if (screen.kind !== 'anypick' || !home) {
      return;
    }
    const row = home.rows[selectedIndex];
    if (!row) {
      setContextLines(undefined);
      return;
    }
    setContextLines(anypickContextLines(row));
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const p = await buildAnyPickPreview(app, row.providerId, row.name);
          if (cancelled) {
            return;
          }
          setContextLines(anypickContextFromPreview(row, p));
        } catch {
          // keep static context
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [app, screen.kind, home, selectedIndex]);

  const openSwitch = async (focusRef?: string) => {
    await withBusy('Loading saved logins', async () => {
      await reloadHome(focusRef);
      go({ kind: 'anypick', focusRef });
    });
  };

  const openApps = async (focusClientId?: string) => {
    await withBusy('Loading apps', async () => {
      await reloadClients(focusClientId);
      go({ kind: 'apps', focusClientId });
    });
  };

  const openProxy = async (focusRef?: string) => {
    await withBusy('Loading proxies', async () => {
      await reloadProxies(focusRef);
      go({ kind: 'proxy', focusRef });
    });
  };

  const openAccounts = async (focusRef?: string) => {
    await withBusy('Loading saved logins', async () => {
      await reloadHome(focusRef);
      go({ kind: 'accounts', focusRef });
    });
  };

  const openGateways = async (focusName?: string) => {
    await withBusy('Loading gateways', async () => {
      const rows = await loadGateways(app);
      setGatewayRows(rows);
      setApps(loadAppBindings(app));
      go({ kind: 'gateways', focusName });
      const idx = focusName ? rows.findIndex((r) => r.name === focusName) : 0;
      setSelectedIndex(idx >= 0 ? idx : 0);
    });
  };

  return {
    clientRows,
    home,
    proxyRows,
    gatewayRows,
    catalogPicks,
    setCatalogPicks,
    apps,
    setApps,
    preview,
    setPreview,
    accountDetail,
    setAccountDetail,
    liveUsageSummary,
    contextLines,
    reloadHome,
    reloadClients,
    reloadProxies,
    openSwitch,
    openApps,
    openProxy,
    openAccounts,
    openGateways,
  };
}
