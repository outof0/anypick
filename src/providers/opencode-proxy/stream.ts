import type { ServerResponse } from 'node:http';
import { HOP_BY_HOP } from '../proxy-shared';
import { isAbortError } from './abort';

export async function pipeResponse(
  upstreamRes: Response,
  res: ServerResponse,
  log: (line: string) => void,
  label?: string,
): Promise<void> {
  const started = Date.now();
  log(`← ${upstreamRes.status}${label ? ` ${label}` : ''}`);
  const headers: Record<string, string> = {};
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && lower !== 'content-encoding') {
      headers[key] = value;
    }
  });
  res.writeHead(upstreamRes.status, headers);
  if (!upstreamRes.body) {
    res.end();
    return;
  }

  let bytes = 0;
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    void upstreamRes.body?.cancel().catch(() => {});
  };
  res.once('close', onClose);
  const reader = upstreamRes.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    while (!clientGone && !res.writableEnded && !res.destroyed) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.byteLength) {
        continue;
      }
      bytes += value.byteLength;
      if (!res.write(Buffer.from(value))) {
        if (!(await waitForDrain(res))) {
          clientGone = true;
          void reader.cancel().catch(() => {});
          break;
        }
      }
    }
    if (!clientGone) {
      log(`✓ ${label ?? 'stream'} done · ${bytes} bytes · ${Date.now() - started}ms`);
    } else {
      log(`✗ client disconnected after ${bytes} bytes (aborting upstream)`);
    }
  } catch (err) {
    if (!isAbortError(err) && !clientGone) {
      log(
        `✗ ${label ?? 'stream'} interrupted after ${bytes} bytes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    res.removeListener('close', onClose);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
}

export function waitForDrain(res: ServerResponse): Promise<boolean> {
  if (res.writableEnded || res.destroyed || res.socket?.destroyed) {
    return Promise.resolve(false);
  }
  if (!res.writableNeedDrain) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onFail);
      res.removeListener('error', onFail);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onFail = () => done(false);
    res.once('drain', onDrain);
    res.once('close', onFail);
    res.once('error', onFail);
  });
}
