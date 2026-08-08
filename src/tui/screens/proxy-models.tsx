/**
 * Model role editor with visible autocomplete picker.
 *
 * While editing a role the field owns the keyboard, because a model id contains
 * letters and digits: `j`, `k` and `1`-`9` are text, not commands. Navigation
 * follows the convention every autocomplete prompt uses — arrows, plus ctrl-n /
 * ctrl-p — and editing follows readline (ctrl-a/e, ctrl-w, ctrl-u, ctrl-k).
 *
 *   ↑↓ / ctrl-p ctrl-n  move in suggestion list
 *   enter               pick highlighted (or the typed text if none)
 *   tab                 fill highlighted / complete common prefix
 *   esc                 cancel
 *
 * When not editing a role, this is a list: j/k move and `a` applies.
 */

import { Box, Text, useInput } from 'ink';
import { G, ScreenShell, type KeyHint } from '../components/chrome';
import type { ClientModelRole } from '../../types';
import type { ModelSuggestionsSource } from '../model/screen';
import { lineEditFor, renderLine, type LineEdit } from '../model/line-editor';
import { commonPrefix, filterModelSuggestions } from './proxy-models-utils';

export { filterModelSuggestions } from './proxy-models-utils';

export interface ProxyModelsScreenProps {
  /** e.g. grok/jonben or openrouter-work */
  proxyRef: string;
  /** User-facing title (app name or "Gateway") */
  clientName: string;
  roles: readonly ClientModelRole[];
  /** role id → model id */
  values: Record<string, string>;
  suggestions: string[];
  selectedIndex: number;
  /** When set, keyboard goes to the text field for this role. */
  editingRoleId?: string | null;
  editDraft?: string;
  /** Caret position within `editDraft`, as a grapheme offset. */
  editCursor?: number;
  /** Highlighted row in the suggestion list while editing. */
  suggestionIndex?: number;
  columns?: number;
  busy?: boolean;
  /** Breadcrumb path (default proxy/apps/models). */
  path?: string | string[];
  /** Confirm hint when not editing. */
  confirmLabel?: string;
  /** Support line when not editing. */
  supportHint?: string;
  /** Where suggestions came from (shown under the list). */
  suggestionsSource?: ModelSuggestionsSource;
  onMove: (delta: number) => void;
  onStartEdit: (roleId: string) => void;
  onEditChange: (text: string) => void;
  /** Apply one readline edit to the draft, keeping the caret. */
  onEditLine?: (edit: LineEdit) => void;
  /** Move highlight in filtered suggestions. */
  onMoveSuggestion?: (delta: number) => void;
  /** Set suggestion highlight index. */
  onSetSuggestionIndex?: (index: number) => void;
  onCommitEdit: (value?: string) => void;
  onCancelEdit: () => void;
  /** Re-ask the provider for its model list. Absent when not discoverable. */
  onReload?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * What the footer says about where the list came from.
 *
 * Worth showing because the two ends of the range mean opposite things to the
 * user: a live list is authoritative and complete, while `catalog` is whatever
 * shipped with this Hotplug build and may predate the model they are looking for.
 */
const SOURCE_NOTES: Record<ModelSuggestionsSource, string> = {
  live: 'live list from this provider',
  cache: 'cached provider list',
  stale: 'provider unreachable — last known list',
  proxy: 'list from this proxy /v1/models',
  fallback: 'proxy list unavailable — limited fallback',
  empty: 'no model list — type ids freely',
  catalog: 'built-in catalog — may be behind the provider',
};

export function ProxyModelsScreen(props: ProxyModelsScreenProps) {
  const {
    proxyRef,
    clientName,
    roles,
    values,
    suggestions,
    selectedIndex,
    editingRoleId,
    editDraft = '',
    editCursor,
    suggestionIndex = 0,
    columns = 80,
    busy,
    onMove,
    onStartEdit,
    onEditChange,
    onEditLine,
    onMoveSuggestion,
    onSetSuggestionIndex,
    onCommitEdit,
    onCancelEdit,
    onReload,
    onConfirm,
    onCancel,
    path = ['proxy', 'apps', 'models'],
    confirmLabel = 'apply models',
    supportHint = 'enter edit · a apply to the app',
    suggestionsSource,
  } = props;

  const editing = Boolean(editingRoleId);
  const matches = editing ? filterModelSuggestions(suggestions, editDraft) : [];
  const hi = matches.length ? Math.min(Math.max(0, suggestionIndex), matches.length - 1) : 0;

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (editing) {
      if (key.escape) {
        onCancelEdit();
        return;
      }
      // ctrl-n / ctrl-p are the emacs aliases for the arrows; ctrl-j is what the
      // terminal sends for return, so it is deliberately not a movement key.
      if (key.upArrow || (key.ctrl && input === 'p')) {
        if (matches.length) {
          onMoveSuggestion?.(-1);
        }
        return;
      }
      if (key.downArrow || (key.ctrl && input === 'n')) {
        if (matches.length) {
          onMoveSuggestion?.(1);
        }
        return;
      }
      if (key.return) {
        if (matches[hi]) {
          onCommitEdit(matches[hi]);
        } else {
          onCommitEdit(editDraft.trim() || undefined);
        }
        return;
      }
      if (key.tab) {
        if (matches[hi]) {
          // First tab: fill highlighted; if already equal, commit
          if (editDraft === matches[hi]) {
            onCommitEdit(matches[hi]);
          } else {
            onEditChange(matches[hi]);
            onSetSuggestionIndex?.(hi);
          }
          return;
        }
        const prefix = commonPrefix(matches);
        if (prefix && prefix.length > editDraft.length) {
          onEditChange(prefix);
        }
        return;
      }
      const edit = lineEditFor(input, key);
      if (edit) {
        onEditLine?.(edit);
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }
    // `a` is the discoverable apply action. Keep Tab as a compatibility
    // alias because older builds advertised it and users may still use it.
    if (input === 'a' || key.tab) {
      onConfirm();
      return;
    }
    if (input === 'r' && onReload) {
      onReload();
      return;
    }
    if (key.upArrow || input === 'k') {
      onMove(-1);
      return;
    }
    if (key.downArrow || input === 'j') {
      onMove(1);
      return;
    }
    if (key.return) {
      const role = roles[selectedIndex];
      if (role) {
        onStartEdit(role.id);
      }
    }
  });

