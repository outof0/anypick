/**
 * Unstable test helpers. These exports may change outside a major release.
 * Production integrations must import from `hotplug` and `hotplug/adapters`.
 */
export { createApp, createAppReady, type CreateAppOptions, type HotplugApp } from './core/app';
export { ProviderRegistry } from './core/registry';
export { ClientRegistry, registerBuiltinClients } from './clients/index';
export { CatalogRegistry, registerBuiltinCatalog } from './catalog/providers';
