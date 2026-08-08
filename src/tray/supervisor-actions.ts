import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AnyPickApp } from '../core/app';
import { proxyHubIssueCount } from '../core/proxy-hub-service';
import { displayRef } from '../core/refs';
import { AnyPickError } from '../utils/errors';
import type { TrayActivityKind, TrayActivityService } from './activity';
import { resolveTrayModelRoleActions } from './model-role-actions';
import type { TrayApplyModelRolesCommand, TrayInvokeCommand } from './protocol';
import type { TrayActionTarget, TrayProxyActionTarget } from './snapshot-types';
import { recordTrayActivity } from './supervisor-activity';
import { trayActionError, trayModelRolesError, trayProxyActionError } from './supervisor-errors';
import type { TrayCommandResult } from './supervisor-native';
import { sendResult } from './supervisor-native';

export interface TrayActionSet {
  targets: Map<string, TrayActionTarget | TrayProxyActionTarget>;
  labels: Map<string, string>;
}

export async function invokeTrayModelRoles(
  app: AnyPickApp,
  native: ChildProcessWithoutNullStreams,
  payload: TrayApplyModelRolesCommand,
  actionSets: Map<number, TrayActionSet>,
  activity: TrayActivityService,
  refresh: () => Promise<void>,
  invalidateUsage: () => void,
): Promise<void> {
  const respond = (result: Omit<TrayCommandResult, 'version' | 'requestId'>) => {
    sendResult(native, { version: 1, requestId: payload.requestId, ...result });
  };
  const actionSet = resolveActionSetForRoleIds(actionSets, payload.revision, payload.roleActionIds);
  if (!actionSet) {
    respond({ status: 'error', message: 'The model list changed. Open models and try again.' });
    return;
  }

  try {
    const client = app.clients.get(payload.clientId);
    const resolved = resolveTrayModelRoleActions(
      client,
      actionSet.targets,
      payload.clientId,
      payload.roleActionIds,
    );
    await app.bindingService.use(payload.clientId, {
      with: resolved.source,
      model: resolved.defaultModel,
      modelRoles: resolved.modelRoles,
      verbose: false,
    });
    invalidateUsage();
    const overrides = Math.max(0, Object.keys(resolved.modelRoles).length - 1);
    const message =
      overrides === 0
        ? `${client.name} now uses ${resolved.defaultModel} for every model role.`
        : `Updated ${client.name}: ${overrides} custom model role${overrides === 1 ? '' : 's'}.`;
    await recordTrayActivity(activity, message, false, 'switch');
    await refresh().catch((refreshErr: unknown) => {
      process.stderr.write(`[tray] ${trayActionError(refreshErr)}\n`);
    });
    respond({ status: 'success', message });
  } catch (err) {
    invalidateUsage();
    const message = trayModelRolesError(err);
    process.stderr.write(`[tray] ${message}\n`);
    await recordTrayActivity(activity, message, true, 'switch');
    await refresh().catch(() => {});
    respond({ status: 'error', message });
  }
}

/**
 * Apply one menu action through the persistent activation service. Keeping
 * this in the supervisor means tray clicks get the same plan/journal/rollback
 * guarantees as `anypick use`; provider account services are never called
 * directly from the UI process.
 */
