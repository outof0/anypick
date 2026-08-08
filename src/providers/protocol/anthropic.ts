/**
 * Vendor-neutral Anthropic ↔ OpenAI protocol layer.
 *
 * Every built-in translation proxy (grok, gemini, opencode) speaks both the
 * Anthropic Messages API and the OpenAI Chat/Responses API, so the request and
 * response shapes, the converters between them, and the SSE stream translator
 * are shared infrastructure rather than any one provider's concern.
 *
 * This module previously lived under `grok-proxy/`, which made two sibling
 * providers depend on a third provider's internals (11 import sites). Nothing
 * here may import from a specific `*-proxy/` directory: the dependency runs
 * provider → protocol, never provider → provider.
 */
export * from './anthropic-types';
export * from './anthropic-convert';
export * from './anthropic-stream';
export {
  deepSanitizeRequiredFields,
  sanitizeAnthropicToolSchemas,
  sanitizeInferenceToolSchemas,
  sanitizeJsonSchema,
  sanitizeOpenAIToolSchemas,
} from './json-schema';
export { fixMissingToolResponses, sse } from './anthropic-helpers';
export { estimateAnthropicInputTokens } from './token-estimate';
