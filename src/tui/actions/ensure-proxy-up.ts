import type { HotplugApp } from '../../core/app';
import type { ProxyRow } from '../model';
import { proxyRef } from '../app-ui-helpers';

export interface ProxyUpResult {
  endpoint?: string;
  restarted: boolean;
  realignedClients?: string[];
}

/**
 * Bring the proxy for `row` up, whatever state it is in.
 *
 * `enableProxy` only auto-starts the *active* account, so a row the user picked
 * off the board still has to be started explicitly.
 */
export async function ensureProxyUp(app: HotplugApp, row: ProxyRow): Promise<ProxyUpResult> {
  if (row.needsApiKey) {
    throw new Error(
      row.attentionHint ?? `${proxyRef(row)} needs GEMINI_API_KEY in the saved login .env`,
    );
  }
  if (row.rowKind === 'pool') {
    const handle = await app.proxy.startPoolProxy(row.providerId);
    return {
      endpoint: handle.endpoint,
      restarted: false,
      realignedClients: handle.realignedClients,
    };
  }
  const enabled = await app.proxy.enableProxy(row.providerId, row.name, { start: true });
  if (enabled.started) {
    return {
      endpoint: enabled.started.endpoint,
      restarted: false,
      realignedClients: enabled.started.realignedClients,
    };
  }
  const st = await app.proxy.proxyStatus(row.providerId, row.name);
  if (st.running) {
    return { endpoint: st.endpoint, restarted: false };
  }
  if (!st.enabled) {
    await app.proxy.enableProxy(row.providerId, row.name, { start: false });
  }
  const handle = await app.proxy.startProxy(row.providerId, row.name);
  return {
    endpoint: handle.endpoint,
    restarted: false,
    realignedClients: handle.realignedClients,
  };
}
