import type { CatalogProvider, ModelDiscoveryContext, ModelMap } from '../types';
import { Registry } from '../core/registry';
import { fetchAnthropicModels, fetchGeminiModels, fetchOpenAiStyleModels } from './model-fetch';

/**
 * Suggested model maps for each catalog provider.
 *
 * IDs reflect current public APIs as of 2026-07 (Anthropic Claude
 * Fable/Opus/Sonnet/Haiku, OpenAI GPT-5.6 family, Google Gemini 3.x, xAI Grok
 * 4.5). Revisit when providers release new generations.
 *
 * Every id here is a request a user's client will actually make, so a value is
 * only added after it is read off the vendor's own model list — an invented id
 * typechecks and then fails every request at runtime. Google is the live
 * example: Gemini 3.x Pro ships preview-only, so the id carries `-preview`.
 *
 * Alias keys are stable logical names used by client overlays (claude-sonnet,
 * gpt, …). Values are provider-specific model IDs.
 */

export class CatalogRegistry extends Registry<CatalogProvider> {
  constructor() {
    super({
      kind: 'catalog provider',
      duplicateCode: 'DUPLICATE_CATALOG_PROVIDER',
      unknownCode: 'UNKNOWN_CATALOG_PROVIDER',
    });
  }
}

export const catalogRegistry = new CatalogRegistry();

/** Anthropic Claude API — latest GA aliases (docs.anthropic.com / platform.claude.com). */
export const ANTHROPIC_MODELS: ModelMap = {
  // Role aliases used by Claude Code client overlays
  'claude-fable': 'claude-fable-5',
  'claude-opus': 'claude-opus-5',
  'claude-sonnet': 'claude-sonnet-5',
  'claude-haiku': 'claude-haiku-4-5',
  // Explicit latest pins
  'claude-fable-5': 'claude-fable-5',
  'claude-opus-5': 'claude-opus-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-haiku-4-5': 'claude-haiku-4-5',
  // Still useful recent gens
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
};

/** OpenAI API — GPT-5.6 frontier family (developers.openai.com). */
export const OPENAI_MODELS: ModelMap = {
  // Role aliases
  gpt: 'gpt-5.6-sol',
  'gpt-5': 'gpt-5.6-sol',
  'gpt-default': 'gpt-5.6-sol',
  'gpt-balanced': 'gpt-5.6-terra',
  'gpt-fast': 'gpt-5.6-luna',
  'gpt-codex': 'gpt-5.3-codex',
  // Explicit IDs
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.5-pro': 'gpt-5.5-pro',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'gpt-4.1': 'gpt-4.1',
};

/**
 * Google Gemini API (AI Studio) — current ids (2026-07).
 *
 * There is no stable Gemini 3.x Pro: `gemini-3.1-pro-preview` is the only Pro
 * id the API serves, so the alias resolves to it rather than to a bare
 * `gemini-3.1-pro`, which 404s. Explicit 2.5 ids remain for pass-through.
 */
export const GEMINI_MODELS: ModelMap = {
  gemini: 'gemini-3.6-flash',
  'gemini-pro': 'gemini-3.1-pro-preview',
  'gemini-flash': 'gemini-3.6-flash',
  'gemini-lite': 'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.6-flash': 'gemini-3.6-flash',
  'gemini-3.5-flash': 'gemini-3.5-flash',
  'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite',
  // Legacy ids (lookup only — not defaults)
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
};

/** xAI Grok API (docs.x.ai). */
export const GROK_MODELS: ModelMap = {
  grok: 'grok-4.5',
  'grok-4.5': 'grok-4.5',
  'grok-4.3': 'grok-4.3',
  'grok-4.20': 'grok-4.20-0309-reasoning',
  'grok-4.20-reasoning': 'grok-4.20-0309-reasoning',
  'grok-4.20-non-reasoning': 'grok-4.20-0309-non-reasoning',
  'grok-multi-agent': 'grok-4.20-multi-agent-0309',
  'grok-build': 'grok-build-0.1',
};

/**
 * OpenRouter gateway IDs (openrouter.ai).
 * Slugs use provider prefix + dotted minor versions where OpenRouter does.
 */
