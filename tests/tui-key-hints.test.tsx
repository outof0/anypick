/**
 * The footer is the only place a key is discoverable, so a key that is handled
 * but never listed is effectively hidden, and a key that is listed but never
 * handled looks broken. These tests guard both directions.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { KeyHints, type KeyHint } from '../src/tui/components/chrome/header';

const SCREEN_DIR = join(import.meta.dirname, '../src/tui/screens');

/**
 * Aliases every screen accepts and no screen lists: j/k mirror the arrows and
 * ctrl-c mirrors q. The help screen documents them once, globally.
 */
const ALIASES = new Set(['j', 'k', 'c']);

/** Named hints whose handler is an Ink `key.*` flag rather than `input`. */
const NAMED: Record<string, RegExp> = {
  enter: /key\.return/,
  esc: /key\.escape/,
  tab: /key\.tab/,
  space: /input === ' '/,
};

/** Keys the screen advertises, e.g. `{ key: 'x', ... }`. */
function hintedKeys(source: string): string[] {
  return [...source.matchAll(/\{ key: '([^']+)',/g)].map((m) => m[1]);
}

/** Single-character keys the screen reacts to, e.g. `input === 'x'`. */
function handledCharKeys(source: string): string[] {
  return (
    [...source.matchAll(/(key\.ctrl && )?input === '([^' ])'/g)]
      // A ctrl combination is not the bare letter: ctrl-p is an alias for ↑, and
      // the letter itself still reaches the text field. Only bare letters are
      // keys a user has to discover from the footer.
      .filter((m) => !m[1])
      .map((m) => m[2])
  );
}

/**
 * Chrome components that own their own `useInput`, and the keys they consume.
 *
 * A screen that renders one of these has genuinely wired the key up, just not in
 * its own source, so matching only on the screen file would report a false
 * orphan and push the handler back into the screen where it would be duplicated.
 */
const DELEGATES: Record<string, string[]> = {
  TextInputField: ['enter', 'esc'],
};

function isHandled(source: string, key: string): boolean {
  for (const [component, keys] of Object.entries(DELEGATES)) {
    if (keys.includes(key) && source.includes(`<${component}`)) {
      return true;
    }
  }
  if (NAMED[key]) {
    return NAMED[key].test(source);
  }
  if (key.length === 1) {
    return source.includes(`input === '${key}'`);
  }
  // Descriptive labels such as `↑↓` or `1-9` have no single handler to match.
  return true;
}

const screens = readdirSync(SCREEN_DIR).filter((f) => f.endsWith('.tsx'));

describe('screen key hints', () => {
  it.each(screens)('%s advertises no key it does not handle', (file) => {
    const source = readFileSync(join(SCREEN_DIR, file), 'utf8');
    const orphans = hintedKeys(source).filter((k) => !isHandled(source, k));
    expect(orphans).toEqual([]);
  });

  it.each(screens)('%s hides no key it handles', (file) => {
    const source = readFileSync(join(SCREEN_DIR, file), 'utf8');
    const hinted = new Set(hintedKeys(source));
    const undocumented = handledCharKeys(source).filter((k) => !hinted.has(k) && !ALIASES.has(k));
    expect([...new Set(undocumented)]).toEqual([]);
  });
});

const crowded: KeyHint[] = [
  { key: 'enter', label: 'open in Switch' },
  { key: 'v', label: 'view' },
  { key: 'r', label: 'refresh' },
  { key: 's', label: 'save current' },
  { key: 'd', label: 'delete' },
  { key: 'a', label: 'add' },
  { key: 'i', label: 'import' },
  { key: 'e', label: 'export' },
  { key: 'tab', label: 'gateways' },
  { key: 'esc', label: 'switch' },
  { key: 'h', label: 'help' },
  { key: 'q', label: 'quit' },
];

describe('KeyHints', () => {
  it('shows every hint when the width allows', () => {
    const frame = render(<KeyHints hints={crowded} columns={400} />).lastFrame() ?? '';
    for (const h of crowded) {
      expect(frame).toContain(h.label);
    }
  });

  it('keeps help reachable when hints must be dropped', () => {
    const frame = render(<KeyHints hints={crowded} columns={40} />).lastFrame() ?? '';
    expect(frame).toContain('help');
    expect(frame).not.toContain('export');
  });

  it('drops nothing that fits and respects an explicit max', () => {
    const frame = render(<KeyHints hints={crowded} columns={400} max={2} />).lastFrame() ?? '';
    expect(frame).toContain('view');
    expect(frame).not.toContain('refresh');
  });
});

/**
 * Single-letter keys are the first letter of the action they perform, so the
 * footer doubles as the mnemonic. Anything that cannot follow the rule is
 * listed here with the reason, which keeps the exceptions few and deliberate.
 */
const MNEMONIC_EXCEPTIONS: Record<string, string> = {
  // Movement and section keys are positional, not mnemonic.
  j: 'move',
  k: 'move',
};

describe('key mnemonics', () => {
  it.each(screens)('%s binds each letter to the first letter of its label', (file) => {
    const source = readFileSync(join(SCREEN_DIR, file), 'utf8');
    const offenders = [...source.matchAll(/\{ key: '([a-z])', label: '([^']+)'/g)]
      .filter(([, key, label]) => {
        if (MNEMONIC_EXCEPTIONS[key] === label) {
          return false;
        }
        // A label may name the object rather than the verb ("pool mode",
        // "multi pool"): any word may carry the mnemonic.
        return !label.split(/[\s/-]+/).some((word) => word.startsWith(key));
      })
      .map(([, key, label]) => `${key} → ${label}`);
    expect(offenders).toEqual([]);
  });
});
