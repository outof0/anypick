import type { Server } from 'node:http';

/** Close an in-process backend without leaving a handle alive in the Hub child. */
export function closeProxyHubBackend(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
