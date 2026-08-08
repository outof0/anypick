import {
  fail,
  fieldPath,
  isOptionalString,
  isRecord,
  isString,
  isStringArray,
  ok,
  type DecoderResult,
} from './primitives';
import { decodeAccountProxyConfig, type DecodedAccountProxyConfig } from './account';

export interface DecodedRuntimeProfileMeta {
  name: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  notes?: string;
  endpoint?: string;
  headerNames?: string[];
  models: Record<string, unknown>;
  defaultModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  clientOverrides?: Record<string, Record<string, unknown>>;
  proxy?: DecodedAccountProxyConfig & { adapterId?: string };
}

export function decodeRuntimeProfileMeta(
  v: unknown,
  key: string,
): DecoderResult<DecodedRuntimeProfileMeta> {
  if (!isRecord(v)) {
    return fail(fieldPath('RuntimeProfileMeta', key, '<root>'));
  }
  if (!isString(v.name)) {
    return fail(fieldPath('RuntimeProfileMeta', key, 'name'));
  }
  if (!isString(v.provider)) {
    return fail(fieldPath('RuntimeProfileMeta', key, 'provider'));
  }
  if (!isString(v.createdAt)) {
    return fail(fieldPath('RuntimeProfileMeta', key, 'createdAt'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('RuntimeProfileMeta', key, 'updatedAt'));
  }
  const models =
    v.models && typeof v.models === 'object' && !Array.isArray(v.models)
      ? (v.models as Record<string, unknown>)
      : {};
  return ok({
    name: v.name,
    provider: v.provider,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    label: isOptionalString(v.label) ? v.label : undefined,
    notes: isOptionalString(v.notes) ? v.notes : undefined,
    endpoint: isOptionalString(v.endpoint) ? v.endpoint : undefined,
    headerNames: Array.isArray(v.headerNames) ? (v.headerNames as string[]) : undefined,
    models,
    defaultModel: isOptionalString(v.defaultModel) ? v.defaultModel : undefined,
    sonnetModel: isOptionalString(v.sonnetModel) ? v.sonnetModel : undefined,
    opusModel: isOptionalString(v.opusModel) ? v.opusModel : undefined,
    haikuModel: isOptionalString(v.haikuModel) ? v.haikuModel : undefined,
    clientOverrides:
      v.clientOverrides &&
      typeof v.clientOverrides === 'object' &&
      !Array.isArray(v.clientOverrides)
        ? (v.clientOverrides as Record<string, Record<string, unknown>>)
        : undefined,
    proxy: (() => {
      if (!v.proxy) {
        return undefined;
      }
      const r = decodeAccountProxyConfig(v.proxy, key);
      return r.ok ? { ...r.value } : undefined;
    })(),
  });
}

// ── RuntimeProfileSecrets (v0) ────────────────────────────────

export interface DecodedRuntimeProfileSecrets {
  apiKey?: string;
  headers?: Record<string, string>;
}

export function decodeRuntimeProfileSecrets(
  v: unknown,
  key: string,
): DecoderResult<DecodedRuntimeProfileSecrets> {
  if (!isRecord(v)) {
    return fail(fieldPath('RuntimeProfileSecrets', key, '<root>'));
  }
  return ok({
    apiKey: isOptionalString(v.apiKey) ? v.apiKey : undefined,
    headers:
      v.headers && typeof v.headers === 'object' && !Array.isArray(v.headers)
        ? (v.headers as Record<string, string>)
        : undefined,
  });
}

// ── ClientState (v0) ──────────────────────────────────────────

export interface DecodedClientState {
  clientId: string;
  mode: string;
  profileName?: string;
  accountRef?: { provider: string; name: string };
  updatedAt: string;
  managedPaths: string[];
  managedEnvKeys: string[];
}

export function decodeClientState(v: unknown, key: string): DecoderResult<DecodedClientState> {
  if (!isRecord(v)) {
    return fail(fieldPath('ClientState', key, '<root>'));
  }
  if (!isString(v.clientId)) {
    return fail(fieldPath('ClientState', key, 'clientId'));
  }
  if (!isString(v.mode)) {
    return fail(fieldPath('ClientState', key, 'mode'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('ClientState', key, 'updatedAt'));
  }
  let accountRef: { provider: string; name: string } | undefined;
  if (v.accountRef && typeof v.accountRef === 'object' && !Array.isArray(v.accountRef)) {
    const ar = v.accountRef as Record<string, unknown>;
    if (isString(ar.provider) && isString(ar.name)) {
      accountRef = { provider: ar.provider, name: ar.name };
    }
  }
  return ok({
    clientId: v.clientId,
    mode: v.mode,
    profileName: isOptionalString(v.profileName) ? v.profileName : undefined,
    accountRef,
    updatedAt: v.updatedAt,
    managedPaths: isStringArray(v.managedPaths) ? v.managedPaths : [],
    managedEnvKeys: isStringArray(v.managedEnvKeys) ? v.managedEnvKeys : [],
  });
}

// ── GlobalBinding (v0) ────────────────────────────────────────
