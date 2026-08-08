import type { AccountProxyConfig } from './account';
import type { Protocol } from './bindings';

export type ApiStyle = 'openai' | 'anthropic' | 'custom';

/** Maps logical alias → provider model id. */
export type ModelMap = Record<string, string>;

/**
 * A provider's opinion about which model fills each client-shaped role
 * (`default`, `sonnet`, `opus`, `haiku`), plus what to offer when live model
 * discovery is unavailable.
 *
 * Both `CatalogProvider` (gateways) and `Provider` (proxy-backed accounts)
 * expose this so core, CLI and TUI can ask the provider instead of consulting a
 * hardcoded `switch (providerId)`. A provider registered through the public API
 * therefore gets first-class model behaviour rather than falling into a
 * built-in default branch that suggests other vendors' model ids.
 *
 * Every field is optional: omitting all of them means "no opinion", which is
 * the correct answer for a provider whose catalog is account-specific and only
 * knowable from a live `/v1/models` call.
 */
export interface ModelPolicy {
  /**
   * Role id → model id. An empty string means "this role exists but must be
   * filled from live discovery or by the user" — deliberately distinct from an
   * absent key, which means the role does not apply to this provider.
   */
  roleDefaults?(): Record<string, string>;
  /**
   * Alias → model id map offered for autocomplete. Providers whose catalog is
   * account-specific should omit this: a stale map looks authoritative but its
   * ids fail at request time, which is worse than an empty picker.
   */
  suggestModels?(): ModelMap;
  /**
   * Extra bare ids offered for autocomplete beyond `suggestModels()` aliases.
   */
  roleFriendlyModels?(): readonly string[];
  /**
   * Conservative ids to show when live discovery fails. Prefer returning an
   * empty list over ids the account may not actually be entitled to.
   */
  staticFallbackModels?(): readonly string[];
  /**
   * Substrings that identify which live model suits each role, used to fill
   * roles from a `/v1/models` response. Gemini, for example, maps the cheap
   * roles to ids containing "flash"/"lite" and the strong roles to "pro".
   *
   * Only meaningful for providers whose roles come from live discovery; a
   * provider with fixed `roleDefaults()` has no need for it.
   */
  roleModelHints?(): Record<string, readonly string[]>;
  /**
   * Ask the vendor which models this credential can actually use.
   *
   * The provider owns the request shape because every vendor differs: OpenAI
   * exposes `GET /v1/models` with a bearer token, Anthropic needs an
   * `anthropic-version` header, Google puts the key in the query string of
   * `/v1beta/models`. Keeping that here is what lets core, CLI and TUI ask for a
   * live list without a `switch (providerId)`.
   *
   * Return the ids in the vendor's own order — the picker preserves it, and
   * newest-first is what makes the top suggestion the right default. Omitting
   * this method means "cannot be discovered", which falls back to the static
   * catalog rather than being an error.
   *
   * Implementations must fetch through `ctx.fetch`, never global `fetch`: it
   * carries the origin allowlist that keeps a rewritten endpoint from receiving
   * the user's API key.
   */
  fetchLiveModels?(ctx: ModelDiscoveryContext): Promise<readonly string[]>;
}

/** What a provider needs in order to ask its vendor for a model list. */
export interface ModelDiscoveryContext {
  /** Base URL to query — the profile's endpoint, or the catalog default. */
  endpoint: string;
  /** Credential for this gateway/account, absent when the endpoint is open. */
  apiKey?: string;
  /** Allowlisted, timeout-bounded fetch. Never call global `fetch` instead. */
  fetch: (target: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Catalog entry for an AI service used by runtime profiles.
 * Distinct from account auth providers (codex/grok/kiro file auth).
 */
export interface CatalogProvider extends ModelPolicy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly apiStyle: ApiStyle;
  /** Wire protocols the gateway actually serves. Never infer this from its id. */
  readonly protocols?: readonly Protocol[];
  readonly defaultEndpoint?: string;
}

// ── Runtime profiles ─────────────────────────────────────────────

export interface RuntimeProfileMeta {
  name: string;
  /** CatalogProvider.id */
  provider: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  notes?: string;
  endpoint?: string;
  /** Non-secret header names; values live in secrets. */
  headerNames?: string[];
  /**
   * Optional alias → model id map (advanced).
   * Prefer the first-class model fields below for day-to-day use.
   */
  models: ModelMap;
  /** Default / primary model (bare id for Claude Code, or gateway id for Codex). */
  defaultModel?: string;
  /** Claude Code role models — set at profile create, applied on profile use. */
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  /**
   * Per-client overlay (advanced). Keys are ClientAdapter.id.
   * Day-to-day model config lives on the profile fields above.
   */
  clientOverrides?: Record<string, Record<string, unknown>>;
  /** Optional proxy config (account-style shape + optional adapterId). */
  proxy?: AccountProxyConfig & { adapterId?: string };
}

export interface RuntimeProfileSecrets {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface RuntimeProfile {
  meta: RuntimeProfileMeta;
  secrets: RuntimeProfileSecrets;
  profileDir: string;
}

// ── Clients ──────────────────────────────────────────────────────
