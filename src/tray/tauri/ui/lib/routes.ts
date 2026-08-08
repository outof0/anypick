import type {
  TrayActionSnapshot,
  TrayClientModelConfigSnapshot,
} from '../../../snapshot-types';
import { providerName } from './provider';

export function routeKind(action: TrayActionSnapshot) {
  return action.routeKind ?? (action.kind === 'native' ? 'direct-account' : 'gateway');
}

export function routeTitle(action: TrayActionSnapshot) {
  if (routeKind(action) === 'hub') {
    return action.label || 'Proxy Hub';
  }
  return action.label;
}

export function routeSubtitle(action: TrayActionSnapshot) {
  if (routeKind(action) === 'hub') {
    return action.detail || 'Multi-model local endpoint';
  }
  return action.detail || providerName(action.sourceId);
}

export function routeProvider(action: TrayActionSnapshot) {
  return routeKind(action) === 'hub'
    ? action.upstreamProviderId || 'proxy-hub'
    : action.upstreamProviderId || action.sourceId;
}

export function shortAccountLabel(label: string) {
  const parts = String(label || '').split(' · ');
  const account = parts.length > 1 ? parts.slice(1).join(' · ') : String(label || '');
  const at = account.indexOf('@');
  return at >= 0 ? account.slice(0, at) : account;
}

export function chipTitle(action: TrayActionSnapshot) {
  if (routeKind(action) === 'hub') return 'Hub';
  return shortAccountLabel(action.label) || action.label;
}

export function accountLine(
  selected: TrayActionSnapshot | undefined,
  route: { source?: string } | null | undefined,
) {
  if (!selected) return route?.source || 'Not configured';
  if (routeKind(selected) === 'hub') {
    return 'Proxy Hub';
  }
  if (selected.label) return selected.label;
  if (selected.detail) return selected.detail;
  return route?.source || 'Not configured';
}

export function modelLine(
  selected: TrayActionSnapshot | undefined,
  route: { model?: string } | null | undefined,
  config: TrayClientModelConfigSnapshot | undefined,
) {
  if (route?.model) return route.model;
  return config?.modelRoles?.default ?? config?.defaultModel ?? selected?.modelId ?? null;
}

/** True when Switch / chips are useful: more than two enabled sources. */
export function routeHasAlternates(actions: TrayActionSnapshot[]) {
  return actions.filter((action) => action.enabled).length > 2;
}

export function chipActionsFor(actions: TrayActionSnapshot[], limit = 4) {
  // One (or zero) selectable sources → no chip strip.
  if (!routeHasAlternates(actions)) return [];
  const result: TrayActionSnapshot[] = [];
  const selected = actions.find((action) => action.selected);
  if (selected) result.push(selected);
  for (const action of actions) {
    if (action.selected) continue;
    if (result.length >= limit) break;
    if (routeKind(action) === 'hub' && result.some((item) => routeKind(item) === 'hub')) {
      continue;
    }
    result.push(action);
  }
  return result;
}

export function orderedModelRoles(config: TrayClientModelConfigSnapshot | undefined) {
  const roles = Array.isArray(config?.roles) ? config.roles : [];
  const roleOrder = new Map([
    ['default', 0],
    ['sonnet', 1],
    ['opus', 2],
    ['haiku', 3],
    // Codex Desktop list slots (Hub → native GPT allowlist aliases).
    ['list2', 1],
    ['list3', 2],
    ['list4', 3],
    ['list5', 4],
  ]);
  return roles.toSorted(
    (left, right) =>
      (roleOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (roleOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      String(left.label).localeCompare(String(right.label)),
  );
}

export function modelOption(
  config: TrayClientModelConfigSnapshot | undefined,
  actionId: string | null | undefined,
) {
  return (config?.options ?? []).find((option) => option.actionId === actionId);
}

export function modelOptionForId(
  config: TrayClientModelConfigSnapshot | undefined,
  modelId: string | undefined,
) {
  return (config?.options ?? []).find((option) => option.modelId === modelId);
}

export function modelSummary(config: TrayClientModelConfigSnapshot | undefined) {
  if (!config) return '';
  const defaultModel = config.defaultModel || config.modelRoles?.default;
  if (!defaultModel) return 'Models need attention';
  const custom = orderedModelRoles(config).filter(
    (role) =>
      role.id !== 'default' &&
      Object.hasOwn(config.modelRoles ?? {}, role.id) &&
      config.modelRoles[role.id] !== defaultModel,
  ).length;
  if (custom === 0) {
    return config.clientId === 'codex'
      ? `${defaultModel} · other models auto-fill`
      : `${defaultModel} · other roles inherit`;
  }
  return config.clientId === 'codex'
    ? `${defaultModel} · ${custom} model${custom === 1 ? '' : 's'} pinned`
    : `${defaultModel} · ${custom} custom role${custom === 1 ? '' : 's'}`;
}

export function activityIcon(event: { isError?: boolean; kind?: string }) {
  if (event.isError) return '⚠';
  if (event.kind === 'switch') return '⇄';
  if (event.kind === 'account') return '◎';
  return '•';
}