export async function invokeTrayAction(
  app: AnyPickApp,
  native: ChildProcessWithoutNullStreams,
  payload: TrayInvokeCommand,
  actionSets: Map<number, TrayActionSet>,
  activity: TrayActivityService,
  refresh: () => Promise<void>,
  invalidateUsage: () => void,
): Promise<void> {
  const respond = (result: Omit<TrayCommandResult, 'version' | 'requestId'>) => {
    sendResult(native, {
      version: 1,
      requestId: payload.requestId,
      ...result,
    });
  };

  const target = resolveActionTarget(actionSets, payload.revision, payload.actionId);
  if (!target) {
    const message = 'That account is no longer available. Refresh AnyPick.';
    await recordTrayActivity(activity, message, true, 'switch');
    respond({ status: 'error', message });
    return;
  }
  const actionSet = actionSetContaining(actionSets, payload.revision, payload.actionId);
  if (!actionSet) {
    const message = 'The tray menu changed. Please try again.';
    await recordTrayActivity(activity, message, true, 'system');
    respond({ status: 'error', message });
    return;
  }

  try {
    let resultMessage: string;
    if ('operation' in target) {
      const actionMessage = await invokeProxyAction(app, target);
      resultMessage =
        actionMessage ??
        (target.operation === 'disable'
          ? `Stopped ${actionSet.labels.get(payload.actionId) ?? 'proxy'}.`
          : target.operation === 'restart'
            ? `Restarted ${actionSet.labels.get(payload.actionId) ?? 'proxy'}.`
            : `Started ${actionSet.labels.get(payload.actionId) ?? 'proxy'}.`);
      if (target.operation === 'account-switch') {
        invalidateUsage();
      }
    } else {
      await app.bindingService.use(target.clientId, {
        with: target.source,
        model: target.model,
        modelRoles: target.modelRoles,
        verbose: false,
      });
      invalidateUsage();
      resultMessage = `Switched to ${actionSet.labels.get(payload.actionId) ?? 'the selected account'}.`;
    }
    // The activation is already journalled and committed at this point. A
    // transient status refresh must not turn a successful switch into a false
    // failure in the tray UI.
    const activityKind: TrayActivityKind =
      'operation' in target
        ? target.operation === 'account-switch'
          ? 'switch'
          : 'proxy'
        : 'switch';
    await recordTrayActivity(activity, resultMessage, false, activityKind);
    await refresh().catch((refreshErr: unknown) => {
      process.stderr.write(`[tray] ${trayActionError(refreshErr)}\n`);
    });
    respond({
      status: 'success',
      message: resultMessage,
    });
  } catch (err) {
    const message =
      'operation' in target ? trayProxyActionError(err, target.operation) : trayActionError(err);
    invalidateUsage();
    process.stderr.write(`[tray] ${message}\n`);
    const activityKind: TrayActivityKind =
      'operation' in target
        ? target.operation === 'account-switch'
          ? 'switch'
          : 'proxy'
        : 'switch';
    await recordTrayActivity(activity, message, true, activityKind);
    await refresh().catch((refreshErr: unknown) => {
      process.stderr.write(`[tray] ${trayActionError(refreshErr)}\n`);
    });
    respond({ status: 'error', message });
  }
}

