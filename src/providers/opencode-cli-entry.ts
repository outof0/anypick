import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveCliEntry(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const primary = join(here, '..', 'cli.js');
  if (existsSync(primary)) {
    return primary;
  }
  const fromSrc = join(here, '..', '..', 'dist', 'cli.js');
  if (existsSync(fromSrc)) {
    return fromSrc;
  }
  return primary;
}
