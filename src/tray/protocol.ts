/** Commands emitted by the native tray helper over its stdout pipe. */
export const TRAY_PROTOCOL_VERSION = 1;
export const MAX_TRAY_COMMAND_BYTES = 16 * 1024;

export interface TrayInvokeCommand {
  version: 1;
  requestId: string;
  revision: number;
  actionId: string;
}

export interface TrayApplyModelRolesCommand {
  version: 1;
  requestId: string;
  revision: number;
  clientId: string;
  /** Role id -> opaque model action id from this exact snapshot revision. */
  roleActionIds: Record<string, string>;
}

export interface TrayLogsCommand {
  version: 1;
  requestId: string;
  providerId: string;
  name: string;
  lines: number;
}

export type TrayProxyLogsState = 'ready' | 'empty' | 'not-running' | 'error';

export interface TrayProxyLogsResult {
  version: 1;
  requestId: string;
  proxyId: string;
  state: TrayProxyLogsState;
  text: string;
}

/** Stable identity shared by snapshot rows, log requests, and log responses. */
export function trayLogSourceId(providerId: string, name: string): string {
  return `${providerId}/${name}`;
}

export type TrayMutationOperation =
  | 'account-detect'
  | 'account-save'
  | 'account-edit'
  | 'account-refresh'
  | 'account-remove'
  /** Clear the live app login (stash: optional backup + local wipe, no remote logout). */
  | 'account-clear'
  | 'gateway-create'
  | 'gateway-edit'
  | 'gateway-refresh'
  | 'gateway-remove'
  | 'client-reset'
  | 'hub-source-toggle'
  | 'proxy-restart-all'
  | 'proxy-stop-all'
  | 'setting-launch-at-login'
  | 'setting-auto-start-proxies'
  | 'setting-show-quota'
  | 'setting-quota-guard';

export interface TrayMutationCommand {
  version: 1;
  requestId: string;
  operation: TrayMutationOperation;
  providerId?: string;
  sourceId?: string;
  name: string;
  label?: string;
  endpoint?: string;
  apiKey?: string;
  /** Non-secret credential qualifier (e.g. Kiro API region) for account-save. */
  region?: string;
  defaultModel?: string;
  overwrite?: boolean;
  enabled?: boolean;
}

export type TrayCommand =
  | { kind: 'open' | 'refresh' | 'restart' | 'stop' | 'quit' }
  | {
      kind: 'navigate';
      screen: 'accounts' | 'gateways' | 'proxy' | 'proxy-hub' | 'add-account' | 'add-gateway';
    }
  | { kind: 'apply-model-roles'; payload: TrayApplyModelRolesCommand }
  | { kind: 'logs'; payload: TrayLogsCommand }
  | { kind: 'mutate'; payload: TrayMutationCommand }
  | { kind: 'invoke'; payload: TrayInvokeCommand };

type SimpleTrayCommandKind = 'open' | 'refresh' | 'restart' | 'stop' | 'quit';

const SIMPLE_COMMANDS = new Set<SimpleTrayCommandKind>([
  'open',
  'refresh',
  'restart',
  'stop',
  'quit',
]);
const INVOKE_PREFIX = 'invoke\t';
const MODEL_ROLES_PREFIX = 'model-roles\t';
const LOGS_PREFIX = 'logs\t';
const MUTATE_PREFIX = 'mutate\t';
const NAVIGATE_PREFIX = 'navigate\t';
const NAVIGATE_SCREENS = new Set([
  'accounts',
  'gateways',
  'proxy',
  'proxy-hub',
  'add-account',
  'add-gateway',
]);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes one complete command line from the native tray helper.
 *
 * The helper is a separate process, so malformed input is ignored rather than
 * allowed to disrupt proxy supervision.
 */
export function decodeTrayCommand(line: string): TrayCommand | undefined {
  try {
    if (Buffer.byteLength(line, 'utf8') > MAX_TRAY_COMMAND_BYTES) {
      return undefined;
    }

    if (SIMPLE_COMMANDS.has(line as SimpleTrayCommandKind)) {
      return { kind: line as SimpleTrayCommandKind };
    }

    if (line.startsWith(NAVIGATE_PREFIX)) {
      const screen = line.slice(NAVIGATE_PREFIX.length);
      if (NAVIGATE_SCREENS.has(screen)) {
        return {
          kind: 'navigate',
          screen: screen as
            | 'accounts'
            | 'gateways'
            | 'proxy'
            | 'proxy-hub'
            | 'add-account'
            | 'add-gateway',
        };
      }
      return undefined;
    }

    const encoded = line.startsWith(INVOKE_PREFIX)
      ? line.slice(INVOKE_PREFIX.length)
      : line.startsWith(MODEL_ROLES_PREFIX)
        ? line.slice(MODEL_ROLES_PREFIX.length)
        : line.startsWith(LOGS_PREFIX)
          ? line.slice(LOGS_PREFIX.length)
          : line.startsWith(MUTATE_PREFIX)
            ? line.slice(MUTATE_PREFIX.length)
            : undefined;
    if (encoded === undefined) {
      return undefined;
    }
    if (
      encoded.length === 0 ||
      Buffer.byteLength(encoded, 'utf8') > MAX_TRAY_COMMAND_BYTES ||
      !CANONICAL_BASE64.test(encoded)
    ) {
      return undefined;
    }

    const bytes = Buffer.from(encoded, 'base64');
    const decoded = bytes.toString('utf8');
    if (
      bytes.length > MAX_TRAY_COMMAND_BYTES ||
      bytes.toString('base64') !== encoded ||
      !bytes.equals(Buffer.from(decoded, 'utf8'))
    ) {
      return undefined;
    }

    const value: unknown = JSON.parse(decoded);
    if (line.startsWith(INVOKE_PREFIX)) {
      return isTrayInvokeCommand(value) ? { kind: 'invoke', payload: value } : undefined;
    }
    if (line.startsWith(MODEL_ROLES_PREFIX)) {
      return isTrayApplyModelRolesCommand(value)
        ? { kind: 'apply-model-roles', payload: value }
        : undefined;
    }
    if (line.startsWith(LOGS_PREFIX)) {
      return isTrayLogsCommand(value) ? { kind: 'logs', payload: value } : undefined;
    }
    return isTrayMutationCommand(value) ? { kind: 'mutate', payload: value } : undefined;
  } catch {
    return undefined;
  }
}