export async function invokeProxyAction(
  app: AnyPickApp,
  target: TrayProxyActionTarget,
): Promise<string | undefined> {
  switch (target.operation) {
    case 'hub-own-models': {
      await app.hub.setModelOwners(target.name, target.models, target.source);
      return `Routed ${target.models.length} overlapping model${target.models.length === 1 ? '' : 's'} through ${displayRef(target.source)}.`;
    }
    case 'hub-test': {
      const config = await app.hub.get(target.name);
      if (!config.enabled || !config.sources.some((source) => source.enabled)) {
        throw new AnyPickError(
          'Proxy Hub test needs at least one explicitly enabled source.',
          'STATE_CONFLICT',
        );
      }
      const preview = await app.hub.refreshPreview(target.name);
      if (preview.unavailable.length > 0) {
        throw new AnyPickError(
          `Proxy Hub test found ${preview.unavailable.length} unavailable source${preview.unavailable.length === 1 ? '' : 's'}.`,
          'STATE_CONFLICT',
        );
      }
      if (preview.routes.length === 0) {
        throw new AnyPickError(
          'Proxy Hub test found no routable models. Resolve conflicts and retry.',
          'STATE_CONFLICT',
        );
      }
      const issueCount = proxyHubIssueCount(preview);
      if (issueCount > 0) {
        throw new AnyPickError(
          `Proxy Hub test found ${issueCount} unresolved routing ${issueCount === 1 ? 'choice' : 'choices'}.`,
          'STATE_CONFLICT',
        );
      }
      await app.hub.ensureRunning(target.name);
      return `Proxy Hub check passed: ${preview.catalogs.length} source${preview.catalogs.length === 1 ? '' : 's'} and ${preview.routes.length} routable model${preview.routes.length === 1 ? '' : 's'}.`;
    }
    case 'hub-start': {
      const hub = await app.hub.get(target.name);
      if (!hub.enabled) {
        await app.hub.save({ ...hub, enabled: true });
      }
      await app.hub.ensureRunning(target.name);
      return 'Started Proxy Hub.';
    }
    case 'hub-stop':
      await app.hub.stop(target.name);
      return 'Stopped Proxy Hub.';
    case 'hub-restart': {
      const hub = await app.hub.get(target.name);
      if (!hub.enabled) {
        await app.hub.save({ ...hub, enabled: true });
      }
      await app.hub.stop(target.name);
      await app.hub.ensureRunning(target.name);
      return 'Restarted Proxy Hub.';
    }
    case 'account-switch': {
      const result = await app.accounts.use(target.providerId, target.accountName);
      const provider = app.accountRegistry.get(target.providerId);
      return `Switched ${provider.shortName ?? provider.name} to ${result.to}.`;
    }
    case 'enable':
      await app.proxy.enableProxy(target.providerId, target.accountName, { start: true });
      return undefined;
    case 'disable':
      await app.proxy.disableProxy(target.providerId, target.accountName);
      return undefined;
    case 'restart': {
      const status = await app.proxy.proxyStatus(target.providerId, target.accountName);
      if (status.running) {
        await app.proxy.stopProxy(target.providerId, target.accountName);
      }
      if (status.enabled) {
        await app.proxy.startProxy(target.providerId, target.accountName);
      } else {
        await app.proxy.enableProxy(target.providerId, target.accountName, { start: true });
      }
      return undefined;
    }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/**
 * Find an action set that still carries the given action id, preferring the
 * revision the UI displayed but tolerating a stale one. The supervisor only
 * keeps the two most recent snapshot generations (2.5s apart), so a click
 * racing the refresh — or coming from a panel that paused stdin — would
 * otherwise be rejected with a false "menu changed" error. Action ids are
 * stable across snapshots, so the exact target the UI rendered still exists.
 */
function resolveActionTarget(
  actionSets: Map<number, TrayActionSet>,
  revision: number,
  actionId: string,
): TrayActionTarget | TrayProxyActionTarget | undefined {
  const preferred = actionSets.get(revision)?.targets.get(actionId);
  if (preferred) {
    return preferred;
  }
  for (const set of actionSets.values()) {
    const target = set.targets.get(actionId);
    if (target) {
      return target;
    }
  }
  return undefined;
}

function actionSetContaining(
  actionSets: Map<number, TrayActionSet>,
  revision: number,
  actionId: string,
): TrayActionSet | undefined {
  const preferred = actionSets.get(revision);
  if (preferred?.targets.has(actionId)) {
    return preferred;
  }
  for (const set of actionSets.values()) {
    if (set.targets.has(actionId)) {
      return set;
    }
  }
  return undefined;
}

/**
 * Resolve an apply-model-roles command against a single action set that carries
 * every referenced role id. Falls back across retained generations the same way
 * resolveActionTarget does, so a stale revision does not reject a valid apply.
 */
function resolveActionSetForRoleIds(
  actionSets: Map<number, TrayActionSet>,
  revision: number,
  roleActionIds: Readonly<Record<string, string>>,
): TrayActionSet | undefined {
  const actionIds = Object.values(roleActionIds);
  const hasAll = (set: TrayActionSet) => actionIds.every((id) => set.targets.has(id));
  const preferred = actionSets.get(revision);
  if (preferred && hasAll(preferred)) {
    return preferred;
  }
  for (const set of actionSets.values()) {
    if (hasAll(set)) {
      return set;
    }
  }
  return undefined;
}
