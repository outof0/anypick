import type { AnyPickApp } from '../core/app';
import { trayPreferences } from './settings';

export async function stopAllProxies(app: AnyPickApp): Promise<void> {
  await app.hub.stop().catch(() => {});
  await app.proxy.stopProxies();
  for (const provider of app.accountRegistry.list()) {
    try {
      const status = await app.proxy.poolProxyStatus(provider.id);
      if (status.running) {
        await app.proxy.stopPoolProxy(provider.id);
      }
    } catch {
      // Provider has no supported pool/proxy.
    }
  }
}

export async function startEnabledProxies(app: AnyPickApp): Promise<void> {
  const hub = await app.hub.get().catch(() => null);
  // Hub / account proxy failures must not take the whole Tray down — the menu
  // is how the user diagnoses and restarts them.
  if (hub?.enabled && hub.sources.some((source) => source.enabled)) {
    try {
      await app.hub.ensureRunning(hub.name);
    } catch (err) {
      process.stderr.write(
        `[tray] Proxy Hub failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  try {
    await app.proxy.startProxies();
  } catch (err) {
    process.stderr.write(
      `[tray] Account proxies failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  for (const provider of app.accountRegistry.list()) {
    try {
      const pool = await app.proxy.getPool(provider.id);
      if (pool.mode === 'multi' && pool.enabled) {
        await app.proxy.startPoolProxy(provider.id);
      }
    } catch {
      // Provider has no enabled pool/proxy, or start failed — keep going.
    }
  }
}

export async function startConfiguredProxies(app: AnyPickApp): Promise<void> {
  const preferences = trayPreferences(await app.config.read());
  if (preferences.startEnabledProxies) {
    await startEnabledProxies(app);
  }
}

export async function totalRunningProxyCount(
  app: AnyPickApp,
  accountProxyCount: number,
): Promise<number> {
  const hub = await app.hub.status().catch(() => null);
  return accountProxyCount + Number(hub?.running);
}
