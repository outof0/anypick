/**
 * Proxy overview + detail screens.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  brandColor,
  Explanation,
  G,
  Header,
  HintLine,
  PrimaryAction,
  Spacer,
  theme,
} from '../components/chrome';
import type { ProxyRow } from '../model';

export interface ProxyListScreenProps {
  rows: ProxyRow[];
  selectedIndex: number;
  filterProviderId?: string;
  onMove: (delta: number) => void;
  onOpen: (row: ProxyRow) => void;
  onBack: () => void;
}

export function ProxyListScreen(props: ProxyListScreenProps) {
  const { rows, selectedIndex, filterProviderId, onMove, onOpen, onBack } = props;
  const selected = rows[selectedIndex];

  useInput((input, key) => {
    if (key.escape) {
      onBack();
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
      onOpen(selected);
    }
  });

  return (
    <Box flexDirection="column">
      <Header breadcrumb={['proxies']} title={filterProviderId ? filterProviderId : undefined} />
      <Spacer />
      {rows.length === 0 ? (
        <Text dimColor> No proxy-capable accounts to show.</Text>
      ) : (
        rows.map((row, i) => {
          const mark = i === selectedIndex ? G.focus : ' ';
          const label = `${row.providerName}/${row.name}`;
          const inactive = row.inactiveEnabled ? '  inactive account' : '';
          const line = `${mark} ${label.padEnd(22)} ${row.stateText.padEnd(10)} ${row.endpointText.padEnd(18)} ${row.compatibilityText}${inactive}`;
          return (
            <Text
              key={`${row.providerId}/${row.name}`}
              color={i === selectedIndex ? brandColor('accent') : undefined}
              bold={i === selectedIndex}
            >
              {line}
            </Text>
          );
        })
      )}
      <Spacer />
      {selected ? (
        <Explanation
          text={
            selected.inactiveEnabled
              ? `${selected.providerId}/${selected.name} has proxy enabled but is not the active account — it is not serving.`
              : selected.detailText
                ? selected.detailText
                : `${selected.providerId}/${selected.name} · ${selected.stateText}`
          }
        />
      ) : null}
      <Spacer />
      <PrimaryAction label={selected ? `Open ${selected.providerId}/${selected.name}` : 'Back'} />
      <HintLine text="↵ open · esc back" />
    </Box>
  );
}

export type ProxyDetailAction =
  | 'enable'
  | 'disable'
  | 'start'
  | 'stop'
  | 'configure'
  | 'logs'
  | 'back';

export interface ProxyDetailScreenProps {
  row: ProxyRow;
  selectedAction: number;
  receipt?: React.ReactNode;
  error?: string;
  onMove: (delta: number) => void;
  onAction: (action: ProxyDetailAction) => void;
  onBack: () => void;
}

export function ProxyDetailScreen(props: ProxyDetailScreenProps) {
  const { row, selectedAction, receipt, error, onMove, onAction, onBack } = props;

  const actions: Array<{ id: ProxyDetailAction; label: string }> = [];
  if (!row.status.enabled) {
    actions.push({ id: 'enable', label: 'Enable proxy' });
  } else {
    actions.push({ id: 'disable', label: 'Disable proxy' });
    if (row.active) {
      if (row.status.running) {
        actions.push({ id: 'stop', label: 'Stop proxy' });
        actions.push({ id: 'start', label: 'Restart proxy' });
      } else {
        actions.push({ id: 'start', label: 'Start proxy' });
      }
    }
  }
  actions.push({ id: 'configure', label: 'Configure host/port' });
  actions.push({ id: 'logs', label: 'View logs' });
  actions.push({ id: 'back', label: 'Back' });

  useInput((input, key) => {
    if (key.escape) {
      onBack();
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
      const a = actions[selectedAction];
      if (a) {
        onAction(a.id);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Header breadcrumb={['proxies', `${row.providerId}/${row.name}`]} />
      <Spacer />
      <Text>
        {' '}
        status {row.stateText}
        {row.inactiveEnabled ? ' (inactive account)' : ''}
      </Text>
      <Text> endpoint {row.endpointText}</Text>
      <Text> compatibility {row.compatibilityText}</Text>
      {row.status.pid != null ? <Text> pid {row.status.pid}</Text> : null}
      {row.status.logPath ? <Text dimColor> log {row.status.logPath}</Text> : null}
      {row.detailText ? <Text color={theme.warn}> detail {row.detailText}</Text> : null}
      <Spacer />
      {receipt}
      {error ? <Text color={theme.danger}> {error}</Text> : null}
      {actions.map((a, i) => (
        <Text
          key={a.id}
          color={i === selectedAction ? brandColor('accent') : undefined}
          bold={i === selectedAction}
        >
          {' '}
          {i === selectedAction ? G.focus : ' '} {a.label}
        </Text>
      ))}
      <Spacer />
      <PrimaryAction label={actions[selectedAction]?.label ?? 'Back'} />
      <HintLine text="↵ select · esc back" />
    </Box>
  );
}
