export type DecoderResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): DecoderResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: string): DecoderResult<T> {
  return { ok: false, error };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

export function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || v === null || typeof v === 'string';
}

export function isOptionalNumber(v: unknown): v is number | undefined {
  return v === undefined || v === null || typeof v === 'number';
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function fieldPath(kind: string, key: string, field: string): string {
  return `${kind}(${key}).${field}`;
}

// ── ResourceRef decoder ────────────────────────────────────────

export interface AccountRef {
  kind: 'account';
  provider: string;
  name: string;
}
export interface GatewayRef {
  kind: 'gateway';
  name: string;
}
export interface PresetRef {
  kind: 'preset';
  name: string;
}
export interface PoolRef {
  kind: 'account-pool';
  provider: string;
}
export type DecodedResourceRef = AccountRef | GatewayRef | PresetRef | PoolRef;

export function decodeResourceRef(v: unknown, context: string): DecoderResult<DecodedResourceRef> {
  if (!isRecord(v)) {
    return fail(`${context}: not an object`);
  }
  if (v.kind === 'account') {
    if (!isString(v.provider)) {
      return fail(`${context}.provider: expected string`);
    }
    if (!isString(v.name)) {
      return fail(`${context}.name: expected string`);
    }
    return ok({ kind: 'account', provider: v.provider, name: v.name });
  }
  if (v.kind === 'gateway') {
    if (!isString(v.name)) {
      return fail(`${context}.name: expected string`);
    }
    return ok({ kind: 'gateway', name: v.name });
  }
  if (v.kind === 'preset') {
    if (!isString(v.name)) {
      return fail(`${context}.name: expected string`);
    }
    return ok({ kind: 'preset', name: v.name });
  }
  if (v.kind === 'account-pool') {
    if (!isString(v.provider)) {
      return fail(`${context}.provider: expected string`);
    }
    return ok({ kind: 'account-pool', provider: v.provider });
  }
  return fail(`${context}.kind: unknown "${String(v.kind)}"`);
}

// ── ModelSelection decoder ─────────────────────────────────────

export interface DecodedModelSelection {
  mode: 'explicit' | 'omitted' | 'unknown';
  id?: string;
  reason?: 'legacy_migration' | 'external_import';
}

export function decodeModelSelection(
  v: unknown,
  context: string,
): DecoderResult<DecodedModelSelection> {
  if (!isRecord(v)) {
    return fail(`${context}: not an object`);
  }
  const mode = v.mode;
  if (mode === 'explicit') {
    if (!isString(v.id)) {
      return fail(`${context}.id: expected string for explicit mode`);
    }
    return ok({ mode: 'explicit', id: v.id });
  }
  if (mode === 'omitted') {
    return ok({ mode: 'omitted' });
  }
  if (mode === 'unknown') {
    const reason = v.reason;
    if (reason !== 'legacy_migration' && reason !== 'external_import') {
      return fail(`${context}.reason: unknown "${String(reason)}"`);
    }
    return ok({ mode: 'unknown', reason });
  }
  return fail(`${context}.mode: unknown "${String(mode)}"`);
}

// ── BindingSpec decoder ────────────────────────────────────────

export interface DecodedBindingSpec {
  client: string;
  source: DecodedResourceRef;
  model: DecodedModelSelection;
  transportPolicy: 'auto' | 'direct' | 'proxy';
  clientOptions: Record<string, unknown>;
}

export function decodeBindingSpec(v: unknown, context: string): DecoderResult<DecodedBindingSpec> {
  if (!isRecord(v)) {
    return fail(`${context}: not an object`);
  }
  if (!isString(v.client)) {
    return fail(`${context}.client: expected string`);
  }
  const source = decodeResourceRef(v.source, `${context}.source`);
  if (!source.ok) {
    return source;
  }
  const model = decodeModelSelection(v.model, `${context}.model`);
  if (!model.ok) {
    return model;
  }
  const tp = v.transportPolicy;
  if (tp !== 'auto' && tp !== 'direct' && tp !== 'proxy') {
    return fail(`${context}.transportPolicy: unknown "${String(tp)}"`);
  }
  const co =
    v.clientOptions && typeof v.clientOptions === 'object' && !Array.isArray(v.clientOptions)
      ? (v.clientOptions as Record<string, unknown>)
      : {};
  return ok({
    client: v.client,
    source: source.value,
    model: model.value,
    transportPolicy: tp,
    clientOptions: co,
  });
}

// ── BindingProvenance decoder ──────────────────────────────────

export interface DecodedBindingProvenance {
  kind: string;
  [key: string]: unknown;
}

export function decodeBindingProvenance(
  v: unknown,
  context: string,
): DecoderResult<DecodedBindingProvenance> {
  if (!isRecord(v)) {
    return fail(`${context}: not an object`);
  }
  if (!isString(v.kind)) {
    return fail(`${context}.kind: expected string`);
  }
  // Accept any kind — validated at the call site per variant.
  return ok(v as DecodedBindingProvenance);
}

// ── AccountMeta (v0) ──────────────────────────────────────────
