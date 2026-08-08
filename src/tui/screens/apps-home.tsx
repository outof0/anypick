import { Box, Text, useInput } from 'ink';
import type { ClientRow } from '../../cli/launcher-model';
import {
  DataRow,
  EmptyState,
  ScreenShell,
  type KeyHint,
  type StatusKind,
} from '../components/chrome';
import type { OperationReceipt } from '../model';

export interface AppsHomeScreenProps {
  rows: ClientRow[];
  selectedIndex: number;
  columns: number;
  receipt?: OperationReceipt | null;
  busy?: boolean;
  busyLabel?: string;
  onMove: (delta: number) => void;
  onConfigure: (row: ClientRow) => void;
  onAccounts: () => void;
  onGateways: () => void;
  onProxies: () => void;
  onDiagnose: () => void;
  onHelp: () => void;
  onTray?: () => void;
  onDetach?: () => void;
  onQuit: () => void;
}

function rowStatus(row: ClientRow): StatusKind {
  if (row.status === 'ready') {
    return 'using';
  }
  if (row.status === 'attention') {
    return 'attention';
  }
  if (row.status === 'native') {
    return 'signed-in';
  }
  return 'not-using';
}

export function AppsHomeScreen(props: AppsHomeScreenProps) {
  const selected = props.rows[props.selectedIndex];

  useInput((input, key) => {
    if (props.busy) {
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      return props.onQuit();
    }
    if (input === 'a') {
      return props.onAccounts();
    }
    if (key.tab) {
      return props.onAccounts();
    }
    if (input === 'g') {
      return props.onGateways();
    }
    if (input === 'p') {
      return props.onProxies();
    }
    if (input === 'd') {
      return props.onDiagnose();
    }
    if (input === 'h') {
      return props.onHelp();
    }
    if (input === 't' && props.onTray) {
      return props.onTray();
    }
    if (input === 'D' && props.onDetach) {
      return props.onDetach();
    }
    if (key.upArrow || input === 'k') {
      return props.onMove(-1);
    }
    if (key.downArrow || input === 'j') {
      return props.onMove(1);
    }
    if (key.return && selected) {
      props.onConfigure(selected);
    }
  });

  const hints: KeyHint[] = [
    {
      key: 'enter',
      label:
        selected?.status === 'unbound' || selected?.status === 'native'
          ? 'connect app'
          : 'change route',
    },
    { key: 'a', label: 'accounts' },
    { key: 'tab', label: 'manage accounts' },
    { key: 'g', label: 'gateways' },
    { key: 'p', label: 'proxies' },
    { key: 't', label: 'tray runtime', when: Boolean(props.onTray) },
    { key: 'D', label: 'detach to Tray', when: Boolean(props.onDetach) },
    { key: 'd', label: 'diagnose' },
    { key: 'h', label: 'help' },
    { key: 'q', label: 'quit TUI; background stays running' },
  ];
  const ready = props.rows.filter((row) => row.status === 'ready').length;
  const native = props.rows.filter((row) => row.status === 'native').length;
  const ambient = [ready ? `${ready} managed` : '', native ? `${native} native` : '']
    .filter(Boolean)
    .join(' · ');
  const outcome = selected
    ? selected.status === 'unbound'
      ? `Connect ${selected.shortName}`
      : selected.status === 'native'
        ? `${selected.shortName} uses its native login`
        : selected.status === 'attention'
          ? `${selected.shortName} needs attention`
          : `${selected.shortName} uses ${selected.source}`
    : 'No app-routing clients are registered';
  const support = selected
    ? selected.status === 'native'
      ? `${selected.nativeIdentity ?? 'signed in'} · not managed by AnyPick · enter to build a route`
      : (selected.attention ??
        `${selected.model ? `model ${selected.model} · ` : ''}enter to preview a different route`)
    : 'Register an app-routing client, then reopen AnyPick.';

  return (
    <ScreenShell
      path="apps"
      ambient={ambient || undefined}
      columns={props.columns}
      receipt={props.receipt}
      busy={props.busy}
      busyLabel={props.busyLabel}
      outcome={outcome}
      support={support}
      hints={hints}
    >
      <Box flexDirection="column">
        {props.rows.length === 0 ? (
          <EmptyState
            text="No Claude Code or Codex route is available."
            hint="Install a supported client, then reopen AnyPick."
          />
        ) : (
          <>
            <Text dimColor> Routes for Claude Code and Codex</Text>
            {props.rows.map((row, index) => (
              <DataRow
                key={row.clientId}
                selected={index === props.selectedIndex}
                name={row.shortName}
                identity={
                  row.source
                    ? `${row.source}${row.model ? ` · ${row.model}` : ''}`
                    : 'not connected'
                }
                status={rowStatus(row)}
                statusLabel={
                  row.status === 'unbound'
                    ? 'not set'
                    : row.status === 'native'
                      ? 'native'
                      : row.status
                }
                columns={props.columns}
              />
            ))}
          </>
        )}
      </Box>
    </ScreenShell>
  );
}
