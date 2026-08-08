import type { AnyPickApp } from '../../core/app';
import type { ActivationPlan, ResourceRef, TransportCapability } from '../../types';
import { accountAdapterFor } from '../../sources/account-adapters';
import { gatewayAdapterFromProfile } from '../../sources/gateway-adapters';
import { displayRef, serializeRef } from '../../core/refs';
import { materializeResolvedSource } from '../../core/resolve-source';
import { identityDisplayText } from './identity';

export type AppRouteSourceCategory = 'native' | 'gateway' | 'saved';

export interface AppRouteSourceRow {
  ref: ResourceRef;
  value: string;
  label: string;
  detail: string;
  providerId: string;
  sourceId: string;
  transport: Exclude<TransportCapability, 'unsupported'>;
  category: AppRouteSourceCategory;
}

/** Native credential switching uses the app's own model selection. */
export function routeNeedsModelSelection(row: AppRouteSourceRow): boolean {
  return row.category !== 'native';
}

function transportLabel(capability: Exclude<TransportCapability, 'unsupported'>): string {
  switch (capability) {
    case 'direct':
      return 'direct';
    case 'managed_builtin_proxy':
      return 'managed proxy';
    case 'managed_external_proxy':
      return 'managed external proxy';
    case 'external_manual_proxy':
      return 'external helper required';
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

export async function loadCompatibleSources(
  app: AnyPickApp,
  clientId: string,
): Promise<AppRouteSourceRow[]> {
  const rows: AppRouteSourceRow[] = [];

  for (const listed of await app.accounts.list()) {
    const account = await app.accounts.get(listed.provider, listed.name);
    if (!account) {
      continue;
    }
    const provider = app.accounts.provider(listed.provider);
    const adapter = accountAdapterFor(provider, account);
    const transport = adapter.transportFor(clientId);
    if (transport === 'unsupported') {
      continue;
    }
    const ref = adapter.sourceRef;
    const source = provider.accountSource
      ? await provider.accountSource(account.snapshotDir)
      : { id: provider.id, name: provider.shortName ?? provider.name };
    const native = transport === 'direct';
    rows.push({
      ref,
      value: serializeRef(ref),
      label: `${source.name} · ${account.meta.name}`,
      detail: native
        ? `${identityDisplayText(listed.identity, account.meta.name)} · native account`
        : `${identityDisplayText(listed.identity, source.name)} · ${transportLabel(transport)}`,
      providerId: listed.provider,
      sourceId: source.id,
      transport,
      category: native ? 'native' : 'gateway',
    });
  }

  for (const provider of app.accounts.listProviders()) {
    const pool = await app.pools.get(provider.id);
    if (!pool || pool.mode !== 'multi') {
      continue;
    }
    const resolved = await materializeResolvedSource(
      { kind: 'account-pool', provider: provider.id },
      app,
    );
    const transport = resolved.adapter.transportFor(clientId);
    if (transport === 'unsupported') {
      continue;
    }
    rows.push({
      ref: resolved.ref,
      value: serializeRef(resolved.ref),
      label: displayRef(resolved.ref),
      detail: `${pool.members.filter((member) => member.enabled).length} enabled · ${transportLabel(transport)}`,
      providerId: provider.id,
      sourceId: provider.id,
      transport,
      category: 'gateway',
    });
  }

  for (const profile of await app.profiles.list()) {
    const catalogProvider = app.catalog.has(profile.meta.provider)
      ? app.catalog.get(profile.meta.provider)
      : undefined;
    const adapter = gatewayAdapterFromProfile(profile, {
      catalogProvider,
      clients: app.clients,
    });
    const transport = adapter.transportFor(clientId);
    if (transport === 'unsupported') {
      continue;
    }
    const ref = adapter.sourceRef;
    rows.push({
      ref,
      value: serializeRef(ref),
      label: displayRef(ref),
      detail: `${catalogProvider?.name ?? profile.meta.provider} · ${transportLabel(transport)}`,
      providerId: profile.meta.provider,
      sourceId: profile.meta.provider,
      transport,
      category: 'gateway',
    });
  }

  // The Hub is deliberately one explicit source rather than a set of provider
  // aliases. Its token-scoped manifest chooses the provider after the client
  // chooses a model, so users never need model prefixes such as `cx/` or `kr/`.
  const hub = await app.hub.get();
  if (hub.enabled) {
    const resolved = await materializeResolvedSource({ kind: 'proxy-hub', name: hub.name }, app);
    const transport = resolved.adapter.transportFor(clientId);
    if (transport !== 'unsupported') {
      rows.push({
        ref: resolved.ref,
        value: serializeRef(resolved.ref),
        label: 'Proxy Hub',
        detail: `${hub.sources.filter((source) => source.enabled).length} sources · ${transportLabel(transport)}`,
        providerId: 'proxy-hub',
        sourceId: hub.name,
        transport,
        category: 'gateway',
      });
    }
  }

  for (const preset of app.presets.list()) {
    if (preset.spec.client !== clientId) {
      continue;
    }
    try {
      const source = await materializeResolvedSource(preset.spec.source, app);
      const transport = source.adapter.transportFor(clientId);
      if (transport === 'unsupported') {
        continue;
      }
      const ref = { kind: 'preset' as const, name: preset.name };
      rows.push({
        ref,
        value: serializeRef(ref),
        label: displayRef(ref),
        detail: `${source.display} · saved setup`,
        providerId: source.adapter.capabilities.provider,
        sourceId: source.adapter.capabilities.provider,
        transport,
        category: 'saved',
      });
    } catch {
      // Broken presets belong in Doctor; the route picker only offers usable choices.
    }
  }

  return rows.toSorted((a, b) => {
    const categoryRank: Record<AppRouteSourceCategory, number> = {
      native: 0,
      gateway: 1,
      saved: 2,
    };
    const category = categoryRank[a.category] - categoryRank[b.category];
    if (category !== 0) {
      return category;
    }
    if (a.ref.kind === 'preset' && b.ref.kind !== 'preset') {
      return -1;
    }
    if (a.ref.kind !== 'preset' && b.ref.kind === 'preset') {
      return 1;
    }
    return a.label.localeCompare(b.label);
  });
}

function policyModels(policy: {
  suggestModels?: () => Record<string, string>;
  roleFriendlyModels?: () => readonly string[];
  staticFallbackModels?: () => readonly string[];
}): string[] {
  return [
    ...Object.values(policy.suggestModels?.() ?? {}),
    ...(policy.roleFriendlyModels?.() ?? []),
    ...(policy.staticFallbackModels?.() ?? []),
  ];
}

export async function modelSuggestionsForRoute(
  app: AnyPickApp,
  row: AppRouteSourceRow,
): Promise<{ suggestions: string[]; source: 'catalog' | 'empty'; defaultModel?: string }> {
  const values: Array<string | undefined> = [];
  let defaultModel: string | undefined;

  if (row.ref.kind === 'preset') {
    const preset = app.presets.getByName(row.ref.name);
    if (preset?.spec.model.mode === 'explicit') {
      defaultModel = preset.spec.model.id;
      values.push(defaultModel);
    }
  } else if (row.ref.kind === 'gateway') {
    const profile = await app.profiles.get(row.ref.name);
    defaultModel = profile.meta.defaultModel;
    const configured = Object.values(profile.meta.models);
    values.push(...configured);
    if (configured.length === 0) {
      values.push(defaultModel);
    }
    if (configured.length === 0 && app.catalog.has(profile.meta.provider)) {
      values.push(...policyModels(app.catalog.get(profile.meta.provider)));
    }
  } else if (row.ref.kind === 'proxy-hub') {
    const hub = await app.hub.get(row.ref.name);
    try {
      const preview = await app.hub.preview(row.ref.name);
      values.push(...preview.routes.map((route) => route.model));
    } catch {
      // Keep explicitly resolved conflicts selectable as a last resort; the
      // activation validation will still reject models unavailable at attach.
      values.push(...hub.modelOwners.map((owner) => owner.model));
    }
  } else {
    const providerId = row.ref.provider;
    if (app.accountRegistry.has(providerId)) {
      values.push(...policyModels(app.accountRegistry.get(providerId)));
    }
  }

  const suggestions = [
    ...new Set(values.map((value) => value?.trim()).filter(Boolean)),
  ] as string[];
  return { suggestions, source: suggestions.length ? 'catalog' : 'empty', defaultModel };
}

export function routePlanLines(
  plan: ActivationPlan,
  modelRoles: Record<string, string>,
  opts: { nativeAccount?: boolean } = {},
): string[] {
  const primaryModel = modelRoles.default?.trim();
  const transport = plan.transport.capability.replaceAll('_', ' ');
  const lines = [
    `App       ${plan.client}`,
    `Source    ${plan.resolvedSource.display}`,
    ...(opts.nativeAccount ? [] : [`Model     ${primaryModel || 'source default'}`]),
    `Scope     ${plan.mode === 'persistent' ? 'global default' : plan.mode}`,
    `Transport ${transport}`,
    '',
    'AnyPick will:',
  ];
  for (const step of plan.steps.filter((item) => item.kind !== 'ResolveSource').slice(0, 8)) {
    lines.push(`· ${step.detail ?? step.kind.replaceAll(/([a-z])([A-Z])/g, '$1 $2')}`);
  }
  return lines;
}
