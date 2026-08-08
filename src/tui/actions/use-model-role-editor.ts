import React from 'react';
import type { ClientModelRole } from '../../types';
import { applyLineEdit, lineAtEnd, type LineEdit, type LineState } from '../model/line-editor';

/** The handlers `ProxyModelsScreen` needs to drive inline row editing. */
export interface ModelRoleEditorHandlers {
  onStartEdit: (roleId: string) => void;
  onEditChange: (text: string) => void;
  onEditLine: (edit: LineEdit) => void;
  onMoveSuggestion: (delta: number) => void;
  onSetSuggestionIndex: (index: number) => void;
  onCommitEdit: (picked?: string) => void;
  onCancelEdit: () => void;
}

export interface ModelRoleEditorBinding {
  roles: readonly ClientModelRole[];
  values: Record<string, string>;
  /** Persist the edited map — normally by replacing the current screen. */
  onCommit: (values: Record<string, string>) => void;
  /** Move the row cursor, so committing one role lands on the next. */
  onSelectRow: (index: number) => void;
}

/**
 * Inline editing state for one model-role row.
 *
 * Shared because the proxy and gateway model screens are the same editor over
 * different suggestion sources; keeping one copy stops the two from drifting.
 */
export interface ModelRoleEditor {
  /** Role currently being typed into, or `null` when navigating the list. */
  editingRoleId: string | null;
  setEditingRoleId: React.Dispatch<React.SetStateAction<string | null>>;
  editDraft: string;
  /** Grapheme offset of the caret within `editDraft`. */
  editCursor: number;
  setEditDraft: (value: string) => void;
  suggestionIndex: number;
  setSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Leave edit mode and drop the draft. */
  reset: () => void;
  /** Handlers for one model screen, spread straight onto `ProxyModelsScreen`. */
  handlers: (binding: ModelRoleEditorBinding) => ModelRoleEditorHandlers;
}

export function useModelRoleEditor(): ModelRoleEditor {
  const [editingRoleId, setEditingRoleId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<LineState>(() => lineAtEnd(''));
  const [suggestionIndex, setSuggestionIndex] = React.useState(0);

  const reset = React.useCallback(() => {
    setEditingRoleId(null);
    setDraft(lineAtEnd(''));
    setSuggestionIndex(0);
  }, []);

  const setEditDraft = React.useCallback((value: string) => {
    setDraft(lineAtEnd(value));
    setSuggestionIndex(0);
  }, []);

  const handlers = React.useCallback(
    ({ roles, values, onCommit, onSelectRow }: ModelRoleEditorBinding) => ({
      onStartEdit: (roleId: string) => {
        setEditingRoleId(roleId);
        setDraft(lineAtEnd(values[roleId] ?? ''));
        setSuggestionIndex(0);
      },
      onEditChange: setEditDraft,
      onEditLine: (edit: LineEdit) => {
        setDraft((current) => {
          const next = applyLineEdit(current, edit);
          // Only a changed *filter* invalidates the highlight; moving the caret
          // leaves the match list alone, so the highlight must survive it.
          if (next.value !== current.value) {
            setSuggestionIndex(0);
          }
          return next;
        });
      },
      onMoveSuggestion: (delta: number) => {
        setSuggestionIndex((i) => Math.max(0, i + delta));
      },
      onSetSuggestionIndex: (index: number) => setSuggestionIndex(index),
      onCommitEdit: (picked?: string) => {
        if (!editingRoleId) {
          return;
        }
        const next = (picked ?? draft.value).trim() || values[editingRoleId] || '';
        const committedAt = roles.findIndex((r) => r.id === editingRoleId);
        onCommit({ ...values, [editingRoleId]: next });
        reset();
        // Auto-advance to the next role so editing all roles is a straight run
        // of enter/type/enter without a manual ↓ between each.
        if (committedAt >= 0 && committedAt < roles.length - 1) {
          onSelectRow(committedAt + 1);
        }
      },
      onCancelEdit: reset,
    }),
    [draft.value, editingRoleId, reset, setEditDraft],
  );

  return {
    editingRoleId,
    setEditingRoleId,
    editDraft: draft.value,
    editCursor: draft.cursor,
    setEditDraft,
    suggestionIndex,
    setSuggestionIndex,
    reset,
    handlers,
  };
}
