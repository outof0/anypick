/**
 * One readline-shaped line editor for every text field in the TUI.
 *
 * Two rules the ad-hoc per-screen handlers kept getting wrong:
 *
 * 1. A cursor is a *grapheme* offset, not a UTF-16 offset. Vietnamese typed as
 *    NFD ("ắ" = ă + U+0301) is two code units, so slicing by index deletes half
 *    a letter and the rest of the line appears to shift.
 * 2. Ink hands a pasted or IME-composed string to `useInput` as one multi-char
 *    `input`. Anything gated on `input.length === 1` silently drops it.
 *
 * Editing keys follow GNU readline emacs mode, which is what fzf, enquirer and
 * @inquirer all implement; printable characters — digits, `j`, `k`, space —
 * are always literal text here. Screens that also drive a list must test
 * `isEditingKey` first and keep their vim-style navigation for non-edit mode.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Drop C0 controls and DEL, so an unnamed escape sequence never enters a value. */
function stripControl(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

/** Split into grapheme clusters, so one visible letter is one cursor step. */
export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), (s) => s.segment);
}

/** Visible length in cursor steps, which is not `value.length`. */
export function graphemeLength(value: string): number {
  return graphemes(value).length;
}

/** Slice by grapheme offset. Both bounds are clamped. */
export function graphemeSlice(value: string, start: number, end?: number): string {
  return graphemes(value).slice(start, end).join('');
}

export interface LineState {
  value: string;
  /** Grapheme offset in `value`, from 0 to its grapheme length. */
  cursor: number;
}

export function clampCursor(state: LineState): LineState {
  const max = graphemeLength(state.value);
  const cursor = Math.min(Math.max(0, state.cursor), max);
  return cursor === state.cursor ? state : { ...state, cursor };
}

/** A line with the cursor at the end — the usual starting point for a field. */
export function lineAtEnd(value: string): LineState {
  return { value, cursor: graphemeLength(value) };
}

/** Word boundaries follow readline: runs of non-space separated by space. */
function wordStart(cells: string[], from: number): number {
  let i = from;
  while (i > 0 && cells[i - 1]?.trim() === '') {
    i -= 1;
  }
  while (i > 0 && cells[i - 1]?.trim() !== '') {
    i -= 1;
  }
  return i;
}

function wordEnd(cells: string[], from: number): number {
  let i = from;
  while (i < cells.length && cells[i]?.trim() === '') {
    i += 1;
  }
  while (i < cells.length && cells[i]?.trim() !== '') {
    i += 1;
  }
  return i;
}

export type LineEdit =
  | { kind: 'insert'; text: string }
  | { kind: 'delete-back' }
  | { kind: 'delete-forward' }
  | { kind: 'delete-word-back' }
  | { kind: 'delete-to-start' }
  | { kind: 'delete-to-end' }
  | { kind: 'move'; delta: number }
  | { kind: 'move-word'; delta: number }
  | { kind: 'move-to-start' }
  | { kind: 'move-to-end' }
  | { kind: 'replace'; value: string };

export function applyLineEdit(state: LineState, edit: LineEdit): LineState {
  const cells = graphemes(state.value);
  const at = Math.min(Math.max(0, state.cursor), cells.length);
  const join = (next: string[], cursor: number): LineState =>
    clampCursor({ value: next.join(''), cursor });

  switch (edit.kind) {
    case 'insert': {
      if (!edit.text) {
        return state;
      }
      const added = graphemes(edit.text);
      return join([...cells.slice(0, at), ...added, ...cells.slice(at)], at + added.length);
    }
    case 'delete-back':
      return at === 0 ? state : join([...cells.slice(0, at - 1), ...cells.slice(at)], at - 1);
    case 'delete-forward':
      return at >= cells.length ? state : join([...cells.slice(0, at), ...cells.slice(at + 1)], at);
    case 'delete-word-back': {
      const start = wordStart(cells, at);
      return start === at ? state : join([...cells.slice(0, start), ...cells.slice(at)], start);
    }
    case 'delete-to-start':
      return at === 0 ? state : join(cells.slice(at), 0);
    case 'delete-to-end':
      return at >= cells.length ? state : join(cells.slice(0, at), at);
    case 'move':
      return clampCursor({ ...state, cursor: at + edit.delta });
    case 'move-word':
      return clampCursor({
        ...state,
        cursor: edit.delta < 0 ? wordStart(cells, at) : wordEnd(cells, at),
      });
    case 'move-to-start':
      return { ...state, cursor: 0 };
    case 'move-to-end':
      return { ...state, cursor: cells.length };
    case 'replace':
      return lineAtEnd(edit.value);
  }
}

