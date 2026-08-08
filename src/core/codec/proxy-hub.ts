import {
  decodeResourceRef,
  fail,
  isNumber,
  isOptionalNumber,
  isOptionalString,
  isRecord,
  isString,
  ok,
  type DecoderResult,
} from './primitives';

export interface DecodedProxyHubConfig {
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  sources: Array<{
    ref:
      | { kind: 'account'; provider: string; name: string }
      | { kind: 'account-pool'; provider: string };
    enabled: boolean;
  }>;
  modelOwners: Array<{
    model: string;
    source:
      | { kind: 'account'; provider: string; name: string }
      | { kind: 'account-pool'; provider: string };
  }>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DecodedProxyHubRuntimeState {
  name: string;
  endpoint?: string;
  pid?: number;
  instanceId?: string;
  logPath?: string;
  startedAt?: string;
}

function decodeHubSource(
  value: unknown,
  context: string,
): DecoderResult<DecodedProxyHubConfig['sources'][number]> {
  if (!isRecord(value)) {
    return fail(`${context}: expected object`);
  }
  const ref = decodeResourceRef(value.ref, `${context}.ref`);
  if (!ref.ok) {
    return ref;
  }
  if (ref.value.kind !== 'account' && ref.value.kind !== 'account-pool') {
    return fail(`${context}.ref.kind: expected account or account-pool`);
  }
  return ok({ ref: ref.value, enabled: value.enabled !== false });
}

export function decodeProxyHubConfig(
  value: unknown,
  key: string,
): DecoderResult<DecodedProxyHubConfig> {
  if (!isRecord(value)) {
    return fail(`ProxyHubConfig(${key}): expected object`);
  }
  if (!isString(value.name)) {
    return fail(`ProxyHubConfig(${key}).name: expected string`);
  }
  if (!isString(value.host)) {
    return fail(`ProxyHubConfig(${key}).host: expected string`);
  }
  if (
    !isNumber(value.port) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  ) {
    return fail(`ProxyHubConfig(${key}).port: expected port`);
  }
  if (!isNumber(value.revision) || !Number.isInteger(value.revision) || value.revision < 1) {
    return fail(`ProxyHubConfig(${key}).revision: expected positive integer`);
  }
  if (!isString(value.createdAt) || !isString(value.updatedAt)) {
    return fail(`ProxyHubConfig(${key}).timestamps: expected strings`);
  }
  if (!Array.isArray(value.sources)) {
    return fail(`ProxyHubConfig(${key}).sources: expected array`);
  }
  const sources: DecodedProxyHubConfig['sources'] = [];
  for (const [index, source] of value.sources.entries()) {
    const decoded = decodeHubSource(source, `ProxyHubConfig(${key}).sources[${index}]`);
    if (!decoded.ok) {
      return decoded;
    }
    sources.push(decoded.value);
  }
  if (!Array.isArray(value.modelOwners)) {
    return fail(`ProxyHubConfig(${key}).modelOwners: expected array`);
  }
  const modelOwners: DecodedProxyHubConfig['modelOwners'] = [];
  for (const [index, owner] of value.modelOwners.entries()) {
    if (!isRecord(owner) || !isString(owner.model)) {
      return fail(`ProxyHubConfig(${key}).modelOwners[${index}]: expected model`);
    }
    const decoded = decodeHubSource(
      { ref: owner.source, enabled: true },
      `ProxyHubConfig(${key}).modelOwners[${index}].source`,
    );
    if (!decoded.ok) {
      return decoded;
    }
    modelOwners.push({ model: owner.model, source: decoded.value.ref });
  }
  return ok({
    name: value.name,
    enabled: value.enabled === true,
    host: value.host,
    port: value.port,
    sources,
    modelOwners,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export function decodeProxyHubRuntimeState(
  value: unknown,
  key: string,
): DecoderResult<DecodedProxyHubRuntimeState> {
  if (!isRecord(value) || !isString(value.name)) {
    return fail(`ProxyHubRuntimeState(${key}): expected name`);
  }
  if (!isOptionalString(value.endpoint) || !isOptionalNumber(value.pid)) {
    return fail(`ProxyHubRuntimeState(${key}): invalid endpoint or pid`);
  }
  if (
    !isOptionalString(value.instanceId) ||
    !isOptionalString(value.logPath) ||
    !isOptionalString(value.startedAt)
  ) {
    return fail(`ProxyHubRuntimeState(${key}): invalid optional field`);
  }
  return ok({
    name: value.name,
    endpoint: value.endpoint,
    pid: value.pid,
    instanceId: value.instanceId,
    logPath: value.logPath,
    startedAt: value.startedAt,
  });
}
