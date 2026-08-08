/**
 * Shared synthetic RuntimeProfile builder for account-proxy endpoint injection.
 *
 * Lives in core (not clients/) because `RuntimeService` needs it and core must
 * not take value imports from the clients package. Pure data builder — no fs,
 * no spawn, no env reads beyond the timestamp.
 */

import type { RuntimeProfile } from '../types';

export interface SyntheticProxyProfileOpts {
  name: string;
  endpoint: string;
  apiKey?: string;
  defaultModel?: string;
  /** Claude Code role models (and similar multi-slot clients). */
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  /** Full role map; keys default/sonnet/opus/haiku also fill meta fields. */
  modelRoles?: Record<string, string>;
  provider?: string;
}

/** Build a synthetic RuntimeProfile for account-proxy endpoint injection. */
export function syntheticProxyProfile(opts: SyntheticProxyProfileOpts): RuntimeProfile {
  const now = new Date().toISOString();
  const roles = opts.modelRoles ?? {};
  const defaultModel = opts.defaultModel ?? roles.default;
  const sonnetModel = opts.sonnetModel ?? roles.sonnet;
  const opusModel = opts.opusModel ?? roles.opus;
  const haikuModel = opts.haikuModel ?? roles.haiku;
  return {
    meta: {
      name: opts.name,
      provider: opts.provider ?? 'custom',
      createdAt: now,
      updatedAt: now,
      models: {},
      endpoint: opts.endpoint,
      defaultModel,
      sonnetModel,
      opusModel,
      haikuModel,
    },
    secrets: {
      apiKey: opts.apiKey ?? 'hotplug-proxy',
    },
    profileDir: '',
  };
}
