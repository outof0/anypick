import {
  decodeBindingProvenance,
  decodeBindingSpec,
  type DecodedBindingProvenance,
  type DecodedBindingSpec,
  type DecodedModelSelection,
  type DecodedResourceRef,
  type DecoderResult,
} from './codec/primitives';
import {
  decodeAccountMeta,
  decodeAccountProxyConfig,
  decodeGlobalConfig,
  decodeProxyRuntimeState,
  type DecodedAccountMeta,
  type DecodedAccountProxyConfig,
  type DecodedGlobalConfig,
  type DecodedProxyRuntimeState,
} from './codec/account';
import {
  decodeClientState,
  decodeRuntimeProfileMeta,
  decodeRuntimeProfileSecrets,
  type DecodedClientState,
  type DecodedRuntimeProfileMeta,
  type DecodedRuntimeProfileSecrets,
} from './codec/runtime';
import {
  decodeGlobalBinding,
  decodePoolMembers,
  decodePresetSpec,
  decodeProjectBinding,
  type DecodedGlobalBinding,
  type DecodedPoolMember,
  type DecodedPresetSpec,
  type DecodedProjectBinding,
} from './codec/bindings';
import {
  decodeBindingProvenanceFromJson,
  decodeBindingSpecFromJson,
  decodeJournalEntry,
  decodeProxyLease,
  type DecodedJournalEntry,
  type DecodedProxyLease,
} from './codec/operations';
import {
  decodeProxyHubConfig,
  decodeProxyHubRuntimeState,
  type DecodedProxyHubConfig,
  type DecodedProxyHubRuntimeState,
} from './codec/proxy-hub';

export function decode<T>(
  json: string,
  decoder: (v: unknown, key: string) => DecoderResult<T>,
  key: string = '<unknown>',
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodecError(`corrupt json: ${key}`, key);
  }
  const result = decoder(parsed, key);
  if (result.ok) {
    return result.value;
  }
  throw new CodecError(result.error, key);
}

/**
 * Parse JSON into T with a fallback value on failure. Used where the record is
 * optional and corruption is not fatal (e.g. proxy_json defaults).
 */
export function decodeWithFallback<T>(
  json: string,
  decoder: (v: unknown, key: string) => DecoderResult<T>,
  fallback: T,
  key: string = '<unknown>',
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fallback;
  }
  const result = decoder(parsed, key);
  return result.ok ? result.value : fallback;
}

/**
 * Structured error for codec failures. Carries record kind + field path,
 * never secret values.
 */
export class CodecError extends Error {
  readonly recordKind: string;
  constructor(message: string, recordKind: string) {
    super(message);
    this.name = 'CodecError';
    this.recordKind = recordKind;
  }
}

// Export decoders for use by store modules.
export const decoders = {
  accountMeta: decodeAccountMeta,
  accountProxyConfig: decodeAccountProxyConfig,
  proxyRuntimeState: decodeProxyRuntimeState,
  globalConfig: decodeGlobalConfig,
  runtimeProfileMeta: decodeRuntimeProfileMeta,
  runtimeProfileSecrets: decodeRuntimeProfileSecrets,
  clientState: decodeClientState,
  globalBinding: decodeGlobalBinding,
  projectBinding: decodeProjectBinding,
  presetSpec: decodePresetSpec,
  poolMembers: decodePoolMembers,
  proxyLease: decodeProxyLease,
  journalEntry: decodeJournalEntry,
  bindingSpec: decodeBindingSpec,
  bindingSpecFromJson: decodeBindingSpecFromJson,
  bindingProvenance: decodeBindingProvenance,
  bindingProvenanceFromJson: decodeBindingProvenanceFromJson,
  proxyHubConfig: decodeProxyHubConfig,
  proxyHubRuntimeState: decodeProxyHubRuntimeState,
} as const;

export type {
  DecodedAccountMeta,
  DecodedAccountProxyConfig,
  DecodedProxyRuntimeState,
  DecodedGlobalConfig,
  DecodedRuntimeProfileMeta,
  DecodedRuntimeProfileSecrets,
  DecodedClientState,
  DecodedGlobalBinding,
  DecodedProjectBinding,
  DecodedPresetSpec,
  DecodedPoolMember,
  DecodedProxyLease,
  DecodedJournalEntry,
  DecodedBindingSpec,
  DecodedBindingProvenance,
  DecodedResourceRef,
  DecodedModelSelection,
  DecodedProxyHubConfig,
  DecodedProxyHubRuntimeState,
};
