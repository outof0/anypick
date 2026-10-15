import type { HubSource, Snapshot } from './contract';
import { isRotation } from './hub';

/**
 * The desktop commands the macOS app already sends.
 *
 * Each function returns the operation and only the keys that operation's
 * allowlist accepts. An empty optional is omitted. An empty label on an edit
 * is kept, because the engine treats a present blank label as a clear.
 * `account-detect`, `account-clear`, and `gateway-test` still need a name
 * even though the handler does not store it, so those names are fixed sentinels.
 */

export type DesktopAction = {
  operation: string;
  extra: Record<string, unknown>;
};

function defined(fields: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    extra[key] = value;
  }
  return extra;
}

export function detectAccount(providerId: string, sourceId?: string): DesktopAction {
  return { operation: 'account-detect', extra: defined({ name: 'detect', providerId, sourceId }) };
}

export function saveCurrentLogin(providerId: string, sourceId?: string): DesktopAction {
  return { operation: 'account-save-current', extra: defined({ providerId, sourceId }) };
}

export function loginAccount(input: {
  providerId: string;
  methodId: string;
  sourceId?: string;
  name?: string;
  label?: string;
}): DesktopAction {
  return {
    operation: 'account-login',
    extra: defined({
      providerId: input.providerId,
      methodId: input.methodId,
      sourceId: input.sourceId,
      name: input.name?.trim(),
      label: input.label?.trim(),
    }),
  };
}

export function savePastedAuth(input: {
  providerId: string;
  name?: string;
  path: string;
  overwrite?: boolean;
}): DesktopAction {
  return {
    operation: 'account-save-auth',
    extra: defined({
      providerId: input.providerId,
      name: input.name?.trim(),
      path: input.path,
      // false would still be sent. The engine treats a missing flag as keep.
      overwrite: input.overwrite ? true : undefined,
    }),
  };
}

export function saveCredentialInput(input: {
  providerId: string;
  name: string;
  kind: string;
  apiKey: string;
  profile?: string;
}): DesktopAction {
  return {
    operation: 'account-save-input',
    extra: defined({
      providerId: input.providerId,
      name: input.name.trim(),
      kind: input.kind,
      apiKey: input.apiKey,
      profile: input.profile?.trim(),
    }),
  };
}

export function editAccount(account: { providerId: string; name: string }, label: string): DesktopAction {
  return {
    operation: 'account-edit',
    extra: { providerId: account.providerId, name: account.name, label },
  };
}

export function clearLiveLogin(providerId: string, sourceId?: string): DesktopAction {
  return { operation: 'account-clear', extra: defined({ name: 'live', providerId, sourceId }) };
}

export function createGateway(input: {
  providerId: string;
  name: string;
  endpoint?: string;
  apiKey?: string;
  label?: string;
  defaultModel?: string;
  region?: string;
  gatewayId?: string;
  profile?: string;
  kind?: string;
}): DesktopAction {
  const extra = defined({
    providerId: input.providerId,
    name: input.name.trim(),
    endpoint: input.endpoint?.trim(),
    apiKey: input.apiKey,
    label: input.label?.trim(),
    defaultModel: input.defaultModel?.trim(),
    region: input.region?.trim(),
    gatewayId: input.gatewayId?.trim(),
    profile: input.profile?.trim(),
  });
  return {
    operation: input.kind === 'account-api-key' ? 'account-save' : 'gateway-create',
    extra,
  };
}

export function testGateway(input: {
  providerId: string;
  endpoint: string;
  apiKey: string;
  profile?: string;
}): DesktopAction {
  return {
    operation: 'gateway-test',
    extra: defined({
      name: 'test',
      providerId: input.providerId,
      endpoint: input.endpoint.trim(),
      apiKey: input.apiKey,
      profile: input.profile?.trim(),
    }),
  };
}

export function editGateway(name: string, label: string): DesktopAction {
  return { operation: 'gateway-edit', extra: { name, label } };
}

export function refreshGateway(name: string): DesktopAction {
  return { operation: 'gateway-refresh', extra: { name } };
}

export function removeGateway(name: string, providerId: string): DesktopAction {
  return { operation: 'gateway-remove', extra: defined({ name, providerId }) };
}

export function exportBackup(
  path: string,
  accounts: Array<{ provider: string; name: string }>,
  overwrite: boolean,
): DesktopAction {
  return {
    operation: 'account-backup-export',
    extra: { path, accounts, overwrite },
  };
}

export function importBackup(inspectionId: string, entryIds: string[], overwriteConfirmed: boolean): DesktopAction {
  return {
    operation: 'account-backup-import',
    extra: { inspectionId, entryIds, overwriteConfirmed },
  };
}

export function forgetBackup(inspectionId: string): DesktopAction {
  return { operation: 'account-backup-forget', extra: { inspectionId } };
}

/** Entry ids that would change. A replace is skipped unless the user asked to overwrite. */
export function backupImportEntryIDs(
  selectedIds: readonly string[],
  dispositions: Readonly<Record<string, string>>,
  overwrite: boolean,
): string[] {
  return [...selectedIds].filter((id) => overwrite || dispositions[id] !== 'replace').sort();
}

export function accountFromSource(sourceId: string): { provider: string; name: string } | null {
  const parts = sourceId.split('/');
  if (parts.length !== 3 || parts[0] !== 'account' || !parts[1] || !parts[2]) return null;
  return { provider: parts[1], name: parts[2] };
}

export function gatewayFromSource(sourceId: string): string | null {
  if (!sourceId.startsWith('gateway/')) return null;
  const name = sourceId.slice('gateway/'.length);
  return name || null;
}

