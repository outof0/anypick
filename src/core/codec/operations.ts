import {
  decodeBindingProvenance,
  decodeBindingSpec,
  fail,
  fieldPath,
  isNumber,
  isOptionalString,
  isRecord,
  isString,
  isStringArray,
  ok,
  type DecodedBindingProvenance,
  type DecodedBindingSpec,
  type DecoderResult,
} from './primitives';

export interface DecodedProxyLease {
  leaseId: string;
  provider: string;
  account?: string;
  port: number;
  host: string;
  endpoint?: string;
  ownerPid: number;
  instanceId?: string;
  bindingRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export function decodeProxyLease(v: unknown, key: string): DecoderResult<DecodedProxyLease> {
  if (!isRecord(v)) {
    return fail(fieldPath('ProxyLease', key, '<root>'));
  }
  if (!isString(v.leaseId)) {
    return fail(fieldPath('ProxyLease', key, 'leaseId'));
  }
  if (!isString(v.provider)) {
    return fail(fieldPath('ProxyLease', key, 'provider'));
  }
  if (!isNumber(v.port)) {
    return fail(fieldPath('ProxyLease', key, 'port'));
  }
  if (!isString(v.host)) {
    return fail(fieldPath('ProxyLease', key, 'host'));
  }
  if (!isNumber(v.ownerPid)) {
    return fail(fieldPath('ProxyLease', key, 'ownerPid'));
  }
  if (!isString(v.createdAt)) {
    return fail(fieldPath('ProxyLease', key, 'createdAt'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('ProxyLease', key, 'updatedAt'));
  }
  return ok({
    leaseId: v.leaseId,
    provider: v.provider,
    account: isOptionalString(v.account) ? v.account : undefined,
    port: v.port,
    host: v.host,
    endpoint: isOptionalString(v.endpoint) ? v.endpoint : undefined,
    ownerPid: v.ownerPid,
    instanceId: isOptionalString(v.instanceId) ? v.instanceId : undefined,
    bindingRefs: isStringArray(v.bindingRefs) ? v.bindingRefs : [],
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  });
}

// ── OperationJournalEntry (v0) ────────────────────────────────

const JOURNAL_STATES = [
  'planned',
  'executing',
  'verifying',
  'rolling_back',
  'rolled_back',
  'failed',
  'committed',
] as const;

type DecodedJournalState = (typeof JOURNAL_STATES)[number];

export interface DecodedJournalEntry {
  id: string;
  type: string;
  state: DecodedJournalState;
  affectedResources: string[];
  backupPaths: string[];
  params?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
}

export function decodeJournalEntry(v: unknown, key: string): DecoderResult<DecodedJournalEntry> {
  if (!isRecord(v)) {
    return fail(fieldPath('JournalEntry', key, '<root>'));
  }
  if (!isString(v.id)) {
    return fail(fieldPath('JournalEntry', key, 'id'));
  }
  if (!isString(v.type)) {
    return fail(fieldPath('JournalEntry', key, 'type'));
  }
  if (!isString(v.state)) {
    return fail(fieldPath('JournalEntry', key, 'state'));
  }
  const state = JOURNAL_STATES.find((candidate) => candidate === v.state);
  if (!state) {
    return fail(fieldPath('JournalEntry', key, `state: unknown "${v.state}"`));
  }
  if (!isStringArray(v.affectedResources)) {
    return fail(fieldPath('JournalEntry', key, 'affectedResources'));
  }
  if (!isStringArray(v.backupPaths)) {
    return fail(fieldPath('JournalEntry', key, 'backupPaths'));
  }
  if (!isString(v.startedAt)) {
    return fail(fieldPath('JournalEntry', key, 'startedAt'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('JournalEntry', key, 'updatedAt'));
  }
  return ok({
    id: v.id,
    type: v.type,
    state,
    affectedResources: v.affectedResources,
    backupPaths: v.backupPaths,
    params:
      v.params && typeof v.params === 'object' && !Array.isArray(v.params)
        ? (v.params as Record<string, unknown>)
        : undefined,
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
  });
}

// ── BindingSpec from DB row ────────────────────────────────────

export function decodeBindingSpecFromJson(
  json: string,
  key: string,
): DecoderResult<DecodedBindingSpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail(fieldPath('BindingSpec', key, '<json parse>'));
  }
  return decodeBindingSpec(parsed, key);
}

// ── BindingProvenance from DB row ──────────────────────────────

export function decodeBindingProvenanceFromJson(
  json: string,
  key: string,
): DecoderResult<DecodedBindingProvenance> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail(fieldPath('BindingProvenance', key, '<json parse>'));
  }
  return decodeBindingProvenance(parsed, key);
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Parse JSON and decode into the expected type. On failure, returns a structured
 * error with record kind + field path. No secret values are placed into the error.
 */
