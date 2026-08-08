import { randomUUID } from 'node:crypto';
import type { AnyPickApp } from '../core/app';
import { serializeRef } from '../core/refs';
import {
  defaultModelRolesForProxy,
  modelDefaultsForSuggestions,
  modelRolesForClient,
  modelRolesFromClientOptions,
} from '../clients';
import type { ListedAccount } from '../core/service';
import type { ProxyHubPreview } from '../core/proxy-hub-service';
import { nativeConnectionFor } from '../cli/launcher-model';
import { shortClientName } from '../presentation/client-name';
import {
  loadCompatibleSources,
  modelSuggestionsForRoute,
  type AppRouteSourceRow,
} from '../tui/model';
import {
  fetchModelsFromProxyEndpoint,
  mergeProxyModelSuggestions,
} from '../tui/proxy-models-fetch';
import { modelPolicyLookup } from '../core/model-policy';
import {
  hubSourcePresentation,
  modelFamilyForId,
  nativeSourceInstalled,
  primaryModel,
  traySourceDisplay,
} from './snapshot-helpers';
import type {
  TrayActionKind,
  TrayActionRegistry,
  TrayActionSnapshot,
  TrayActionTarget,
  TrayClientModelConfigSnapshot,
  TrayClientModelOptionSnapshot,
  TrayRouteKind,
  TrayRouteSnapshot,
  TraySnapshotOptions,
} from './snapshot-types';

export interface TrayClientSnapshotPiece {
  route: TrayRouteSnapshot;
  actions: TrayActionSnapshot[];
  modelConfig?: TrayClientModelConfigSnapshot;
}

/** Cap Configure Models options so role pickers stay glanceable. */
const MAX_MODEL_OPTIONS = 48;

