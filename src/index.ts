/**
 * Stable, side-effect-free public API.
 *
 * Extension contracts live at `hotplug/adapters`; test-only composition
 * helpers live at `hotplug/testing`. Internal source paths are unsupported.
 */
export type * from './types';
export {
  DEFAULT_PROXY_CONFIG,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_GLOBAL_CONFIG,
  PLUGIN_API_VERSION,
} from './types';
export { createHotplugApp, type CreateHotplugAppOptions, type Hotplug } from './public';
export { HotplugError } from './utils/errors';
export {
  InMemoryEventSink,
  DebugStderrEventSink,
  type HotplugEvent,
  type HotplugEventSeverity,
  type HotplugEventSink,
} from './core/events';
