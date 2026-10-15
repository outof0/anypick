/**
 * Reads the feature inventory out of both source trees.
 *
 * The parity test and `make check-parity` share this so the check and the
 * report can never disagree about what the inventory is. Extraction is the
 * part that quietly rots, so it lives in one place with its own guard.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const macosDir = resolve(__dirname, '../../../macos');
const uiDir = resolve(__dirname, '..');

/** Every source file that can name a Tauri element. */
function uiSources(dir: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(tsx|ts)$/.test(entry.name)) files.push(path);
    }
  };
  visit(dir);
  return files;
}

/**
 * Colour-utility prefixes that name a `--color-*` token in Tailwind v4.
 *
 * `bg-badge` compiles to `background-color: var(--color-badge)`; with no such
 * token Tailwind emits nothing, so the element silently loses its fill. That
 * shipped three times (`bg-badge`, `bg-active`, `bg-amber-500`) and jsdom
 * cannot see it, because it never loads the stylesheet. These two functions are
 * what make the missing token a failing test instead of a blank pixel.
 */
const COLOUR_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'divide',
  'outline',
  'fill',
  'stroke',
  'accent',
  'caret',
  'decoration',
  'placeholder',
  'from',
  'via',
  'to',
] as const;

/**
 * Names that carry a colour-shaped prefix but resolve without a `--color-*`.
 *
 * Two groups: Tailwind's built-in palette words, and the structural keywords
 * that share a prefix (`text-center`, `border-0`, `divide-y`). Each entry is a
 * deliberate exemption, so adding one is a decision rather than a way to quiet
 * the check.
 */
const NOT_A_TOKEN = new Set([
  // Built-in palette words. Tailwind resolves these itself.
  'transparent',
  'current',
  'inherit',
  'black',
  'white',
  // Text alignment, wrapping, and decoration keywords.
  'center',
  'left',
  'right',
  'justify',
  'start',
  'end',
  'ellipsis',
  'clip',
  'nowrap',
  'wrap',
  'balance',
  'pretty',
  'underline',
  'overline',
  'line-through',
  'none',
  // Border, ring, divide, and outline sides and styles.
  'solid',
  'dashed',
  'dotted',
  'double',
  'hidden',
  'x',
  'y',
  't',
  'r',
  'b',
  'l',
  's',
  'e',
]);

/**
 * Every colour-token name a colour utility in the TSX sources asks for.
 *
 * Only literal and template-literal class lists count, and only the `.tsx`
 * files: a colour class is emitted by JSX, and a bare `{className}` prop is
 * forwarded rather than naming anything. Variant prefixes (`hover:`, `dark:`,
 * `after:`) and the `/50` opacity suffix are stripped, because neither changes
 * which token the utility names.
 */
export function colourUtilities(): string[] {
  const used = new Set<string>();
  for (const path of uiSources(uiDir)) {
    if (!path.endsWith('.tsx')) continue;
    const source = readFileSync(path, 'utf8');
    for (const literal of source.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      for (const raw of literal[1].split(/\s+/)) {
        const token = raw.replace(/^(?:[a-z-]+:)+/, '');
        const match = /^([a-z]+)-(.+)$/.exec(token);
        if (!match) continue;
        if (!(COLOUR_PREFIXES as readonly string[]).includes(match[1])) continue;
        let name = match[2].replace(/\/\d+$/, '');
        // An arbitrary value (`bg-[#323234]`) names no token, and a numeric
        // suffix (`border-0`, `ring-2`) is a width, not a colour.
        if (name.includes('[') || /^[0-9]/.test(name)) continue;
        // `border-t-secondary` is the top border in the `secondary` colour;
        // `border-t` alone is only the side.
        if (match[1] === 'border') {
          const side = /^[xytrblse]-(.+)$/.exec(name);
          if (side) name = side[1];
        }
        if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
        if (NOT_A_TOKEN.has(name)) continue;
        used.add(name);
      }
    }
  }
  return [...used].sort();
}