export function refreshModels(sourceId: string): DesktopAction | null {
  const account = accountFromSource(sourceId);
  if (account) {
    return { operation: 'account-refresh', extra: { providerId: account.provider, name: account.name } };
  }
  const gateway = gatewayFromSource(sourceId);
  if (gateway) return { operation: 'gateway-refresh', extra: { name: gateway } };
  return null;
}

/**
 * Probe a gateway that is already saved.
 *
 * The pre-create probe uses the sentinel name "test" so it cannot attach to a
 * stored profile. A saved probe uses the profile name: the engine loads the
 * stored endpoint and key and ignores anything else on the command.
 */
export function testSavedGateway(gateway: { name: string; providerId: string }): DesktopAction {
  return { operation: 'gateway-test', extra: { name: gateway.name, providerId: gateway.providerId } };
}

export type GatewayConnectRoute = {
  clientId: string;
  client: string;
  actionId: string;
  using: boolean;
};

/** Apps whose published route points at this gateway. Identity is `gateway/<name>`. */
export function gatewayConnectRoutes(snapshot: Snapshot, gatewayName: string): GatewayConnectRoute[] {
  const sourceId = `gateway/${gatewayName}`;
  const routes: GatewayConnectRoute[] = [];
  const seen = new Set<string>();
  for (const action of snapshot.actions) {
    if (action.kind !== 'gateway' || action.sourceId !== sourceId || !action.enabled) continue;
    if (seen.has(action.clientId)) continue;
    seen.add(action.clientId);
    routes.push({
      clientId: action.clientId,
      client: action.client,
      actionId: action.id,
      using: action.selected,
    });
  }
  return routes;
}

/**
 * Route invokes that make the checked apps use this gateway, and send the
 * unchecked ones that currently use it back to their native route.
 */
export function gatewayConnectInvokes(
  snapshot: Snapshot,
  gatewayName: string,
  wantedClientIds: readonly string[],
): string[] {
  const wanted = new Set(wantedClientIds);
  const invokes: string[] = [];
  for (const route of gatewayConnectRoutes(snapshot, gatewayName)) {
    if (wanted.has(route.clientId) && !route.using) {
      invokes.push(route.actionId);
      continue;
    }
    if (!wanted.has(route.clientId) && route.using) {
      const native = snapshot.actions.find(
        (action) => action.clientId === route.clientId && action.kind === 'native' && action.enabled,
      );
      if (native) invokes.push(native.id);
    }
  }
  return invokes;
}

export function resetClient(clientId: string): DesktopAction {
  return { operation: 'client-reset', extra: { name: clientId, providerId: clientId } };
}

export function validCodexProfileName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function saveCodexProfile(input: {
  name: string;
  sourceId: string;
  modelId: string;
  transportPolicy: string;
}): DesktopAction {
  return {
    operation: 'codex-profile-save',
    extra: defined({
      name: input.name,
      sourceId: input.sourceId,
      defaultModel: input.modelId,
      transportPolicy: input.transportPolicy,
    }),
  };
}

export function updateCodexProfile(input: {
  name: string;
  sourceId: string;
  modelId: string;
  transportPolicy: string;
}): DesktopAction {
  return {
    operation: 'codex-profile-update',
    extra: defined({
      name: input.name,
      sourceId: input.sourceId,
      defaultModel: input.modelId,
      transportPolicy: input.transportPolicy,
    }),
  };
}

export function removeCodexProfile(name: string): DesktopAction {
  return { operation: 'codex-profile-remove', extra: { name } };
}

export function syncCodexProfiles(sourceIds: string[]): DesktopAction {
  return { operation: 'codex-profile-sync', extra: { sourceIds } };
}

export function missingCodexProfileSources(snapshot: Snapshot): string[] {
  const profiled = new Set(snapshot.codexProfiles.map((profile) => profile.sourceId));
  return snapshot.codexProfileSources
    .filter((source) => source.kind === 'account' && !profiled.has(source.sourceId))
    .map((source) => source.sourceId);
}

export function settingChange(operation: string, enabled: boolean): DesktopAction {
  return { operation, extra: { name: 'settings', enabled } };
}

export function languageChange(language: string): DesktopAction {
  return { operation: 'setting-language', extra: { name: 'settings', language } };
}

/**
 * The wire form of one hub source switch.
 *
 * Three row kinds share one operation and are told apart by which keys are
 * present, because the engine reads `SourceID` as the account and treats
 * `pool:<provider>` as the retired pooled row:
 *   - a rotation row is `hub-rotation` and carries only the hub name;
 *   - an account source is `hub-source-toggle` and carries the provider, the
 *     account name in `sourceId`, and the explicit flag;
 *   - a pool source is `hub-source-toggle` with the pool account as
 *     `sourceId`, which is how the engine recognises it.
 *
 * `enabled` is always sent. The old presence-toggle inferred it from whether
 * the key was there, which inverted the switch.
 */
export function hubSourceChange(input: {
  hub: string;
  source: HubSource;
  enabled: boolean;
}): DesktopAction {
  const hub = input.hub || 'default';
  if (isRotation(input.source)) {
    return { operation: 'hub-rotation', extra: { name: hub, enabled: input.enabled } };
  }
  return {
    operation: 'hub-source-toggle',
    extra: {
      name: hub,
      providerId: input.source.providerId,
      sourceId: input.source.name,
      enabled: input.enabled,
    },
  };
}

export const SETTING_ROWS = [
  { key: 'launchAtLogin', operation: 'setting-launch-at-login', label: 'Open at Login' },
  { key: 'showQuota', operation: 'setting-show-quota', label: 'Show Usage Remaining' },
  { key: 'startEnabledProxies', operation: 'setting-auto-start-proxies', label: 'Start Enabled Proxies at Launch' },
  { key: 'quotaGuardEnabled', operation: 'setting-quota-guard', label: 'Skip Accounts That Reach Their Usage Limit' },
] as const;
