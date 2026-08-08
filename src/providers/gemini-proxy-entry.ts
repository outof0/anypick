import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveProxyMain(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const primary = join(here, 'gemini-proxy', 'main.js');
  if (existsSync(primary)) {
    return primary;
  }
  const fromSrc = join(here, '..', '..', 'dist', 'providers', 'gemini-proxy', 'main.js');
  if (existsSync(fromSrc)) {
    return fromSrc;
  }
  return primary;
}
