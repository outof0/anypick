/**
 * Strict upstreams (xAI cli-chat-proxy, …) validate tool JSON Schemas where
 * `required` must be an **array of strings** — including when there are no
 * required properties.
 *
 * Claude Code (and some serializers) either:
 *  - omit `required`, or
 *  - emit `"required": null`
 *
 * Anthropic accepts both. xAI's meta-schema treats a missing `required` as
 * null and returns:
 *   standard_violation /required: null is not of type "array"
 *
 * Fix: every object-shaped schema used as a tool parameter must carry
 * `required: string[]` (possibly empty). Dropping the key is not enough.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRequiredArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Walk any JSON value and only fix keys named `required`:
 *  - null / non-array → `[]`
 *  - array → string-only entries (may be empty)
 *
 * Does not strip unrelated nulls (e.g. stop_sequence: null).
 */
export function deepSanitizeRequiredFields(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  let changed = false;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isRecord(node)) {
      return node;
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      if (key === 'required') {
        const names = asRequiredArray(entry);
        if (!Array.isArray(entry) || names.length !== entry.length) {
          changed = true;
        }
        out.required = names;
        continue;
      }
      out[key] = walk(entry);
    }
    return out;
  };

  return { value: walk(value), changed };
}

/**
 * Make a tool-parameter JSON Schema acceptable to strict validators.
 * Always materializes `required` as a string array on object schemas.
 */
export function sanitizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: 'object', properties: {}, required: [] };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (key === 'required') {
      // Handled after the loop so we can force it on object schemas.
      continue;
    }

    if (key === 'enum') {
      if (Array.isArray(value)) {
        out.enum = value;
      }
      continue;
    }

    if (key === 'properties' && isRecord(value)) {
      const properties: Record<string, Record<string, unknown>> = {};
      for (const [name, prop] of Object.entries(value)) {
        properties[name] = sanitizeJsonSchema(prop);
      }
      out.properties = properties;
      continue;
    }

    if (key === 'items') {
      out.items = Array.isArray(value)
        ? value.map((item) => sanitizeJsonSchema(item))
        : sanitizeJsonSchema(value);
      continue;
    }

    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map((branch) => sanitizeJsonSchema(branch));
      continue;
    }

    if ((key === '$defs' || key === 'definitions') && isRecord(value)) {
      const defs: Record<string, Record<string, unknown>> = {};
      for (const [name, def] of Object.entries(value)) {
        defs[name] = sanitizeJsonSchema(def);
      }
      out[key] = defs;
      continue;
    }

    if (key === 'additionalProperties' || key === 'propertyNames' || key === 'not') {
      if (typeof value === 'boolean') {
        out[key] = value;
      } else {
        out[key] = sanitizeJsonSchema(value);
      }
      continue;
    }

    if (key === 'patternProperties' && isRecord(value)) {
      const patterns: Record<string, Record<string, unknown>> = {};
      for (const [pattern, prop] of Object.entries(value)) {
        patterns[pattern] = sanitizeJsonSchema(prop);
      }
      out.patternProperties = patterns;
      continue;
    }

    out[key] = value;
  }

  // xAI requires `required` to be an array on object schemas. Force it when
  // the schema looks like an object; drop invalid required on non-objects.
  const type = out.type;
  const isObjectSchema =
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    (type === undefined && (isRecord(out.properties) || 'additionalProperties' in out));

  if (isObjectSchema) {
    out.required = asRequiredArray(schema.required);
  }

  return out;
}

/** Anthropic Messages tools: rewrite each `input_schema`. */
export function sanitizeAnthropicToolSchemas<
  T extends { input_schema?: Record<string, unknown> | null },
>(tools: readonly T[]): T[] {
  return tools.map((tool) => ({
    ...tool,
    input_schema: sanitizeJsonSchema(tool.input_schema ?? { type: 'object', properties: {} }),
  }));
}

/**
 * OpenAI chat tools (`function.parameters`) and Responses tools (`parameters`
 * on the tool object itself).
 */
export function sanitizeOpenAIToolSchemas(tools: readonly unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!isRecord(tool)) {
      return tool;
    }
    if (isRecord(tool.function)) {
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: sanitizeJsonSchema(
            tool.function.parameters ?? { type: 'object', properties: {} },
          ),
        },
      };
    }
    if ('parameters' in tool) {
      return {
        ...tool,
        parameters: sanitizeJsonSchema(tool.parameters ?? { type: 'object', properties: {} }),
      };
    }
    if ('input_schema' in tool) {
      return {
        ...tool,
        input_schema: sanitizeJsonSchema(tool.input_schema ?? { type: 'object', properties: {} }),
      };
    }
    return tool;
  });
}

/**
 * Best-effort rewrite of a parsed inference body:
 *  1. deep-fix every `required` key (null → [])
 *  2. full schema sanitize on known tool parameter shapes (always emit required)
 */
export function sanitizeInferenceToolSchemas(
  path: string,
  body: Record<string, unknown>,
): { body: Record<string, unknown>; changed: boolean } {
  const deep = deepSanitizeRequiredFields(body);
  let next = (deep.changed ? deep.value : body) as Record<string, unknown>;
  let changed = deep.changed;

  if (Array.isArray(next.tools) && next.tools.length > 0) {
    if (path === '/v1/messages' || path.endsWith('/messages')) {
      next = {
        ...next,
        tools: sanitizeAnthropicToolSchemas(
          next.tools as Array<{ input_schema?: Record<string, unknown> | null }>,
        ),
      };
      changed = true;
    } else if (
      path === '/v1/chat/completions' ||
      path === '/v1/responses' ||
      path.endsWith('/chat/completions') ||
      path.endsWith('/responses')
    ) {
      next = {
        ...next,
        tools: sanitizeOpenAIToolSchemas(next.tools),
      };
      changed = true;
    } else {
      next = {
        ...next,
        tools: sanitizeOpenAIToolSchemas(
          sanitizeAnthropicToolSchemas(
            next.tools as Array<{ input_schema?: Record<string, unknown> | null }>,
          ),
        ),
      };
      changed = true;
    }
  }

  return { body: next, changed };
}
