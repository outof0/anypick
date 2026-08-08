import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathExists } from '../utils/fs';

export function isUnderRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

export async function walkHotplugOwned(
  root: string,
  visit: (path: string, isDir: boolean) => Promise<void>,
): Promise<void> {
  if (!(await pathExists(root))) {
    return;
  }
  await visit(root, true);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = await stat(full);
        if (st.isDirectory()) {
          await visit(full, true);
          stack.push(full);
        } else if (st.isFile()) {
          await visit(full, false);
        }
      } catch {
        // ignore
      }
    }
  }
}
