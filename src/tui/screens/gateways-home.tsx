/**
 * Gateways — API sources (endpoint + key), bind to clients like proxies.
 *
 * Mental model matches Proxy:
 *   gateway row → enter manage apps → map models → apply
 * Difference: no process to start; credentials already on the profile.
 */

import { Box, Text, useInput } from 'ink';
import {
  DataRow,
  DataRowHeader,
  EmptyState,
  G,
  ScreenShell,
  type KeyHint,
  type Notice,
  type StatusKind,
} from '../components/chrome';
import type { GatewayRow, OperationReceipt } from '../model';
import type { ProviderFilterOption } from '../model/provider-filter';

export interface GatewaysHomeScreenProps {
  rows: GatewayRow[];
  selectedIndex: number;
  columns?: number;
  receipt?: OperationReceipt | null;
  notice?: Notice | null;
  busy?: boolean;
  busyLabel?: string;
  onMove: (delta: number) => void;
  onAdd: () => void;
  onUseApps: (row: GatewayRow) => void;
  onEditModels: (row: GatewayRow) => void;
  onEditEndpoint: (row: GatewayRow) => void;
  onDelete: (row: GatewayRow) => void;
  onSwitch: () => void;
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

function rowStatus(row: GatewayRow): StatusKind {
  if (!row.hasApiKey) {
    return 'attention';
  }
  if (row.usedByApps.length > 0) {
    return 'using';
  }
  return 'saved';
}

function usedByLabel(row: GatewayRow): string {
  if (!row.hasApiKey) {
    return 'needs key';
  }
  if (row.usedByApps.length === 0) {
    return G.dash;
  }
  return row.usedByApps.join(', ');
}

export function GatewaysHomeScreen(props: GatewaysHomeScreenProps) {
  const {
    rows,
    selectedIndex,
    columns = 80,
    receipt,
    notice,
    busy,
    busyLabel,
    onMove,
    onAdd,
    onUseApps,
    onEditModels,
    onEditEndpoint,
    onDelete,
    onSwitch,
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

  const selected = rows[selectedIndex];
  const usingCount = rows.filter((r) => r.usedByApps.length > 0).length;
  const ambient = usingCount > 0 ? `${G.live} ${usingCount} in use` : undefined;

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
      onSwitch();
      return;
    }
    if (key.tab) {
      (onNextSection ?? onSwitch)();
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
      onAdd();
      return;
    }
    if (input === 'f' && providerFilterOptions.length > 0) {
      onCycleProvider?.();
      return;
    }
    if (!selected) {
      if (key.return) {
        onAdd();
      }
      return;
    }
    if (input === 'm') {
      onEditModels(selected);
      return;
    }
    if (key.return) {
      // Same primary as Proxy: manage which apps use this source
      onUseApps(selected);
      return;
    }
    if (input === 'd') {
      onDelete(selected);
      return;
    }
    if (input === 'e') {
      onEditEndpoint(selected);
      return;
    }
  });

  let outcome = providerFilterId ? `No gateways for ${providerFilterLabel}` : 'No gateways yet';
  let support = providerFilterId
    ? 'Press f for the next provider, or esc to show all providers.'
    : 'Gateways are API sources available to Claude Code and Codex.';
  if (selected) {
    if (!selected.hasApiKey) {
      outcome = `${selected.name} has no API key`;
      support = `Set it with: anypick gateway edit ${selected.name} --api-key <key>`;
    } else if (selected.usedByApps.length > 0) {
      outcome = `Manage apps using ${selected.name}`;
      support = `${selected.usedByApps.join(', ')} · enter manage apps · m model defaults`;
    } else {
      outcome = `Use ${selected.name} with apps`;
      support = selected.modelSummary
        ? `models  ${selected.modelSummary}  ·  enter manage apps  ·  m model defaults`
        : 'enter manage apps · m model defaults';
    }
  }

  const hints: KeyHint[] = selected
    ? [
        { key: 'enter', label: 'manage apps' },
        { key: 'm', label: 'model defaults' },
        { key: 'e', label: 'endpoint' },
        { key: 'a', label: 'add' },
        { key: 'd', label: 'delete' },
        { key: 'f', label: 'filter provider', when: providerFilterOptions.length > 0 },
        { key: 'tab', label: 'proxy' },
        { key: 'esc', label: providerFilterId ? 'all providers' : 'apps' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit UI; proxies stay running' },
      ]
    : [
        { key: 'a', label: 'add' },
        { key: 'enter', label: 'add' },
        { key: 'f', label: 'filter provider', when: providerFilterOptions.length > 0 },
        { key: 'tab', label: 'proxy' },
        { key: 'esc', label: providerFilterId ? 'all providers' : 'apps' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit UI; proxies stay running' },
      ];

  hints.push(
    { key: 't', label: 'tray runtime', when: Boolean(onTray) },
    { key: 'D', label: 'detach to Tray', when: Boolean(onDetach) },
  );

  return (
    <ScreenShell
      path={['manage', 'gateways']}
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
        {rows.length === 0 ? (
          <EmptyState
            text={providerFilterId ? `No gateways for ${providerFilterLabel}.` : 'No gateways yet.'}
            hint={
              providerFilterId
                ? 'Press f for another provider, or esc to show all providers.'
                : 'Press a to add an API endpoint and key for Claude Code or Codex.'
            }
          />
        ) : (
          <>
            <DataRowHeader
              name="gateway"
              identity="provider · endpoint"
              extra="used by"
              status="status"
              columns={columns}
            />
            {rows.map((row, i) => (
              <DataRow
                key={row.name}
                selected={i === selectedIndex}
                name={row.name}
                identity={`${row.providerName} · ${row.endpointShort}`}
                extra={usedByLabel(row)}
                status={rowStatus(row)}
                columns={columns}
              />
            ))}
          </>
        )}
        {selected?.modelSummary ? <Text dimColor> models {selected.modelSummary}</Text> : null}
      </Box>
    </ScreenShell>
  );
}
