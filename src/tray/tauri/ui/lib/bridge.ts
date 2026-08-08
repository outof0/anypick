import { createDemoBridge, emptyDemoSnapshot } from '../../demo/bridge.js';
import type { TrayBridge } from './types';

export function createBridge(): TrayBridge {
  if (window.__TAURI__) {
    return {
      isDemo: false,
      invoke: window.__TAURI__.core.invoke,
      listen: window.__TAURI__.event.listen,
    };
  }
  return createDemoBridge(
    new URLSearchParams(window.location.search).has('empty') ? emptyDemoSnapshot : undefined,
  );
}
