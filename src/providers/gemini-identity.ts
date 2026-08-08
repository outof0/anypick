import { join } from 'node:path';
import { pathExists, readJsonFile } from '../utils/fs';

export async function readIdentityFromDir(dir: string): Promise<string | undefined> {
  const accountsPath = join(dir, 'google_accounts.json');
  if (await pathExists(accountsPath)) {
    try {
      const data = await readJsonFile<{ active?: string }>(accountsPath);
      if (typeof data.active === 'string' && data.active.trim()) {
        return data.active.trim();
      }
    } catch {
      // fall through
    }
  }

  // Best-effort: email-like line in .env comments is rare; skip.
  return undefined;
}
