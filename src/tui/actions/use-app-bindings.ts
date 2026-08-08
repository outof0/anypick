import type { AnyPickApp } from '../../core/app';
import { parseRef } from '../../core/refs';
import {
  defaultModelRolesForProxy,
  modelDefaultsForSuggestions,
  modelRolesForClient,
  modelRolesFromClientOptions,
  normalizeModelRoles,
  type ModelPolicyLookup,
} from '../../clients/model-roles';
import {
  compatibleAppsForProxy,
  loadAppBindings,
  suggestModelsForGateway,
  type AppBindingRow,
  type ProxyRow,
} from '../model';
import type { ModelSuggestionsSource, ProxyModelsScreenState, Screen } from '../model/screen';
import { describeAppChanges } from '../screens/manage-apps';
import { proxyRef } from '../app-ui-helpers';
import { errorText, type TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';
import type { ModelRoleEditor } from './use-model-role-editor';
import { ensureProxyUp } from './ensure-proxy-up';
import { fetchModelsFromProxyEndpoint, mergeProxyModelSuggestions } from '../proxy-models-fetch';

/** A previously verified setup offered back to the user as a one-key resume. */
export interface SourceResumeCandidate {
  app: AppBindingRow;
  model?: string;
  modelRoles?: Record<string, string>;
  updatedAt: string;
}

export interface AttachTarget {
  clientId: string;
  clientName: string;
  model?: string;
  modelRoles?: Record<string, string>;
}

/**
 * Pointing client apps at a source (a proxy, a pool, or a gateway).
 *
 * This layer is shared by the proxy and gateway domains rather than owned by
 * either: both end in the same "which apps, which models, apply" flow. It
 * depends on `ensureProxyUp` as a plain function so it stays acyclic — the
 * proxy hook consumes these actions, never the reverse.
 */
export interface AppBindingActions {
  /** Canonical source token for a binding: `pool:<id>`, `<id>/<name>`, or a gateway name. */
  bindingWith: (providerId: string, name: string) => string;
  resolveProxyRow: (providerId: string, name: string, fallbackRunning?: boolean) => ProxyRow;
  openModelsForAttach: (opts: {
    providerId: string;
    name: string;
    clientId: string;
    clientName: string;
    queue: Array<{ clientId: string; clientName: string }>;
    detach: AppBindingRow[];
    rolesByClient: Record<string, Record<string, string>>;
    reedit?: boolean;
  }) => void;
  applyAppBindingBatch: (opts: {
    providerId: string;
    name: string;
    attach: AttachTarget[];
    detach: AppBindingRow[];
  }) => Promise<void>;
  sourceResumeFor: (source: string, appRow: AppBindingRow) => SourceResumeCandidate | undefined;
  latestSourceResumeFor: (
    source: string,
    appsForSource: AppBindingRow[],
  ) => SourceResumeCandidate | undefined;
  offerSourceResume: (opts: {
    source: string;
    providerId: string;
    name: string;
    resume: SourceResumeCandidate;
    back: Screen;
  }) => void;
  openAppChangesConfirm: (row: ProxyRow, list: AppBindingRow[], checked: Set<string>) => void;
  /**
   * Reopen the model map for one already-bound client, from an app picker.
   *
   * A no-op unless the client is bound to *this* source: the picker also lists
   * apps pointed elsewhere, and editing those models here would silently write
   * a map for a binding the user is not looking at.
   */
  openModelReedit: (opts: {
    providerId: string;
    name: string;
    source: string;
    apps: AppBindingRow[];
    clientId: string;
  }) => void;
  /** Accept the model map on screen: either advance the queue or apply the batch. */
  commitProxyModels: (screen: ProxyModelsScreenState) => void;
  /** Back out of the model map, to wherever the batch was entered from. */
  cancelProxyModels: (screen: ProxyModelsScreenState) => void;
  refreshProxyModelSuggestions: (providerId: string, name: string, forceRefresh?: boolean) => void;
}

/** The `--with` value a client is bound to for this source. */
function bindingWith(providerId: string, name: string): string {
  // Gateway sources are bare profile names
  if (providerId === 'gateway') {
    return name;
  }
  // Proxy Hub uses hub:name (parseRef accepts hub: / hub/).
  if (providerId === 'proxy-hub') {
    return `hub:${name}`;
  }
  if (name === 'pool' || name === '*') {
    return `pool:${providerId}`;
  }
  return `${providerId}/${name}`;
}

export function useAppBindings(
  app: AnyPickApp,
  shell: TuiShell,
  nav: TuiNav,
  policyLookup: ModelPolicyLookup,
  roleEditor: ModelRoleEditor,
): AppBindingActions {
  const { withBusy, go, setSelectedIndex, setReceipt, reportOk } = shell;
  const { apps, proxyRows, setApps, openGateways, openProxy } = nav;

  /**
   * Model discovery uses the proxy's per-instance token. The token is stored
   * in proxy_state for lifecycle reuse but is intentionally not exposed by
   * proxyStatus (or rendered in the TUI). Passing the placeholder key makes
   * /v1/models return 401, which looks like an empty catalog to the picker.
   */
  const proxyModelListToken = async (
    providerId: string,
    name: string,
  ): Promise<string | undefined> => {
    let accountName = name;
    if (name === 'pool' || name === '*') {
      const pool = await app.proxy.getPool(providerId);
      accountName = pool.members.find((member) => member.enabled)?.account ?? '';
    }
    if (!accountName) {
      return undefined;
    }
    const state = await app.accountStore.readProxyState(providerId, accountName);
    return state?.token;
  };

  const resolveProxyRow = (providerId: string, name: string, fallbackRunning = true): ProxyRow => {
    const live = proxyRows.find(
      (r) =>
        r.providerId === providerId &&
        (r.name === name ||
          (name === 'pool' && r.rowKind === 'pool') ||
          (name === '*' && r.rowKind === 'pool')),
    );
    if (live) {
      return live;
    }
    return {
      providerId,
      name,
      providerName: providerId,
      active: true,
      status: { enabled: true, running: fallbackRunning },
      stateLabel: fallbackRunning ? 'running' : 'enabled-stopped',
      stateText: fallbackRunning ? 'running' : 'stopped',
      endpointText: '—',
      compatibilityText: '—',
      inactiveEnabled: false,
      rowKind: name === 'pool' || name === '*' ? 'pool' : 'account',
    };
  };

  /** Return the last successful setup only when that client still supports this source. */
  const sourceResumeFor = (
    source: string,
    appRow: AppBindingRow,
  ): SourceResumeCandidate | undefined => {
    try {
      const ref = parseRef(source);
      const recent = app.bindings
        .listSourceResumes(ref)
        .find((entry) => entry.client === appRow.clientId);
      if (!recent) {
        return undefined;
      }
      const storedRoles = modelRolesFromClientOptions(recent.spec.clientOptions);
      const explicit = recent.spec.model.mode === 'explicit' ? recent.spec.model.id : undefined;
      const modelRoles =
        storedRoles || explicit
          ? { ...(explicit ? { default: explicit } : {}), ...storedRoles }
          : undefined;
      return {
        app: appRow,
        model: modelRoles?.default ?? explicit,
        modelRoles,
        updatedAt: recent.updatedAt,
      };
    } catch {
      return undefined;
    }
  };

  /** Most recent compatible setup for this source, regardless of client. */
  const latestSourceResumeFor = (
    source: string,
    appsForSource: AppBindingRow[],
  ): SourceResumeCandidate | undefined => {
    try {
      const byClient = new Map(appsForSource.map((appRow) => [appRow.clientId, appRow]));
      const ref = parseRef(source);
      for (const recent of app.bindings.listSourceResumes(ref)) {
        const appRow = byClient.get(recent.client);
        if (!appRow) {
          continue;
        }
        const storedRoles = modelRolesFromClientOptions(recent.spec.clientOptions);
        const explicit = recent.spec.model.mode === 'explicit' ? recent.spec.model.id : undefined;
        const modelRoles =
          storedRoles || explicit
            ? { ...(explicit ? { default: explicit } : {}), ...storedRoles }
            : undefined;
        return {
          app: appRow,
          model: modelRoles?.default ?? explicit,
          modelRoles,
          updatedAt: recent.updatedAt,
        };
      }
    } catch {
      // History is optional; fall through to the normal picker.
    }
    return undefined;
  };

  const openModelsForAttach = (opts: {
    providerId: string;
    name: string;
    clientId: string;
    clientName: string;
    queue: Array<{ clientId: string; clientName: string }>;
    detach: AppBindingRow[];
    rolesByClient: Record<string, Record<string, string>>;
    reedit?: boolean;
    forceRefresh?: boolean;
  }) => {
    void (async () => {
      await withBusy('Loading models', async () => {
        const clientAdapter = app.clients.has(opts.clientId)
          ? app.clients.get(opts.clientId)
          : opts.clientId;
        const defaults = defaultModelRolesForProxy(opts.providerId, clientAdapter, policyLookup);
        let existing: Record<string, string> | undefined;
        try {
          const source = bindingWith(opts.providerId, opts.name);
          const candidate = sourceResumeFor(source, {
            clientId: opts.clientId,
            clientName: opts.clientName,
            bound: false,
          });
          existing =
            candidate?.modelRoles ?? (candidate?.model ? { default: candidate.model } : undefined);
        } catch {
          existing = undefined;
        }

        // Live model list from running proxy /v1/models
        let suggestions: string[] = [];
        let suggestionsSource: ModelSuggestionsSource = 'empty';
        if (opts.providerId !== 'gateway') {
          try {
            const st =
              opts.name === 'pool' || opts.name === '*'
                ? await app.proxy.poolProxyStatus(opts.providerId)
                : await app.proxy.proxyStatus(opts.providerId, opts.name);
            const endpoint = st.endpoint;
            if (endpoint && st.running) {
              const apiKey = await proxyModelListToken(opts.providerId, opts.name);
              const fetched = await fetchModelsFromProxyEndpoint(endpoint, {
                apiKey,
                refresh: opts.forceRefresh,
              });
              const merged = mergeProxyModelSuggestions(opts.providerId, fetched.models, {
                includeStaticFallback: false,
                policy: policyLookup,
              });
              suggestions = merged.suggestions;
              suggestionsSource = merged.source;
            }
            if (suggestions.length === 0) {
              const liveDiscovery = await app.modelDiscovery.list({
                providerId: opts.providerId,
                refresh: opts.forceRefresh,
              });
              if (liveDiscovery.models.length > 0) {
                suggestions = liveDiscovery.models;
                suggestionsSource = liveDiscovery.source;
              } else {
                const merged = mergeProxyModelSuggestions(opts.providerId, [], {
                  includeStaticFallback: true,
                  policy: policyLookup,
                });
                suggestions = merged.suggestions;
                suggestionsSource = merged.source;
              }
            }
          } catch {
            const merged = mergeProxyModelSuggestions(opts.providerId, [], {
              includeStaticFallback: true,
              policy: policyLookup,
            });
            suggestions = merged.suggestions;
            suggestionsSource = merged.source;
          }
        } else {
          // A gateway's ids come from the vendor when it can be asked, because
          // the role defaults below are derived from this list — unlike the
          // gateway model screen, which can open on the catalog and refresh
          // afterwards. This path is already inside `withBusy`.
          let providerId = opts.name;
          let endpoint: string | undefined;
          let apiKey: string | undefined;
          try {
            const p = await app.profiles.get(opts.name);
            providerId = p.meta.provider;
            endpoint = p.meta.endpoint;
            apiKey = p.secrets.apiKey;
          } catch {
            // Unknown profile: the catalog list below is still the right answer.
          }
          const fromCatalog = suggestModelsForGateway(providerId, app.catalog);
          const live = await app.modelDiscovery.list({ providerId, endpoint, apiKey });
          suggestions =
            live.source === 'catalog'
              ? fromCatalog
              : [...new Set([...live.models, ...fromCatalog])];
          suggestionsSource = live.source;
        }

        // Fill empty role defaults from first live model when provider has no template
        const filledDefaults = modelDefaultsForSuggestions(
          opts.providerId,
          defaults,
          suggestions,
          policyLookup,
        );
        const firstModel = suggestions[0];
        if (firstModel) {
          for (const role of modelRolesForClient(clientAdapter)) {
            if (!filledDefaults[role.id]?.trim()) {
              filledDefaults[role.id] = firstModel;
            }
          }
        }
        const values = normalizeModelRoles(existing, filledDefaults);

        go({
          kind: 'proxy-models',
          providerId: opts.providerId,
          name: opts.name,
          clientId: opts.clientId,
          clientName: opts.clientName,
          roles: [...modelRolesForClient(clientAdapter)],
          values,
          suggestions,
          suggestionsSource,
          queue: opts.queue,
          detach: opts.detach,
          rolesByClient: opts.rolesByClient,
          reedit: opts.reedit,
        });
        setSelectedIndex(0);
        roleEditor.reset();
      });
    })();
  };

  const applyAppBindingBatch = async (opts: {
    providerId: string;
    name: string;
    attach: AttachTarget[];
    detach: AppBindingRow[];
  }) => {
    const withSource = bindingWith(opts.providerId, opts.name);
    const isGateway = opts.providerId === 'gateway';
    const row = isGateway ? null : resolveProxyRow(opts.providerId, opts.name);
    const isStopOnly = opts.attach.length === 0 && opts.detach.length === 1;
    const isUseOnly = opts.detach.length === 0 && opts.attach.length >= 1;
    await withBusy('Updating apps', async () => {
      const okNames: string[] = [];
      const failures: Array<{ name: string; reason: string }> = [];
      if (!isGateway && row && !row.status.running && opts.attach.length > 0) {
        await ensureProxyUp(app, row);
      }
      for (const a of opts.attach) {
        try {
          const clientAdapter = app.clients.has(a.clientId)
            ? app.clients.get(a.clientId)
            : a.clientId;
          const defaults = isGateway
            ? defaultModelRolesForProxy('custom', clientAdapter, policyLookup)
            : defaultModelRolesForProxy(opts.providerId, clientAdapter, policyLookup);
          const modelRoles = normalizeModelRoles(a.modelRoles, defaults);
          await app.bindingService.use(a.clientId, {
            with: withSource,
            modelRoles: Object.keys(modelRoles).length ? modelRoles : undefined,
            model: a.model ?? modelRoles.default,
          });
          okNames.push(a.clientName);
        } catch (err) {
          failures.push({ name: a.clientName, reason: errorText(err) });
        }
      }
      for (const a of opts.detach) {
        try {
          await app.bindingService.reset(a.clientId);
          okNames.push(a.clientName);
        } catch (err) {
          failures.push({ name: a.clientName, reason: errorText(err) });
        }
      }
      const failNames = failures.map((failure) => failure.name);
      setApps(loadAppBindings(app));
      if (failNames.length === 0) {
        const msg = isStopOnly
          ? `${opts.detach[0].clientName} no longer uses ${withSource}`
          : isUseOnly
            ? `${okNames.join(' and ')} use${okNames.length === 1 ? 's' : ''} ${withSource}`
            : `Updated ${okNames.join(', ')}`;
        reportOk(msg);
      } else if (okNames.length > 0) {
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'warn',
              text: `${okNames.join(' and ')} updated. ${failNames.join(
                ' and ',
              )} couldn't be updated.`,
            },
            ...failures.map((failure) => ({
              kind: 'fail' as const,
              text: `${failure.name}: ${failure.reason}`,
            })),
          ],
        });
      } else {
        setReceipt({
          title: '',
          lines: [
            {
              kind: 'fail',
              text: `${failNames.join(' and ')} couldn't be updated.`,
            },
            ...failures.map((failure) => ({
              kind: 'fail' as const,
              text: `${failure.name}: ${failure.reason}`,
            })),
          ],
        });
      }
      if (isGateway) {
        await openGateways(withSource);
      } else {
        await openProxy(withSource);
      }
    });
  };

  /**
   * Let Enter resume a verified setup while Esc returns to the explicit picker.
   * The underlying history is only written after successful activation.
   */
  const offerSourceResume = (opts: {
    source: string;
    providerId: string;
    name: string;
    resume: SourceResumeCandidate;
    back: Screen;
  }): void => {
    const { resume } = opts;
    const model = resume.model ?? 'saved default model';
    go({
      kind: 'confirm',
      path: ['proxy', 'resume'],
      title: `Use the last setup for ${opts.source}?`,
      body: [
        `${resume.app.clientName}  ·  ${model}`,
        '',
        'Enter applies it now. Esc lets you choose a different app or model.',
      ],
      confirmLabel: `use ${resume.app.clientName} · ${model}`,
      cancelLabel: 'change setup',
      back: opts.back,
      action: async () => {
        await applyAppBindingBatch({
          providerId: opts.providerId,
          name: opts.name,
          attach: [
            {
              clientId: resume.app.clientId,
              clientName: resume.app.clientName,
              model: resume.model,
              modelRoles: resume.modelRoles,
            },
          ],
          detach: [],
        });
      },
    });
  };

  const openAppChangesConfirm = (row: ProxyRow, list: AppBindingRow[], checked: Set<string>) => {
    const withSource = proxyRef(row);
    const { attach, detach, body } = describeAppChanges(withSource, list, checked);
    if (attach.length === 0 && detach.length === 0) {
      return;
    }
    const isStopOnly = attach.length === 0 && detach.length === 1;
    const isUseOnly = detach.length === 0 && attach.length >= 1;
    if (isUseOnly && attach.length === 1) {
      const resume = sourceResumeFor(withSource, attach[0]);
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
            apps: list,
            checked: [...checked],
          },
        });
        return;
      }
    }
    const title = isStopOnly
      ? `Stop using ${withSource} with ${detach[0].clientName}?`
      : isUseOnly
        ? attach.length === 1
          ? `Use ${withSource} with ${attach[0].clientName}?`
          : 'Update app setup?'
        : 'Update app setup?';
    go({
      kind: 'confirm',
      path: ['proxy', 'apps'],
      title,
      body: [
        ...body,
        '',
        row.status.running ? 'The proxy is already running.' : 'The proxy will start if needed.',
        isStopOnly
          ? "Other apps won't change."
          : attach.length
            ? 'Next you can set models for each app.'
            : '',
      ].filter(Boolean),
      confirmLabel: 'confirm',
      back: {
        kind: 'manage-apps',
        providerId: row.providerId,
        name: row.name,
        apps: list,
        checked: [...checked],
      },
      action: async () => {
        if (attach.length === 0) {
          await applyAppBindingBatch({
            providerId: row.providerId,
            name: row.name,
            attach: [],
            detach,
          });
          return;
        }
        // Model map for first attach app, then queue the rest
        const [first, ...rest] = attach;
        openModelsForAttach({
          providerId: row.providerId,
          name: row.name,
          clientId: first.clientId,
          clientName: first.clientName,
          queue: rest.map((a) => ({ clientId: a.clientId, clientName: a.clientName })),
          detach,
          rolesByClient: {},
        });
      },
    });
  };

  const openModelReedit = (opts: {
    providerId: string;
    name: string;
    source: string;
    apps: AppBindingRow[];
    clientId: string;
  }) => {
    const appRow = opts.apps.find((a) => a.clientId === opts.clientId);
    if (!appRow?.bound || appRow.sourceDisplay !== opts.source) {
      return;
    }
    openModelsForAttach({
      providerId: opts.providerId,
      name: opts.name,
      clientId: appRow.clientId,
      clientName: appRow.clientName,
      queue: [],
      detach: [],
      rolesByClient: {},
      reedit: true,
    });
  };

  const commitProxyModels = (screen: ProxyModelsScreenState) => {
    // The values on screen are the user's; re-deriving defaults here would
    // overwrite a deliberate edit with a template for the wrong client.
    const rolesByClient = {
      ...screen.rolesByClient,
      [screen.clientId]: normalizeModelRoles(screen.values, screen.values),
    };
    if (screen.queue.length > 0) {
      const [next, ...rest] = screen.queue;
      openModelsForAttach({
        providerId: screen.providerId,
        name: screen.name,
        clientId: next.clientId,
        clientName: next.clientName,
        queue: rest,
        detach: screen.detach,
        rolesByClient,
      });
      return;
    }
    const attach = Object.entries(rolesByClient).map(([clientId, modelRoles]) => ({
      clientId,
      clientName:
        clientId === screen.clientId
          ? screen.clientName
          : (apps.find((a) => a.clientId === clientId)?.clientName ?? clientId),
      modelRoles,
    }));
    void applyAppBindingBatch({
      providerId: screen.providerId,
      name: screen.name,
      attach,
      // A re-edit touches one client's models only; the detach list belongs to
      // the batch that opened this screen.
      detach: screen.reedit ? [] : screen.detach,
    });
  };

  const cancelProxyModels = (screen: ProxyModelsScreenState) => {
    roleEditor.reset();
    if (screen.providerId === 'gateway') {
      void openGateways(screen.name);
      return;
    }
    if (screen.reedit) {
      void openProxy(
        screen.name === 'pool'
          ? `pool:${screen.providerId}`
          : `${screen.providerId}/${screen.name}`,
      );
      return;
    }
    // Mid-batch, so step back to the app picker the batch came from.
    void (async () => {
      const compatible = await compatibleAppsForProxy(app, screen.providerId, screen.name);
      const withSource = bindingWith(screen.providerId, screen.name);
      go({
        kind: 'manage-apps',
        providerId: screen.providerId,
        name: screen.name,
        apps: compatible,
        checked: compatible
          .filter((a) => a.bound && a.sourceDisplay === withSource)
          .map((a) => a.clientId),
      });
      setSelectedIndex(0);
    })();
  };

  const refreshProxyModelSuggestions = (providerId: string, name: string, forceRefresh = false) => {
    if (shell.screen.kind !== 'proxy-models') {
      return;
    }
    const s = shell.screen;
    openModelsForAttach({
      providerId,
      name,
      clientId: s.clientId,
      clientName: s.clientName,
      queue: s.queue ?? [],
      detach: s.detach ?? [],
      rolesByClient: s.rolesByClient ?? {},
      reedit: s.reedit,
      forceRefresh,
    });
  };

  return {
    bindingWith,
    resolveProxyRow,
    openModelsForAttach,
    applyAppBindingBatch,
    sourceResumeFor,
    latestSourceResumeFor,
    offerSourceResume,
    openAppChangesConfirm,
    openModelReedit,
    commitProxyModels,
    cancelProxyModels,
    refreshProxyModelSuggestions,
  };
}
