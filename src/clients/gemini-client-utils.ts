import { join } from 'node:path';
import { pathExists, removePath } from '../utils/fs';
import type { ClientState } from '../types';

export async function stripKeysFromEnv(filePath: string, keys: string[]): Promise<void> {
  if (!keys.length || !(await pathExists(filePath))) {
    return;
  }
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf8');
  const drop = new Set(keys);
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && drop.has(m[1])) {
      continue;
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') {
    kept.pop();
  }
  if (!kept.length) {
    await removePath(filePath);
    return;
  }
  const { writeTextFile } = await import('../utils/fs');
  await writeTextFile(filePath, `${kept.join('\n')}\n`, 0o600);
}

export function stateHomeRoot(state: ClientState, fallbackHome: string): string {
  for (const p of state.managedPaths) {
    const idx = p.replace(/\\/g, '/').indexOf('/clients/gemini/');
    if (idx > 0) {
      return p.slice(0, idx);
    }
  }
  return process.env.HOTPLUG_HOME ?? join(fallbackHome, '.hotplug');
}
