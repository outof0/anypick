/**
 * The line editor every TUI text field shares.
 *
 * Two classes of bug live here, and both were real: a cursor that counts UTF-16
 * units mangles Vietnamese typed as NFD, and a key filter that only accepts a
 * one-character `input` silently drops paste and IME composition. Neither shows
 * up as a type error, so they are pinned by test.
 */

import { describe, it, expect } from 'vitest';
import {
  applyLineEdit,
  displayValue,
  graphemeLength,
  isEditingKey,
  lineAtEnd,
  lineEditFor,
  renderLine,
  type LineState,
} from '../src/tui/model/line-editor';

/** Type `text` one Ink key event at a time, as a terminal would deliver it. */
function type(start: LineState, text: string): LineState {
  let state = start;
  for (const ch of text) {
    const edit = lineEditFor(ch, {});
    if (edit) {
      state = applyLineEdit(state, edit);
    }
  }
  return state;
}

const NFC = 'khắc'; // khắc, precomposed
const NFD = 'khắc'; // khắc, ă + combining acute

describe('grapheme cursor', () => {
  it('counts a decomposed Vietnamese letter as one step', () => {
    expect(NFD).toHaveLength(5);
    expect(graphemeLength(NFD)).toBe(4);
    expect(graphemeLength(NFC)).toBe(4);
  });

  it('backspace removes the whole letter, not half of it', () => {
    const after = applyLineEdit(lineAtEnd(NFD), { kind: 'delete-back' });
    expect(after.value).toBe('khắ');
    const twice = applyLineEdit(after, { kind: 'delete-back' });
    expect(twice.value).toBe('kh');
    expect(twice.cursor).toBe(2);
  });

  it('moves the caret one letter at a time across combining marks', () => {
    const line = lineAtEnd(NFD);
    const left = applyLineEdit(applyLineEdit(line, { kind: 'move', delta: -1 }), {
      kind: 'move',
      delta: -1,
    });
    expect(left.cursor).toBe(2);
    // Inserting at that caret lands between "kh" and the accented letter.
    expect(applyLineEdit(left, { kind: 'insert', text: 'X' }).value).toBe('khXắc');
  });

  it('clamps a caret past either end', () => {
    expect(applyLineEdit(lineAtEnd('ab'), { kind: 'move', delta: 9 }).cursor).toBe(2);
    expect(applyLineEdit({ value: 'ab', cursor: 0 }, { kind: 'move', delta: -9 }).cursor).toBe(0);
    expect(applyLineEdit({ value: '', cursor: 0 }, { kind: 'delete-back' }).value).toBe('');
  });
});

describe('typing', () => {
  it('accepts Vietnamese in either normalization form', () => {
    expect(type(lineAtEnd(''), NFC).value).toBe(NFC);
    expect(type(lineAtEnd(''), 'xin chào').value).toBe('xin chào');
  });

  it('inserts a pasted string whole rather than dropping it', () => {
    // Ink delivers a paste as one multi-character `input`; the old field
    // required `input.length === 1` and lost the lot.
    const edit = lineEditFor('claude-opus-5', {});
    expect(edit).toEqual({ kind: 'insert', text: 'claude-opus-5' });
  });

  it('treats digits and vim letters as text', () => {
    for (const ch of ['j', 'k', '1', '9', 'a', ' ', '.', '-']) {
      expect(lineEditFor(ch, {})).toEqual({ kind: 'insert', text: ch });
    }
    expect(type(lineAtEnd(''), 'gpt-5.6-luna').value).toBe('gpt-5.6-luna');
    expect(type(lineAtEnd(''), 'claude-haiku').value).toBe('claude-haiku');
  });

  it('inserts at the caret, not at the end', () => {
    const line = applyLineEdit(lineAtEnd('claude-5'), { kind: 'move', delta: -1 });
    expect(type(line, 'opus-').value).toBe('claude-opus-5');
  });

  it('strips control bytes but keeps the printable characters beside them', () => {
    expect(lineEditFor('\u001b[', {})).toEqual({ kind: 'insert', text: '[' });
    expect(lineEditFor('a\u0000b', {})).toEqual({ kind: 'insert', text: 'ab' });
  });
});

describe('readline keys', () => {
  it('maps the control set Ink reports as letter + ctrl', () => {
    expect(lineEditFor('a', { ctrl: true })).toEqual({ kind: 'move-to-start' });
    expect(lineEditFor('e', { ctrl: true })).toEqual({ kind: 'move-to-end' });
    expect(lineEditFor('w', { ctrl: true })).toEqual({ kind: 'delete-word-back' });
    expect(lineEditFor('u', { ctrl: true })).toEqual({ kind: 'delete-to-start' });
    expect(lineEditFor('k', { ctrl: true })).toEqual({ kind: 'delete-to-end' });
  });

  it('does not type the letter when ctrl is held', () => {
    // The printable branch must come last, or ctrl-a inserts an "a".
    expect(applyLineEdit(lineAtEnd('x'), lineEditFor('a', { ctrl: true })!).value).toBe('x');
  });

  it('leaves the screen keys alone', () => {
    for (const key of [{ escape: true }, { return: true }, { tab: true }, { upArrow: true }]) {
      expect(lineEditFor('', key)).toBeUndefined();
      expect(isEditingKey('', key)).toBe(false);
    }
    // ctrl-p / ctrl-n belong to the suggestion list, not to the text.
    expect(lineEditFor('p', { ctrl: true })).toBeUndefined();
    expect(lineEditFor('n', { ctrl: true })).toBeUndefined();
  });

  it('deletes a word back from the caret', () => {
    const line = lineAtEnd('anthropic/claude opus');
    expect(applyLineEdit(line, { kind: 'delete-word-back' }).value).toBe('anthropic/claude ');
  });

  it('kills to either end of the line', () => {
    const line = { value: 'claude-opus-5', cursor: 7 };
    expect(applyLineEdit(line, { kind: 'delete-to-start' }).value).toBe('opus-5');
    expect(applyLineEdit(line, { kind: 'delete-to-end' }).value).toBe('claude-');
  });

  it('reads a forward delete as forward, since Ink calls DEL a backspace', () => {
    expect(lineEditFor('', { backspace: true })).toEqual({ kind: 'delete-back' });
    expect(lineEditFor('', { delete: true })).toEqual({ kind: 'delete-forward' });
  });
});

describe('rendering', () => {
  it('puts the block cursor on the grapheme it occupies', () => {
    const line = applyLineEdit(lineAtEnd('abc'), { kind: 'move', delta: -1 });
    expect(renderLine(line)).toEqual({ before: 'ab', at: 'c', after: '' });
    expect(renderLine(lineAtEnd('abc'))).toEqual({ before: 'abc', at: ' ', after: '' });
  });

  it('masks one dot per visible letter, not per code unit', () => {
    expect(displayValue(NFD, true)).toBe('••••');
    expect(displayValue(NFD)).toBe(NFD);
    expect(renderLine({ value: NFD, cursor: 1 }, true).at).toBe('•');
  });
});
