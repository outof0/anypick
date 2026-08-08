import type { AnyPick } from './core/app';
import type { AnyPickEventSink } from './core/events';

/** Options accepted by the supported programmatic application factory. */
export interface CreateAnyPickAppOptions {
  /** Data root. Defaults to `~/.anypick` (or `ANYPICK_HOME`). */
  root?: string;
  /** Optional sanitized lifecycle-event sink owned by the caller. */
  events?: AnyPickEventSink;
}

/**
 * Open a fully initialized AnyPick application.
 *
 * The promise resolves only after schema migration, legacy migration, plugin
 * loading, and startup recovery have completed. The returned facade excludes
 * SQLite, stores, journals, and leases; call `close()` when finished.
 */
export async function createAnyPickApp(options: CreateAnyPickAppOptions = {}): Promise<AnyPick> {
  const { createAppReady } = await import('./core/app');
  return createAppReady(options);
}

export type { AnyPick } from './core/app';
