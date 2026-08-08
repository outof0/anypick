import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const relativeSpecifier = /((?:from\s*|import\()['"](?:\.\.?\/)[^'"]+)(?=['"])/g;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
    } else if (entry.name.endsWith('.d.ts')) {
      const original = await readFile(path, 'utf8');
      const rewritten = original.replace(relativeSpecifier, (specifier) =>
        /\.(?:[cm]?js|json)$/.test(specifier) ? specifier : `${specifier}.js`,
      );
      if (rewritten !== original) {
        await writeFile(path, rewritten);
      }
    }
  }
}

await visit(dist);
