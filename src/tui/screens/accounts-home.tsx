/**
 * Accounts — saved login inventory (DESIGN-TUI §7).
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  DataRow,
  EmptyState,
  ScreenShell,
  type KeyHint,
  type Notice,
  type StatusKind,
} from '../components/chrome';
import {
  accountStatusKind,
  groupAnyPickHomeRows,
  identityDisplayText,
  type OperationReceipt,
  type AnyPickHomeModel,
  type AnyPickHomeRow,
} from '../model';
import type { ProviderFilterOption } from '../model/provider-filter';

export interface AccountsHomeScreenProps {
  model: AnyPickHomeModel;
  selectedIndex: number;
  columns?: number;
  receipt?: OperationReceipt | null;
  notice?: Notice | null;
  busy?: boolean;
  busyLabel?: string;
  onMove: (delta: number) => void;
  onAdd: (providerId?: string) => void;
  onRefresh: (row: AnyPickHomeRow) => void;
  onDelete: (row: AnyPickHomeRow) => void;
  onExport: (row: AnyPickHomeRow) => void;
  onImport: () => void;
  onOpenSwitch: (row: AnyPickHomeRow) => void;
  /** Open the read-only detail + usage view for this account. */
  onViewDetail?: (row: AnyPickHomeRow) => void;
  /** Save live login that is not stored yet (same as Switch save-live). */
  onSaveLive?: (row: AnyPickHomeRow) => void;
  /** Replace a changed active snapshot with the login currently on this computer. */
  onSaveCurrent?: (row: AnyPickHomeRow) => void;
  onBack: () => void;
  onNextSection?: () => void;
  providerFilterId?: string;
  providerFilterLabel?: string;
  providerFilterOptions?: ProviderFilterOption[];
  onCycleProvider?: () => void;
  onClearProvider?: () => void;
  onHelp?: () => void;
  onTray?: () => void;
  onDetach?: () => void;
  onQuit: () => void;
}

function statusKindFor(row: AnyPickHomeRow): StatusKind {
  return accountStatusKind(row);
}

