/**
 * Stable, side-effect-free public API.
 *
 * Extension contracts live at `anypick/adapters`; test-only composition
 * helpers live at `anypick/testing`. Internal source paths are unsupported.
 */
export type * from './types';
export {
  DEFAULT_PROXY_CONFIG,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_GLOBAL_CONFIG,
  PLUGIN_API_VERSION,
} from './types';
export { createAnyPickApp, type CreateAnyPickAppOptions, type AnyPick } from './public';
export { AnyPickError } from './utils/errors';
export {
  InMemoryEventSink,
  DebugStderrEventSink,
  type AnyPickEvent,
  type AnyPickEventSeverity,
  type AnyPickEventSink,
} from './core/events';
