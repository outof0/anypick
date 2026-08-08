/** HTTP lifecycle and dependency wiring for the OpenCode compatibility proxy. */
import { createServer, type Server } from 'node:http';
import { assertLoopbackHost } from '../../utils/network';
import { json } from './http';
import { routeRequest } from './router';
import { OpenCodeRuntime } from './runtime';
import type { OpenCodeProxyServerOptions } from './types';

export type { OpenCodeProxyServerOptions } from './types';
export { estimateAnthropicInputTokens } from './body';

export function createOpenCodeProxyServer(opts: OpenCodeProxyServerOptions): Server {
  assertLoopbackHost(opts.host);
  const proxyToken = opts.token ?? process.env.ANYPICK_PROXY_TOKEN ?? '';
  const log =
    opts.log ?? (opts.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`));
  const runtime = new OpenCodeRuntime(opts, log);
  const server = createServer((req, res) => {
    void routeRequest(runtime, req, res, proxyToken, log).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ unhandled ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) {
        json(res, 502, { error: { message, type: 'proxy_error' } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  server.once('close', () => void runtime.egress.close());
  (server as unknown as { __warmCatalog?: () => Promise<void> }).__warmCatalog = async () => {
    await runtime.catalog.live();
  };
  return server;
}

export async function warmOpenCodeCatalog(server: Server): Promise<void> {
  const warm = (server as unknown as { __warmCatalog?: () => Promise<void> }).__warmCatalog;
  if (warm) {
    await warm();
  }
}

export function listenOpenCodeProxy(
  opts: OpenCodeProxyServerOptions,
): Promise<{ server: Server; endpoint: string; port: number }> {
  const server = createOpenCodeProxyServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind OpenCode proxy'));
        return;
      }
      resolve({
        server,
        endpoint: `http://${opts.host}:${address.port}`,
        port: address.port,
      });
    });
  });
}
