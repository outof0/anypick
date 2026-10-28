import type { HubSource, HubStrategy, Snapshot } from './contract';
import { isRotation } from './hub';
import type { ServicePort } from './service';

/**
 * The desktop commands the macOS app already sends.
 *
 * Each function returns the operation and only the keys that operation's
 * allowlist accepts. An empty optional is omitted. An empty label on an edit
 * is kept, because the engine treats a present blank label as a clear.
 * `account-detect`, `account-clear`, and `gateway-test` still need a name
 * even though the handler does not store it, so those names are fixed sentinels.
 *
 * Panes send mutations only through these builders. Every builder has a case
 * in `test/command-corpus.ts`, whose output the Go engine must accept
 * (`internal/desktop/ui_command_corpus_test.go`). A payload built inline in a
 * pane reached the engine untested: Detect sent no name and every press was
 * refused as `MALFORMED_FRAME`.
 */

export type DesktopAction = {
  operation: string;
  extra: Record<string, unknown>;
};

/** Send a built action; returns the requestId the service assigned. */
export function mutateAction(service: Pick<ServicePort, 'mutate'>, action: DesktopAction): string {
  return service.mutate(action.operation, action.extra);
}

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

/**
 * Save the login the app already holds under a new name.
 *
 * `identity` is a display hint older hosts send; the engine derives stored
 * identity from the provider snapshot only.
 */
export function saveLiveLogin(input: {
  providerId: string;
  name: string;
  identity: string;
  sourceId?: string;
}): DesktopAction {
  return {
    operation: 'account-save',
    extra: defined({
      providerId: input.providerId,
      name: input.name.trim(),
      identity: input.identity,
      sourceId: input.sourceId,
    }),
  };
}

export function removeAccount(providerId: string, name: string): DesktopAction {
  return { operation: 'account-remove', extra: { providerId, name } };
}

/** Refresh a saved row: an account re-reads its login, a gateway is re-probed. */
export function refreshSaved(row: { kind: string; providerId: string; name: string }): DesktopAction {
  return row.kind === 'gateway'
    ? { operation: 'gateway-refresh', extra: { name: row.name } }
    : { operation: 'account-refresh', extra: { providerId: row.providerId, name: row.name } };
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

/** Save what the Add API Gateway sheet collected, sending only what was filled. */
export function createGateway(input: {
  providerId: string;
  name: string;
  endpoint?: string;
  apiKey?: string;
  label?: string;
  defaultModel?: string;
  gatewayId?: string;
  profile?: string;
}): DesktopAction {
  return {
    operation: 'gateway-create',
    extra: defined({
      providerId: input.providerId,
      name: input.name.trim(),
      label: input.label?.trim(),
      endpoint: input.endpoint?.trim(),
      apiKey: input.apiKey,
      defaultModel: input.defaultModel?.trim(),
      gatewayId: input.gatewayId?.trim(),
      profile: input.profile?.trim(),
    }),
  };
}

export function testGateway(input: {
  providerId: string;
  endpoint: string;
  apiKey?: string;
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

/** Back up every account to a temp file the engine names; there is no picker. */
export function backupAll(): DesktopAction {
  return { operation: 'account-backup-all', extra: { path: '' } };
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

export function openCodexProfile(name: string): DesktopAction {
  return { operation: 'codex-profile-open', extra: { name } };
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

export type ProxyBulkOperation = 'proxy-start-all' | 'proxy-restart-all' | 'proxy-stop-all';

export function proxyBulk(operation: ProxyBulkOperation): DesktopAction {
  return { operation, extra: { name: 'all' } };
}

/**
 * Ask the engine for a proxy's bearer. It is returned in the result only,
 * never a snapshot (ADR 0006 §6).
 */
export function proxyToken(subject: { providerId: string; name: string }): DesktopAction {
  return { operation: 'proxy-token', extra: { providerId: subject.providerId, name: subject.name } };
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
/**
 * The hub-wide request mode (ADR-0035). `enabled` rides along so an engine
 * that predates the named strategy still reads round-robin on or off.
 */
export function hubStrategyChange(hub: string, strategy: HubStrategy): DesktopAction {
  return {
    operation: 'hub-rotation',
    extra: { name: hub || 'default', strategy, enabled: strategy === 'round-robin' },
  };
}

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
