import { modelRolesForClient } from '../clients';
import type { ClientAdapter } from '../types';
import { ExitCode, anypickError } from '../utils/errors';
import type { TrayActionTarget, TrayProxyActionTarget } from './snapshot-types';

export interface ResolvedTrayModelRoles {
  source: string;
  defaultModel: string;
  modelRoles: Record<string, string>;
}

/**
 * Resolve an untrusted Tray role map exclusively through one snapshot's opaque
 * action set. The helper never accepts source refs or model ids from the UI,
 * and all selected models must belong to one client + source so activation can
 * apply the four Claude slots as one journalled operation.
 */
export function resolveTrayModelRoleActions(
  client: Pick<ClientAdapter, 'id' | 'modelRoles'>,
  targets: ReadonlyMap<string, TrayActionTarget | TrayProxyActionTarget>,
  clientId: string,
  roleActionIds: Readonly<Record<string, string>>,
): ResolvedTrayModelRoles {
  if (client.id !== clientId) {
    throw invalidSelection('That app is no longer available. Refresh AnyPick and try again.');
  }

  const allowedRoles = new Set(modelRolesForClient(client).map((role) => role.id));
  if (!allowedRoles.has('default') || !roleActionIds.default) {
    throw invalidSelection('Choose a Default model before applying model settings.');
  }

  const modelRoles: Record<string, string> = {};
  let source: string | undefined;
  for (const [roleId, actionId] of Object.entries(roleActionIds)) {
    if (!allowedRoles.has(roleId)) {
      throw invalidSelection('That model role is not supported by this app.');
    }
    const target = targets.get(actionId);
    if (!target || 'operation' in target || target.clientId !== clientId) {
      throw invalidSelection(
        'The model list changed. Refresh AnyPick and choose the models again.',
      );
    }
    const model = target.model?.trim();
    if (!model) {
      throw invalidSelection('That route does not expose a selectable model.');
    }
    if (source !== undefined && target.source !== source) {
      throw invalidSelection('All role models must use the same client connection.');
    }
    source = target.source;
    modelRoles[roleId] = model;
  }

  const defaultModel = modelRoles.default;
  if (!source || !defaultModel) {
    throw invalidSelection('Choose a Default model before applying model settings.');
  }
  return { source, defaultModel, modelRoles };
}

function invalidSelection(message: string) {
  return anypickError(message, 'STATE_CONFLICT', {
    exitCode: ExitCode.CAPABILITY_CONFLICT,
  });
}
