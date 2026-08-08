import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Resolve project root for project bindings (spec §16.2):
 * 1. nearest Git root
 * 2. otherwise current working directory
 */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  let dir = resolve(cwd);
  const root = resolve('/');
  while (true) {
    if (existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) {
      break;
    }
    dir = parent;
  }
  return resolve(cwd);
}
