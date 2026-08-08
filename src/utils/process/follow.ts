import { open, stat } from 'node:fs/promises';

interface FileIdentity {
  dev: number;
  ino: number;
}

function identityOf(file: { dev: number; ino: number }): FileIdentity {
  return { dev: file.dev, ino: file.ino };
}

function sameFile(a: FileIdentity | undefined, b: FileIdentity): boolean {
  return a?.dev === b.dev && a.ino === b.ino;
}

export async function followFile(
  path: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  let cursor = 0;
  let buffer = '';
  let stopped = false;
  let decoder = new TextDecoder();
  let identity: FileIdentity | undefined;
  let reading = false;

  const flush = (text: string) => {
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        onLine(line);
      }
    }
  };

  const readFrom = async () => {
    if (stopped || reading) {
      return;
    }
    reading = true;
    try {
      const current = await stat(path);
      const currentIdentity = identityOf(current);
      if (!sameFile(identity, currentIdentity) || current.size < cursor) {
        // A renamed replacement can be longer than its predecessor, so size
        // alone is not enough. Reset both byte and UTF-8 decoder state.
        cursor = 0;
        buffer = '';
        decoder = new TextDecoder();
      }
      identity = currentIdentity;
      const unread = current.size - cursor;
      if (unread > 0) {
        // Read only the appended range. A proxy log can run for days; polling
        // must be proportional to new bytes, not the lifetime file size.
        const handle = await open(path, 'r');
        try {
          const appended = Buffer.allocUnsafe(unread);
          const { bytesRead } = await handle.read(appended, 0, unread, cursor);
          cursor += bytesRead;
          flush(decoder.decode(appended.subarray(0, bytesRead), { stream: true }));
        } finally {
          await handle.close();
        }
      }
    } catch {
      // file not present yet — keep cursor, wait for next poll
    } finally {
      reading = false;
    }
  };

  // Seed cursor at end of current file so we only emit *new* lines.
  try {
    const s = await stat(path);
    cursor = s.size;
    identity = identityOf(s);
  } catch {
    cursor = 0;
  }

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    // Poll every 200ms — reliable across macOS/Linux and immune to the
    // missed-event races that fs.watchFile can hit when an external process
    // (the proxy) appends rapidly.
    timer = setInterval(() => {
      if (stopped) {
        clearInterval(timer);
        return;
      }
      void readFrom();
    }, 200);
  });
}
