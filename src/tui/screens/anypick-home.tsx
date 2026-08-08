/**
 * Switch — default screen (DESIGN-TUI §5).
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  DataRow,
  EmptyState,
  GroupHeader,
  ScreenShell,
  type KeyHint,
  type Notice,
  type StatusKind,
} from '../components/chrome';
import {
  accountStatusKind,
  groupAnyPickHomeRows,
  identityDisplayText,
  providerGroupHeader,
  switchAmbient,
  switchOutcome,
  type OperationReceipt,
  type AnyPickHomeModel,
  type AnyPickHomeRow,
} from '../model';

export interface AnyPickHomeScreenProps {
  model: AnyPickHomeModel;
  selectedIndex: number;
  columns: number;
  filter?: string;
  filterDraft?: string;
  filterActive?: boolean;
  contextLines?: string[];
  receipt?: OperationReceipt | null;
  notice?: Notice | null;
  busy?: boolean;
  busyLabel?: string;
  onMove: (delta: number) => void;
  onSwitch: (row: AnyPickHomeRow) => void;
  onRefresh: (row: AnyPickHomeRow) => void;
  onSaveCurrent?: (row: AnyPickHomeRow) => void;
  onAdd?: (providerId?: string) => void;
  onProxy: (row?: AnyPickHomeRow) => void;
  onAccounts: () => void;
  onGateways?: () => void;
  onFilter: () => void;
  onFilterChange?: (value: string) => void;
  onFilterSubmit?: () => void;
  onFilterClear?: () => void;
  onHelp?: () => void;
  onTray?: () => void;
  onDetach?: () => void;
  onQuit: () => void;
  /** Usage summary for the active live account (e.g. "5h 62% left · resets in 2h"). */
  usageSummary?: string;
}

function statusKindFor(row: AnyPickHomeRow): StatusKind {
  return accountStatusKind(row);
}

