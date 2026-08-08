import React from 'react';
import { filterHotplugHomeRows, type HotplugHomeModel } from '../model';
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
  view: (home: HotplugHomeModel) => { model: HotplugHomeModel; committed?: string };
  start: () => void;
  change: (value: string) => void;
  submit: () => void;
  clear: () => void;
}

export function useHomeFilter(shell: TuiShell): HomeFilter {
  const { screen, go, setSelectedIndex } = shell;
  const [draft, setDraft] = React.useState('');

  const committed = screen.kind === 'hotplug' ? screen.filter : undefined;
  const active = screen.kind === 'hotplug' && Boolean(screen.filterActive);

  return {
    draft,
    active,
    view: (home) => {
      const query = active ? draft : committed;
      return {
        model: query ? { ...home, rows: filterHotplugHomeRows(home.rows, query) } : home,
        committed,
      };
    },
    start: () => {
      setDraft(committed ?? '');
      go({ kind: 'hotplug', filterActive: true, filter: committed });
    },
    change: setDraft,
    submit: () => {
      go({ kind: 'hotplug', filter: draft || undefined });
      setSelectedIndex(0);
    },
    clear: () => {
      setDraft('');
      go({ kind: 'hotplug' });
    },
  };
}
