import React from 'react';
import { Box, Text, useInput } from 'ink';
import { brandColor, G, ScreenShell } from '../components/chrome';
import {
  applyLineEdit,
  displayValue,
  lineAtEnd,
  lineEditFor,
  renderLine,
  type LineState,
} from '../model/line-editor';

type FieldId = 'endpoint' | 'api-key';

interface Props {
  providerName: string;
  gatewayName: string;
  initialEndpoint?: string;
  initialApiKey?: string;
  error?: string;
  onSubmit: (values: { endpoint: string; apiKey?: string }) => void;
  onCancel: () => void;
}

export function GatewayConnectionFormScreen(props: Props) {
  const [active, setActive] = React.useState<FieldId>('endpoint');
  const [endpointLine, setEndpointLine] = React.useState<LineState>(() =>
    lineAtEnd(props.initialEndpoint ?? ''),
  );
  const [apiKeyLine, setApiKeyLine] = React.useState<LineState>(() =>
    lineAtEnd(props.initialApiKey ?? ''),
  );
  const [localError, setLocalError] = React.useState<string>();
  const endpoint = endpointLine.value;
  const apiKey = apiKeyLine.value;

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.tab || input === '\t' || key.upArrow || key.downArrow) {
      setActive((field) => (field === 'endpoint' ? 'api-key' : 'endpoint'));
      setLocalError(undefined);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      if (active === 'endpoint') {
        setActive('api-key');
        return;
      }
      const normalizedEndpoint = endpoint.trim();
      if (!normalizedEndpoint) {
        setLocalError('Endpoint is required.');
        setActive('endpoint');
        return;
      }
      try {
        const parsedEndpoint = new URL(normalizedEndpoint);
        void parsedEndpoint;
      } catch {
        setLocalError('Endpoint must be a valid URL.');
        setActive('endpoint');
        return;
      }
      props.onSubmit({ endpoint: normalizedEndpoint, apiKey: apiKey.trim() || undefined });
      return;
    }

    const line = active === 'endpoint' ? endpointLine : apiKeyLine;
    const setLine = active === 'endpoint' ? setEndpointLine : setApiKeyLine;

    const edit = lineEditFor(input, key);
    if (edit) {
      setLine(applyLineEdit(line, edit));
      setLocalError(undefined);
    }
  });

  const labelWidth = 10;

  const renderRow = (field: FieldId, label: string, line: LineState) => {
    const password = field === 'api-key';
    const focused = active === field;
    const { before, at, after } = renderLine(line, password);
    return (
      <Box key={field}>
        <Text bold={focused} color={focused ? brandColor('accent') : undefined}>
          {focused ? `${G.focus} ` : '  '}
          {label.padEnd(labelWidth)}
        </Text>
        <Text>
          {focused ? (
            <>
              {before}
              <Text inverse>{at}</Text>
              {after}
            </>
          ) : line.value ? (
            displayValue(line.value, password)
          ) : (
            <Text dimColor>not set</Text>
          )}
        </Text>
      </Box>
    );
  };

  return (
    <ScreenShell
      path={['gateways', 'add', 'connection']}
      error={localError ?? props.error}
      outcome="enter continue"
      support="tab switch field · esc back"
      hints={[
        { key: 'tab', label: 'switch field' },
        { key: 'enter', label: active === 'endpoint' ? 'next field' : 'continue' },
        { key: 'esc', label: 'back' },
      ]}
    >
      <Box flexDirection="column">
        <Text bold> Connect {props.gatewayName}</Text>
        <Text dimColor> {props.providerName} credentials stay in AnyPick's local secrets.</Text>
        <Text> </Text>
        {renderRow('endpoint', 'Endpoint', endpointLine)}
        {renderRow('api-key', 'API key', apiKeyLine)}
      </Box>
    </ScreenShell>
  );
}
