import type { IncomingMessage, ServerResponse } from 'node:http';
import { UPSTREAM_TIMEOUT_MS } from './constants';

export function linkClientAbort(
  req: IncomingMessage,
  res: ServerResponse,
): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`)),
    UPSTREAM_TIMEOUT_MS,
  );
  timer.unref?.();
  const onClientGone = () => {
    if (!ac.signal.aborted) {
      ac.abort(new Error('client disconnected'));
    }
  };
  req.once('aborted', onClientGone);
  const onResClose = () => {
    if (!res.writableFinished) {
      onClientGone();
    }
  };
  res.once('close', onResClose);
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      req.removeListener('aborted', onClientGone);
      res.removeListener('close', onResClose);
    },
  };
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const value = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (value.name === 'AbortError' || value.name === 'TimeoutError') {
    return true;
  }
  if (value.code === 'ABORT_ERR' || value.code === 'STREAM_IDLE') {
    return true;
  }
  if (
    typeof value.message === 'string' &&
    /aborted|abort|disconnect|client gone|STREAM_IDLE|upstream timeout/i.test(value.message)
  ) {
    return true;
  }
  return value.cause ? isAbortError(value.cause) : false;
}

export function describeAbort(signal: AbortSignal, err: unknown): string {
  const reason: unknown = signal.aborted ? (signal.reason as unknown) : err;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : err instanceof Error
          ? err.message
          : String(reason ?? 'aborted');
  if (/client disconnected|client gone/i.test(message)) {
    return 'client disconnected (Claude cancelled the request)';
  }
  if (/upstream timeout|stream idle|STREAM_IDLE/i.test(message)) {
    return message;
  }
  return message && !/^this operation was aborted$/i.test(message) ? message : 'request aborted';
}
