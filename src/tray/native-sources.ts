import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Ordered Swift sources for the macOS menu-bar helper.
 * Prefer sources.txt so compile order stays stable across machines.
 */
export async function nativeTraySwiftFiles(nativeDir: string): Promise<string[]> {
  const manifest = join(nativeDir, 'sources.txt');
  try {
    const text = await readFile(manifest, 'utf8');
    const names = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.endsWith('.swift'));
    if (names.length > 0) {
      return names.map((name) => join(nativeDir, name));
    }
  } catch {
    // fall through
  }
  const entries = await readdir(nativeDir);
  return entries
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => join(nativeDir, name));
}

/** Concatenated sources — useful for string-scanning tests and fingerprints. */
export async function readNativeTraySwiftBundle(nativeDir: string): Promise<string> {
  const files = await nativeTraySwiftFiles(nativeDir);
  const chunks = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return chunks.join('\n\n');
}
