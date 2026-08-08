import { describe, expect, it } from 'vitest';
import {
  deepSanitizeRequiredFields,
  sanitizeInferenceToolSchemas,
  sanitizeJsonSchema,
} from '../src/providers/protocol/json-schema';
import { anthropicToOpenAI } from '../src/providers/protocol/anthropic-convert';
import { safeJsonParse } from '../src/providers/protocol/anthropic-helpers';

describe('sanitizeJsonSchema', () => {
  it('forces required:[] on object schemas when missing or null', () => {
    expect(
      sanitizeJsonSchema({
        type: 'object',
        properties: {
          command: { type: 'string', description: null },
          args: {
            type: 'array',
            items: { type: 'string' },
            required: null,
          },
        },
        required: null,
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: [],
      additionalProperties: false,
    });
    // Non-object property schemas must not keep a coerced required key.
    expect(
      (
        sanitizeJsonSchema({
          type: 'object',
          properties: {
            args: { type: 'array', items: { type: 'string' }, required: null },
          },
        }).properties as Record<string, Record<string, unknown>>
      ).args,
    ).not.toHaveProperty('required');
  });

  it('keeps string required arrays and filters junk entries', () => {
    expect(
      sanitizeJsonSchema({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a', null, 1, 'b'],
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    });
  });

  it('preserves empty required arrays (xAI rejects omission)', () => {
    expect(
      sanitizeJsonSchema({
        type: 'object',
        properties: { command: { type: 'string' } },
        required: [],
      }),
    ).toEqual({
      type: 'object',
      properties: { command: { type: 'string' } },
      required: [],
    });
  });

  it('recurses through anyOf / $defs and forces required on object branches', () => {
    const out = sanitizeJsonSchema({
      anyOf: [
        { type: 'object', properties: { x: { type: 'string' } }, required: null },
        { type: 'null' },
      ],
      $defs: {
        node: {
          type: 'object',
          properties: { child: { $ref: '#/$defs/node' } },
          required: null,
        },
      },
    });
    expect(out.anyOf).toEqual([
      { type: 'object', properties: { x: { type: 'string' } }, required: [] },
      { type: 'null' },
    ]);
    expect(out.$defs).toEqual({
      node: {
        type: 'object',
        properties: { child: { $ref: '#/$defs/node' } },
        required: [],
      },
    });
  });
});

describe('deepSanitizeRequiredFields', () => {
  it('coerces required:null to [] anywhere without stripping other nulls', () => {
    const input = {
      model: 'grok-4.5',
      stop_sequence: null,
      tools: [
        {
          name: 'Bash',
          input_schema: {
            type: 'object',
            properties: {
              nested: { type: 'object', required: null },
            },
            required: null,
          },
        },
      ],
      metadata: { note: null },
    };
    const { value, changed } = deepSanitizeRequiredFields(input);
    expect(changed).toBe(true);
    expect(value).toEqual({
      model: 'grok-4.5',
      stop_sequence: null,
      tools: [
        {
          name: 'Bash',
          input_schema: {
            type: 'object',
            properties: {
              nested: { type: 'object', required: [] },
            },
            required: [],
          },
        },
      ],
      metadata: { note: null },
    });
  });
});

describe('sanitizeInferenceToolSchemas', () => {
  it('rewrites Anthropic tools.input_schema with required always present', () => {
    const { body, changed } = sanitizeInferenceToolSchemas('/v1/messages', {
      model: 'grok-4.5',
      tools: [
        {
          name: 'Read',
          input_schema: { type: 'object', properties: {}, required: null },
        },
      ],
    });
    expect(changed).toBe(true);
    expect(body.tools).toEqual([
      {
        name: 'Read',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]);
  });

  it('fills required:[] when Claude omits the key entirely', () => {
    const { body } = sanitizeInferenceToolSchemas('/v1/messages', {
      model: 'grok-4.5',
      tools: [
        {
          name: 'Read',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
    expect(body.tools).toEqual([
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: [],
        },
      },
    ]);
  });

  it('rewrites OpenAI function.parameters', () => {
    const { body, changed } = sanitizeInferenceToolSchemas('/v1/chat/completions', {
      model: 'grok-4.5',
      tools: [
        {
          type: 'function',
          function: {
            name: 'Read',
            parameters: { type: 'object', properties: {}, required: null },
          },
        },
      ],
    });
    expect(changed).toBe(true);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'Read',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ]);
  });
});

describe('anthropicToOpenAI tool schema hygiene', () => {
  it('sanitizes parameters when translating tools', () => {
    const out = anthropicToOpenAI({
      model: 'grok-4.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'Bash',
          description: 'shell',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: null as unknown as string[],
          },
        },
      ],
    });
    expect(out.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { command: { type: 'string' } },
      required: [],
    });
  });
});

describe('safeJsonParse and escapeJsonControlCharacters', () => {
  it('escapes raw control characters (newlines, carriage returns, tabs) inside string values', () => {
    const raw =
      '{\n  "path": "src/file.ts",\n  "replacement": "function foo() {\n  return 42;\n}"\n}';
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    expect(parsed.replacement).toBe('function foo() {\n  return 42;\n}');
  });

  it('escapes tabs', () => {
    const raw = '{"text": "val1\tval2"}';
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    expect(parsed.text).toBe('val1\tval2');
  });

  it('handles escaped quotes and backslashes without getting confused', () => {
    const raw = '{"text": "hello \\"world\\" \\\\ literal newline \n here"}';
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    expect(parsed.text).toBe('hello "world" \\ literal newline \n here');
  });

  it('leaves control characters outside string literals unchanged (as normal spacing)', () => {
    const raw = '{\r\n  "a": "b"\r\n}';
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    expect(parsed.a).toBe('b');
  });
});
