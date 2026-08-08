import { parseArgs } from 'node:util';
import { createAppReady } from './app';
import { ProxyHubServer } from './proxy-hub-server';
import { proxyHubLogPath } from './paths';

/** Internal detached-process entry. Never exposes Hub route tokens. */
export async function runProxyHubCli(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', default: 'default' },
      host: { type: 'string', default: '' },
      port: { type: 'string', default: '' },
    },
  });
  const name = values.name?.trim() || 'default';
  const app = await createAppReady();
  const config = await app.hub.get(name);
  const host = values.host?.trim() || config.host;
  const port = values.port ? Number(values.port) : config.port;
  if (!config.enabled || host !== config.host || port !== config.port) {
    app.close();
    throw new Error('Proxy Hub process configuration does not match the saved Hub profile.');
  }
  const server = new ProxyHubServer(
    {
      hubs: app.hubStore,
      accounts: app.accounts,
      pools: app.pools,
      accountRegistry: app.accountRegistry,
    },
    {
      name,
      host,
      port,
      instanceId: process.env.ANYPICK_INSTANCE_ID,
      log: (line) => process.stderr.write(`${line}\n`),
    },
  );
  const listening = await server.listen();
  app.hubStore.saveRuntime({
    name,
    endpoint: listening.endpoint,
    pid: process.pid,
    instanceId: server.instanceId,
    logPath: proxyHubLogPath(app.root, name),
    startedAt: new Date().toISOString(),
  });
  // Parent sets ANYPICK_DEV_WATCH=1 when spawning under `tsx watch` so hub.log
  // shows why an edit to src/ restarts this process without a manual restart.
  const watchNote =
    process.env.ANYPICK_DEV_WATCH === '1' ? ' (dev hot-reload: tsx watch on src/)' : '';
  process.stdout.write(`anypick-proxy-hub listening on ${listening.endpoint}${watchNote}\n`);

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= server
      .close()
      .catch(() => {})
      .finally(() => {
        try {
          app.close();
        } catch {
          // shutdown path — ignore
        }
      });
    return closing;
  };
  // Hard deadline so `tsx watch` reloads never wait on the default 5s force-kill.
  const shutdown = (signal: string) => {
    const hard = setTimeout(() => process.exit(0), 2_000);
    hard.unref?.();
    void close().finally(() => {
      clearTimeout(hard);
      process.exit(0);
    });
    void signal;
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
