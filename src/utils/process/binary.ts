import { existsSync } from 'node:fs';

export async function resolveBinary(
  names: string[],
  extraPaths: string[] = [],
): Promise<string | null> {
  const { access, constants } = await import('node:fs/promises');
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');

  const candidates: string[] = [...extraPaths];
  for (const name of names) {
    if (name.includes('/') || name.includes('\\')) {
      candidates.push(name);
    } else {
      for (const dir of dirs) {
        if (!dir) {
          continue;
        }
        candidates.push(`${dir}/${name}`);
        if (process.platform === 'win32') {
          candidates.push(`${dir}\\${name}.cmd`, `${dir}\\${name}.exe`);
        }
      }
    }
  }

  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Locate an executable on PATH (and common locations). No hardcoded developer homes.
 * Returns absolute path or null.
 */
export function whichExecutable(name: string): string | null {
  if (!name || name.includes('/') || name.includes('\\')) {
    // Absolute/relative path — check existence only
    try {
      if (existsSync(name)) {
        return name;
      }
    } catch {
      return null;
    }
    return null;
  }
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = joinPath(
        dir,
        name + (ext && !name.toUpperCase().endsWith(ext.toUpperCase()) ? ext : ''),
      );
      try {
        if (existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

function joinPath(a: string, b: string): string {
  if (a.endsWith('/') || a.endsWith('\\')) {
    return a + b;
  }
  return a + (process.platform === 'win32' ? '\\' : '/') + b;
}

/**
 * Tail a file like `tail -f`: emits each new line via onLine.
 * Polls every 200ms (reliable across macOS/Linux/Windows and immune to the
 * missed-event races fs.watchFile can hit when an external process appends
 * rapidly). A read-position cursor ensures we only emit appended content
 * (survives rotation/truncation). Resolves when signal aborts.
 */
