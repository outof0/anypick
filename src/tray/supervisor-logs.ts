import { readFile } from 'node:fs/promises';
import type { AnyPickApp } from '../core/app';
import { trayLogPath } from '../core/tray-runtime';
import { AnyPickError, isAnyPickError } from '../utils/errors';
import { trayLogSourceId } from './protocol';
import type { TrayLogsCommand, TrayProxyLogsResult, TrayProxyLogsState } from './protocol';

export async function resolveTrayProxyLogs(
  app: AnyPickApp,
  payload: TrayLogsCommand,
): Promise<TrayProxyLogsResult> {
  const proxyId = trayLogSourceId(payload.providerId, payload.name);
  const result = (state: TrayProxyLogsState, text: string): TrayProxyLogsResult => ({
    version: 1,
    requestId: payload.requestId,
    proxyId,
    state,
    text: redactTrayProxyLogs(text),
  });
  try {
    if (payload.providerId === 'proxy-hub') {
      const hub = await app.hub.get();
      if (payload.name !== hub.name) {
        throw new AnyPickError('That Proxy Hub log source does not exist.', 'RESOURCE_NOT_FOUND');
      }
      const [raw, status] = await Promise.all([
        app.hub.logs(hub.name, payload.lines),
        app.hub.status(hub.name),
      ]);
      if (!status.running) {
        return result(
          'not-running',
          raw.trim()
            ? `Proxy Hub is not running. Showing previous logs.\n\n${raw}`
            : 'Proxy Hub is not running. Start it to create logs.',
        );
      }
      return raw.trim()
        ? result('ready', raw)
        : result('empty', 'Proxy Hub is running. No log entries yet.');
    }
    if (payload.providerId === 'tray-supervisor') {
      if (payload.name !== 'main') {
        throw new AnyPickError('That Tray log source does not exist.', 'RESOURCE_NOT_FOUND');
      }
      const raw = await readFile(trayLogPath(app.root), 'utf8').catch(() => '');
      const all = raw.split(/\r?\n/u);
      const text = all.slice(Math.max(0, all.length - payload.lines)).join('\n');
      return text.trim()
        ? result('ready', text)
        : result('empty', 'Tray supervisor has no log entries yet.');
    }
    const [raw, state] = await Promise.all([
      app.proxy.proxyLogs(payload.providerId, payload.name, payload.lines),
      app.accountStore.readProxyState(payload.providerId, payload.name).catch(() => null),
    ]);
    return {
      version: 1,
      requestId: payload.requestId,
      proxyId,
      state: raw.trim() ? 'ready' : 'empty',
      text: redactTrayProxyLogs(raw.trim() ? raw : 'No proxy log entries yet.', state?.token),
    };
  } catch (err) {
    return result('error', trayLogReadError(err, payload.providerId));
  }
}

function trayLogReadError(err: unknown, providerId: string): string {
  if (isAnyPickError(err) && err.code === 'RESOURCE_NOT_FOUND') {
    return 'That log source no longer exists. Refresh AnyPick and try again.';
  }
  return providerId === 'proxy-hub'
    ? 'Could not read Proxy Hub logs. Refresh and try again.'
    : 'Could not read proxy logs. Refresh and try again.';
}

/** The native helper is an output boundary; runtime and upstream secrets stay in the supervisor. */
export function redactTrayProxyLogs(raw: string, runtimeToken?: string): string {
  const exactRedacted = runtimeToken?.trim() ? raw.replaceAll(runtimeToken, '<redacted>') : raw;
  return exactRedacted
    .replace(/("(?:token|api[_-]?key|authorization|secret)"\s*:\s*")[^"]+/giu, '$1<redacted>')
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer <redacted>')
    .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/giu, '$1<redacted>')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/gu, '<redacted>')
    .replace(/\b[a-f0-9]{48,}\b/giu, '<redacted>')
    .slice(-24_000);
}
