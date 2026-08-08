/**
 * Pick a catalog provider when creating a gateway.
 */

import { Box, Text, useInput } from 'ink';
import { DataRow, ScreenShell, type KeyHint } from '../components/chrome';

export interface CatalogPickRow {
  id: string;
  name: string;
  description: string;
  defaultEndpoint?: string;
}

export interface GatewayPickProviderScreenProps {
  rows: CatalogPickRow[];
  selectedIndex: number;
  columns?: number;
  onMove: (delta: number) => void;
  onSelect: (row: CatalogPickRow) => void;
  onCancel: () => void;
}

export function GatewayPickProviderScreen(props: GatewayPickProviderScreenProps) {
  const { rows, selectedIndex, columns = 80, onMove, onSelect, onCancel } = props;
  const selected = rows[selectedIndex];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
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
      onSelect(selected);
    }
  });

  const hints: KeyHint[] = [
    { key: 'enter', label: 'choose' },
    { key: 'esc', label: 'cancel' },
  ];

  return (
    <ScreenShell
      path={['gateways', 'add']}
      columns={columns}
      outcome={selected ? `Provider ${selected.name}` : 'Choose a provider'}
      support={selected?.defaultEndpoint ?? selected?.description ?? ''}
      hints={hints}
    >
      <Box flexDirection="column">
        <Text bold> Choose provider</Text>
        <Text> </Text>
        {rows.map((row, i) => (
          <DataRow
            key={row.id}
            selected={i === selectedIndex}
            name={row.name}
            identity={row.id}
            status="saved"
            columns={columns}
          />
        ))}
      </Box>
    </ScreenShell>
  );
}
