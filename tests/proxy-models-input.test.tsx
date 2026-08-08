/**
 * The model role editor, driven through the real component and the real hook.
 *
 * The bug this pins was invisible to types and to unit tests: while a role was
 * being edited the screen still ran the list's keymap, so `j`, `k` and `1`-`9`
 * never reached the field. Typing `gpt-5.6-luna` committed at the `5`, and
 * `claude-haiku` lost its letters. Since a model id is mostly letters and
 * digits, that made hand-typing an override impossible — which is exactly the
 * escape hatch a user needs when the suggestion list lacks the id they want.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ProxyModelsScreen } from '../src/tui/screens/proxy-models';
import { useModelRoleEditor } from '../src/tui/actions/use-model-role-editor';
import { CLAUDE_MODEL_ROLES } from '../src/clients/model-roles';

const SUGGESTIONS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
];

const ENTER = '\r';
const TAB = '\t';
const ESC = '';
const DOWN = '[B';
const LEFT = '[D';
const CTRL_N = '';
const CTRL_P = '';
const CTRL_A = '';
const CTRL_W = '';

interface Seen {
  draft: string;
  committed?: Record<string, string>;
  cancelled: boolean;
}

/**
 * Mount the screen already editing the `default` role, wired to the production
 * hook so draft state, caret and highlight behave exactly as they do in the app.
 */
