/** Dynamic model catalog helpers for the OpenCode Zen/Go proxy. */

export type OpenCodeModelProtocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'google';

/** Token limits published by OpenCode/models.dev for a model. */
export interface OpenCodeModelLimits {
  context?: number;
  input?: number;
  output?: number;
}

export interface OpenCodeModelDescriptor {
  id: string;
  protocol?: OpenCodeModelProtocol;
  limits?: OpenCodeModelLimits;
  providerPackage?: string;
  created?: number;
  ownedBy?: string;
  source?: 'zen' | 'go';
}

/** Strip provider prefixes clients sometimes add while preserving unknown ids. */
export function bareOpenCodeModelId(model: string | undefined): string {
  if (!model) {
    return '';
  }
  const id = model.trim();
  if (!id) {
    return '';
  }
  if (id.startsWith('models/')) {
    return id.slice('models/'.length);
  }
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(slash + 1) : id;
}

/** Map stable provider adapter metadata to the HTTP protocol it implements. */
export function protocolFromProviderPackage(
  providerPackage: string | undefined,
): OpenCodeModelProtocol | undefined {
  const id = providerPackage?.trim().toLowerCase();
  if (!id) {
    return undefined;
  }
  if (id.includes('anthropic')) {
    return 'anthropic';
  }
  if (id === '@ai-sdk/openai') {
    return 'openai-responses';
  }
  if (id === '@ai-sdk/google') {
    return 'google';
  }
  if (id.includes('openai-compatible')) {
    return 'openai-chat';
  }
  return undefined;
}

/** Protocol is metadata-driven; model names are never used to guess it. */
export function usesAnthropicMessagesProtocol(
  model: Pick<OpenCodeModelDescriptor, 'protocol'> | OpenCodeModelProtocol | undefined,
): boolean {
  return (typeof model === 'string' ? model : model?.protocol) === 'anthropic';
}

/**
 * Resolve only normalization/case/default selection against the live catalog.
 * Missing aliases are intentionally not mapped to an unrelated hardcoded id.
 */
export function resolveOpenCodeModel(
  requested: string | undefined,
  available: readonly string[],
): { id: string; remapped: boolean; reason?: 'case' | 'default' } {
  const bare = bareOpenCodeModelId(requested);
  if (bare) {
    const exact = available.find((id) => id === bare);
    if (exact) {
      return { id: exact, remapped: false };
    }
    const caseInsensitive = available.find((id) => id.toLowerCase() === bare.toLowerCase());
    if (caseInsensitive) {
      return {
        id: caseInsensitive,
        remapped: caseInsensitive !== bare,
        reason: 'case',
      };
    }
    return { id: bare, remapped: false };
  }
  const first = available[0] ?? '';
  return { id: first, remapped: Boolean(first), reason: first ? 'default' : undefined };
}

/** Parse model objects while retaining any upstream protocol metadata. */
export function parseOpenCodeModelDescriptors(body: unknown): OpenCodeModelDescriptor[] {
  if (!isRecord(body)) {
    return [];
  }
  const out: OpenCodeModelDescriptor[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const descriptor = descriptorFromUnknown(value);
    if (!descriptor?.id || seen.has(descriptor.id)) {
      return;
    }
    seen.add(descriptor.id);
    out.push(descriptor);
  };
  if (Array.isArray(body.data)) {
    body.data.forEach(add);
  }
  if (Array.isArray(body.models)) {
    body.models.forEach(add);
  }
  return out;
}

/** Backward-compatible id-only parser used by callers that need only names. */
export function parseOpenCodeModelsList(body: unknown): string[] {
  return parseOpenCodeModelDescriptors(body).map((model) => model.id);
}

/**
 * Parse models.dev provider metadata. The returned descriptors are still
 * intersected with the authenticated live Zen/Go catalogs by the server.
 */
export function parseOpenCodeProviderMetadata(body: unknown): OpenCodeModelDescriptor[] {
  if (!isRecord(body)) {
    return [];
  }
  const out: OpenCodeModelDescriptor[] = [];
  for (const [providerId, source] of [
    ['opencode', 'zen'],
    ['opencode-go', 'go'],
  ] as const) {
    const provider = body[providerId];
    if (!isRecord(provider) || !isRecord(provider.models)) {
      continue;
    }
    for (const [key, value] of Object.entries(provider.models)) {
      if (!isRecord(value)) {
        continue;
      }
      const descriptor = descriptorFromUnknown({ ...value, id: value.id ?? key });
      if (descriptor) {
        out.push({ ...descriptor, source });
      }
    }
  }
  return out;
}

function descriptorFromUnknown(value: unknown): OpenCodeModelDescriptor | undefined {
  if (typeof value === 'string') {
    const id = bareOpenCodeModelId(value);
    return id ? { id } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const rawId = typeof value.id === 'string' ? value.id : value.name;
  if (typeof rawId !== 'string') {
    return undefined;
  }
  const id = bareOpenCodeModelId(rawId);
  if (!id) {
    return undefined;
  }
  const provider = isRecord(value.provider) ? value.provider : undefined;
  const api = isRecord(value.api) ? value.api : undefined;
  const providerPackage = stringValue(
    provider?.npm ?? api?.npm ?? value.providerPackage ?? value.provider_package,
  );
  const explicitProtocol = parseProtocol(value.protocol);
  const limits = parseModelLimits(value.limit ?? value.limits);
  return {
    id,
    protocol: explicitProtocol ?? protocolFromProviderPackage(providerPackage),
    ...(limits ? { limits } : {}),
    providerPackage,
    created: numberValue(value.created),
    ownedBy: stringValue(value.owned_by ?? value.ownedBy),
  };
}

function parseModelLimits(value: unknown): OpenCodeModelLimits | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const limits: OpenCodeModelLimits = {};
  for (const key of ['context', 'input', 'output'] as const) {
    const number = numberValue(value[key]);
    if (number != null && number > 0) {
      limits[key] = number;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function parseProtocol(value: unknown): OpenCodeModelProtocol | undefined {
  if (value === 'anthropic' || value === 'messages') {
    return 'anthropic';
  }
  if (value === 'openai-chat' || value === 'chat' || value === 'chat/completions') {
    return 'openai-chat';
  }
  if (value === 'openai-responses' || value === 'responses') {
    return 'openai-responses';
  }
  if (value === 'google' || value === 'generateContent') {
    return 'google';
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
