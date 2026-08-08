import { Box, Text, useInput } from 'ink';
import { DataRow, EmptyState, GroupHeader, ScreenShell, type KeyHint } from '../components/chrome';
import type { AppRouteSourceCategory, AppRouteSourceRow } from '../model';

function categoryLabel(category: AppRouteSourceCategory): string {
  switch (category) {
    case 'native':
      return 'Native accounts';
    case 'gateway':
      return 'Gateways & proxies';
    case 'saved':
      return 'Saved setups';
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

export function AppRouteSourceScreen(props: {
  clientName: string;
  rows: AppRouteSourceRow[];
  selectedIndex: number;
  columns: number;
  busy?: boolean;
  error?: string;
  onMove: (delta: number) => void;
  onSelect: (row: AppRouteSourceRow) => void;
  onAccounts: () => void;
  onGateways: () => void;
  onBack: () => void;
}) {
  const selected = props.rows[props.selectedIndex];
  useInput((input, key) => {
    if (props.busy) {
      return;
    }
    if (key.escape) {
      return props.onBack();
    }
    if (input === 'a') {
      return props.onAccounts();
    }
    if (input === 'g') {
      return props.onGateways();
    }
    if (key.upArrow || input === 'k') {
      return props.onMove(-1);
    }
    if (key.downArrow || input === 'j') {
      return props.onMove(1);
    }
    if (key.return && selected) {
      props.onSelect(selected);
    }
  });

  const hints: KeyHint[] = props.rows.length
    ? [
        {
          key: 'enter',
          label: selected?.category === 'native' ? 'switch account' : 'choose route',
        },
        { key: 'a', label: 'accounts' },
        { key: 'g', label: 'gateways' },
        { key: 'esc', label: 'back' },
      ]
    : [
        { key: 'a', label: 'add account' },
        { key: 'g', label: 'add gateway' },
        { key: 'esc', label: 'back' },
      ];

  return (
    <ScreenShell
      path={['apps', props.clientName, 'source']}
      columns={props.columns}
      busy={props.busy}
      error={props.error}
      outcome={
        selected
          ? selected.category === 'native'
            ? `Switch ${props.clientName} to ${selected.label}`
            : `Route ${props.clientName} through ${selected.label}`
          : 'No compatible sources yet'
      }
      support={
        selected
          ? selected.category === 'native'
            ? `${selected.detail} · uses the app's own model settings`
            : `${selected.detail} · model routing is configured next`
          : 'Add an account or gateway that this client can safely use.'
      }
      hints={hints}
    >
      <Box flexDirection="column">
        {props.rows.length === 0 ? (
          <EmptyState
            text="No compatible sources."
            hint="Only pairings accepted by this source's transport adapter appear here."
          />
        ) : (
          props.rows.map((row, index) => {
            const firstInCategory = index === 0 || props.rows[index - 1]?.category !== row.category;
            return (
              <Box key={row.value} flexDirection="column">
                {firstInCategory ? (
                  <>
                    {index > 0 ? <Text> </Text> : null}
                    <GroupHeader
                      name={categoryLabel(row.category)}
                      right=""
                      columns={props.columns}
                    />
                  </>
                ) : null}
                <DataRow
                  selected={index === props.selectedIndex}
                  name={row.label}
                  identity={row.detail}
                  status={row.category === 'native' ? 'signed-in' : 'saved'}
                  columns={props.columns}
                  indent
                />
              </Box>
            );
          })
        )}
      </Box>
    </ScreenShell>
  );
}
