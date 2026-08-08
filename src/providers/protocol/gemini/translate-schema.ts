/**
 * Convert a client JSON Schema into the smaller Schema dialect accepted by
 * Gemini function declarations. OpenAI/Anthropic clients commonly send
 * draft-07 metadata and object-schema keywords that Gemini rejects with a
 * 400 instead of ignoring them.
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  const input = isRecord(schema) ? schema : {};
  const out: Record<string, unknown> = {};
  const scalarKeys = [
    'type',
    'format',
    'title',
    'description',
    'nullable',
    'maxItems',
    'minItems',
    'maxProperties',
    'minProperties',
  ] as const;
  for (const key of scalarKeys) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  if (Array.isArray(input.enum)) {
    out.enum = input.enum;
  }
  if (Array.isArray(input.required)) {
    out.required = input.required.filter((v): v is string => typeof v === 'string');
  }
  if (isRecord(input.properties)) {
    const properties: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(input.properties)) {
      properties[name] = sanitizeGeminiSchema(value);
    }
    out.properties = properties;
  }
  if (input.items !== undefined) {
    out.items = sanitizeGeminiSchema(input.items);
  }

  // Gemini does not support additionalProperties/propertyNames/$schema or
  // arbitrary JSON-Schema composition keywords in FunctionDeclaration.
  // If a union has no usable top-level type, retain its first branch so the
  // tool remains callable rather than sending an invalid request.
  if (!out.type) {
    const alternatives = Array.isArray(input.anyOf)
      ? input.anyOf
      : Array.isArray(input.oneOf)
        ? input.oneOf
        : undefined;
    const first = alternatives?.find(isRecord);
    if (first) {
      return { ...sanitizeGeminiSchema(first), ...out };
    }
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
