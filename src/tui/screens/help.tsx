/**
 * Contextual help (DESIGN-TUI §11.2).
 */

import { Box, Text, useInput } from 'ink';
import { G, ScreenShell } from '../components/chrome';

export type HelpContext = 'apps' | 'switch' | 'proxy' | 'accounts' | 'gateways';

export interface HelpScreenProps {
  context: HelpContext;
  onBack: () => void;
}

const KEYS: Record<HelpContext, Array<[string, string]>> = {
  apps: [
    ['↑ ↓ / j k', 'move'],
    ['enter', 'choose source, models, preview, then activate'],
    ['a', 'Accounts'],
    ['tab', 'Accounts (next section)'],
    ['g', 'Gateways'],
    ['p', 'Proxies'],
    ['d', 'Diagnose'],
  ],
  switch: [
    ['↑ ↓ / j k', 'move'],
    ['enter', 'switch, resolve, or save current login'],
    ['r', 'refresh login'],
    ['s', 'save a changed current login'],
    ['a', 'add a login (any tool, even with none saved)'],
    ['/', 'filter'],
    ['tab', 'Proxy (next section)'],
  ],
  proxy: [
    ['↑ ↓ / j k', 'move'],
    ['enter', 'start / manage apps / save unsaved login'],
    ['m', 'manage apps (then edit app models)'],
    ['p', 'multi-account pool on/off (opt-in)'],
    ['space', 'pause/enable pool member'],
    ['s', 'stop'],
    ['r', 'restart'],
    ['d', 'disable proxy auto-start'],
    ['l', 'logs'],
    ['a', 'Accounts'],
    ['tab', 'Apps (next section)'],
  ],
  accounts: [
    ['↑ ↓ / j k', 'move'],
    ['enter', 'switch account, view active details, or save current login'],
    ['v', 'view details + usage'],
    ['a', 'add a login'],
    ['r', 'refresh'],
    ['s', 'save changed current login'],
    ['d', 'delete'],
    ['e', 'export'],
    ['i', 'import'],
    ['f', 'filter by provider'],
    ['tab', 'Gateways (next section)'],
    ['esc', 'clear provider filter, then Apps'],
  ],
  gateways: [
    ['↑ ↓ / j k', 'move'],
    ['enter', 'manage apps (bind like a proxy)'],
    ['m', 'edit gateway model defaults'],
    ['e', 'edit endpoint'],
    ['a', 'add gateway'],
    ['d', 'delete gateway'],
    ['f', 'filter by provider'],
    ['tab', 'Proxy (next section)'],
    ['esc', 'clear provider filter, then Apps'],
  ],
};

const STATUS: Array<[string, string]> = [
  [`${G.live} live`, 'tool uses this saved login'],
  [`${G.open} saved`, 'stored in AnyPick'],
  [`${G.changed} changed`, 'live and saved login differ'],
  [`${G.changed} attention`, 'not saved yet, or needs an API key'],
  [`${G.fail} failed`, 'status or action failed'],
];

const NOTES: Record<HelpContext, string[]> = {
  apps: [
    'Only source/client pairings accepted by transportFor appear in the route builder.',
    'Activation is previewed before AnyPick writes client configuration.',
    'Codex model choices apply to the AnyPick-managed profile; native ChatGPT stays untouched.',
  ],
  switch: [
    'Save current login appears when this computer is signed in but AnyPick has no snapshot.',
    'For a changed active login, s saves the current tool login over its old snapshot.',
  ],
  proxy: [
    'After manage apps, set models (Claude: default / sonnet / opus / haiku).',
    'Gemini proxy needs GEMINI_API_KEY in the saved login (.env). OAuth-only cannot drive the proxy.',
    'Default is one proxy per account. Press p only when you want multi-account failover.',
    's stops the selected proxy. To stop the supervisor and every proxy: anypick tray stop.',
  ],
  accounts: [
    'Save current login appears when this computer is signed in but AnyPick has no snapshot.',
    'For a changed active login, s saves the current tool login over its old snapshot.',
    'a always opens the tool picker, so a tool with nothing saved is still reachable.',
    'Delete is d, so r remains refresh across the app.',
  ],
  gateways: [
    'A gateway is like a proxy with the API key already set — bind Claude/Codex to it.',
    'Enter manages apps. m edits gateway model defaults. d deletes after confirmation.',
  ],
};

export function HelpScreen(props: HelpScreenProps) {
  useInput((_input, key) => {
    if (key.escape || key.return) {
      props.onBack();
    }
  });

  const title =
    props.context === 'apps'
      ? 'Apps'
      : props.context === 'switch'
        ? 'Switch'
        : props.context === 'proxy'
          ? 'Proxy'
          : props.context === 'gateways'
            ? 'Gateways'
            : 'Accounts';

  return (
    <ScreenShell path="help" outcome="" support="" hints={[{ key: 'esc', label: 'back' }]}>
      <Box flexDirection="column">
        <Text bold> {title}</Text>
        {KEYS[props.context].map(([k, v]) => (
          <Text key={k}>
            {'  '}
            <Text bold>{k.padEnd(14)}</Text>
            {v}
          </Text>
        ))}
        <Text> </Text>
        <Text bold> Status</Text>
        {STATUS.map(([k, v]) => (
          <Text key={k}>
            {'  '}
            <Text bold>{k.padEnd(14)}</Text>
            {v}
          </Text>
        ))}
        <Text> </Text>
        <Text bold> Notes</Text>
        {NOTES[props.context].map((line) => (
          <Text key={line} dimColor>
            {'  '}
            {line}
          </Text>
        ))}
        <Text> </Text>
        <Text bold> Global</Text>
        <Text>
          {'  '}
          <Text bold>{'a / r / d'.padEnd(14)}</Text>
          add / refresh / delete
        </Text>
        <Text>
          {'  '}
          <Text bold>{'e / i'.padEnd(14)}</Text>
          export / import
        </Text>
        <Text>
          {'  '}
          <Text bold>{'esc'.padEnd(14)}</Text>
          back or cancel
        </Text>
        <Text>
          {'  '}
          <Text bold>{'h'.padEnd(14)}</Text>
          help
        </Text>
        <Text>
          {'  '}
          <Text bold>{'t'.padEnd(14)}</Text>
          Tray runtime and default surface
        </Text>
        <Text>
          {'  '}
          <Text bold>{'Shift+D'.padEnd(14)}</Text>
          detach to Tray and close TUI
        </Text>
        <Text>
          {'  '}
          <Text bold>{'q'.padEnd(14)}</Text>
          close UI; supervisor and proxies keep running
        </Text>
      </Box>
    </ScreenShell>
  );
}