export async function buildTrayClientSnapshots(
  app: AnyPickApp,
  listedAccounts: readonly ListedAccount[],
  hubPreview: ProxyHubPreview | null,
  registry: TrayActionRegistry | undefined,
  opts: TraySnapshotOptions,
): Promise<TrayClientSnapshotPiece[]> {
  const liveAccounts = listedAccounts.filter((account) => account.isLiveMatch);
  const liveNativeRefs = new Set(
    liveAccounts.map((account) =>
      serializeRef({ kind: 'account', provider: account.provider, name: account.name }),
    ),
  );
  const liveNativeProviders = new Set(liveAccounts.map((account) => account.provider));
  const policyLookup = modelPolicyLookup({
    accountRegistry: app.accountRegistry,
    catalog: app.catalog,
  });
  // One catalog resolve per account across all clients (snapshot is hot path).
  const accountModelCache = new Map<string, Promise<string[]>>();

  return Promise.all(
    app.clients.list().map(async (client) => {
      const current = app.bindingService.current(client.id)[0];
      const spec = current?.binding?.spec;
      const native = spec ? null : await nativeConnectionFor(app, client.id);
      const loadedSources = await loadCompatibleSources(app, client.id);
      const compatibleSources = (
        await Promise.all(
          loadedSources.map(async (row) => {
            if (client.routingSurfacePolicy === 'all-compatible') {
              return row;
            }
            if (row.category !== 'native') {
              return null;
            }
            const installed = await (opts.isNativeSourceInstalled ?? nativeSourceInstalled)(
              client,
              row.sourceId,
            );
            return installed ? row : null;
          }),
        )
      ).filter((row): row is (typeof loadedSources)[number] => row !== null);
      const currentSource = spec ? serializeRef(spec.source) : undefined;
      const currentRow = compatibleSources.find((row) => row.value === currentSource);
      const liveNativeRow = compatibleSources.find(
        (row) => row.category === 'native' && liveNativeRefs.has(row.value),
      );
      const nativeBindingMismatch =
        currentRow?.category === 'native' &&
        liveNativeRow !== undefined &&
        currentRow.value !== liveNativeRow.value;
      const shortClient = shortClientName(client.id, client.name, client.shortName);
      const presentation =
        client.routingSurfacePolicy === 'all-compatible' ? 'app-route' : 'native-account';

      // Switch is source-first: one tray action per bindable source. Model fan-out
      // belongs in Configure Models / the client’s own picker (Codex catalog,
      // Claude role slots) — not in the Switch menu (see tray README + ADR 0013).
      const baseActionsNested = await Promise.all(
        compatibleSources
          .filter((row) => row.ref.kind !== 'proxy-hub')
          .map(async (row): Promise<TrayActionSnapshot[]> => {
            const kind: TrayActionKind = row.category === 'native' ? 'native' : 'gateway';
            // Native checkmarks follow the live login only when this client has
            // no AnyPick route (or is already on a native binding). A proxy/hub
            // binding must not leave the Codex account looking "selected".
            const selected =
              kind === 'native'
                ? (!spec || currentRow?.category === 'native') &&
                  liveNativeProviders.has(row.providerId) &&
                  liveNativeRefs.has(row.value)
                : currentSource === row.value;
            const routeKind = routeKindForSource(row);

            if (kind === 'native') {
              const target = { clientId: client.id, source: row.value };
              const id = registry?.register(target) ?? randomUUID();
              return [
                {
                  id,
                  clientId: client.id,
                  sourceId: row.sourceId,
                  client: shortClient,
                  label: row.label,
                  detail: row.detail,
                  kind,
                  presentation,
                  selected,
                  enabled: true,
                  routeKind: 'direct-account',
                  upstreamProviderId: row.providerId,
                  upstreamSourceLabel: row.label,
                },
              ];
            }

            const catalogModels = await resolveGatewayModels(
              app,
              row,
              hubPreview,
              accountModelCache,
              policyLookup,
            );
            const suggested = await modelSuggestionsForRoute(app, row);
            const models = [
              ...new Set([
                ...catalogModels,
                ...suggested.suggestions,
                ...(selected && spec?.model.mode === 'explicit' ? [spec.model.id] : []),
                ...(selected
                  ? Object.values(modelRolesFromClientOptions(spec?.clientOptions) ?? {})
                  : []),
              ]),
            ].filter((id): id is string => Boolean(id?.trim()));

            const preset =
              row.ref.kind === 'preset' ? app.presets.getByName(row.ref.name) : undefined;
            const explicitPresetModel =
              preset?.spec.model.mode === 'explicit' ? preset.spec.model.id : undefined;
            const currentRoles = selected
              ? modelRolesFromClientOptions(spec?.clientOptions)
              : undefined;
            const currentModel =
              selected && spec?.model.mode === 'explicit'
                ? spec.model.id
                : selected
                  ? currentRoles?.default
                  : undefined;

            // Bootstrap default only — clients still receive the full catalog
            // (Codex model_catalog_json / Hub /v1/models) so they can pick others.
            // Prefer the active binding when this row is already selected so a
            // re-emit does not rewrite the user's current model.
            const softDefault =
              explicitPresetModel ??
              (selected ? currentModel : undefined) ??
              suggested.defaultModel ??
              models[0];

            if (!softDefault && models.length === 0) {
              // Still offer the source: omitted model is valid for discovery-
              // first clients. Disabled only when activation would leave Claude
              // with no usable slot and we know nothing about the catalog.
              const canOmit = row.ref.kind === 'gateway' || row.ref.kind === 'account';
              if (!canOmit) {
                return [
                  {
                    id: randomUUID(),
                    clientId: client.id,
                    sourceId: row.sourceId,
                    client: shortClient,
                    label: row.label,
                    detail: row.detail,
                    kind,
                    presentation,
                    selected,
                    enabled: false,
                    disabledReason: 'Open AnyPick to finish this source',
                    routeKind,
                    upstreamProviderId: row.providerId,
                    upstreamSourceLabel: row.label,
                  },
                ];
              }
            }

            const target: TrayActionTarget = {
              clientId: client.id,
              source: row.value,
            };
            if (softDefault) {
              target.model = softDefault;
            }
            // Multi-role clients (Claude): seed role slots from provider policy
            // against the live catalog so Switch does not require a model drill.
            // Configure Models remains the place for custom overrides.
            if (selected && currentRoles && Object.keys(currentRoles).length > 0) {
              // Re-emit the active binding roles so a selected row is stable.
              target.modelRoles = { ...currentRoles };
            } else if (modelRolesForClient(client).length > 1) {
              const baseRoles = defaultModelRolesForProxy(row.providerId, client, policyLookup);
              const filled = modelDefaultsForSuggestions(
                row.providerId,
                baseRoles,
                models.length > 0 ? models : softDefault ? [softDefault] : [],
                policyLookup,
              );
              if (softDefault && !filled.default) {
                filled.default = softDefault;
              }
              if (Object.keys(filled).length > 0) {
                target.modelRoles = filled;
                if (!target.model && filled.default) {
                  target.model = filled.default;
                }
              }
            }

            const id = registry?.register(target) ?? randomUUID();
            return [
              {
                id,
                clientId: client.id,
                sourceId: row.sourceId,
                client: shortClient,
                label: row.label,
                detail: row.detail,
                kind,
                presentation,
                selected,
                enabled: true,
                routeKind,
                ...(softDefault || currentModel ? { modelId: currentModel ?? softDefault } : {}),
                upstreamProviderId: row.providerId,
                upstreamSourceLabel: row.label,
              },
            ];
          }),
      );
      const baseActions = baseActionsNested.flat();

      // Proxy Hub is one source. Attach exposes the full uniquely-routed
      // catalog; Switch only points the client at Hub. Soft-default a model so
      // Claude/Codex boot with a usable default; /v1/models stays complete.
      const hubActions = compatibleSources
        .filter((row) => row.ref.kind === 'proxy-hub')
        .flatMap((row): TrayActionSnapshot[] => {
          const routes = hubPreview?.routes ?? [];
          const selected = currentSource === row.value;
          const currentModel =
            selected && spec?.model.mode === 'explicit'
              ? spec.model.id
              : selected
                ? modelRolesFromClientOptions(spec?.clientOptions)?.default
                : undefined;
          const available = new Set(routes.map((route) => route.model));
          const softDefault =
            (currentModel && available.has(currentModel) ? currentModel : undefined) ??
            routes[0]?.model;

          if (routes.length === 0) {
            return [
              {
                id: randomUUID(),
                clientId: client.id,
                sourceId: 'proxy-hub',
                client: shortClient,
                label: row.label,
                detail: 'No uniquely routed models yet',
                kind: 'gateway' as const,
                presentation,
                selected,
                enabled: false,
                disabledReason: 'Add hub sources or resolve model conflicts first',
                routeKind: 'hub' as const,
                upstreamProviderId: 'proxy-hub',
                upstreamSourceLabel: row.label,
              },
            ];
          }

          const target: TrayActionTarget = {
            clientId: client.id,
            source: row.value,
            ...(softDefault ? { model: softDefault } : {}),
          };
          if (modelRolesForClient(client).length > 1 && softDefault) {
            // Hub catalogs mix providers, so seed every Claude role or Codex list
            // slot with a valid route; the user can refine them in Configure Models.
            const roles = Object.fromEntries(
              modelRolesForClient(client).map((role) => [role.id, softDefault]),
            );
            target.modelRoles = roles;
          }
          const id = registry?.register(target) ?? randomUUID();
          const sourceCount = new Set(routes.map((route) => serializeRef(route.source))).size;
          return [
            {
              id,
              clientId: client.id,
              sourceId: 'proxy-hub',
              client: shortClient,
              label: row.label,
              detail: `${routes.length} model${routes.length === 1 ? '' : 's'} · ${sourceCount} source${sourceCount === 1 ? '' : 's'}`,
              kind: 'gateway' as const,
              presentation,
              selected,
              enabled: true,
              routeKind: 'hub' as const,
              ...(softDefault ? { modelId: softDefault } : {}),
              upstreamProviderId: 'proxy-hub',
              upstreamSourceLabel: row.label,
            },
          ];
        });
      const actions = [...baseActions, ...hubActions];
      const roleDefinitions = modelRolesForClient(client).map((role) => ({
        id: role.id,
        label: role.label,
      }));
      const storedRoles = modelRolesFromClientOptions(spec?.clientOptions) ?? {};
      const defaultModel = spec ? primaryModel(spec) : undefined;
      const allowedRoleIds = new Set(roleDefinitions.map((role) => role.id));
      const currentModelRoles = Object.fromEntries(
        Object.entries(storedRoles).filter(
          ([roleId, modelId]) => allowedRoleIds.has(roleId) && modelId.trim(),
        ),
      );
      if (defaultModel && !currentModelRoles.default) {
        currentModelRoles.default = defaultModel;
      }

      // Configure Models lists catalog options for the *current* source only —
      // not Switch fan-out.
      let modelOptions: TrayClientModelOptionSnapshot[] = [];
      if (currentRow && currentRow.category !== 'native') {
        if (currentRow.ref.kind === 'proxy-hub') {
          // Routes mirror the live proxy catalog; the picker groups by provider
          // and searches, so truncating here silently hides valid models
          // (e.g. mimo-v2.5-free past the first 48 alphabetically).
          modelOptions = (hubPreview?.routes ?? []).map((route) => {
            const source = hubSourcePresentation(app, listedAccounts, route.source);
            return {
              actionId:
                registry?.register({
                  clientId: client.id,
                  source: currentRow.value,
                  model: route.model,
                }) ?? randomUUID(),
              modelId: route.model,
              // Show the model's actual provider family (claude → anthropic,
              // gpt → openai, etc.) instead of the upstream account ("opencode"),
              // which is misleading when configuring a different client.
              providerId: modelFamilyForId(route.model),
              sourceLabel: source.label,
            };
          });
        } else {
          const catalogModels = await resolveGatewayModels(
            app,
            currentRow,
            hubPreview,
            accountModelCache,
            policyLookup,
          );
          const suggested = await modelSuggestionsForRoute(app, currentRow);
          // Prefer configured / active roles first so a large live catalog does
          // not push the gateway's own model map out of the options cap.
          const models = [
            ...new Set([
              ...Object.values(currentModelRoles),
              ...(defaultModel ? [defaultModel] : []),
              ...suggested.suggestions,
              ...catalogModels,
            ]),
          ].filter(Boolean);
          modelOptions = models.slice(0, MAX_MODEL_OPTIONS).map((modelId) => ({
            actionId:
              registry?.register({
                clientId: client.id,
                source: currentRow.value,
                model: modelId,
              }) ?? randomUUID(),
            modelId,
            providerId: currentRow.providerId,
            sourceLabel: currentRow.label,
          }));
        }
      }
      modelOptions = [
        ...new Map(modelOptions.map((option) => [option.modelId, option])).values(),
      ].toSorted((left, right) => left.modelId.localeCompare(right.modelId));

      // Configure Models is available for every app-routing client (Claude multi-
      // role and Codex Desktop list slots). Desktop Codex only shows ~5 allowlisted
      // slugs, so AnyPick Apps/Tray is where Default + List 2–5 are chosen.
      const modelConfig: TrayClientModelConfigSnapshot | undefined =
        roleDefinitions.length > 0
          ? {
              clientId: client.id,
              client: shortClientName(client.id, client.name, client.shortName),
              ...(currentRow ? { sourceLabel: currentRow.label } : {}),
              editable: modelOptions.length > 0,
              ...(!spec
                ? { unavailableReason: 'Choose a proxy or gateway route first.' }
                : currentRow?.category === 'native'
                  ? { unavailableReason: 'Native routes use the client model picker.' }
                  : !currentRow
                    ? { unavailableReason: 'The current connection is not available in Tray.' }
                    : modelOptions.length === 0
                      ? { unavailableReason: 'No models were discovered for this connection.' }
                      : {}),
              roles: roleDefinitions,
              ...(defaultModel ? { defaultModel } : {}),
              modelRoles: currentModelRoles,
              options: modelOptions,
            }
          : undefined;
      return {
        route: {
          clientId: client.id,
          client: shortClientName(client.id, client.name, client.shortName),
          source:
            currentRow?.category === 'native'
              ? (liveNativeRow?.label ?? (spec ? traySourceDisplay(spec.source) : undefined))
              : spec
                ? traySourceDisplay(spec.source)
                : (liveNativeRow?.label ?? (native ? 'native login' : undefined)),
          model: spec ? primaryModel(spec) : undefined,
          status: nativeBindingMismatch
            ? ('attention' as const)
            : spec
              ? ('ready' as const)
              : native
                ? ('native' as const)
                : ('unbound' as const),
        },
        actions,
        modelConfig,
      };
    }),
  );
}

