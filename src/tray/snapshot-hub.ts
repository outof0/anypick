import { randomUUID } from 'node:crypto';
import type { AnyPickApp } from '../core/app';
import { serializeRef } from '../core/refs';
import type { ProxyHubPreview } from '../core/proxy-hub-service';
import type { ListedAccount } from '../core/service';
import type { ProxyHubSourceRef } from '../types';
import { hubSourcePresentation } from './snapshot-helpers';
import type {
  TrayActionRegistry,
  TrayHubConflictSnapshot,
  TrayHubSourceSnapshot,
  TrayManagedAccountSnapshot,
} from './snapshot-types';

export function buildTrayHubSources(
  app: AnyPickApp,
  managedAccounts: readonly TrayManagedAccountSnapshot[],
  hubConfig: Awaited<ReturnType<AnyPickApp['hub']['get']>> | null,
  hubPreview: ProxyHubPreview | null,
): TrayHubSourceSnapshot[] {
  const enabledHubSources = new Set(
    hubConfig?.sources
      .filter((source) => source.enabled)
      .map((source) => serializeRef(source.ref)) ?? [],
  );
  return managedAccounts
    .filter((account) => app.accountRegistry.get(account.providerId).createProxyHubBackend != null)
    .map((account): TrayHubSourceSnapshot => {
      const ref = { kind: 'account' as const, provider: account.providerId, name: account.name };
      const sourceId = serializeRef(ref);
      const enabled = enabledHubSources.has(sourceId);
      const catalog = hubPreview?.catalogs.find((entry) => serializeRef(entry.source) === sourceId);
      const unavailable = hubPreview?.unavailable.find(
        (entry) => serializeRef(entry.source) === sourceId,
      );
      const warning = enabled
        ? (unavailable?.reason ?? (!hubPreview || !catalog ? 'catalog unavailable' : undefined))
        : undefined;
      const snapshot: TrayHubSourceSnapshot = {
        id: account.id,
        providerId: account.providerId,
        name: account.name,
        label: account.label,
        detail: account.detail,
        enabled,
        status: !enabled ? 'disabled' : warning ? 'unavailable' : 'ready',
        modelCount: enabled && catalog ? new Set(catalog.models).size : 0,
      };
      if (warning) {
        snapshot.warning = warning;
      }
      return snapshot;
    })
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.providerId.localeCompare(right.providerId) ||
        left.name.localeCompare(right.name),
    );
}

export function buildHubConflictGroups(
  app: AnyPickApp,
  accounts: readonly ListedAccount[],
  preview: ProxyHubPreview | null,
  registry?: TrayActionRegistry,
): TrayHubConflictSnapshot[] {
  if (!preview) {
    return [];
  }
  const grouped = new Map<string, { models: string[]; candidates: ProxyHubSourceRef[] }>();
  for (const conflict of preview.conflicts) {
    const candidates = [...conflict.candidates].toSorted((left, right) =>
      serializeRef(left).localeCompare(serializeRef(right)),
    );
    const key = candidates.map(serializeRef).join('\u0000');
    const group = grouped.get(key) ?? { models: [], candidates };
    group.models.push(conflict.model);
    grouped.set(key, group);
  }

  const modelOverlaps = [...grouped.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, group], index): TrayHubConflictSnapshot => {
      const models = [...group.models].toSorted((left, right) => left.localeCompare(right));
      return buildHubConflictSnapshot(app, accounts, preview, registry, {
        id: `hub-conflict-${index + 1}`,
        kind: 'model-overlap',
        title: `Choose a provider for ${models.length} overlapping ${models.length === 1 ? 'model' : 'models'}`,
        models,
        candidates: group.candidates,
      });
    });
  const sourceChoices = preview.sourceChoices.map((choice, index) => {
    const providers = [
      ...new Set(
        choice.candidates.map((source) => {
          const provider = app.accountRegistry.get(source.provider);
          return provider.shortName ?? provider.name;
        }),
      ),
    ];
    const catalogLabel = providers.length === 1 ? providers[0] : choice.catalogId;
    return buildHubConflictSnapshot(app, accounts, preview, registry, {
      id: `hub-source-choice-${index + 1}`,
      kind: 'source-choice',
      title: `Choose one ${catalogLabel} account`,
      models: choice.models,
      candidates: choice.candidates,
    });
  });
  return [...sourceChoices, ...modelOverlaps];
}

function buildHubConflictSnapshot(
  app: AnyPickApp,
  accounts: readonly ListedAccount[],
  preview: ProxyHubPreview,
  registry: TrayActionRegistry | undefined,
  conflict: Omit<TrayHubConflictSnapshot, 'candidates'> & {
    candidates: ProxyHubSourceRef[];
  },
): TrayHubConflictSnapshot {
  return {
    ...conflict,
    candidates: conflict.candidates.map((source) => {
      const presentation = hubSourcePresentation(app, accounts, source);
      const actionId =
        registry?.register({
          operation: 'hub-own-models',
          name: preview.config.name,
          models: conflict.models,
          source,
        }) ?? randomUUID();
      return {
        id: serializeRef(source),
        providerId: source.provider,
        label: presentation.label,
        detail: presentation.detail,
        actionId,
      };
    }),
  };
}
