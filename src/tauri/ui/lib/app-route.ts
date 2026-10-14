/**
 * The Apps connection flow, ported from `src/macos/AppSheets.swift`.
 *
 * The stages, the grouping, and the rules that decide whether the model step
 * appears at all live here rather than in the sheet, so each one is testable
 * without a webview.
 */

import type { ActionRow, ClientModelConfig, Snapshot } from './contract';
import { isAppRouteConfigured, nativeProviderName, uniqueCompatibleRoutes } from './model';

export type RouteStage = 'connection' | 'models' | 'review' | 'applying' | 'success' | 'recovery';

export type RouteKind = 'account' | 'hub' | 'gateway';

/** One selectable connection, grouped the way the sheet groups it. */
export type RouteOption = {
  id: string;
  label: string;
  detail: string;
  kind: RouteKind;
  /** The provider whose icon and name the row shows. */
  providerId: string;
  actionId: string;
  /** The client this connection belongs to, so the sheet can name it. */
  client: string;
  enabled: boolean;
  disabledReason?: string;
  selected: boolean;
};

export type RouteGroups = {
  current: RouteOption | null;
  accounts: RouteOption[];
  hub: RouteOption | null;
  gateways: RouteOption[];
};

/**
 * The provider out of a serialized source ref.
 *
 * `ActionRow.sourceId` is `refs.SerializeRef` output — `account/claude/work`,
 * `gateway/team`, `hub/default` — not a bare provider id. Handing the
 * whole ref to `nativeProviderName` titles an account row "Account", which is
 * what the scope picker showed until this was read off the ref.
 *
 * macOS reaches the same answer through `providerID(forRoute:)` and falls back
 * to the account's own provider when the ref does not name one.
 */
export function providerFromSourceRef(sourceId: string): string {
  const parts = sourceId.split('/');
  if (parts[0] === 'account' && parts.length >= 2) return parts[1] as string;
  // The engine serializes a hub ref as `hub/<name>` (`refs.SerializeRef`,
  // `KindProxyHub`) — `proxy-hub/default` is a *proxy row* id, a different
  // namespace, and reading it here meant a real hub connection row titled
  // itself "Hub/Default" and wore a server rack instead of the hub's triangle.
  if (parts[0] === 'hub' || parts[0] === 'proxy-hub') return 'proxy-hub';
  // A gateway ref names the gateway, not the vendor behind it. Guessing one
  // here made every gateway row wear the OpenRouter mark — a wrong brand on
  // rows for LiteLLM, Cloudflare and anything else. The caller resolves it from
  // the snapshot, where the vendor is actually recorded.
  if (parts[0] === 'gateway') return '';
  return sourceId;
}

/**
 * `snapshot.gateways`, keyed by **name**, for resolving a gateway ref.
 *
 * `refs.SerializeRef(refs.GatewayRef(name))` is `gateway/<name>`, so the name
 * is the key. Keying on the gateway id resolved nothing at all — the two
 * differ whenever a user has renamed one.
 */
export function gatewayProviders(gateways: readonly { name: string; providerId: string }[]): Map<string, string> {
  return new Map(gateways.map((gateway) => [gateway.name, gateway.providerId]));
}

const KIND_OF: Record<string, RouteKind> = {
  hub: 'hub',
  gateway: 'gateway',
  'managed-account': 'account',
  'direct-account': 'account',
  'app-route': 'account',
};

/**
 * `compatibleAccountRoutes` plus the hub and the gateways, in the order the
 * sheet renders them.
 *
 * The selected row is kept exactly once and pinned to the top as "Current", so
 * the user is never offered the connection they already have as a change.
 */
export function routeGroups(
  rows: readonly ActionRow[],
  gatewayProvider: (gatewayId: string) => string | undefined = () => undefined,
): RouteGroups {
  const unique = uniqueCompatibleRoutes([...rows]);

  const providerOf = (sourceId: string) => {
    const direct = providerFromSourceRef(sourceId);
    if (direct) return direct;
    const parts = sourceId.split('/');
    return parts[0] === 'gateway' ? (gatewayProvider(parts.slice(1).join('/')) ?? '') : '';
  };

  const toOption = (row: ActionRow): RouteOption => ({
    id: row.id,
    label: row.label,
    detail: row.detail ?? '',
    kind: KIND_OF[row.routeKind ?? row.kind] ?? 'account',
    providerId: providerOf(row.sourceId),
    actionId: row.id,
    client: row.client,
    enabled: row.enabled && !row.disabledReason,
    disabledReason: row.disabledReason,
    selected: row.selected,
  });

  const options = unique.map(toOption);
  return {
    current: options.find((option) => option.selected) ?? null,
    accounts: options.filter((option) => option.kind === 'account' && !option.selected),
    hub: options.find((option) => option.kind === 'hub' && !option.selected) ?? null,
    gateways: options.filter((option) => option.kind === 'gateway' && !option.selected),
  };
}

/** Every option, current included. The search field counts these, not the rest. */
export function allRouteOptions(groups: RouteGroups): RouteOption[] {
  return [...(groups.current ? [groups.current] : []), ...groups.accounts, ...(groups.hub ? [groups.hub] : []), ...groups.gateways];
}

/**
 * Above this many options the sheet grows a search field. macOS uses 6
 * (`showsConnectionSearch`); below it a field is a control for a list of four.
 */
const SEARCH_THRESHOLD = 6;

export function showsConnectionSearch(groups: RouteGroups): boolean {
  return allRouteOptions(groups).length > SEARCH_THRESHOLD;
}