/** The subset of Ink's `Key` this module reads. */
export interface EditorKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
}

/**
 * Map one Ink key event to an edit, or `undefined` when the screen owns the key.
 *
 * Ink reports ctrl-letters as the bare letter plus `key.ctrl`, so the control
 * combinations are matched before the printable branch — otherwise ctrl-a types
 * an "a". `key.return` is left alone: the terminal delivers ctrl-j as return, so
 * it can never be an editing key.
 */
export function lineEditFor(input: string, key: EditorKey): LineEdit | undefined {
  if (key.escape || key.return || key.tab || key.upArrow || key.downArrow) {
    return undefined;
  }
  if (key.backspace) {
    return { kind: 'delete-back' };
  }
  if (key.delete) {
    // Ink names the DEL byte (0x7f) `backspace`, so `delete` really is the
    // forward-delete escape sequence and must not erase backwards.
    return { kind: 'delete-forward' };
  }
  if (key.home) {
    return { kind: 'move-to-start' };
  }
  if (key.end) {
    return { kind: 'move-to-end' };
  }
  if (key.ctrl) {
    switch (input) {
      case 'a':
        return { kind: 'move-to-start' };
      case 'e':
        return { kind: 'move-to-end' };
      case 'b':
        return { kind: 'move', delta: -1 };
      case 'f':
        return { kind: 'move', delta: 1 };
      case 'w':
        return { kind: 'delete-word-back' };
      case 'u':
        return { kind: 'delete-to-start' };
      case 'k':
        return { kind: 'delete-to-end' };
      case 'd':
        return { kind: 'delete-forward' };
      case 'h':
        return { kind: 'delete-back' };
      default:
        return undefined;
    }
  }
  if (key.meta) {
    switch (input) {
      case 'b':
        return { kind: 'move-word', delta: -1 };
      case 'f':
        return { kind: 'move-word', delta: 1 };
      default:
        return undefined;
    }
  }
  if (key.leftArrow) {
    return { kind: 'move', delta: -1 };
  }
  if (key.rightArrow) {
    return { kind: 'move', delta: 1 };
  }
  // Printable text, including a whole pasted or IME-composed string. Control
  // characters other than the ones handled above are dropped rather than
  // inserted, so a stray escape sequence cannot corrupt the value.
  const text = stripControl(input);
  if (text) {
    return { kind: 'insert', text };
  }
  return undefined;
}

/** True when this key is text editing, so a list screen must not also act on it. */
export function isEditingKey(input: string, key: EditorKey): boolean {
  return lineEditFor(input, key) !== undefined;
}

/** What a field shows when it does not have the cursor. `•` per grapheme. */
export function displayValue(value: string, password = false): string {
  return password
    ? graphemes(value)
        .map(() => '•')
        .join('')
    : value;
}

export interface RenderedLine {
  before: string;
  at: string;
  after: string;
}

/**
 * Split a line for rendering a block cursor. `password` masks per grapheme so
 * the dot count matches what the user typed.
 */
export function renderLine(state: LineState, password = false): RenderedLine {
  const cells = graphemes(state.value);
  const shown = password ? cells.map(() => '•') : cells;
  const at = Math.min(Math.max(0, state.cursor), shown.length);
  return {
    before: shown.slice(0, at).join(''),
    at: shown[at] ?? ' ',
    after: shown.slice(at + 1).join(''),
  };
}
