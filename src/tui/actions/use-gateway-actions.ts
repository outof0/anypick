import React from 'react';
import type { AnyPickApp } from '../../core/app';
import { normalizeModelRoles } from '../../clients/model-roles';
import {
  compatibleAppsForGateway,
  gatewayProfileModelRoles,
  loadAppBindings,
  suggestModelsForGateway,
  type AppBindingRow,
  type GatewayRow,
} from '../model';
import type { CatalogPickRow } from '../screens/gateway-pick-provider';
import type {
  GatewayConnectionScreen,
  GatewayModelsScreen,
  ModelSuggestionsSource,
} from '../model/screen';
import type { TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';
import type { AppBindingActions } from './use-app-bindings';
import type { ModelRoleEditor } from './use-model-role-editor';

export interface GatewayCreateDraft {
  providerId: string;
  name: string;
  endpoint?: string;
  apiKey?: string;
  models: Record<string, string>;
}

/**
 * Gateway lifecycle: pick a catalog provider, create, edit model roles, and
 * point apps at the result.
 *
 * Consumes `AppBindingActions` for anything that ends in a client binding, so
 * the gateway and proxy domains stay siblings instead of one importing the
 * other.
 */
export interface GatewayActions {
  startGatewayCreate: () => void;
  openGatewayModels: (name: string) => Promise<void>;
  /** Re-ask the vendor for this gateway's model list (the `r` key). */
  refreshGatewayModelSuggestions: (name: string, refresh?: boolean) => Promise<void>;
  openGatewayApps: (name: string) => Promise<void>;
  saveGatewayModels: (
    name: string,
    values: Record<string, string>,
    reapply: boolean,
  ) => Promise<void>;
  finishGatewayCreate: (draft: GatewayCreateDraft) => Promise<void>;
  applyGatewayAppChanges: (
    gatewayName: string,
    list: AppBindingRow[],
    checked: Set<string>,
  ) => Promise<void>;
  startEditEndpoint: (row: GatewayRow) => void;
  confirmDeleteGateway: (row: GatewayRow) => void;
  /** Connection form accepted: hold the draft and go pick model roles. */
  submitGatewayConnection: (
    screen: GatewayConnectionScreen,
    form: { endpoint?: string; apiKey?: string },
  ) => void;
  /** True while a create is mid-flight, which is what makes the model step say "create". */
  hasPendingGatewayCreate: boolean;
  commitGatewayModels: (screen: GatewayModelsScreen) => void;
  cancelGatewayModels: (screen: GatewayModelsScreen) => void;
}

export function useGatewayActions(
  app: AnyPickApp,
  shell: TuiShell,
  nav: TuiNav,
  bindings: AppBindingActions,
  roleEditor: ModelRoleEditor,
): GatewayActions {
  const { go, replaceScreen, setSelectedIndex, withBusy, setReceipt, reportOk, reportFail } = shell;
  const { setCatalogPicks, setApps, openGateways } = nav;
  const {
    openModelsForAttach,
    applyAppBindingBatch,
    sourceResumeFor,
    latestSourceResumeFor,
    offerSourceResume,
  } = bindings;

  /**
   * Suggestions for a gateway, merged with what the vendor actually serves.
   *
   * The catalog list comes first and unconditionally, so the screen can open
   * without waiting on the network; the live ids are then prepended, since the
   * picker treats the head of the list as the default. `undefined` endpoint means
   * the profile never stored one, in which case discovery falls back to the
   * provider's default endpoint.
   */
  const gatewaySuggestions = async (
    providerId: string,
    opts: { endpoint?: string; apiKey?: string; refresh?: boolean } = {},
  ): Promise<{ suggestions: string[]; source: ModelSuggestionsSource }> => {
    const fromCatalog = suggestModelsForGateway(providerId, app.catalog);
    const live = await app.modelDiscovery.list({
      providerId,
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      refresh: opts.refresh,
    });
    if (live.source === 'catalog') {
      return { suggestions: fromCatalog, source: 'catalog' };
    }
    return {
      suggestions: [...new Set([...live.models, ...fromCatalog])],
      source: live.source,
    };
  };

  const startGatewayCreate = () => {
    const picks: CatalogPickRow[] = app.catalog.list().map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      defaultEndpoint: c.defaultEndpoint,
    }));
    setCatalogPicks(picks);
    setSelectedIndex(0);
    go({ kind: 'gateway-pick-provider' });
  };

  const openGatewayModels = async (name: string) => {
    try {
      const profile = await app.profiles.get(name);
      const values = gatewayProfileModelRoles(profile, app.catalog);
      // Open on the catalog list first: discovery may need a round trip, and a
      // screen that waits for the network before drawing looks frozen.
      go({
        kind: 'gateway-models',
        name,
        values: normalizeModelRoles(values, values),
        suggestions: suggestModelsForGateway(profile.meta.provider, app.catalog),
        suggestionsSource: 'catalog',
        reapply: true,
      });
      setSelectedIndex(0);
      roleEditor.reset();
      void refreshGatewayModelSuggestions(name);
    } catch (err) {
      reportFail(err);
    }
  };

  /**
   * Replace a gateway model screen's suggestions with the discovered list.
   *
   * Runs detached from the screen transition, and re-reads the current screen
   * before writing: the user may have navigated away, or already be typing into
   * a role, and clobbering the screen under them is exactly the jumping this
   * whole flow is supposed to avoid.
   */
  const refreshGatewayModelSuggestions = async (name: string, refresh = false) => {
    try {
      const profile = await app.profiles.get(name);
      const next = await gatewaySuggestions(profile.meta.provider, {
        endpoint: profile.meta.endpoint,
        apiKey: profile.secrets.apiKey,
        refresh,
      });
      replaceScreen((screen) =>
        screen.kind === 'gateway-models' && screen.name === name
          ? { ...screen, suggestions: next.suggestions, suggestionsSource: next.source }
          : null,
      );
    } catch {
      // The catalog list is already on screen; a failed refresh changes nothing.
    }
  };

  const openGatewayApps = async (name: string) => {
    let profile;
    try {
      profile = await app.profiles.get(name);
    } catch (err) {
      reportFail(err);
      return;
    }
    const list = compatibleAppsForGateway(app, profile);
    const checked = list.filter((a) => a.bound && a.sourceDisplay === name).map((a) => a.clientId);
    if (checked.length === 0) {
      const resume = latestSourceResumeFor(name, list);
      if (resume) {
        offerSourceResume({
          source: name,
          providerId: 'gateway',
          name,
          resume,
          back: { kind: 'gateway-apps', name, apps: list, checked: [] },
        });
        return;
      }
    }
    // Single app already using this gateway → open models (same as Proxy)
    if (list.length === 1) {
      const only = list[0];
      if (only.bound && only.sourceDisplay === name) {
        openModelsForAttach({
          providerId: 'gateway',
          name,
          clientId: only.clientId,
          clientName: only.clientName,
          queue: [],
          detach: [],
          rolesByClient: {},
          reedit: true,
        });
        return;
      }
      // Single app not yet using → confirm attach with models next
      void applyGatewayAppChanges(name, list, new Set([only.clientId]));
      return;
    }
    go({
      kind: 'gateway-apps',
      name,
      apps: list,
      checked,
    });
    setSelectedIndex(0);
  };

  const saveGatewayModels = async (
    name: string,
    values: Record<string, string>,
    reapply: boolean,
  ) => {
    await withBusy('Saving models', async () => {
      try {
        await app.profiles.edit(name, {
          defaultModel: values.default,
          sonnetModel: values.sonnet,
          opusModel: values.opus,
          haikuModel: values.haiku,
        });
        if (reapply) {
          const bound = loadAppBindings(app).filter((a) => a.bound && a.sourceDisplay === name);
          for (const a of bound) {
            try {
              await app.bindingService.use(a.clientId, {
                with: name,
                modelRoles: values,
                model: values.default,
              });
            } catch {
              // continue
            }
          }
        }
        setApps(loadAppBindings(app));
        reportOk(`Models saved for ${name}`);
        await openGateways(name);
      } catch (err) {
        reportFail(err);
      }
    });
  };

  const finishGatewayCreate = async (draft: GatewayCreateDraft) => {
    await withBusy('Creating gateway', async () => {
      try {
        const profile = await app.profiles.create(draft.name, {
          provider: draft.providerId,
          endpoint: draft.endpoint,
          apiKey: draft.apiKey,
          defaultModel: draft.models.default,
          sonnetModel: draft.models.sonnet,
          opusModel: draft.models.opus,
          haikuModel: draft.models.haiku,
        });
        reportOk(`Gateway ${profile.meta.name} created`);
        await openGateways(profile.meta.name);
        // Offer manage apps next by opening apps screen
        void openGatewayApps(profile.meta.name);
      } catch (err) {
        reportFail(err);
        await openGateways();
      }
    });
  };

  const applyGatewayAppChanges = async (
    gatewayName: string,
    list: AppBindingRow[],
    checked: Set<string>,
  ) => {
    const currentlyUsing = new Set(
      list.filter((a) => a.bound && a.sourceDisplay === gatewayName).map((a) => a.clientId),
    );
    const attach = list.filter((a) => checked.has(a.clientId) && !currentlyUsing.has(a.clientId));
    const detach = list.filter((a) => currentlyUsing.has(a.clientId) && !checked.has(a.clientId));
    if (attach.length === 0 && detach.length === 0) {
      return;
    }

    if (attach.length === 1) {
      const resume = sourceResumeFor(gatewayName, attach[0]);
      if (resume) {
        offerSourceResume({
          source: gatewayName,
          providerId: 'gateway',
          name: gatewayName,
          resume,
          back: {
            kind: 'gateway-apps',
            name: gatewayName,
            apps: list,
            checked: [...checked],
          },
        });
        return;
      }
    }

    // Attaching: the gateway already carries model defaults (set at create or
    // via `d`), so bind straight away instead of reopening the model editor.
    // Per-app model tweaks stay available through `m`/enter on a bound app.
    if (attach.length > 0) {
      let profile;
      try {
        profile = await app.profiles.get(gatewayName);
      } catch {
        profile = null;
      }
      const defaults = profile ? gatewayProfileModelRoles(profile, app.catalog) : undefined;
      await applyAppBindingBatch({
        providerId: 'gateway',
        name: gatewayName,
        attach: attach.map((a) => ({
          clientId: a.clientId,
          clientName: a.clientName,
          modelRoles: defaults,
          model: defaults?.default,
        })),
        detach,
      });
      return;
    }

    // Detach only
    await withBusy('Updating apps', async () => {
      const detached: string[] = [];
      const failed: string[] = [];
      for (const a of detach) {
        try {
          await app.bindingService.reset(a.clientId);
          detached.push(a.clientName);
        } catch {
          failed.push(a.clientName);
        }
      }
      setApps(loadAppBindings(app));
      setReceipt({
        title: '',
        lines: [
          {
            kind: failed.length ? 'warn' : 'ok',
            text: failed.length
              ? `${detached.join(' and ')} updated. ${failed.join(' and ')} failed.`
              : `${detached.join(' and ')} no longer use ${gatewayName}`,
          },
        ],
      });
      await openGateways(gatewayName);
    });
  };

  const startEditEndpoint = (row: GatewayRow) => {
    setReceipt(null);
    go({
      kind: 'text-input',
      purpose: 'gateway-edit-endpoint',
      accountName: row.name,
      label: 'Endpoint',
      initial: row.endpoint ?? '',
      hint: `Gateway ${row.name}`,
      back: { kind: 'gateways', focusName: row.name },
    });
  };

  const confirmDeleteGateway = (row: GatewayRow) => {
    setReceipt(null);
    go({
      kind: 'confirm',
      path: 'gateways',
      title: `Remove gateway ${row.name}?`,
      body: [
        `${row.providerName} · ${row.endpointShort}`,
        '',
        row.usedByApps.length
          ? `${row.usedByApps.join(' and ')} currently use this gateway.`
          : 'No app is using this gateway.',
        'Secrets stored for this gateway will be deleted.',
      ],
      confirmLabel: 'remove',
      danger: true,
      back: { kind: 'gateways', focusName: row.name },
      action: async () => {
        await withBusy(`Removing ${row.name}`, async () => {
          await app.profiles.delete(row.name);
          reportOk(`Removed gateway ${row.name}`);
          await openGateways();
        });
      },
    });
  };

  /**
   * A gateway is only written once its models are chosen, so the connection
   * details have to survive the model step. They are held here rather than
   * pushed onto the screen so that backing out cannot half-create a gateway.
   */
  const [pendingCreate, setPendingCreate] = React.useState<GatewayCreateDraft | null>(null);

  const submitGatewayConnection = (
    screen: GatewayConnectionScreen,
    form: { endpoint?: string; apiKey?: string },
  ) => {
    const defaults = gatewayProfileModelRoles(
      { meta: { provider: screen.providerId } },
      app.catalog,
    );
    setPendingCreate({
      providerId: screen.providerId,
      name: screen.name,
      endpoint: form.endpoint,
      apiKey: form.apiKey,
      models: defaults,
    });
    go({
      kind: 'gateway-models',
      name: screen.name,
      values: defaults,
      suggestions: suggestModelsForGateway(screen.providerId, app.catalog),
      suggestionsSource: 'catalog',
      reapply: false,
    });
    setSelectedIndex(0);
    roleEditor.reset();
    // The gateway does not exist yet, so its credential comes from the form
    // rather than from a stored profile.
    void (async () => {
      const next = await gatewaySuggestions(screen.providerId, {
        endpoint: form.endpoint,
        apiKey: form.apiKey,
      });
      replaceScreen((current) =>
        current.kind === 'gateway-models' && current.name === screen.name
          ? { ...current, suggestions: next.suggestions, suggestionsSource: next.source }
          : null,
      );
    })();
  };

  const commitGatewayModels = (screen: GatewayModelsScreen) => {
    const values = normalizeModelRoles(screen.values, screen.values);
    if (pendingCreate && pendingCreate.name === screen.name) {
      setPendingCreate(null);
      void finishGatewayCreate({ ...pendingCreate, models: values });
      return;
    }
    void saveGatewayModels(screen.name, values, Boolean(screen.reapply));
  };

  const cancelGatewayModels = (screen: GatewayModelsScreen) => {
    setPendingCreate(null);
    void openGateways(screen.name);
  };

  return {
    startGatewayCreate,
    openGatewayModels,
    refreshGatewayModelSuggestions,
    openGatewayApps,
    saveGatewayModels,
    finishGatewayCreate,
    applyGatewayAppChanges,
    startEditEndpoint,
    confirmDeleteGateway,
    submitGatewayConnection,
    hasPendingGatewayCreate: pendingCreate !== null,
    commitGatewayModels,
    cancelGatewayModels,
  };
}
