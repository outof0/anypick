/**
 * Model-policy resolution across both id spaces.
 *
 * Hotplug has two kinds of "provider": account providers (`codex`, `gemini`,
 * `grok`, …) that front a local login plus optional proxy, and catalog providers
 * (`openrouter`, `anthropic`, `grok-api`, …) that describe a remote gateway.
 * Both carry a `ModelPolicy`, and callers such as the model pickers hold only an
 * id string, so this resolves an id against whichever registry knows it.
 *
 * Account providers win on collision: `gemini` names the local CLI provider,
 * while the gateway catalog spells the API-key variant `gemini-api`.
 */

import type { ModelPolicy } from '../types';
import type { ProviderRegistry } from './registry';
import type { CatalogRegistry } from '../catalog/providers';

export interface ModelPolicySources {
  accountRegistry?: Pick<ProviderRegistry, 'has' | 'get'>;
  catalog?: Pick<CatalogRegistry, 'has' | 'get'>;
}

/**
 * Build a lookup usable by `defaultModelRolesForProxy` and friends. Returns
 * `undefined` for ids neither registry knows, which callers treat as "no
 * opinion" rather than as an error — a model picker must still render for an
 * unrecognized id.
 */
export function modelPolicyLookup(
  sources: ModelPolicySources,
): (providerId: string) => ModelPolicy | undefined {
  return (providerId: string): ModelPolicy | undefined => {
    if (sources.accountRegistry?.has(providerId)) {
      return sources.accountRegistry.get(providerId);
    }
    if (sources.catalog?.has(providerId)) {
      return sources.catalog.get(providerId);
    }
    return undefined;
  };
}