/** Every `--color-*` name the `@theme` block in `styles.css` declares. */
export function colourTokens(): string[] {
  const source = readFileSync(join(uiDir, 'styles.css'), 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(match[1]);
  return [...names].sort();
}

/**
 * Every accessibility identifier the macOS app publishes.
 *
 * Three shapes reach `.accessibilityIdentifier`, and a scan that reads only the
 * first one under-reports the feature inventory:
 *
 *  1. a literal argument: `.accessibilityIdentifier("hub.rotate-api-key")`
 *  2. a component parameter: `DesignCopyButton(identifier: "hub.copy-address")`
 *     applies it itself (`SharedUI.swift:301`), so the literal is not next to
 *     the word `accessibilityIdentifier` at the call site
 *  3. a computed helper: `strategyIdentifier(for:)` returns a literal, so the id
 *     exists only as a return value
 *
 * Swift interpolates with `\(expr)`, which can itself contain parentheses
 * (`\(strategyIdentifier(for: rotation))`), so `normalizeInterpolation` counts
 * nesting rather than stopping at the first `)`.
 */
export function macosIdentifiers(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(macosDir)) {
    if (!file.endsWith('.swift')) continue;
    const source = readFileSync(join(macosDir, file), 'utf8');

    for (const match of source.matchAll(/accessibilityIdentifier\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
      ids.add(normalizeInterpolation(match[1]));
    }
    // Shape 2. A component parameter. Two spellings reach the tree: a plain
    // `identifier:`, which `DesignCopyButton` forwards itself
    // (`SharedUI.swift:301`), and `accessibilityIdentifier:`, which is a
    // labelled argument on `DesignCandidatePicker`. Reading only the first
    // missed `hub.conflict.<id>.picker` and five published-model rows; reading
    // only the second missed the copy buttons.
    for (const match of source.matchAll(/(?<![A-Za-z])identifier:\s*"([^"]+)"/g)) {
      ids.add(normalizeInterpolation(match[1]));
    }
    for (const match of source.matchAll(/accessibilityIdentifier:\s*"([^"]+)"/g)) {
      ids.add(normalizeInterpolation(match[1]));
    }
    // Shape 3. A computed id that reaches the tree through a variable:
    //   `let rowKey = cond ? "hub.rotation.\(id)" : "hub.account.\(id)"`
    //   `.accessibilityIdentifier(rowKey)`
    // Every literal in such a binding is a distinct id, and the variable's own
    // use site carries no literal to find. `ProxyHubView.swift:451,500` is the
    // case; without this the two hub source-row ids were absent entirely.
    for (const match of source.matchAll(
      /\blet\s+(\w*[Ii]d\w*|\w*[Kk]ey)\s*(?::\s*String\s*)?=\s*([^;\n]{0,200})/g,
    )) {
      const initializer = match[2];
      // `cond ? "a" : "b"` is one id per arm. A single literal is one id. A
      // call or a concatenation is a format, not an id, and its values belong
      // to the other shapes.
      const ternary = /^[^?"]*\?\s*"[^"]*"\s*:\s*"[^"]*"\s*$/.test(initializer.trim());
      const single = /^"[^"]*"$/.test(initializer.trim());
      if (!ternary && !single) continue;
      for (const literal of initializer.matchAll(/"([^"]+)"/g)) {
        // A local named `key` can hold a translation key rather than an
        // accessibility identifier. ProxyHubView uses this shape to choose
        // the singular/plural model-count catalog entry; treating those
        // values as controls makes parity fail on `desktop.hub.*`.
        if (literal[1].startsWith('desktop.')) continue;
        ids.add(normalizeInterpolation(literal[1]));
      }
    }

    // Shape 4. A helper function that returns a literal id.
    for (const match of source.matchAll(
      /func\s+\w*[Ii]dentifier\w*\s*\([^)]*\)\s*(?:->\s*String\s*)?\{([^}]{0,400})\}/g,
    )) {
      for (const literal of match[1].matchAll(/"([^"]+)"/g)) {
        ids.add(normalizeInterpolation(literal[1]));
      }
    }
  }
  return [...ids].sort();
}

/** `\(anything, parens included)` becomes `{x}`, so it compares to a template id. */
function normalizeInterpolation(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\' && raw[i + 1] === '(') {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '(') depth += 1;
        else if (raw[i] === ')') depth -= 1;
        i += 1;
      }
      i -= 1;
      out += '{x}';
      continue;
    }
    out += raw[i];
  }
  return out;
}

/**
 * Every `data-testid` and `testId` the UI emits.
 *
 * Both spellings are read because a pane passes `testId` down through a
 * primitive rather than always writing the attribute itself. Only literal and
 * template-literal values count: a bare `{testId}` is a prop being forwarded
 * and names nothing.
 */
export function tauriIdentifiers(): string[] {
  const ids = new Set<string>();
  for (const path of uiSources(uiDir)) {
    const source = readFileSync(path, 'utf8');
    const pattern = /(?:data-testid|testId)\s*=\s*(?:\{\s*)?(?:"([^"]+)"|`([^`]+)`)/g;
    for (const match of source.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? '';
      if (!value || value === 'testId') continue;
      ids.add(value);
    }
  }
  return [...ids].sort();
}

/** `${action.id}` normalizes to `{x}`, matching the Swift side. */
export function normalizeTauri(value: string): string {
  return value.replace(/\$\{[^}]*\}/g, '{x}');
}
