import { Box, Text, useInput } from 'ink';
import type { ProxyHubViewModel } from '../model';
import { G, ScreenShell, theme, type KeyHint } from '../components/chrome';

export interface ProxyHubScreenProps {
  view: ProxyHubViewModel;
  selectedIndex: number;
  columns: number;
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  onMove: (delta: number) => void;
  onToggle: (index: number) => void;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onAccounts: () => void;
  onBack: () => void;
  onHelp?: () => void;
  onQuit: () => void;
}

/** One-screen Hub control surface: sources are opt-in and models stay prefix-free. */
export function ProxyHubScreen(props: ProxyHubScreenProps) {
  const {
    view,
    selectedIndex,
    columns,
    busy,
    busyLabel,
    error,
    onMove,
    onToggle,
    onStart,
    onStop,
    onRefresh,
    onAccounts,
    onBack,
    onHelp,
    onQuit,
  } = props;
  const selected = view.sources[selectedIndex];

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (input === 'h' && onHelp) {
      onHelp();
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
    if ((input === ' ' || key.return) && selected) {
      onToggle(selectedIndex);
      return;
    }
    if (input === 's') {
      onStart();
      return;
    }
    if (input === 't') {
      onStop();
      return;
    }
    if (input === 'r') {
      onRefresh();
      return;
    }
    if (input === 'a') {
      onAccounts();
    }
  });

  const status = view.status.running ? 'running' : view.status.enabled ? 'stopped' : 'off';
  const hints: KeyHint[] = [
    { key: 'space', label: 'toggle source', when: Boolean(selected) },
    { key: 's', label: view.status.running ? 'running' : 'start' },
    { key: 't', label: 'turn Hub off', when: view.status.running },
    { key: 'r', label: 'refresh models' },
    { key: 'a', label: 'accounts' },
    { key: 'esc', label: 'back' },
    { key: 'h', label: 'help', when: Boolean(onHelp) },
    { key: 'q', label: 'quit' },
  ];

  return (
    <ScreenShell
      path={['proxy', 'hub']}
      ambient={`${G.live} ${status} · ${view.models.length} routed models`}
      columns={columns}
      busy={busy}
      busyLabel={busyLabel}
      error={error}
      outcome={
        view.status.running
          ? 'One local endpoint routes by model'
          : 'Choose sources, then start one local endpoint'
      }
      support={
        view.conflicts.length
          ? `${view.conflicts.length} ambiguous model${view.conflicts.length === 1 ? '' : 's'} need an owner.`
          : '1. Enable sources · 2. Start Hub · 3. In Tray, Switch Codex or Claude and choose a model.'
      }
      hints={hints}
    >
      <Box flexDirection="column">
        <Text bold> Proxy Hub</Text>
        <Text>
          {view.status.endpoint ?? 'No endpoint yet'} · {view.status.sourceCount} enabled source
          {view.status.sourceCount === 1 ? '' : 's'}
        </Text>
        <Text> </Text>
        {view.sources.length === 0 ? (
          <Text>No saved Hub-capable account yet. Press a to save one, then return here.</Text>
        ) : (
          view.sources.map((source, index) => (
            <Text
              key={
                source.ref.kind === 'account'
                  ? `${source.ref.provider}/${source.ref.name}`
                  : `pool/${source.ref.provider}`
              }
              color={source.available ? undefined : theme.warn}
            >
              {index === selectedIndex ? G.focus : ' '} [{source.enabled ? 'x' : ' '}]{' '}
              {source.label}
              {'  '}
              <Text>{source.detail}</Text>
            </Text>
          ))
        )}
        {view.conflicts.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.warn}>
              Ambiguous models: {view.conflicts.slice(0, 4).join(', ')}
            </Text>
            <Text>Set an explicit owner with `anypick proxy hub owner`.</Text>
          </Box>
        ) : null}
        {view.unavailable.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.warn}>Unavailable source: {view.unavailable[0]}</Text>
          </Box>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
