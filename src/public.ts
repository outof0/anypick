import type { Hotplug } from './core/app';
import type { HotplugEventSink } from './core/events';

/** Options accepted by the supported programmatic application factory. */
export interface CreateHotplugAppOptions {
  /** Data root. Defaults to `~/.hotplug` (or `HOTPLUG_HOME`). */
  root?: string;
  /** Optional sanitized lifecycle-event sink owned by the caller. */
  events?: HotplugEventSink;
}

/**
 * Open a fully initialized Hotplug application.
 *
 * The promise resolves only after schema migration, legacy migration, plugin
 * loading, and startup recovery have completed. The returned facade excludes
 * SQLite, stores, journals, and leases; call `close()` when finished.
 */
export async function createHotplugApp(options: CreateHotplugAppOptions = {}): Promise<Hotplug> {
  const { createAppReady } = await import('./core/app');
  return createAppReady(options);
}

export type { Hotplug } from './core/app';