export function AccountsHomeScreen(props: AccountsHomeScreenProps) {
  const {
    model,
    selectedIndex,
    columns = 80,
    receipt,
    notice,
    busy,
    busyLabel,
    onMove,
    onAdd,
    onRefresh,
    onDelete,
    onExport,
    onImport,
    onOpenSwitch,
    onViewDetail,
    onSaveLive,
    onSaveCurrent,
    onBack,
    onNextSection,
    providerFilterId,
    providerFilterLabel = 'All providers',
    providerFilterOptions = [],
    onCycleProvider,
    onClearProvider,
    onHelp,
    onTray,
    onDetach,
    onQuit,
  } = props;

  const rows = model.rows;
  const selected = rows[selectedIndex];
  const grouped = groupAnyPickHomeRows(rows, model.providers);
  const isSaveLive = selected?.rowKind === 'save-live';
  const canSaveCurrent = Boolean(
    selected?.active &&
    selected.rowKind !== 'save-live' &&
    (selected.providerRelation === 'drift' || selected.statusText.includes('changed')),
  );

  useInput((input, key) => {
    if (busy) {
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
    if (key.escape && providerFilterId) {
      onClearProvider?.();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (key.tab && onNextSection) {
      onNextSection();
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
    if (input === 'a') {
      onAdd(selected?.providerId ?? providerFilterId);
      return;
    }
    if (input === 'f' && providerFilterOptions.length > 0) {
      onCycleProvider?.();
      return;
    }
    if (input === 'i') {
      onImport();
      return;
    }
    if (!selected) {
      return;
    }
    if (key.return) {
      if (selected.rowKind === 'save-live') {
        (onSaveLive ?? onOpenSwitch)(selected);
      } else if (selected.active && selected.isLiveMatch && onViewDetail) {
        onViewDetail(selected);
      } else {
        onOpenSwitch(selected);
      }
      return;
    }
    if (input === 's') {
      if (selected.rowKind === 'save-live') {
        (onSaveLive ?? onOpenSwitch)(selected);
        return;
      }
      if (canSaveCurrent && onSaveCurrent) {
        onSaveCurrent(selected);
        return;
      }
    }
    if (input === 'r' && selected.canRefresh && selected.rowKind !== 'save-live') {
      onRefresh(selected);
      return;
    }
    if (input === 'd' && selected.rowKind !== 'save-live') {
      onDelete(selected);
      return;
    }
    if (input === 'e' && selected.rowKind !== 'save-live') {
      onExport(selected);
      return;
    }
    if (input === 'v' && selected.rowKind !== 'save-live' && onViewDetail) {
      onViewDetail(selected);
    }
  });

  const savedCount = rows.filter((r) => r.rowKind !== 'save-live').length;
  const ambient = savedCount > 0 ? `${savedCount} saved` : undefined;
  let outcome = providerFilterId
    ? `No saved accounts for ${providerFilterLabel}`
    : 'No saved accounts yet';
  let support = providerFilterId
    ? 'Press f for the next provider, or esc to show all providers.'
    : 'Press a to add an account, or i to import one.';
  if (selected) {
    if (selected.rowKind === 'save-live') {
      outcome = `Save ${identityDisplayText(
        selected.identity ?? selected.liveIdentity,
        'current login',
      )} as a ${selected.providerName} login`;
      support = 'Stores a snapshot so you can switch back later.';
    } else {
      outcome = `${selected.ref} was updated ${selected.updatedRelative}`;
      support = identityDisplayText(selected.identity, '');
    }
  }

  const hints: KeyHint[] =
    rows.length === 0
      ? [
          { key: 'a', label: 'add a login' },
          { key: 'i', label: 'import' },
          { key: 'f', label: 'filter provider', when: providerFilterOptions.length > 0 },
          { key: 'tab', label: 'gateways', when: Boolean(onNextSection) },
          { key: 'esc', label: providerFilterId ? 'all providers' : 'apps' },
          { key: 'h', label: 'help', when: Boolean(onHelp) },
          { key: 'q', label: 'quit' },
        ]
      : isSaveLive
        ? [
            { key: 'enter', label: 'save this login' },
            { key: 's', label: 'save' },
            { key: 'a', label: 'add' },
            { key: 'i', label: 'import' },
            { key: 'f', label: 'filter provider', when: providerFilterOptions.length > 0 },
            { key: 'tab', label: 'gateways', when: Boolean(onNextSection) },
            { key: 'esc', label: providerFilterId ? 'all providers' : 'apps' },
            { key: 'h', label: 'help', when: Boolean(onHelp) },
            { key: 'q', label: 'quit' },
          ]
        : [
            {
              key: 'enter',
              label:
                selected?.active && selected.isLiveMatch && onViewDetail
                  ? 'view details'
                  : 'switch account',
            },
            { key: 'v', label: 'view', when: Boolean(onViewDetail && !isSaveLive) },
            { key: 'r', label: 'refresh', when: Boolean(selected?.canRefresh) },
            { key: 's', label: 'save current', when: canSaveCurrent },
            { key: 'd', label: 'delete' },
            { key: 'a', label: 'add' },
            { key: 'i', label: 'import' },
            { key: 'e', label: 'export' },
            { key: 'f', label: 'filter provider', when: providerFilterOptions.length > 0 },
            { key: 'tab', label: 'gateways', when: Boolean(onNextSection) },
            { key: 'esc', label: providerFilterId ? 'all providers' : 'apps' },
            { key: 'h', label: 'help', when: Boolean(onHelp) },
            { key: 'q', label: 'quit' },
          ];

  hints.push(
    { key: 't', label: 'tray runtime', when: Boolean(onTray) },
    { key: 'D', label: 'detach to Tray', when: Boolean(onDetach) },
  );

  const nodes: React.ReactNode[] = [];
  if (rows.length === 0) {
    nodes.push(
      <EmptyState
        key="empty"
        text={
          providerFilterId
            ? `No saved accounts for ${providerFilterLabel}.`
            : 'No saved accounts yet.'
        }
        hint={
          providerFilterId
            ? 'Press f for another provider, or esc to show all providers.'
            : 'Press a to add an account, or save the login already active on this computer.'
        }
      />,
    );
  } else {
    let lastProvider: string | null = null;
    for (const item of grouped) {
      if (item.kind === 'provider') {
        if (lastProvider !== null) {
          nodes.push(<Text key={`sp-${item.provider.providerId}`}> </Text>);
        }
        lastProvider = item.provider.providerId;
        nodes.push(
          <Text key={`p-${item.provider.providerId}`} bold>
            {' '}
            {item.provider.providerName}
          </Text>,
        );
        continue;
      }
      // A provider with nothing saved still gets a group, so `a` can reach it.
      if (item.kind === 'empty') {
        nodes.push(
          <Text key={`e-${item.providerId}`} dimColor>
            {'    '}No saved logins — press a to add one.
          </Text>,
        );
        continue;
      }
      const { row, accountIndex } = item;
      nodes.push(
        <DataRow
          key={row.ref}
          selected={accountIndex === selectedIndex}
          name={row.rowKind === 'save-live' ? 'Save current login' : row.label || row.name}
          identity={identityDisplayText(
            row.rowKind === 'save-live' ? (row.liveIdentity ?? row.identity) : row.identity,
            '',
          )}
          extra={row.rowKind === 'save-live' ? 'not saved' : row.updatedRelative}
          status={statusKindFor(row)}
          columns={columns}
          indent
        />,
      );
    }
  }

  return (
    <ScreenShell
      path={['manage', 'accounts']}
      ambient={ambient}
      columns={columns}
      receipt={receipt}
      notice={notice}
      busy={busy}
      busyLabel={busyLabel}
      outcome={outcome}
      support={support}
      hints={hints}
    >
      <Box flexDirection="column">
        {providerFilterOptions.length > 0 ? (
          <>
            <Text dimColor>
              {' '}
              Provider <Text bold>{providerFilterLabel}</Text> · f next
            </Text>
            <Text> </Text>
          </>
        ) : null}
        {nodes}
      </Box>
    </ScreenShell>
  );
}
