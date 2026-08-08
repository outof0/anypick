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
  onHelp?: () => void;
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
    onHelp,
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
    if (key.escape || key.tab) {
      onSwitch();
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

  let outcome = 'No gateways yet';
  let support = 'a add  ·  gateways are API sources you bind to Claude, Codex, …';
  if (selected) {
    if (!selected.hasApiKey) {
      outcome = `${selected.name} has no API key`;
      support = 'Edit via CLI or remove and re-add with a key, then bind apps.';
    } else if (selected.usedByApps.length > 0) {
      outcome = `Manage apps using ${selected.name}`;
      support = `${selected.usedByApps.join(', ')} · m model defaults`;
    } else {
      outcome = `Use ${selected.name} with apps`;
      support = selected.modelSummary
        ? `models  ${selected.modelSummary}  ·  m manage apps`
        : 'm manage apps (like a proxy, but the API key is already here)';
    }
  }

  const hints: KeyHint[] = selected
    ? [
        { key: 'enter', label: 'manage apps' },
        { key: 'm', label: 'model defaults' },
        { key: 'e', label: 'endpoint' },
        { key: 'a', label: 'add' },
        { key: 'd', label: 'delete' },
        { key: 'tab', label: 'switch' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit' },
      ]
    : [
        { key: 'a', label: 'add' },
        { key: 'enter', label: 'add' },
        { key: 'tab', label: 'switch' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit' },
      ];

  return (
    <ScreenShell
      path="gateways"
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
        {rows.length === 0 ? (
          <EmptyState
            text="No gateways yet."
            hint="Add an API endpoint + key, then bind Claude/Codex like a proxy."
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