function mountEditing(initial: string, seen: Seen) {
  function Harness() {
    const editor = useModelRoleEditor();
    const values = React.useMemo(() => ({ default: initial }), []);

    // Enter edit mode once, the way pressing enter on the row does.
    React.useEffect(() => {
      editor.setEditingRoleId('default');
      editor.setEditDraft(initial);
    }, []);

    seen.draft = editor.editDraft;

    return (
      <ProxyModelsScreen
        proxyRef="openrouter/work"
        clientName="Claude Code"
        roles={CLAUDE_MODEL_ROLES}
        values={values}
        suggestions={SUGGESTIONS}
        selectedIndex={0}
        editingRoleId={editor.editingRoleId}
        editDraft={editor.editDraft}
        editCursor={editor.editCursor}
        suggestionIndex={editor.suggestionIndex}
        onMove={() => {}}
        {...editor.handlers({
          roles: CLAUDE_MODEL_ROLES,
          values,
          onCommit: (next) => {
            seen.committed = next;
          },
          onSelectRow: () => {},
        })}
        onCancelEdit={() => {
          seen.cancelled = true;
          editor.reset();
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
  }

  const r = render(<Harness />);
  return {
    frame: () => r.lastFrame() ?? '',
    /** Send one Ink key event per character, as a terminal does. */
    type: async (text: string) => {
      for (const ch of text) {
        r.stdin.write(ch);
        await settle();
      }
    },
    press: (seq: string) => r.stdin.write(seq),
    unmount: () => r.unmount(),
  };
}

/** React state lands a tick after the write, so every step awaits a frame. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

async function editing(initial = '') {
  const seen: Seen = { draft: '', cancelled: false };
  const ui = mountEditing(initial, seen);
  await settle();
  return { ui, seen };
}

describe('typing a model id by hand', { timeout: 30000 }, () => {
  it('types digits instead of committing a numbered suggestion', async () => {
    const { ui, seen } = await editing();
    await ui.type('gpt-5.6-luna');
    expect(seen.draft).toBe('gpt-5.6-luna');
    expect(seen.committed).toBeUndefined();
    ui.unmount();
  });

  it('types j and k rather than moving the suggestion highlight', async () => {
    const { ui, seen } = await editing();
    await ui.type('claude-haiku');
    expect(seen.draft).toBe('claude-haiku');
    ui.unmount();
  });

  it('commits the typed text when nothing matches it', async () => {
    const { ui, seen } = await editing();
    await ui.type('my-own-model-9000');
    ui.press(ENTER);
    await settle();
    expect(seen.committed).toEqual({ default: 'my-own-model-9000' });
    ui.unmount();
  });

  it('commits hand-typed custom model ID even when partial suggestions match', async () => {
    const { ui, seen } = await editing();
    await ui.type('ocg/claude-opus-5');
    ui.press(ENTER);
    await settle();
    expect(seen.committed).toEqual({ default: 'ocg/claude-opus-5' });
    ui.unmount();
  });

  it('edits mid-string with the caret instead of only at the end', async () => {
    const { ui, seen } = await editing('claude-opus-5');
    ui.press(LEFT);
    await settle();
    ui.press(LEFT);
    await settle();
    await ui.type('X');
    expect(seen.draft).toBe('claude-opusX-5');
    ui.unmount();
  });

  it('supports the readline keys a small field is expected to have', async () => {
    const { ui, seen } = await editing('anthropic/claude opus');
    ui.press(CTRL_W);
    await settle();
    expect(seen.draft).toBe('anthropic/claude ');
    ui.press(CTRL_A);
    await settle();
    await ui.type('x');
    expect(seen.draft).toBe('xanthropic/claude ');
    ui.unmount();
  });

  it('accepts a pasted id as one event', async () => {
    const { ui, seen } = await editing();
    ui.press('anthropic/claude-opus-5');
    await settle();
    expect(seen.draft).toBe('anthropic/claude-opus-5');
    ui.unmount();
  });
});

describe('suggestion navigation while editing', { timeout: 30000 }, () => {
  it('moves the highlight with the arrows and commits the highlighted id', async () => {
    const { ui, seen } = await editing();
    await ui.type('claude');
    ui.press(DOWN);
    await settle();
    ui.press(ENTER);
    await settle();
    expect(seen.committed).toEqual({ default: 'claude-opus-5' });
    ui.unmount();
  });

  it('accepts ctrl-n / ctrl-p as the emacs aliases for the arrows', async () => {
    const { ui, seen } = await editing();
    await ui.type('claude');
    ui.press(CTRL_N);
    await settle();
    ui.press(CTRL_N);
    await settle();
    ui.press(CTRL_P);
    await settle();
    ui.press(ENTER);
    await settle();
    expect(seen.committed).toEqual({ default: 'claude-opus-5' });
    ui.unmount();
  });

  it('keeps the highlight when the caret moves but the filter does not', async () => {
    const { ui, seen } = await editing();
    await ui.type('claude');
    ui.press(DOWN);
    await settle();
    ui.press(LEFT);
    await settle();
    ui.press(ENTER);
    await settle();
    expect(seen.committed).toEqual({ default: 'claude-opus-5' });
    ui.unmount();
  });

  it('resets the highlight when a keystroke changes the filter', async () => {
    const { ui, seen } = await editing();
    await ui.type('claude');
    ui.press(DOWN);
    await settle();
    await ui.type('-');
    ui.press(ENTER);
    await settle();
    // The highlight is back at the top of the refiltered list, not still on
    // the second row of the list the user was looking at before the keystroke.
    expect(seen.committed).toEqual({ default: 'claude-sonnet-5' });
    ui.unmount();
  });

  it('esc still cancels', async () => {
    const { ui, seen } = await editing();
    await ui.type('gpt');
    ui.press(ESC);
    // A lone ESC is held back until Ink can rule out an escape sequence.
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.cancelled).toBe(true);
    expect(seen.committed).toBeUndefined();
    ui.unmount();
  });

  it('does not advertise a number key it no longer honours', async () => {
    const { ui } = await editing();
    await ui.type('claude');
    expect(ui.frame()).not.toMatch(/1-9/);
    ui.unmount();
  });

  it('fills the highlighted id on tab without committing it', async () => {
    const { ui, seen } = await editing();
    await ui.type('haiku');
    ui.press(TAB);
    await settle();
    expect(seen.draft).toBe('claude-haiku-4-5');
    expect(seen.committed).toBeUndefined();
    ui.unmount();
  });
});
