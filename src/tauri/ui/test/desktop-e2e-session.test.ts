import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createNativeSession } from '../scripts/desktop-e2e-session.mjs';

it.each([true, false])('creates a session only after the native window is ready (eventually ready: %s)', async (eventuallyReady) => {
  let polls = 0;
  let sessions = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/status') {
      polls++;
      response.end(JSON.stringify({ value: { ready: eventuallyReady && polls >= 3 } }));
    } else {
      sessions++;
      response.end(JSON.stringify({ value: polls >= 3 ? { sessionId: 'native-session' } : { error: 'no such window' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()).value;
  };
  const wait = async (_label: string, check: () => Promise<unknown>) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const value = await check();
      if (value) return value;
    }
    throw new Error('window readiness timed out');
  };
  try {
    if (eventuallyReady) {
      expect(await createNativeSession(request, wait, {})).toEqual({ sessionId: 'native-session' });
      expect(polls).toBe(3);
      expect(sessions).toBe(1);
    } else {
      await expect(createNativeSession(request, wait, {})).rejects.toThrow('window readiness timed out');
      expect(sessions).toBe(0);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