function isTrayLogsCommand(value: unknown): value is TrayLogsCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).every((key) =>
      ['version', 'requestId', 'providerId', 'name', 'lines'].includes(key),
    ) &&
    candidate.version === TRAY_PROTOCOL_VERSION &&
    safeTrayString(candidate.requestId, 128, false) &&
    safeTrayString(candidate.providerId, 64, false) &&
    safeTrayString(candidate.name, 128, false) &&
    typeof candidate.lines === 'number' &&
    Number.isSafeInteger(candidate.lines) &&
    candidate.lines >= 1 &&
    candidate.lines <= 200
  );
}

function isTrayMutationCommand(value: unknown): value is TrayMutationCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'requestId',
    'operation',
    'providerId',
    'sourceId',
    'name',
    'label',
    'endpoint',
    'apiKey',
    'region',
    'defaultModel',
    'overwrite',
    'enabled',
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    return false;
  }
  if (
    candidate.version !== TRAY_PROTOCOL_VERSION ||
    !safeTrayString(candidate.requestId, 128, false) ||
    !safeTrayString(candidate.name, 128, false) ||
    !isMutationOperation(candidate.operation)
  ) {
    return false;
  }
  for (const [key, limit] of [
    ['providerId', 64],
    ['sourceId', 64],
    ['label', 160],
    ['endpoint', 2048],
    ['apiKey', 8192],
    ['region', 64],
    ['defaultModel', 256],
  ] as const) {
    if (candidate[key] !== undefined && !safeTrayString(candidate[key], limit, true)) {
      return false;
    }
  }
  if (candidate.overwrite !== undefined && typeof candidate.overwrite !== 'boolean') {
    return false;
  }
  if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
    return false;
  }
  const needsProvider =
    candidate.operation === 'account-detect' ||
    candidate.operation === 'account-save' ||
    candidate.operation === 'account-edit' ||
    candidate.operation === 'account-refresh' ||
    candidate.operation === 'account-remove' ||
    candidate.operation === 'account-clear' ||
    candidate.operation === 'gateway-create' ||
    candidate.operation === 'hub-source-toggle';
  const isSetting = candidate.operation.startsWith('setting-');
  const needsEnabled = isSetting || candidate.operation === 'hub-source-toggle';
  return (
    (!needsProvider || safeTrayString(candidate.providerId, 64, false)) &&
    (!needsEnabled || typeof candidate.enabled === 'boolean')
  );
}

function isMutationOperation(value: unknown): value is TrayMutationOperation {
  return (
    value === 'account-detect' ||
    value === 'account-save' ||
    value === 'account-edit' ||
    value === 'account-refresh' ||
    value === 'account-remove' ||
    value === 'account-clear' ||
    value === 'gateway-create' ||
    value === 'gateway-edit' ||
    value === 'gateway-refresh' ||
    value === 'gateway-remove' ||
    value === 'client-reset' ||
    value === 'hub-source-toggle' ||
    value === 'proxy-restart-all' ||
    value === 'proxy-stop-all' ||
    value === 'setting-launch-at-login' ||
    value === 'setting-auto-start-proxies' ||
    value === 'setting-show-quota' ||
    value === 'setting-quota-guard'
  );
}

function safeTrayString(value: unknown, maxLength: number, allowEmpty: boolean): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxLength &&
    !value.includes(String.fromCharCode(0)) &&
    !value.includes('\n') &&
    !value.includes('\r')
  );
}

function isTrayInvokeCommand(value: unknown): value is TrayInvokeCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === TRAY_PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 128 &&
    typeof candidate.revision === 'number' &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    typeof candidate.actionId === 'string' &&
    candidate.actionId.length > 0 &&
    candidate.actionId.length <= 128
  );
}

function isTrayApplyModelRolesCommand(value: unknown): value is TrayApplyModelRolesCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !['version', 'requestId', 'revision', 'clientId', 'roleActionIds'].includes(key),
    ) ||
    candidate.version !== TRAY_PROTOCOL_VERSION ||
    !safeTrayString(candidate.requestId, 128, false) ||
    !safeTrayString(candidate.clientId, 64, false) ||
    typeof candidate.revision !== 'number' ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0 ||
    candidate.roleActionIds === null ||
    typeof candidate.roleActionIds !== 'object' ||
    Array.isArray(candidate.roleActionIds)
  ) {
    return false;
  }
  const entries = Object.entries(candidate.roleActionIds as Record<string, unknown>);
  return (
    entries.length >= 1 &&
    entries.length <= 16 &&
    entries.some(([roleId]) => roleId === 'default') &&
    entries.every(
      ([roleId, actionId]) =>
        safeTrayString(roleId, 64, false) && safeTrayString(actionId, 128, false),
    )
  );
}
