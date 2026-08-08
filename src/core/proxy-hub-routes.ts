import type {
  ProxyHubConfig,
  ProxyHubModelConflict,
  ProxyHubRouteTarget,
  ProxyHubSourceChoiceConflict,
  ProxyHubSourceRef,
} from '../types';
import { serializeRef } from './refs';

export interface ProxyHubSourceCatalog {
  source: ProxyHubSourceRef;
  /** Adapter-owned model namespace. Accounts sharing this identity are credentials, not rivals. */
  catalogId: string;
  models: readonly string[];
}

export interface CompiledProxyHubRoutes {
  routes: ProxyHubRouteTarget[];
  conflicts: ProxyHubModelConflict[];
  sourceChoices: ProxyHubSourceChoiceConflict[];
}

export function proxyHubCatalogIdentity(catalog: ProxyHubSourceCatalog): string {
  return catalog.catalogId.trim() || catalog.source.provider;
}

/**
 * Compile the no-prefix routing table. Accounts whose adapters declare the
 * same catalog identity are credential alternatives for one model namespace,
 * but only an explicit account-pool can safely combine their credentials.
 * Unresolved credential choices are aggregated separately from true model
 * overlaps, so core never falls back to source ordering (ADR-0013).
 */
export function compileProxyHubRoutes(
  config: Pick<ProxyHubConfig, 'sources' | 'modelOwners'>,
  catalogs: readonly ProxyHubSourceCatalog[],
): CompiledProxyHubRoutes {
  const enabled = new Set(
    config.sources.filter((source) => source.enabled).map((source) => serializeRef(source.ref)),
  );
  const byModel = new Map<string, Map<string, ProxyHubSourceRef[]>>();

  for (const catalog of catalogs) {
    const sourceId = serializeRef(catalog.source);
    if (!enabled.has(sourceId)) {
      continue;
    }
    const catalogId = proxyHubCatalogIdentity(catalog);
    const seen = new Set<string>();
    for (const raw of catalog.models) {
      const model = raw.trim();
      if (!model || seen.has(model)) {
        continue;
      }
      seen.add(model);
      const catalogsForModel = byModel.get(model) ?? new Map<string, ProxyHubSourceRef[]>();
      const sources = catalogsForModel.get(catalogId) ?? [];
      if (!sources.some((candidate) => serializeRef(candidate) === sourceId)) {
        sources.push(catalog.source);
      }
      catalogsForModel.set(catalogId, sources);
      byModel.set(model, catalogsForModel);
    }
  }

  const owners = new Map(config.modelOwners.map((owner) => [owner.model, owner.source]));
  const routes: ProxyHubRouteTarget[] = [];
  const conflicts: ProxyHubModelConflict[] = [];
  const sourceChoices = new Map<
    string,
    { catalogId: string; models: string[]; candidates: ProxyHubSourceRef[] }
  >();

  for (const [model, catalogGroups] of [...byModel.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sourceGroups = [...catalogGroups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([catalogId, sources]) => ({
        catalogId,
        sources: sources.toSorted((left, right) =>
          serializeRef(left).localeCompare(serializeRef(right)),
        ),
      }));
    const allSources = sourceGroups.flatMap((group) => group.sources);
    const owner = owners.get(model);
    if (owner && allSources.some((candidate) => serializeRef(candidate) === serializeRef(owner))) {
      routes.push({ model, source: owner, upstreamModel: model });
      continue;
    }
    if (sourceGroups.length === 1) {
      const [group] = sourceGroups;
      if (group.sources.length === 1) {
        routes.push({ model, source: group.sources[0], upstreamModel: model });
        continue;
      }
      const key = `${group.catalogId}\u0000${group.sources.map(serializeRef).join('\u0000')}`;
      const choice = sourceChoices.get(key) ?? {
        catalogId: group.catalogId,
        models: [],
        candidates: group.sources,
      };
      choice.models.push(model);
      sourceChoices.set(key, choice);
      continue;
    }
    conflicts.push({
      kind: 'model-overlap',
      model,
      catalogIds: sourceGroups.map((group) => group.catalogId),
      candidates: allSources,
    });
  }

  return {
    routes,
    conflicts,
    sourceChoices: [...sourceChoices.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, choice]) => ({
        kind: 'source-choice' as const,
        catalogId: choice.catalogId,
        models: choice.models.toSorted((left, right) => left.localeCompare(right)),
        candidates: choice.candidates,
      })),
  };
}