  const hints: KeyHint[] = editing
    ? [
        { key: '↑↓', label: 'suggest' },
        { key: 'enter', label: 'pick' },
        { key: 'tab', label: 'fill' },
        { key: 'esc', label: 'cancel' },
      ]
    : [
        { key: 'enter', label: 'edit role' },
        { key: 'a', label: confirmLabel },
        { key: 'r', label: 'reload models', when: Boolean(onReload) },
        { key: 'esc', label: 'back' },
      ];

  const roleLabel = roles.find((r) => r.id === editingRoleId)?.label ?? 'model';
  const outcome = editing
    ? `Edit ${roleLabel} — pick a suggestion or type an id`
    : `Models for ${clientName} · ${proxyRef}`;
  const sourceNote = suggestionsSource ? SOURCE_NOTES[suggestionsSource] : '';
  const support = editing
    ? matches.length
      ? `${matches.length} match${matches.length === 1 ? '' : 'es'}  ·  enter pick  ·  free text ok`
      : 'No matches — free text is ok'
    : `${supportHint}${sourceNote ? `  ·  ${sourceNote}` : ''}`;

  const nameW = Math.min(28, Math.max(16, Math.floor((columns - 8) * 0.55)));

  return (
    <ScreenShell
      path={path}
      columns={columns}
      busy={busy}
      outcome={outcome}
      support={support}
      hints={hints}
    >
      <Box flexDirection="column">
        <Text bold> Models for {clientName}</Text>
        <Text dimColor> {proxyRef}</Text>
        <Text> </Text>
        {roles.map((role, i) => {
          const selected = !editing && i === selectedIndex;
          const isEditing = editingRoleId === role.id;
          const mark = selected || isEditing ? G.focus : ' ';
          const prefix = ` ${mark} ${role.label.padEnd(10)} `;
          if (!isEditing) {
            return (
              <Text key={role.id} bold={selected}>
                {prefix}
                {values[role.id] ?? '—'}
              </Text>
            );
          }
          const caret = renderLine({ value: editDraft, cursor: editCursor ?? editDraft.length });
          return (
            <Text key={role.id} bold>
              {prefix}
              {caret.before}
              <Text inverse>{caret.at}</Text>
              {caret.after}
            </Text>
          );
        })}

        {editing ? (
          <Box flexDirection="column">
            <Text> </Text>
            <Text dimColor>
              {' '}
              Suggestions
              {sourceNote ? `  (${sourceNote})` : ''}
            </Text>
            {matches.length === 0 ? (
              <Text dimColor> (type a model id · free text ok)</Text>
            ) : (
              matches.map((m, i) => {
                const mark = i === hi ? G.focus : ' ';
                const line = `${mark}  ${m}`;
                return (
                  <Text key={m} bold={i === hi} inverse={i === hi}>
                    {` ${line.slice(0, nameW + 8)}`}
                  </Text>
                );
              })
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text> </Text>
            <Text dimColor> enter edit role · a → {confirmLabel}</Text>
            {suggestions.length > 0 ? (
              <Text dimColor>
                {' '}
                {suggestions.length} model
                {suggestions.length === 1 ? '' : 's'} available
                {sourceNote ? ` (${sourceNote})` : ''}
              </Text>
            ) : (
              <Text dimColor> No list from proxy — type model ids, then a to apply</Text>
            )}
          </Box>
        )}
      </Box>
    </ScreenShell>
  );
}