export const OPENROUTER_MODELS: ModelMap = {
  // Claude role aliases → latest
  'claude-fable': 'anthropic/claude-fable-5',
  'claude-opus': 'anthropic/claude-opus-5',
  'claude-sonnet': 'anthropic/claude-sonnet-5',
  'claude-haiku': 'anthropic/claude-haiku-4.5',
  'claude-fable-5': 'anthropic/claude-fable-5',
  'claude-opus-5': 'anthropic/claude-opus-5',
  'claude-opus-5-fast': 'anthropic/claude-opus-5-fast',
  'claude-opus-4.8': 'anthropic/claude-opus-4.8',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
  'claude-sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  // OpenAI
  gpt: 'openai/gpt-5.6-sol',
  'gpt-5': 'openai/gpt-5.6-sol',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-sol-pro': 'openai/gpt-5.6-sol-pro',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-codex': 'openai/gpt-5.3-codex',
  // Grok / xAI — OpenRouter drops the date suffix the xAI API carries.
  grok: 'x-ai/grok-4.5',
  'grok-4.5': 'x-ai/grok-4.5',
  'grok-4.3': 'x-ai/grok-4.3',
  'grok-4.20': 'x-ai/grok-4.20',
  // Google (common on OpenRouter)
  'gemini-pro': 'google/gemini-3.1-pro-preview',
  'gemini-flash': 'google/gemini-3.6-flash',
  'gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',
  'gemini-3.6-flash': 'google/gemini-3.6-flash',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
};

/**
 * Role defaults shared by every Anthropic-shaped catalog. Claude Code asks for
 * four roles; gateways that serve Claude models fill all four.
 */
const ANTHROPIC_ROLE_DEFAULTS: Record<string, string> = {
  default: 'claude-sonnet-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5',
};

const openrouter: CatalogProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'Multi-model OpenAI-compatible gateway',
  apiStyle: 'openai',
  protocols: ['openai', 'anthropic'],
  defaultEndpoint: 'https://openrouter.ai/api/v1',
  suggestModels(): ModelMap {
    return { ...OPENROUTER_MODELS };
  },
  roleDefaults() {
    return { ...ANTHROPIC_ROLE_DEFAULTS };
  },
  roleFriendlyModels() {
    return [
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.3-codex',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.6-flash',
      'x-ai/grok-4.5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5',
    ];
  },
  staticFallbackModels() {
    return [
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5.6-sol',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.6-flash',
      'x-ai/grok-4.5',
    ];
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchOpenAiStyleModels(ctx);
  },
};

const openai: CatalogProvider = {
  id: 'openai',
  name: 'OpenAI',
  description: 'OpenAI API',
  apiStyle: 'openai',
  protocols: ['openai'],
  defaultEndpoint: 'https://api.openai.com/v1',
  suggestModels(): ModelMap {
    return { ...OPENAI_MODELS };
  },
  roleDefaults() {
    return {
      default: 'gpt-5.6-sol',
      sonnet: 'gpt-5.6-sol',
      opus: 'gpt-5.6-sol',
      haiku: 'gpt-5.6-luna',
    };
  },
  roleFriendlyModels() {
    return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex', 'gpt-5.5', 'gpt-4.1'];
  },
  staticFallbackModels() {
    return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.3-codex'];
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchOpenAiStyleModels(ctx);
  },
};

const anthropic: CatalogProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  description: 'Anthropic Claude API',
  apiStyle: 'anthropic',
  protocols: ['anthropic'],
  defaultEndpoint: 'https://api.anthropic.com',
  suggestModels(): ModelMap {
    return { ...ANTHROPIC_MODELS };
  },
  roleDefaults() {
    return { ...ANTHROPIC_ROLE_DEFAULTS };
  },
  roleFriendlyModels() {
    return [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ];
  },
  staticFallbackModels() {
    return ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchAnthropicModels(ctx);
  },
};

const grokApi: CatalogProvider = {
  id: 'grok-api',
  name: 'Grok (xAI API)',
  description: 'xAI Grok API (API key)',
  apiStyle: 'openai',
  protocols: ['openai'],
  defaultEndpoint: 'https://api.x.ai/v1',
  suggestModels(): ModelMap {
    return { ...GROK_MODELS };
  },
  roleDefaults() {
    return {
      default: 'grok-4.5',
      sonnet: 'grok-4.5',
      opus: 'grok-4.5',
      haiku: 'grok-4.3',
    };
  },
  roleFriendlyModels() {
    return ['grok-4.5', 'grok-4.3', 'grok-4.20', 'grok'];
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchOpenAiStyleModels(ctx);
  },
};

