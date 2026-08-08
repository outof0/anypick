import {
  fail,
  fieldPath,
  isNumber,
  isOptionalNumber,
  isOptionalString,
  isRecord,
  isString,
  ok,
  type DecoderResult,
} from './primitives';

export interface DecodedAccountMeta {
  name: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  identity?: string;
  notes?: string;
  credentialKind?: 'native' | 'proxy-only';
}

export function decodeAccountMeta(v: unknown, key: string): DecoderResult<DecodedAccountMeta> {
  if (!isRecord(v)) {
    return fail(fieldPath('AccountMeta', key, '<root>'));
  }
  if (!isString(v.name)) {
    return fail(fieldPath('AccountMeta', key, 'name'));
  }
  if (!isString(v.provider)) {
    return fail(fieldPath('AccountMeta', key, 'provider'));
  }
  if (!isString(v.createdAt)) {
    return fail(fieldPath('AccountMeta', key, 'createdAt'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('AccountMeta', key, 'updatedAt'));
  }
  return ok({
    name: v.name,
    provider: v.provider,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    label: isOptionalString(v.label) ? v.label : undefined,
    identity: isOptionalString(v.identity) ? v.identity : undefined,
    notes: isOptionalString(v.notes) ? v.notes : undefined,
    // An unrecognised value decodes to native, which is the safe reading: a
    // proxy-only account is exempted from paths that touch the live login, and
    // wrongly exempting one is how a real login stops being switchable.
    credentialKind: v.credentialKind === 'proxy-only' ? 'proxy-only' : undefined,
  });
}

// ── AccountProxyConfig (v0) ───────────────────────────────────

export interface DecodedAccountProxyConfig {
  enabled: boolean;
  port?: number;
  host?: string;
  options?: Record<string, unknown>;
}

export function decodeAccountProxyConfig(
  v: unknown,
  key: string,
): DecoderResult<DecodedAccountProxyConfig> {
  if (!isRecord(v)) {
    return fail(fieldPath('AccountProxyConfig', key, '<root>'));
  }
  return ok({
    enabled: Boolean(v.enabled),
    port: isOptionalNumber(v.port) ? v.port : undefined,
    host: isOptionalString(v.host) ? v.host : undefined,
    options:
      v.options && typeof v.options === 'object' && !Array.isArray(v.options)
        ? (v.options as Record<string, unknown>)
        : undefined,
  });
}

// ── ProxyRuntimeState (v0) ────────────────────────────────────

export interface DecodedProxyRuntimeState {
  accountName: string;
  endpoint: string;
  compatibility?: string;
  pid?: number;
  logPath?: string;
  startedAt: string;
  token?: string;
}

export function decodeProxyRuntimeState(
  v: unknown,
  key: string,
): DecoderResult<DecodedProxyRuntimeState> {
  if (!isRecord(v)) {
    return fail(fieldPath('ProxyRuntimeState', key, '<root>'));
  }
  if (!isString(v.accountName)) {
    return fail(fieldPath('ProxyRuntimeState', key, 'accountName'));
  }
  if (!isString(v.endpoint)) {
    return fail(fieldPath('ProxyRuntimeState', key, 'endpoint'));
  }
  if (!isString(v.startedAt)) {
    return fail(fieldPath('ProxyRuntimeState', key, 'startedAt'));
  }
  return ok({
    accountName: v.accountName,
    endpoint: v.endpoint,
    compatibility: isOptionalString(v.compatibility) ? v.compatibility : undefined,
    pid: isOptionalNumber(v.pid) ? v.pid : undefined,
    logPath: isOptionalString(v.logPath) ? v.logPath : undefined,
    startedAt: v.startedAt,
    token: isOptionalString(v.token) ? v.token : undefined,
  });
}

// ── GlobalConfig (v0 → v2) ───────────────────────────────────

export interface DecodedGlobalConfig {
  schemaVersion: number;
  defaultClient?: string;
  activeProfile?: string;
  defaults?: { proxyHost?: string };
  ui?: {
    color?: boolean;
    defaultSurface?: 'tui' | 'tray';
    quotaGuard?: { enabled?: boolean; cooldownMinutes?: number };
    tray?: { startEnabledProxies?: boolean; showQuota?: boolean; guideSeen?: boolean };
  };
}

export function decodeGlobalConfig(v: unknown, key: string): DecoderResult<DecodedGlobalConfig> {
  if (!isRecord(v)) {
    return fail(fieldPath('GlobalConfig', key, '<root>'));
  }
  return ok({
    schemaVersion: isNumber(v.schemaVersion) ? v.schemaVersion : 0,
    defaultClient: isOptionalString(v.defaultClient) ? v.defaultClient : undefined,
    activeProfile: isOptionalString(v.activeProfile) ? v.activeProfile : undefined,
    defaults:
      v.defaults && typeof v.defaults === 'object'
        ? {
            proxyHost: isOptionalString((v.defaults as Record<string, unknown>).proxyHost)
              ? ((v.defaults as Record<string, unknown>).proxyHost as string | undefined)
              : undefined,
          }
        : undefined,
    ui:
      v.ui && typeof v.ui === 'object'
        ? {
            color:
              typeof (v.ui as Record<string, unknown>).color === 'boolean'
                ? ((v.ui as Record<string, unknown>).color as boolean)
                : undefined,
            defaultSurface:
              (v.ui as Record<string, unknown>).defaultSurface === 'tui' ||
              (v.ui as Record<string, unknown>).defaultSurface === 'tray'
                ? ((v.ui as Record<string, unknown>).defaultSurface as 'tui' | 'tray')
                : undefined,
            quotaGuard:
              (v.ui as Record<string, unknown>).quotaGuard &&
              typeof (v.ui as Record<string, unknown>).quotaGuard === 'object'
                ? {
                    enabled:
                      typeof (
                        (v.ui as Record<string, unknown>).quotaGuard as Record<string, unknown>
                      ).enabled === 'boolean'
                        ? (((v.ui as Record<string, unknown>).quotaGuard as Record<string, unknown>)
                            .enabled as boolean)
                        : undefined,
                    cooldownMinutes: isOptionalNumber(
                      ((v.ui as Record<string, unknown>).quotaGuard as Record<string, unknown>)
                        .cooldownMinutes,
                    )
                      ? (((v.ui as Record<string, unknown>).quotaGuard as Record<string, unknown>)
                          .cooldownMinutes as number)
                      : undefined,
                  }
                : undefined,
            tray:
              (v.ui as Record<string, unknown>).tray &&
              typeof (v.ui as Record<string, unknown>).tray === 'object'
                ? {
                    startEnabledProxies:
                      typeof ((v.ui as Record<string, unknown>).tray as Record<string, unknown>)
                        .startEnabledProxies === 'boolean'
                        ? (((v.ui as Record<string, unknown>).tray as Record<string, unknown>)
                            .startEnabledProxies as boolean)
                        : undefined,
                    showQuota:
                      typeof ((v.ui as Record<string, unknown>).tray as Record<string, unknown>)
                        .showQuota === 'boolean'
                        ? (((v.ui as Record<string, unknown>).tray as Record<string, unknown>)
                            .showQuota as boolean)
                        : undefined,
                    guideSeen:
                      typeof ((v.ui as Record<string, unknown>).tray as Record<string, unknown>)
                        .guideSeen === 'boolean'
                        ? (((v.ui as Record<string, unknown>).tray as Record<string, unknown>)
                            .guideSeen as boolean)
                        : undefined,
                  }
                : undefined,
          }
        : undefined,
  });
}

// ── RuntimeProfileMeta (v0) ───────────────────────────────────
