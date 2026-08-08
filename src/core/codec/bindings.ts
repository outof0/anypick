import {
  decodeBindingProvenance,
  decodeBindingSpec,
  fail,
  fieldPath,
  isOptionalString,
  isRecord,
  isString,
  ok,
  type DecodedBindingProvenance,
  type DecodedBindingSpec,
  type DecodedResourceRef,
  type DecoderResult,
} from './primitives';

export interface DecodedGlobalBinding {
  client: string;
  spec: DecodedBindingSpec;
  provenance: DecodedBindingProvenance;
  managedConfigRevision?: string;
  createdAt: string;
  updatedAt: string;
}

export function decodeGlobalBinding(v: unknown, key: string): DecoderResult<DecodedGlobalBinding> {
  if (!isRecord(v)) {
    return fail(fieldPath('GlobalBinding', key, '<root>'));
  }
  if (!isString(v.client)) {
    return fail(fieldPath('GlobalBinding', key, 'client'));
  }
  const spec = decodeBindingSpec(v.spec, fieldPath('GlobalBinding', key, 'spec'));
  if (!spec.ok) {
    return fail(spec.error);
  }
  const prov = decodeBindingProvenance(v.provenance, fieldPath('GlobalBinding', key, 'provenance'));
  if (!prov.ok) {
    return fail(prov.error);
  }
  if (!isString(v.createdAt)) {
    return fail(fieldPath('GlobalBinding', key, 'createdAt'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('GlobalBinding', key, 'updatedAt'));
  }
  return ok({
    client: v.client,
    spec: spec.value,
    provenance: prov.value,
    managedConfigRevision: isOptionalString(v.managedConfigRevision)
      ? v.managedConfigRevision
      : undefined,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  });
}

// ── ProjectBinding (v0) ───────────────────────────────────────

export interface DecodedProjectBinding {
  projectRoot: string;
  client: string;
  spec: DecodedBindingSpec;
  provenance: DecodedBindingProvenance;
  createdAt: string;
  updatedAt: string;
}

export function decodeProjectBinding(
  v: unknown,
  key: string,
): DecoderResult<DecodedProjectBinding> {
  if (!isRecord(v)) {
    return fail(fieldPath('ProjectBinding', key, '<root>'));
  }
  if (!isString(v.projectRoot)) {
    return fail(fieldPath('ProjectBinding', key, 'projectRoot'));
  }
  if (!isString(v.client)) {
    return fail(fieldPath('ProjectBinding', key, 'client'));
  }
  const spec = decodeBindingSpec(v.spec, fieldPath('ProjectBinding', key, 'spec'));
  if (!spec.ok) {
    return fail(spec.error);
  }
  const prov = decodeBindingProvenance(
    v.provenance,
    fieldPath('ProjectBinding', key, 'provenance'),
  );
  if (!prov.ok) {
    return fail(prov.error);
  }
  if (!isString(v.createdAt)) {
    return fail(fieldPath('ProjectBinding', key, 'createdAt'));
  }
  if (!isString(v.updatedAt)) {
    return fail(fieldPath('ProjectBinding', key, 'updatedAt'));
  }
  return ok({
    projectRoot: v.projectRoot,
    client: v.client,
    spec: spec.value,
    provenance: prov.value,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  });
}

// ── SavedPreset.spec (v0) ─────────────────────────────────────

export interface DecodedPresetSpec {
  client: string;
  source: DecodedResourceRef;
  model: { mode: 'explicit'; id: string } | { mode: 'omitted' };
  transportPolicy: 'auto' | 'direct' | 'proxy';
  clientOptions: Record<string, unknown>;
}

export function decodePresetSpec(v: unknown, key: string): DecoderResult<DecodedPresetSpec> {
  if (!isRecord(v)) {
    return fail(fieldPath('PresetSpec', key, '<root>'));
  }
  const base = decodeBindingSpec(v, `${key}[base]`);
  if (!base.ok) {
    return fail(base.error);
  }
  const ms = v.model as Record<string, unknown>;
  if (!isRecord(ms)) {
    return fail(fieldPath('PresetSpec', key, 'model'));
  }
  if (ms.mode === 'explicit') {
    if (!isString(ms.id)) {
      return fail(fieldPath('PresetSpec', key, 'model.id'));
    }
    return ok({
      ...base.value,
      model: { mode: 'explicit' as const, id: ms.id },
    });
  }
  if (ms.mode === 'omitted') {
    return ok({ ...base.value, model: { mode: 'omitted' as const } });
  }
  return fail(fieldPath('PresetSpec', key, 'model.mode'));
}

// ── PoolMember (v0) ───────────────────────────────────────────

export interface DecodedPoolMember {
  account: string;
  enabled: boolean;
}

export function decodePoolMembers(v: unknown, key: string): DecoderResult<DecodedPoolMember[]> {
  if (!Array.isArray(v)) {
    return fail(fieldPath('PoolMembers', key, '<root>'));
  }
  const out: DecodedPoolMember[] = [];
  for (let i = 0; i < v.length; i++) {
    const m: unknown = v[i];
    if (!isRecord(m)) {
      return fail(fieldPath('PoolMember', key, `[${i}]`));
    }
    if (!isString(m.account)) {
      return fail(fieldPath('PoolMember', key, `[${i}].account`));
    }
    out.push({ account: m.account, enabled: m.enabled !== false });
  }
  return ok(out);
}

// ── ProxyLease (v0) ───────────────────────────────────────────