export function AnyPickHomeScreen(props: AnyPickHomeScreenProps) {
  const {
    model,
    selectedIndex,
    columns,
    filter,
    filterDraft,
    filterActive,
    contextLines,
    receipt,
    notice,
    busy,
    busyLabel,
    onMove,
    onSwitch,
    onRefresh,
    onSaveCurrent,
    onAdd,
    onProxy,
    onFilter,
    onFilterChange,
    onFilterSubmit,
    onFilterClear,
    onHelp,
    onTray,
    onDetach,
    onQuit,
  } = props;

  const rows = model.rows;
  const selected = rows[selectedIndex];
  const grouped = groupAnyPickHomeRows(rows, model.providers);

  let outcome: string;
  let support: string;
  if (contextLines && contextLines.length > 0) {
    outcome = contextLines[0] ?? '';
    support = contextLines[1] ?? '';
  } else {
    const o = switchOutcome(selected);
    outcome = o.outcome;
    support = o.support;
  }
  // Surface live usage on the row that is actually serving right now, replacing
  // the low-value "No change." support with quota remaining.
  if (props.usageSummary && selected?.active && selected.isLiveMatch) {
    support = props.usageSummary;
  }

  const emptyMachine = rows.length === 0;
  const canSaveCurrent = Boolean(
    selected?.active &&
    selected.rowKind !== 'save-live' &&
    (selected.providerRelation === 'drift' || selected.statusText.includes('changed')),
  );

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (filterActive) {
      if (key.escape) {
        onFilterClear?.();
        return;
      }
      if (key.return) {
        onFilterSubmit?.();
        return;
      }
      if (key.backspace || key.delete) {
        onFilterChange?.((filterDraft ?? '').slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        onFilterChange?.((filterDraft ?? '') + input);
      }
      return;
    }
    // A committed filter still hides rows, so esc has to release it here too —
    // otherwise the only way out of a narrowed board is to reopen the prompt.
    if (key.escape && filter) {
      onFilterClear?.();
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit();
      return;
    }
    if (input === 'h' && onHelp) {
      onHelp();
      return;
    }
    if (input === 't' && onTray) {
      onTray();
      return;
    }
    if (input === 'D' && onDetach) {
      onDetach();
      return;
    }
    if (key.tab) {
      onProxy(selected);
      return;
    }
    if (input === 'a' && onAdd) {
      onAdd(selected?.providerId);
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
    if (key.return && selected) {
      onSwitch(selected);
      return;
    }
    if (input === 'r' && selected?.canRefresh) {
      onRefresh(selected);
      return;
    }
    if (input === 's' && selected && canSaveCurrent && onSaveCurrent) {
      onSaveCurrent(selected);
      return;
    }
    if (input === '/') {
      onFilter();
    }
  });

  const hints: KeyHint[] = emptyMachine
    ? [
        { key: 'a', label: 'add a login', when: Boolean(onAdd) },
        { key: 'tab', label: 'proxy' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit' },
      ]
    : [
        {
          key: 'enter',
          label:
            selected?.rowKind === 'save-live'
              ? 'save this login'
              : selected?.active && selected.isLiveMatch
                ? '—'
                : selected?.active &&
                    (selected.providerRelation === 'drift' ||
                      selected.statusText.includes('changed'))
                  ? 'resolve'
                  : 'switch',
          when:
            Boolean(selected) &&
            !(selected?.active && selected?.isLiveMatch && selected?.rowKind !== 'save-live'),
        },
        { key: 'r', label: 'refresh', when: Boolean(selected?.canRefresh) },
        { key: 's', label: 'save current', when: canSaveCurrent },
        { key: 'a', label: 'add', when: Boolean(onAdd) },
        { key: '/', label: 'filter' },
        { key: 'tab', label: 'proxy' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit' },
      ];

  hints.push(
    { key: 't', label: 'tray runtime', when: Boolean(onTray) },
    { key: 'D', label: 'detach to Tray', when: Boolean(onDetach) },
  );

  if (selected?.active && selected.isLiveMatch) {
    const i = hints.findIndex((h) => h.key === 'enter');
    if (i >= 0) {
      hints.splice(i, 1);
    }
  }

  if (filter) {
    hints.unshift({ key: 'esc', label: 'clear filter' });
  }

  const bodyNodes: React.ReactNode[] = [];

  if (filterActive || filter) {
    bodyNodes.push(
      <Text key="filter"> Filter {filterActive ? `${filterDraft ?? ''}█` : filter}</Text>,
    );
    bodyNodes.push(<Text key="filter-sp"> </Text>);
  }

  // The filter case has to be tested first: `rows` is already narrowed, so an
  // unmatched query is indistinguishable from an empty machine by count alone,
  // and telling someone to go save a login they already have is a dead end.
  if (rows.length === 0 && filter) {
    bodyNodes.push(
      <Text key="nomatch" dimColor>
        {' '}
        No saved logins match &quot;{filter}&quot;.
      </Text>,
    );
  } else if (emptyMachine) {
    bodyNodes.push(
      <EmptyState
        key="empty"
        text="No saved logins yet."
        hint="Press a to add a login, or save one already signed in on this computer."
      />,
    );
  } else {
    let lastProvider: string | null = null;
    for (const item of grouped) {
      if (item.kind === 'provider') {
        const hdr = providerGroupHeader(item.provider);
        if (lastProvider !== null) {
          bodyNodes.push(<Text key={`sp-${item.provider.providerId}`}> </Text>);
        }
        lastProvider = item.provider.providerId;
        bodyNodes.push(
          <GroupHeader
            key={`p-${item.provider.providerId}`}
            name={hdr.name}
            right={hdr.right}
            columns={columns}
          />,
        );
        continue;
      }
      if (item.kind === 'empty') {
        bodyNodes.push(
          <Text key={`e-${item.providerId}`} dimColor>
            {'    '}No saved logins — press a to add one.
          </Text>,
        );
        continue;
      }
      const { row, accountIndex } = item;
      bodyNodes.push(
        <DataRow
          key={row.ref}
          selected={accountIndex === selectedIndex}
          name={row.rowKind === 'save-live' ? 'Save current login' : row.label || row.name}
          identity={identityDisplayText(
            row.rowKind === 'save-live' ? (row.liveIdentity ?? row.identity) : row.identity,
            '',
          )}
          status={statusKindFor(row)}
          columns={columns}
          indent
        />,
      );
    }
  }

  return (
    <ScreenShell
      path="switch"
      ambient={switchAmbient(model)}
      columns={columns}
      receipt={receipt}
      notice={notice}
      busy={busy}
      busyLabel={busyLabel}
      outcome={
        filterActive
          ? rows.length === 0
            ? `No saved logins match "${filterDraft ?? ''}"`
            : `${rows.length} match${rows.length === 1 ? '' : 'es'}`
          : filter && rows.length === 0
            ? `No saved logins match "${filter}"`
            : outcome
      }
      support={
        filterActive
          ? rows.length === 0
            ? undefined
            : 'enter focus results   esc clear filter'
          : filter && rows.length === 0
            ? 'Press esc to clear the filter.'
            : support
      }
      hints={
        filterActive
          ? [
              { key: 'enter', label: 'focus results', when: rows.length > 0 },
              { key: 'esc', label: 'clear filter' },
            ]
          : hints
      }
    >
      <Box flexDirection="column">{bodyNodes}</Box>
    </ScreenShell>
  );
}
