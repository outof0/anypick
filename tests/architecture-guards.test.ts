/**
 * Structural guards for the layering and extension contracts.
 *
 * These are not behavioral tests — they fail when a forbidden import or
 * pattern reappears in source. Prefer fixing the architecture over
 * expanding the allowlists.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      // Tauri frontend is intentionally out of scope for these guards.
      if (entry.isDirectory()) {
        if (entry.name === 'tauri' && relative(SRC, full) === 'tray/tauri') {
          continue;
        }
        if (entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        await walk(full);
        continue;
      }
      if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function readSource(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('architecture guards', () => {
  it('withMutationLocks is only used from core and owned tray activity', async () => {
    const files = await listTsFiles(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      const source = stripComments(await readSource(file));
      if (!source.includes('withMutationLocks')) {
        continue;
      }
      // Definition and re-exports are fine.
      if (rel === 'core/mutation-lock.ts') {
        continue;
      }
      // Core services own coordinator locks (ADR 0009 / 0011).
      if (rel.startsWith('core/')) {
        continue;
      }
      // Tray activity is a service-owned scope outside core.
      if (rel === 'tray/activity.ts') {
        continue;
      }
      offenders.push(rel);
    }
    expect(offenders, `unexpected withMutationLocks callers:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('CLI/TUI presentation layers do not switch on built-in provider/client ids', async () => {
    const roots = ['cli', 'tui'].map((p) => join(SRC, p));
    const offenders: string[] = [];
    // Matches `case 'claude':` / `case "codex":` style vendor branches.
    const caseRe = /\bcase\s+['"](?:claude|codex|gemini|kiro|grok|opencode)['"]\s*:/g;
    for (const root of roots) {
      const files = await listTsFiles(root);
      for (const file of files) {
        const rel = relative(SRC, file);
        const source = stripComments(await readSource(file));
        if (caseRe.test(source)) {
          offenders.push(rel);
        }
        caseRe.lastIndex = 0;
      }
    }
    expect(
      offenders,
      `vendor case branches in presentation layers:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('getDefaultApp is never called (throws by design)', async () => {
    const files = await listTsFiles(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel === 'core/app.ts') {
        continue;
      }
      const source = stripComments(await readSource(file));
      if (/\bgetDefaultApp\s*\(/.test(source)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `getDefaultApp callers:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('src tree still exists (sanity)', async () => {
    const info = await stat(SRC);
    expect(info.isDirectory()).toBe(true);
  });
});
