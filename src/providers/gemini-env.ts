import { readFile, rm } from 'node:fs/promises';
import { pathExists, writeTextFile } from '../utils/fs';

const AUTH_ENV_KEYS = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_USE_VERTEXAI',
]);

export async function stripEnvAuthKeys(envPath: string): Promise<string> {
  const raw = await readFile(envPath, 'utf8');
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && AUTH_ENV_KEYS.has(m[1])) {
      continue;
    }
    kept.push(line);
  }
  // Drop trailing empty lines
  while (kept.length && kept[kept.length - 1] === '') {
    kept.pop();
  }
  return kept.join('\n');
}

/** Parse GEMINI_API_KEY (or GOOGLE_API_KEY) from a dotenv-style file. */
export async function readGeminiApiKeyFromEnvFile(envPath: string): Promise<string | undefined> {
  if (!(await pathExists(envPath))) {
    return undefined;
  }
  try {
    const raw = await readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^(?:export\s+)?(GEMINI_API_KEY|GOOGLE_API_KEY)=(.*)$/);
      if (!m) {
        continue;
      }
      let v = m[2] ?? '';
      // strip quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      v = v.trim();
      if (v) {
        return v;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Merge key=value pairs into a dotenv file, replacing existing keys.
 */
export async function upsertEnvFile(
  envPath: string,
  entries: Record<string, string | undefined>,
): Promise<void> {
  let lines: string[] = [];
  if (await pathExists(envPath)) {
    try {
      lines = (await readFile(envPath, 'utf8')).split(/\r?\n/);
    } catch {
      lines = [];
    }
  }

  const keys = new Set(
    Object.keys(entries).filter((k) => entries[k] !== undefined && entries[k] !== ''),
  );
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && keys.has(m[1])) {
      const k = m[1];
      if (!seen.has(k)) {
        out.push(`${k}=${entries[k]}`);
        seen.add(k);
      }
      continue;
    }
    out.push(line);
  }

  for (const k of keys) {
    if (!seen.has(k) && entries[k]) {
      out.push(`${k}=${entries[k]}`);
    }
  }

  while (out.length && out[out.length - 1] === '') {
    out.pop();
  }
  const body = out.length ? `${out.join('\n')}\n` : '';
  if (!body) {
    await rm(envPath, { force: true }).catch(() => {});
    return;
  }
  await writeTextFile(envPath, body, 0o600);
}
