/**
 * Provider capability descriptors.
 *
 * A single source of truth for "what can this provider do" so the core, the
 * TUI, and the CLI all agree. Proxy capability is the presence of a
 * `startProxy` lifecycle (the old boolean `supportsProxy` flag is gone).
 *
 * Prefer these helpers over ad-hoc `typeof provider.foo === 'function'` checks
 * at call sites. Full composition of Provider into Auth/Proxy/Hub facets is a
 * later semver-friendly step; this matrix is the intermediate contract.
 */
import type { Provider } from '../types';

/** Proxy capability: presence of startProxy lifecycle (replaces supportsProxy). */
export function providerCanProxy(provider: Provider): boolean {
  return typeof provider.startProxy === 'function';
}

/** Refresh capability: presence of refreshAuth. */
export function providerCanRefresh(provider: Provider): boolean {
  return typeof provider.refreshAuth === 'function';
}

export interface ProviderCapabilities {
  canProxy: boolean;
  canRefresh: boolean;
  canClear: boolean;
  canDescribe: boolean;
  canBackupInput: boolean;
  canHubBackend: boolean;
  canPool: boolean;
  requiresAccountSourcePick: boolean;
  proxyRequiresApiKey: boolean;
}

/** Single capability descriptor for a provider. */
export function providerCapabilities(provider: Provider): ProviderCapabilities {
  return {
    canProxy: providerCanProxy(provider),
    canRefresh: providerCanRefresh(provider),
    canClear: typeof provider.clearLive === 'function',
    canDescribe: typeof provider.describeSnapshot === 'function',
    canBackupInput: typeof provider.backupInput === 'function',
    canHubBackend: typeof provider.createProxyHubBackend === 'function',
    canPool: typeof provider.poolSourceAdapter === 'function',
    requiresAccountSourcePick: provider.requiresAccountSourcePick === true,
    proxyRequiresApiKey: provider.proxyRequiresApiKey === true,
  };
}
