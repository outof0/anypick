import { Box, Text, useInput } from 'ink';
import { G, ScreenShell, type KeyHint } from '../components/chrome';
import type { OperationReceipt } from '../model';
import type { LaunchSurface } from '../../tray/settings';
import type { TrayStatus } from '../../tray/supervisor';

export interface TrayRuntimeScreenProps {
  available: boolean;
  status: TrayStatus | null;
  defaultSurface: LaunchSurface;
  busy?: boolean;
  busyLabel?: string;
  receipt?: OperationReceipt | null;
  onRefresh: () => void;
  onToggle: () => void;
  onToggleDefaultSurface: () => void;
  onDetach: () => void;
  onBack: () => void;
  onQuit: () => void;
}

export function TrayRuntimeScreen(props: TrayRuntimeScreenProps) {
  const running = props.status?.running === true;
  const toggleLabel = running ? 'turn off Tray + proxies' : 'turn on Tray';

  useInput((input, key) => {
    if (props.busy) {
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      return props.onQuit();
    }
    if (key.escape) {
      return props.onBack();
    }
    if (input === 'r') {
      return props.onRefresh();
    }
    if (input === 't' && props.available) {
      return props.onToggle();
    }
    if (input === 'f') {
      return props.onToggleDefaultSurface();
    }
    if (input === 'D' && props.available) {
      return props.onDetach();
    }
  });

  const hints: KeyHint[] = [
    { key: 't', label: toggleLabel, when: props.available },
    { key: 'f', label: 'flip default surface' },
    { key: 'D', label: 'detach to Tray', when: props.available },
    { key: 'r', label: 'refresh' },
    { key: 'esc', label: 'back' },
    { key: 'q', label: 'quit TUI; Tray state unchanged' },
  ];

  const statusText = !props.available
    ? 'Desktop Tray is unavailable'
    : running
      ? 'Tray is running'
      : 'Tray is stopped';
  const detail = running
    ? `pid ${props.status?.pid ?? '—'} · ${props.status?.proxyCount ?? 0} managed proxies`
    : props.available
      ? 'Start it here or press Shift+D from a main screen to detach.'
      : 'Use the Terminal UI on this installation.';

  return (
    <ScreenShell
      path={['runtime', 'tray']}
      receipt={props.receipt}
      busy={props.busy}
      busyLabel={props.busyLabel}
      outcome={statusText}
      support={detail}
      hints={hints}
    >
      <Box flexDirection="column">
        <Text>
          {' '}
          <Text color={running ? 'green' : undefined}>{running ? G.live : G.open}</Text>{' '}
          <Text bold>Tray runtime</Text>
          <Text dimColor> {running ? 'running' : 'stopped'}</Text>
        </Text>
        <Text>
          {' '}
          <Text dimColor>Default for `anypick`</Text>{' '}
          <Text bold>{props.defaultSurface === 'tray' ? 'Menu bar Tray' : 'Terminal UI'}</Text>
        </Text>
        <Text> </Text>
        <Text dimColor> Shift+D starts the Tray if needed, then closes this TUI.</Text>
        <Text dimColor> Closing with q never changes the current Tray or proxy state.</Text>
        {running ? (
          <Text dimColor> Stopping the Tray also stops the proxies it currently owns.</Text>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
