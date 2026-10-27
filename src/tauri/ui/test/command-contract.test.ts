import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CORPUS, CORPUS_PATH, CORPUS_REQUEST_ID, MUTATE_CASES, OTHER_CASES, parseLine } from './command-corpus';

/**
 * The UI → engine half of the contract. `contract-drift.test.ts` pins what the
 * engine sends the UI; nothing pinned what the UI sends back, and the fake
 * bridge accepted any line. That is how Add Login's Detect shipped without the
 * `name` the engine requires: the UI test asserted with `objectContaining`, the
 * bridge said yes, and on a real install every press was `MALFORMED_FRAME`.
 *
 * Set ANYPICK_UPDATE_GOLDEN=1 to rewrite the golden after a deliberate change;
 * the Go test then decides whether the engine accepts it.
 */

const uiRoot = resolve(__dirname, '..');
const builderSource = readFileSync(join(uiRoot, 'lib/desktop-actions.ts'), 'utf8');

function golden() {
  return CORPUS.map((entry) => {
    const parsed = parseLine(entry.line);
    if (!parsed) throw new Error(`${entry.builder}/${entry.name} is not a framed line`);
    return { case: `${entry.builder}: ${entry.name}`, kind: parsed.kind, payload: parsed.payload };
  });
}

/** Source files a pane, sheet, or shell control lives in. */
function uiSources(): Array<{ path: string; text: string }> {
  const files: string[] = ['App.tsx'];
  for (const dir of ['panes', 'shell', 'ui']) {
    for (const file of readdirSync(join(uiRoot, dir))) {
      if (/\.tsx?$/.test(file)) files.push(join(dir, file));
    }
  }
  return files.map((path) => ({ path, text: readFileSync(join(uiRoot, path), 'utf8') }));
}

describe('UI → engine command contract', () => {
  it('matches the golden the Go engine validates', () => {
    const expected = `${JSON.stringify(golden(), null, 2)}\n`;
    if (process.env.ANYPICK_UPDATE_GOLDEN === '1') writeFileSync(CORPUS_PATH, expected);
    expect(
      readFileSync(CORPUS_PATH, 'utf8'),
      'ui-commands.json is stale: rerun with ANYPICK_UPDATE_GOLDEN=1, then run the Go test',
    ).toBe(expected);
  });

  it('gives every command a fixed request id and a unique case name', () => {
    const names = CORPUS.map((entry) => `${entry.builder}: ${entry.name}`);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of CORPUS) {
      expect(parseLine(entry.line)?.payload.requestId, entry.name).toBe(CORPUS_REQUEST_ID);
    }
  });

  it('has a case for every builder that returns a DesktopAction', () => {
    const file = ts.createSourceFile('desktop-actions.ts', builderSource, ts.ScriptTarget.Latest, true);
    const builders = file.statements
      .filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .filter((fn) => /\bDesktopAction\b/.test(fn.type?.getText(file) ?? ''))
      .map((fn) => fn.name?.text ?? '');
    // Guards the extraction: matching nothing would make the check below pass.
    expect(builders.length).toBeGreaterThan(25);
    const covered = new Set(MUTATE_CASES.map((entry) => entry.builder));
    expect(builders.filter((name) => !covered.has(name))).toEqual([]);
  });

  it('covers every non-mutate kind the service sends', () => {
    const service = readFileSync(join(uiRoot, 'lib/service.ts'), 'utf8');
    const encoders = [...new Set([...service.matchAll(/\b(\w+Command)\(/g)].map((match) => match[1]))];
    expect(encoders.length).toBeGreaterThan(5);
    const covered = new Set(OTHER_CASES.map((entry) => entry.builder));
    expect(encoders.filter((name) => name !== 'mutateCommand' && !covered.has(name))).toEqual([]);
  });

  it('compares what the UI sent exactly, never by containment', () => {
    // A containment matcher passes when a required key is missing, which is
    // the whole class of bug this file exists for. `FakeBridge.bodies` strips
    // the envelope so an exact comparison stays short.
    const sentPayload = /\bbodies\(|mutateBodies\(|mutatePayloads\(|decodePayload\(|\.payload\)/;
    const loose = /toMatchObject\(|objectContaining\(/;
    const testDir = resolve(__dirname);
    const offenders = readdirSync(testDir)
      .filter((file) => /\.test\.tsx?$/.test(file) && file !== 'command-contract.test.ts')
      .flatMap((file) =>
        readFileSync(join(testDir, file), 'utf8')
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => sentPayload.test(line) && loose.test(line))
          .map(({ line, index }) => `${file}:${index + 1}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('builds no mutation payload inline in a pane', () => {
    // Every mutation goes through a builder, so the corpus above is the whole
    // set. A literal operation at a call site is a payload nothing checks.
    const inline = [
      /\.mutate\(\s*['"`]/, // service.mutate('op', …)
      /\boperation:\s*['"`]/, // { operation: 'op', extra: … }
      /\boperation:\s*\w+\s*\?\s*['"`]/, // { operation: cond ? 'a' : 'b' }
      /\bsend\(\s*['"`][a-z]+-[a-z-]+['"`]\s*,/, // a sheet's own send('op', {…})
    ];
    const offenders = uiSources().flatMap(({ path, text }) =>
      text
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => inline.some((pattern) => pattern.test(line)))
        .map(({ line, index }) => `${path}:${index + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
