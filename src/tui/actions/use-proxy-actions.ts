import type { AnyPickApp } from '../../core/app';
import {
  appsUsingProxy,
  compatibleAppsForProxy,
  loadAppBindings,
  loadProxyHubView,
  type ProxyHubSourceRow,
  type ProxyRow,
} from '../model';
import { proxyRef } from '../app-ui-helpers';
import type { TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';
import type { AppBindingActions } from './use-app-bindings';
import { ensureProxyUp } from './ensure-proxy-up';
import { serializeRef } from '../../core/refs';

/**
 * Proxy board row actions.
 *
 * `doProxyPrimary` is what enter does on a stopped row; the rest are the
 * single-key operations. Starting a proxy can chain into app setup, so this
 * depends on `AppBindingActions` — never the reverse.
 */
export interface ProxyActions {
  doProxyPrimary: (row: ProxyRow) => Promise<void>;
  doProxyRestart: (row: ProxyRow) => Promise<void>;
  doProxyStop: (row: ProxyRow) => Promise<void>;
  doProxyEnableStart: (row: ProxyRow) => Promise<void>;
  doProxyDisable: (row: ProxyRow) => Promise<void>;
  doProxyLogs: (row: ProxyRow) => Promise<void>;
  doManageApps: (row: ProxyRow) => Promise<void>;
  doTogglePoolMulti: (row: ProxyRow) => Promise<void>;
  doTogglePoolMember: (row: ProxyRow) => Promise<void>;
  doToggleQuotaGuard: (row: ProxyRow) => Promise<void>;
  openHub: () => Promise<void>;
  doToggleHubSource: (source: ProxyHubSourceRow) => Promise<void>;
  doStartHub: () => Promise<void>;
  doStopHub: () => Promise<void>;
  doRefreshHub: () => Promise<void>;
}

export function useProxyActions(
  app: AnyPickApp,
  shell: TuiShell,
  nav: TuiNav,
  bindings: AppBindingActions,
): ProxyActions {
  const { go, setSelectedIndex, withBusy, setReceipt, reportOk, reportFail } = shell;
  const { apps, setApps, openProxy } = nav;
  const { openModelsForAttach, latestSourceResumeFor, offerSourceResume, openAppChangesConfirm } =
    bindings;

  const reloadHub = async () => {
    const view = await loadProxyHubView(app);
    go({ kind: 'proxy-hub', view });
    setSelectedIndex(0);
  };

  const openHub = async () => {
    await withBusy('Loading Proxy Hub', reloadHub);
  };

  const doToggleHubSource = async (source: ProxyHubSourceRow) => {
    await withBusy(`Updating ${source.label}`, async () => {
      try {
        const config = await app.hub.get();
        const existing = config.sources.find(
          (entry) => serializeRef(entry.ref) === serializeRef(source.ref),
        );
        const sources = existing
          ? config.sources.map((entry) =>
              entry === existing ? { ...entry, enabled: !entry.enabled } : entry,
            )
          : [...config.sources, { ref: source.ref, enabled: true }];
        await app.hub.setSources(config.name, sources);
        await reloadHub();
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const doStartHub = async () => {
    await withBusy('Starting Proxy Hub', async () => {
      try {
        const config = await app.hub.get();
        if (!config.sources.some((source) => source.enabled)) {
          setReceipt({
            title: '',
            lines: [
              {
                kind: 'warn',
                text: 'Enable at least one saved account before starting Proxy Hub.',
              },
            ],
          });
          return;
        }
        if (!config.enabled) {
          await app.hub.save({ ...config, enabled: true });
        }
        const started = await app.hub.ensureRunning(config.name);
        reportOk(`Proxy Hub running at ${started.endpoint}`);
        await reloadHub();
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const doStopHub = async () => {
    await withBusy('Stopping Proxy Hub', async () => {
      try {
        await app.hub.stop();
        reportOk('Proxy Hub stopped. App routes remain saved.');
        await reloadHub();
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const doRefreshHub = async () => {
    await withBusy('Refreshing Proxy Hub models', async () => {
      try {
        await reloadHub();
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const doProxyPrimary = async (row: ProxyRow) => {
    if (row.status.running) {
      return;
    }
    if (row.rowKind === 'unsaved' || row.rowKind === 'member') {
      return;
    }
    if (row.needsApiKey) {
      setReceipt({
        title: '',
        lines: [
          {
            kind: 'warn',
            text:
              row.attentionHint ??
              `${proxyRef(
                row,
              )} needs GEMINI_API_KEY. Add it to ~/.gemini/.env, save the login again, then start the proxy.`,
          },
        ],
      });
      return;
    }
    await withBusy(`Starting ${proxyRef(row)}`, async () => {
      try {
        const started = await ensureProxyUp(app, row);
        const ref = proxyRef(row);
        const refreshedApps = loadAppBindings(app);
        setApps(refreshedApps);
        const savedApps = refreshedApps.filter(
          (candidate) => candidate.bound && candidate.sourceDisplay === ref,
        );
        const restoredIds = new Set(started.realignedClients ?? []);
        const restoredApps =
          started.realignedClients == null
            ? savedApps
            : savedApps.filter((candidate) => restoredIds.has(candidate.clientId));
        const restoredNames = restoredApps.map((candidate) => candidate.clientName);
        const needsSetup =
          savedApps.length === 0 || (started.realignedClients != null && restoredApps.length === 0);
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'ok',
              text: !needsSetup
                ? `Proxy running for ${ref}. Restored ${restoredNames.join(
                    ' and ',
                  )} with saved models.`
                : `Proxy running for ${ref}`,
            },
          ],
        });
        await openProxy(ref);
        // Existing bindings are durable and startProxy already realigned their
        // endpoint/token/model settings. Only open setup for a source that has
        // never been applied to an app.
        if (needsSetup) {
          await doManageApps({
            ...row,
            status: { ...row.status, running: true, enabled: true },
          });
        }
      } catch {
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'fail',
              text: "Proxy didn't start. Press l for logs or enter to retry.",
            },
          ],
        });
        await openProxy(proxyRef(row));
      }
    });
  };

  const doProxyRestart = async (row: ProxyRow) => {
    await withBusy(`Restarting ${proxyRef(row)}`, async () => {
      try {
        if (row.status.running) {
          if (row.rowKind === 'pool') {
            await app.proxy.stopPoolProxy(row.providerId);
          } else {
            await app.proxy.stopProxy(row.providerId, row.name);
          }
        }
        await ensureProxyUp(app, row);
        reportOk(`Proxy running again for ${proxyRef(row)}`);
        await openProxy(proxyRef(row));
      } catch {
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'fail',
              text: "Proxy didn't start. Press l for logs or enter to retry.",
            },
          ],
        });
        await openProxy(proxyRef(row));
      }
    });
  };

  const doProxyStop = async (row: ProxyRow) => {
    const ref = proxyRef(row);
    const appsUsing = appsUsingProxy(apps, ref);
    if (appsUsing.length > 0) {
      go({
        kind: 'confirm',
        path: 'proxy',
        title: `Stop ${ref}?`,
        body: [
          `${appsUsing[0]} currently uses this proxy.`,
          `${appsUsing[0]} may stop working until you start it again.`,
        ],
        confirmLabel: 'stop',
        back: { kind: 'proxy', focusRef: ref },
        action: async () => {
          await withBusy(`Stopping ${ref}`, async () => {
            if (row.rowKind === 'pool') {
              await app.proxy.stopPoolProxy(row.providerId);
            } else {
              await app.proxy.stopProxy(row.providerId, row.name);
            }
            reportOk(`Proxy stopped for ${ref}`);
            await openProxy(ref);
          });
        },
      });
      return;
    }
    await withBusy(`Stopping ${ref}`, async () => {
      try {
        if (row.rowKind === 'pool') {
          await app.proxy.stopPoolProxy(row.providerId);
        } else {
          await app.proxy.stopProxy(row.providerId, row.name);
        }
        reportOk(`Proxy stopped for ${ref}`);
        await openProxy(ref);
      } catch (err) {
        reportFail(err);
        await openProxy(ref);
      }
    });
  };

  const doProxyEnableStart = async (row: ProxyRow) => {
    if (row.rowKind === 'pool') {
      await withBusy(`Starting pool:${row.providerId}`, async () => {
        try {
          const { started } = await app.proxy.enablePoolMulti(row.providerId, {
            port: row.status.port,
            start: true,
          });
          setReceipt({
            title: '',
            lines: [
              {
                kind: 'ok',
                text: started?.endpoint
                  ? `Pool running  ${started.endpoint}`
                  : `Pool multi on for ${row.providerId}`,
              },
            ],
          });
          await openProxy(`pool:${row.providerId}`);
        } catch (err) {
          reportFail(err);
        }
      });
      return;
    }
    await doProxyPrimary(row);
  };

  const doProxyDisable = async (row: ProxyRow) => {
    const ref = proxyRef(row);
    const appsUsing = appsUsingProxy(apps, ref);
    if (row.rowKind === 'pool') {
      go({
        kind: 'confirm',
        path: 'proxy',
        title: `Turn off multi pool for ${row.providerId}?`,
        body: [
          'Back to one proxy process per account (default).',
          appsUsing.length
            ? `${appsUsing.join(' and ')} may need a new setup.`
            : 'App settings are not reset automatically.',
        ],
        confirmLabel: 'use single-account mode',
        back: { kind: 'proxy', focusRef: ref },
        action: async () => {
          await withBusy(`Turning off ${ref}`, async () => {
            await app.proxy.disablePoolMulti(row.providerId);
            reportOk(`${row.providerId} pool → single-account`);
            await openProxy();
          });
        },
      });
      return;
    }
    if (appsUsing.length > 0) {
      go({
        kind: 'confirm',
        path: 'proxy',
        title: `Turn off ${ref}?`,
        body: [
          `${appsUsing[0]} currently uses this proxy.`,
          `${appsUsing[0]} may stop working until you change its setup.`,
        ],
        confirmLabel: 'turn off',
        back: { kind: 'proxy', focusRef: ref },
        action: async () => {
          await withBusy(`Turning off ${ref}`, async () => {
            await app.proxy.disableProxy(row.providerId, row.name);
            reportOk(`Proxy off for ${ref}`);
            await openProxy(ref);
          });
        },
      });
      return;
    }
    await withBusy(`Turning off ${ref}`, async () => {
      try {
        await app.proxy.disableProxy(row.providerId, row.name);
        reportOk(`Proxy off for ${ref}`);
        await openProxy(ref);
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const doProxyLogs = async (row: ProxyRow) => {
    await withBusy('Reading proxy logs', async () => {
      try {
        const accountName =
          row.rowKind === 'pool'
            ? (await app.proxy.getPool(row.providerId)).members.find((m) => m.enabled)?.account
            : row.name;
        if (!accountName) {
          setReceipt({
            title: '',
            lines: [{ kind: 'warn', text: 'Enable a pool account before viewing proxy logs.' }],
          });
          return;
        }
        const text = await app.proxy.proxyLogs(row.providerId, accountName, 80);
        go({
          kind: 'proxy-logs',
          providerId: row.providerId,
          name: accountName,
          text: text || 'No logs yet.',
          running: row.status.running,
        });
      } catch {
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'fail',
              text: "Couldn't read logs. Press f to retry.",
            },
          ],
        });
      }
    });
  };

  /** Resolve an account name for transport discovery (pool → first member). */
  const accountNameForApps = async (row: ProxyRow): Promise<string | null> => {
    if (row.rowKind === 'pool') {
      const pool = await app.proxy.getPool(row.providerId);
      return pool.members.find((m) => m.enabled)?.account ?? pool.members[0]?.account ?? null;
    }
    if (row.rowKind === 'unsaved' || row.name === '__unsaved__') {
      return null;
    }
    return row.name;
  };

  /** Open manage-apps picker for this proxy (Claude, Codex, …). */
  const doManageApps = async (row: ProxyRow) => {
    const withSource = proxyRef(row);
    await withBusy('Looking for supported apps', async () => {
      const accountName = await accountNameForApps(row);
      if (!accountName) {
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'info',
              text: 'Save a login for this tool first, then enable its proxy.',
            },
          ],
        });
        return;
      }
      const compatible = await compatibleAppsForProxy(app, row.providerId, accountName);
      if (compatible.length === 0) {
        go({
          kind: 'confirm',
          path: ['proxy', 'apps'],
          title: 'No supported apps were found.',
          body: ['Run a supported app once, then check again.'],
          confirmLabel: 'check again',
          back: { kind: 'proxy', focusRef: withSource },
          action: async () => {
            await doManageApps(row);
          },
        });
        return;
      }
      // Initialize checked only for apps already using this proxy
      const checked = compatible
        .filter((a) => a.bound && a.sourceDisplay === withSource)
        .map((a) => a.clientId);
      if (checked.length === 0) {
        const resume = latestSourceResumeFor(withSource, compatible);
        if (resume) {
          offerSourceResume({
            source: withSource,
            providerId: row.providerId,
            name: row.rowKind === 'pool' ? 'pool' : row.name,
            resume,
            back: {
              kind: 'manage-apps',
              providerId: row.providerId,
              name: row.rowKind === 'pool' ? 'pool' : row.name,
              apps: compatible,
              checked: [],
            },
          });
          return;
        }
      }
      // Single app already using → open model map (not detach)
      if (compatible.length === 1) {
        const only = compatible[0];
        const already = only.bound && only.sourceDisplay === withSource;
        if (already) {
          openModelsForAttach({
            providerId: row.providerId,
            name: row.rowKind === 'pool' ? 'pool' : row.name,
            clientId: only.clientId,
            clientName: only.clientName,
            queue: [],
            detach: [],
            rolesByClient: {},
            reedit: true,
          });
          return;
        }
        openAppChangesConfirm(row, compatible, new Set([only.clientId]));
        return;
      }
      go({
        kind: 'manage-apps',
        providerId: row.providerId,
        name: row.rowKind === 'pool' ? 'pool' : row.name,
        apps: compatible,
        checked,
      });
      setSelectedIndex(0);
    });
  };

  /**
   * Flip a provider between one proxy per account and a single pooled proxy.
   *
   * Turning multi on starts the pool immediately, because the endpoint it prints
   * is the only thing the user can act on next.
   */
  const doTogglePoolMulti = async (row: ProxyRow) => {
    try {
      const pool = await app.proxy.getPool(row.providerId);
      if (pool.mode === 'multi') {
        await app.proxy.disablePoolMulti(row.providerId);
        reportOk(`${row.providerId} → single-account proxies`);
      } else {
        const { started } = await app.proxy.enablePoolMulti(row.providerId, { start: true });
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'ok',
              text: started?.endpoint
                ? `Multi pool on  ${started.endpoint}`
                : `Multi pool on for ${row.providerId}`,
            },
          ],
        });
      }
      await openProxy();
    } catch (err) {
      reportFail(err);
    }
  };

  const doTogglePoolMember = async (row: ProxyRow) => {
    try {
      const next = !(row.memberEnabled ?? true);
      await app.proxy.setPoolMemberEnabled(row.providerId, row.name, next);
      setReceipt({
        title: '',
        lines: [
          {
            kind: 'ok',
            text: next
              ? `${row.providerId}/${row.name} in pool`
              : `${row.providerId}/${row.name} paused`,
          },
        ],
      });
      await openProxy();
    } catch (err) {
      reportFail(err);
    }
  };

  const doToggleQuotaGuard = async (row: ProxyRow) => {
    if (row.rowKind !== 'pool') {
      return;
    }
    try {
      const enabled = !row.quotaGuardEnabled;
      await app.config.setQuotaGuardEnabled(enabled);
      await app.proxy.restartRunningPools();
      reportOk(
        enabled
          ? 'Quota Guard on · only confirmed account quota errors can fail over.'
          : 'Quota Guard off · native logins were not changed.',
      );
      await openProxy(`pool:${row.providerId}`);
    } catch (err) {
      reportFail(err);
    }
  };

  return {
    doProxyPrimary,
    doProxyRestart,
    doProxyStop,
    doProxyEnableStart,
    doProxyDisable,
    doProxyLogs,
    doManageApps,
    doTogglePoolMulti,
    doTogglePoolMember,
    doToggleQuotaGuard,
    openHub,
    doToggleHubSource,
    doStartHub,
    doStopHub,
    doRefreshHub,
  };
}
