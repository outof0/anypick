/**
 * Model-policy resolution across both id spaces.
 *
 * AnyPick has two kinds of "provider": account providers (`codex`, `gemini`,
 * `grok`, …) that front a local login plus optional proxy, and catalog providers
 * (`openrouter`, `anthropic`, `grok-api`, …) that describe a remote gateway.
 * Both carry a `ModelPolicy`, and callers such as the model pickers hold only an
 * id string, so this resolves an id against whichever registry knows it.
 *
 * Account providers win on collision: `gemini` names the local CLI provider,
 * while the gateway catalog spells the API-key variant `gemini-api`.
 */

import type { ModelCatalogDescriptor, ModelMap, ModelPolicy } from '../types';
import type { ProviderRegistry } from './registry';
import type { CatalogRegistry } from '../catalog/providers';

export interface ModelPolicySources {
  accountRegistry?: Pick<ProviderRegistry, 'has' | 'get'>;
  catalog?: Pick<CatalogRegistry, 'has' | 'get'>;
}

/**
 * Convert a saved alias map into the picker catalog it explicitly exposes.
 * Runtime role defaults are intentionally not an input: they decide which
 * model starts a client, not which models the client advertises in its picker.
 */
export function configuredModelCatalog(models: ModelMap): ModelCatalogDescriptor[] {
  const result: ModelCatalogDescriptor[] = [];
  const seen = new Set<string>();
  for (const [rawAlias, rawId] of Object.entries(models)) {
    const id = rawId.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const alias = rawAlias.trim();
    result.push({
      id,
      ...(alias && alias !== id ? { displayName: `${alias} (${id})` } : {}),
    });
  }
  return result;
}

/**
 * Merge picker catalogs by model id while preserving source order and the
 * first source's labels. Later sources only enrich fields that were unknown;
 * this lets a configured alias remain stable while live provider metadata adds
 * truthful limits or capabilities.
 */
export function mergeModelCatalogs(
  ...sources: readonly (readonly ModelCatalogDescriptor[])[]
): ModelCatalogDescriptor[] {
  const result: ModelCatalogDescriptor[] = [];
  const indexById = new Map<string, number>();

  for (const source of sources) {
    for (const descriptor of source) {
      const id = descriptor.id.trim();
      if (!id) {
        continue;
      }
      const index = indexById.get(id);
      if (index == null) {
        indexById.set(id, result.length);
        result.push({ ...descriptor, id });
        continue;
      }

      const current = result[index];
      result[index] = {
        id,
        displayName: current.displayName ?? descriptor.displayName,
        description: current.description ?? descriptor.description,
        defaultReasoningLevel: current.defaultReasoningLevel ?? descriptor.defaultReasoningLevel,
        supportedReasoningLevels:
          current.supportedReasoningLevels ?? descriptor.supportedReasoningLevels,
        contextWindow: current.contextWindow ?? descriptor.contextWindow,
        maxContextWindow: current.maxContextWindow ?? descriptor.maxContextWindow,
        autoCompactTokenLimit: current.autoCompactTokenLimit ?? descriptor.autoCompactTokenLimit,
        inputModalities: current.inputModalities ?? descriptor.inputModalities,
        supportsParallelToolCalls:
          current.supportsParallelToolCalls ?? descriptor.supportsParallelToolCalls,
        supportsSearchTool: current.supportsSearchTool ?? descriptor.supportsSearchTool,
        supportsVerbosity: current.supportsVerbosity ?? descriptor.supportsVerbosity,
        supportsImageDetailOriginal:
          current.supportsImageDetailOriginal ?? descriptor.supportsImageDetailOriginal,
      };
    }
  }

  return result;
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
