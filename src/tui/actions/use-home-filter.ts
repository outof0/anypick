import React from 'react';
import { filterAnyPickHomeRows, type AnyPickHomeModel } from '../model';
import type { TuiShell } from '../use-tui-shell';

/**
 * The Switch board's row filter.
 *
 * The committed query lives on the screen so that navigating away and back
 * keeps it, while the in-progress draft lives here — a keystroke must not push
 * a new screen. `view` resolves which of the two the board should render.
 */
export interface HomeFilter {
  draft: string;
  active: boolean;
  /** The model narrowed to matching rows, plus the query the footer should show. */
  view: (home: AnyPickHomeModel) => { model: AnyPickHomeModel; committed?: string };
  start: () => void;
  change: (value: string) => void;
  submit: () => void;
  clear: () => void;
}

export function useHomeFilter(shell: TuiShell): HomeFilter {
  const { screen, go, setSelectedIndex } = shell;
  const [draft, setDraft] = React.useState('');

  const committed = screen.kind === 'anypick' ? screen.filter : undefined;
  const active = screen.kind === 'anypick' && Boolean(screen.filterActive);

  return {
    draft,
    active,
    view: (home) => {
      const query = active ? draft : committed;
      return {
        model: query ? { ...home, rows: filterAnyPickHomeRows(home.rows, query) } : home,
        committed,
      };
    },
    start: () => {
      setDraft(committed ?? '');
      go({ kind: 'anypick', filterActive: true, filter: committed });
    },
    change: setDraft,
    submit: () => {
      go({ kind: 'anypick', filter: draft || undefined });
      setSelectedIndex(0);
    },
    clear: () => {
      setDraft('');
      go({ kind: 'anypick' });
    },
  };
}