const geminiApi: CatalogProvider = {
  id: 'gemini-api',
  name: 'Gemini (Google AI)',
  description: 'Google Gemini API (AI Studio key)',
  apiStyle: 'custom',
  protocols: ['openai', 'anthropic'],
  defaultEndpoint: 'https://generativelanguage.googleapis.com',
  suggestModels(): ModelMap {
    return { ...GEMINI_MODELS };
  },
  roleDefaults() {
    return {
      default: 'gemini-3.1-pro-preview',
      sonnet: 'gemini-3.6-flash',
      opus: 'gemini-3.1-pro-preview',
      haiku: 'gemini-3.6-flash',
    };
  },
  roleFriendlyModels() {
    return [
      'gemini-3.1-pro-preview',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-pro',
      'gemini-flash',
    ];
  },
  /** Gemini names cheap models "flash"/"lite" and strong models "pro". */
  roleModelHints() {
    return {
      default: ['pro'],
      opus: ['pro'],
      sonnet: ['flash', 'lite'],
      haiku: ['flash', 'lite'],
    };
  },
  // Account/model rollout differs between API-key and Code Assist OAuth, so an
  // empty picker is safer than inventing ids the account may not expose.
  staticFallbackModels() {
    return [];
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchGeminiModels(ctx);
  },
};

const litellm: CatalogProvider = {
  id: 'litellm',
  name: 'LiteLLM',
  description: 'Self-hosted LiteLLM proxy (OpenAI-compatible)',
  apiStyle: 'openai',
  protocols: ['openai', 'anthropic'],
  defaultEndpoint: 'http://127.0.0.1:4000',
  suggestModels(): ModelMap {
    // LiteLLM often re-exports upstream IDs as-is; ship a practical multi-provider set.
    return {
      'claude-sonnet': 'claude-sonnet-5',
      'claude-opus': 'claude-opus-5',
      'claude-haiku': 'claude-haiku-4-5',
      'claude-fable': 'claude-fable-5',
      gpt: 'gpt-5.6-sol',
      'gpt-5.6-sol': 'gpt-5.6-sol',
      'gpt-5.6-terra': 'gpt-5.6-terra',
      grok: 'grok-4.5',
    };
  },
  roleDefaults() {
    return { ...ANTHROPIC_ROLE_DEFAULTS };
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchOpenAiStyleModels(ctx);
  },
};

const localGateway: CatalogProvider = {
  id: 'local',
  name: 'Local Gateway',
  description: 'Local OpenAI-compatible gateway',
  apiStyle: 'openai',
  protocols: ['openai', 'anthropic'],
  defaultEndpoint: 'http://127.0.0.1:8080/v1',
  suggestModels(): ModelMap {
    return {
      default: 'default',
      'claude-sonnet': 'claude-sonnet-5',
      gpt: 'gpt-5.6-sol',
      grok: 'grok-4.5',
    };
  },
  roleDefaults() {
    return { ...ANTHROPIC_ROLE_DEFAULTS };
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchOpenAiStyleModels(ctx);
  },
};

const custom: CatalogProvider = {
  id: 'custom',
  name: 'Custom',
  description: 'Custom endpoint (you set URL and models)',
  apiStyle: 'custom',
  protocols: ['openai', 'anthropic'],
  suggestModels(): ModelMap {
    return {
      'claude-sonnet': 'claude-sonnet-5',
      'claude-opus': 'claude-opus-5',
      'claude-haiku': 'claude-haiku-4-5',
      gpt: 'gpt-5.6-sol',
      grok: 'grok-4.5',
    };
  },
  roleDefaults() {
    return { ...ANTHROPIC_ROLE_DEFAULTS };
  },
  /** Live list from the vendor; the maps above are the offline fallback. */
  fetchLiveModels(ctx: ModelDiscoveryContext) {
    return fetchOpenAiStyleModels(ctx);
  },
};

export function registerBuiltinCatalog(registry: CatalogRegistry): void {
  for (const p of [
    openrouter,
    openai,
    anthropic,
    grokApi,
    geminiApi,
    litellm,
    localGateway,
    custom,
  ]) {
    registry.register(p);
  }
}
