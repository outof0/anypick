import type { IncomingMessage } from 'node:http';
import { MAX_BODY_BYTES } from './constants';
import type { AnthropicMessageRequest } from '../protocol/anthropic';

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

export function compactBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}b` : `${Math.round(bytes / 1024)}kb`;
}

export function anthropicRequestBreakdown(body: AnthropicMessageRequest): string {
  return [
    `system=${compactBytes(jsonByteLength(body.system))}`,
    `messages=${body.messages?.length ?? 0}/${compactBytes(jsonByteLength(body.messages))}`,
    `tools=${body.tools?.length ?? 0}/${compactBytes(jsonByteLength(body.tools))}`,
  ].join(' ');
}

export function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}

export { estimateAnthropicInputTokens } from '../protocol/token-estimate';
