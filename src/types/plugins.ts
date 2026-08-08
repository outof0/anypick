import type { Provider } from './account';
import type { ClientAdapter } from './clients';
import type { CatalogProvider } from './catalog';

/**
 * The plugin API generation this build understands.
 *
 * A plugin declares the generation it was written against. Refusing a mismatch
 * is cheaper than debugging a plugin that registers an adapter shaped for an
 * older `Provider` interface, because a half-implemented adapter is discovered
 * only when it rewrites a real credential file.
 */
export const PLUGIN_API_VERSION = 1;

/** Manifest read from `hotplug.plugin.json` at the plugin root. */
export interface PluginManifest {
  /** Unique id. Also the directory-independent key used by config and the CLI. */
  name: string;
  version: string;
  description?: string;
  /** Must equal `PLUGIN_API_VERSION`. */
  apiVersion: number;
  /** Entry module, resolved relative to the plugin root. */
  main: string;
}

/**
 * What a plugin is allowed to do.
 *
 * Deliberately three register functions and nothing else — no database, no
 * stores, no data root. A plugin extends the *composition graph*; it does not
 * get an ambient capability to read the credential snapshots that graph
 * manages. Widening this is a security decision, not an ergonomics one.
 */
export interface PluginContext {
  readonly apiVersion: number;
  /** Plugin's own root directory, for reading files it ships. */
  readonly pluginRoot: string;
  registerProvider: (provider: Provider) => void;
  registerClient: (client: ClientAdapter) => void;
  registerCatalogProvider: (provider: CatalogProvider) => void;
}

/**
 * The shape a plugin entry module must export.
 *
 * `activate` is synchronous on purpose: it runs inside `createApp`, between
 * builtin registration and sealing the registries. Any async setup a plugin
 * needs belongs in the adapter methods, which are already async.
 */
export interface HotplugPlugin {
  activate: (ctx: PluginContext) => void;
  /** Called once, in reverse activation order, when the owning app closes. */
  dispose?: () => void;
}

/** A plugin recorded in the data directory. */
export interface PluginRecord {
  name: string;
  /** Absolute path to the plugin root (the directory holding the manifest). */
  path: string;
  version: string;
  enabled: boolean;
  /**
   * SHA-256 of the entry module as it looked when the user trusted it.
   *
   * Re-verified on every load: an enabled plugin whose code changed underneath
   * the user is refused until they run `hotplug plugin trust` again (ADR 0012).
   */
  digest: string;
  addedAt: string;
  updatedAt: string;
}

/** A plugin whose entry module imported and type-checked, ready to activate. */
export interface LoadedPlugin {
  record: PluginRecord;
  manifest: PluginManifest;
  plugin: HotplugPlugin;
}

/** A plugin that was enabled but could not be loaded. */
export interface PluginLoadFailure {
  name: string;
  path: string;
  reason: string;
  /** True when the entry module no longer matches the trusted digest. */
  untrusted: boolean;
}

export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  failures: PluginLoadFailure[];
}