/** macOS's `matchesRouteSearch`: name, detail, and provider all count. */
export function matchesRouteSearch(option: RouteOption, needle: string): boolean {
  const query = needle.trim().toLocaleLowerCase();
  if (!query) return true;
  return (
    option.label.toLocaleLowerCase().includes(query) ||
    option.detail.toLocaleLowerCase().includes(query) ||
    option.providerId.toLocaleLowerCase().includes(query)
  );
}

export function filteredRouteGroups(groups: RouteGroups, needle: string): RouteGroups {
  const keep = (option: RouteOption | null): RouteOption | null =>
    option && matchesRouteSearch(option, needle) ? option : null;
  return {
    current: groups.current,
    accounts: groups.accounts.filter((option) => matchesRouteSearch(option, needle)),
    hub: keep(groups.hub),
    gateways: groups.gateways.filter((option) => matchesRouteSearch(option, needle)),
  };
}

export function hasMatchingConnection(groups: RouteGroups): boolean {
  return (
    groups.accounts.length > 0 || groups.hub !== null || groups.gateways.length > 0
  );
}

/**
 * What the empty section says. Three distinct states, because "nothing
 * configured" and "nothing matches your search" call for different actions.
 */
export function noConnectionCopy(input: {
  totalOptions: number;
  needle: string;
}): string {
  if (input.totalOptions === 0) return 'No compatible connections are available.';
  if (!input.needle.trim()) return 'No other compatible connections are available.';
  return `No other connections match “${input.needle.trim()}”.`;
}

/**
 * `appRouteOffersModelStep`. The model step runs only when the connection can
 * actually be edited and has options and roles.
 *
 * Model options are published per connection. Offering a picker for a route
 * the user has merely selected would let them pin a model the new connection
 * cannot serve, which is the whole reason the step runs *after* the switch.
 */
export function offersModelStep(config: ClientModelConfig | undefined): boolean {
  if (!config) return false;
  return config.editable && config.options.length > 0 && config.roles.length > 0;
}

/** `appRouteNeedsModelChoice`. True when nothing usable is pinned yet. */
export function needsModelChoice(config: ClientModelConfig | undefined): boolean {
  if (!config) return false;
  return !config.defaultModel;
}

/**
 * `modelScopeProviderName`. The family whose default the provider scope covers,
 * or nothing when the current route names no provider — then the sheet stays
 * connection-scoped, as it did before the scope picker existed.
 */
export function modelScopeProviderName(
  option: RouteOption | null,
): string | null {
  if (!option) return null;
  if (option.kind === 'hub') return 'Proxy Hub';
  if (option.kind === 'gateway') return option.label === '' ? null : option.label;
  return option.providerId ? nativeProviderName(option.providerId) : null;
}

/** What the Apply review promises. Same three promises macOS shows. */
export const APPLY_PROMISES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: 'Back up the app’s current settings', detail: 'The backup is kept in Backups.' },
  { title: 'Start a required local proxy', detail: 'Only when the new connection needs one.' },
  { title: 'Write the new app settings atomically', detail: 'A failure leaves the previous settings in place.' },
];

/** The stage a sheet is in, given what has happened so far. */
export function nextStage(input: {
  stage: RouteStage;
  /** True when the user confirmed the review and the apply is in flight. */
  applying: boolean;
  /** The engine's answer to the switch. */
  outcome: 'pending' | 'success' | 'recovery';
  needsModels: boolean;
}): RouteStage {
  if (input.stage === 'models') return 'models';
  if (input.stage === 'review' || input.stage === 'applying') {
    return input.outcome === 'recovery' ? 'recovery' : 'success';
  }
  return input.stage;
}

/**
 * The primary button's label per stage. macOS spells these out because the
 * button is the only place the user learns what pressing it does next.
 */
export function primaryTitle(stage: RouteStage, needsModels: boolean): string {
  switch (stage) {
    case 'connection':
      return 'Review Change';
    case 'models':
      return 'Save Models';
    case 'review':
      return 'Apply Changes';
    case 'applying':
      return 'Applying…';
    case 'success':
      return needsModels ? 'Choose Models' : 'Done';
    case 'recovery':
      return 'Try Again';
  }
}

/**
 * Whether the primary button is disabled. macOS disables on an unchanged
 * selection, not just an empty one, so the button cannot review a no-op.
 */
export function primaryDisabled(input: {
  routeId: string;
  currentRouteId: string;
  stage: RouteStage;
  busy: boolean;
  applying: boolean;
  awaitingModelSave: boolean;
}): boolean {
  if (input.busy || input.applying || input.awaitingModelSave) return true;
  if (!input.routeId) return true;
  return input.stage === 'connection' && input.routeId === input.currentRouteId;
}

export function showsCancel(stage: RouteStage): boolean {
  return stage !== 'applying' && stage !== 'success';
}

/** The options a role picker offers for the freshly selected connection. */
export function roleOptions(config: ClientModelConfig, roleId: string): Array<{ value: string; label: string }> {
  return [
    // Only the default is mandatory; every other role can defer to it. Sending
    // an empty map would clear the pins, and the engine refuses a map with no
    // default.
    ...(roleId === 'default' ? [] : [{ value: '', label: 'Same as Default' }]),
    ...config.options.map((option) => ({ value: option.actionId, label: option.modelId })),
  ];
}

/** The model config for one client, or undefined when the engine sent none. */
export function modelConfigFor(
  snapshot: Snapshot,
  clientId: string,
): ClientModelConfig | undefined {
  return snapshot.clientModelConfigs.find((config) => config.clientId === clientId);
}