export interface IdleStreamReaderOptions {
  idleMs?: number;
  signal?: AbortSignal;
}

export interface IdleStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  markProgress(): void;
}

export function createIdleStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: IdleStreamReaderOptions,
): IdleStreamReader {
  let lastProgressAt = Date.now();

  const markProgress = () => {
    lastProgressAt = Date.now();
  };

  const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    const { idleMs, signal } = options;
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (idleMs != null && idleMs > 0 && Date.now() - lastProgressAt >= idleMs) {
      throw streamIdleError(idleMs);
    }
    if (idleMs == null || idleMs <= 0) {
      return reader.read();
    }

    const remaining = Math.max(1, idleMs - (Date.now() - lastProgressAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
      }
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => {});
            reject(streamIdleError(idleMs));
          }, remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
    }
  };

  return { read, markProgress };
}

function streamIdleError(idleMs: number): Error {
  return Object.assign(new Error(`upstream stream idle for ${idleMs}ms (no content)`), {
    name: 'TimeoutError',
    code: 'STREAM_IDLE',
  });
}