function routeKindForSource(row: AppRouteSourceRow): TrayRouteKind {
  switch (row.ref.kind) {
    case 'account':
      return 'account';
    case 'account-pool':
      return 'pool';
    case 'gateway':
    case 'preset':
      return 'gateway';
    case 'proxy-hub':
      return 'hub';
    default: {
      const exhaustive: never = row.ref;
      return exhaustive;
    }
  }
}

/**
 * Best-effort model ids for a gateway/account row. Prefers live proxy catalogs
 * (and hub preview catalogs for the same provider), then static policy maps.
 * Never throws — empty means the caller falls back to route suggestions.
 */
async function resolveGatewayModels(
  app: AnyPickApp,
  row: AppRouteSourceRow,
  hubPreview: ProxyHubPreview | null,
  cache: Map<string, Promise<string[]>>,
  policyLookup: ReturnType<typeof modelPolicyLookup>,
): Promise<string[]> {
  const cacheKey = row.value;
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const work = (async (): Promise<string[]> => {
    const fromHub =
      hubPreview?.catalogs
        .filter((catalog) => {
          if (row.ref.kind === 'account' && catalog.source.kind === 'account') {
            return (
              catalog.source.provider === row.ref.provider && catalog.source.name === row.ref.name
            );
          }
          if (row.ref.kind === 'account-pool' && catalog.source.kind === 'account-pool') {
            return catalog.source.provider === row.ref.provider;
          }
          return catalog.catalogId === row.providerId || catalog.source.provider === row.providerId;
        })
        .flatMap((catalog) => catalog.models) ?? [];

    if (fromHub.length > 0) {
      return [...new Set(fromHub)];
    }

    if (row.ref.kind === 'account') {
      try {
        const status = await app.proxy.proxyStatus(row.ref.provider, row.ref.name);
        if (status.running && status.endpoint) {
          const token = (
            await app.accountStore.readProxyState(row.ref.provider, row.ref.name).catch(() => null)
          )?.token;
          const fetched = await fetchModelsFromProxyEndpoint(status.endpoint, {
            apiKey: token,
            timeoutMs: 2500,
            refresh: true,
          });
          if (fetched.models.length > 0) {
            return fetched.models;
          }
        }
      } catch {
        // Fall through to static policy.
      }
    }

    if (row.ref.kind === 'gateway') {
      try {
        const profile = await app.profiles.get(row.ref.name);
        const live = await app.modelDiscovery.list({
          providerId: profile.meta.provider,
          endpoint: profile.meta.endpoint,
          apiKey: profile.secrets.apiKey,
        });
        if (live.models.length > 0) {
          return live.models;
        }
      } catch {
        // Fall through.
      }
    }

    const merged = mergeProxyModelSuggestions(row.providerId, [], {
      includeStaticFallback: true,
      policy: policyLookup,
    });
    return merged.suggestions;
  })();

  cache.set(cacheKey, work);
  return work;
}
