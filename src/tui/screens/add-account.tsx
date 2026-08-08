/**
 * Add / save login flows (DESIGN-TUI §7–9).
 */

import { Box, Text, useInput } from 'ink';
import { EmptyState, Picker, ScreenShell, type StatusKind } from '../components/chrome';
import type { ProviderPoolRow } from '../model';

/**
 * The command a user runs to sign in with each provider's own tool, before
 * AnyPick can snapshot the login. Only include commands we're confident about;
 * unknown providers fall back to a generic instruction.
 */
const SIGN_IN_COMMANDS: Record<string, string> = {
  codex: 'codex login',
};

/** Instruction line for signing in with the provider's tool. */
export function signInInstruction(
  providerId: string,
  displayName: string,
  source?: string,
): string {
  if (source === 'antigravity') {
    return 'Open the Antigravity app and sign in with the other account.';
  }
  const cmd = SIGN_IN_COMMANDS[providerId];
  return cmd
    ? `In another terminal, run:  ${cmd}`
    : `In another terminal, use the normal ${displayName} sign-in command.`;
}

export interface AddProviderScreenProps {
  providers: ProviderPoolRow[];
  selectedIndex: number;
  purpose?: 'add' | 'import';
  onMove: (delta: number) => void;
  onSelect: (row: ProviderPoolRow) => void;
  onBack: () => void;
}

function toolStatus(p: ProviderPoolRow): { kind: StatusKind; label: string } {
  if (p.relation === 'error') {
    return { kind: 'unavailable', label: 'unavailable' };
  }
  if (p.liveIdentity) {
    return { kind: 'signed-in', label: `signed in as ${p.liveIdentity}` };
  }
  if (p.relation === 'no-live' || p.relation === 'empty') {
    return { kind: 'signed-out', label: 'signed out' };
  }
  return { kind: 'signed-out', label: 'signed out' };
}

export function AddProviderScreen(props: AddProviderScreenProps) {
  const { providers, selectedIndex, purpose = 'add', onMove, onSelect, onBack } = props;
  const selected = providers[selectedIndex];

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
      onSelect(selected);
    }
  });

  const verb = purpose === 'import' ? 'import' : 'add';
  const outcome = selected ? `enter ${verb} ${selected.displayName} login` : 'Choose a tool';

  return (
    <ScreenShell
      path={['accounts', purpose === 'import' ? 'import' : 'add']}
      outcome={outcome}
      hints={[
        { key: 'enter', label: selected ? `${verb} ${selected.displayName} login` : 'select' },
        { key: 'esc', label: 'cancel' },
      ]}
    >
      <Box flexDirection="column">
        <Text bold> Choose a tool</Text>
        <Text> </Text>
        {providers.length === 0 ? (
          <EmptyState text="No tools registered." />
        ) : (
          <Picker
            items={providers.map((p) => {
              const st = toolStatus(p);
              return {
                id: p.providerId,
                label: p.displayName,
                status: st.kind,
                statusLabel: st.label,
              };
            })}
            selectedIndex={selectedIndex}
          />
        )}
      </Box>
    </ScreenShell>
  );
}

export type GeminiSource = 'gemini-cli' | 'antigravity';

export interface AddSourceScreenProps {
  displayName: string;
  selectedIndex: number;
  onMove: (delta: number) => void;
  onSelect: (source: GeminiSource) => void;
  onBack: () => void;
}

/** Choose which sign-in source to add for a provider that has more than one. */
export function AddSourceScreen(props: AddSourceScreenProps) {
  const { displayName, selectedIndex, onMove, onSelect, onBack } = props;

  const options: Array<{ id: GeminiSource; label: string; hint: string }> = [
    { id: 'gemini-cli', label: 'Gemini CLI', hint: 'API key or Google login under ~/.gemini' },
    { id: 'antigravity', label: 'Antigravity', hint: 'OAuth from your OS credential store' },
  ];

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
      const o = options[selectedIndex];
      if (o) {
        onSelect(o.id);
      }
    }
  });

  const focused = options[selectedIndex];

  return (
    <ScreenShell
      path={['accounts', 'add']}
      outcome={focused ? `enter add ${focused.label} login` : 'Choose a source'}
      support={focused?.hint ?? ''}
      hints={[
        { key: 'enter', label: focused ? `add ${focused.label} login` : 'select' },
        { key: 'esc', label: 'back' },
      ]}
    >
      <Box flexDirection="column">
        <Text bold> How do you sign in to {displayName}?</Text>
        <Text> </Text>
        <Picker
          items={options.map((o) => ({ id: o.id, label: o.label }))}
          selectedIndex={selectedIndex}
        />
      </Box>
    </ScreenShell>
  );
}

export type AddMode = 'save' | 'add-another' | 'login-help' | 'api-key';

const ADD_MODE_ACTIONS: Record<AddMode, string> = {
  save: 'save this login',
  'add-another': 'add another login',
  'login-help': 'check again',
  'api-key': 'enter an API key',
};

export interface AddModeOptionInput {
  livePresent: boolean;
  canClearLive: boolean;
  /** The provider accepts a credential the user types instead of a login. */
  canUseApiKey: boolean;
}

/**
 * Shared so the gate and the screen cannot disagree about how many rows exist —
 * a mismatch scrolls the cursor onto a row that is not rendered.
 */
export function addModeOptions(input: AddModeOptionInput): Array<{ id: AddMode; label: string }> {
  return [
    ...(input.livePresent
      ? [
          { id: 'save' as const, label: 'Save this login' },
          ...(input.canClearLive
            ? [{ id: 'add-another' as const, label: 'Add another login' }]
            : []),
        ]
      : [{ id: 'login-help' as const, label: 'Check again' }]),
    ...(input.canUseApiKey ? [{ id: 'api-key' as const, label: 'Use an API key instead' }] : []),
  ];
}

export interface AddModeScreenProps {
  providerId: string;
  displayName: string;
  livePresent: boolean;
  liveIdentity?: string;
  canClearLive: boolean;
  canUseApiKey: boolean;
  source?: string;
  selectedIndex: number;
  onMove: (delta: number) => void;
  onSelect: (mode: AddMode) => void;
  onBack: () => void;
}

export function AddModeScreen(props: AddModeScreenProps) {
  const {
    displayName,
    livePresent,
    liveIdentity,
    canClearLive,
    canUseApiKey,
    selectedIndex,
    onMove,
    onSelect,
    onBack,
  } = props;

  const options = addModeOptions({ livePresent, canClearLive, canUseApiKey });

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
      const o = options[selectedIndex];
      if (o) {
        onSelect(o.id);
      }
    }
  });

  const focused = options[selectedIndex];
  const action = focused ? ADD_MODE_ACTIONS[focused.id] : undefined;
  // With no login to save and nothing else on offer, the single row would say
  // exactly what the enter hint already says.
  const showPicker = livePresent || options.length > 1;

  return (
    <ScreenShell
      path={['accounts', 'add', props.source ?? props.providerId]}
      outcome={action ? `enter ${action}` : 'Choose how to add'}
      hints={[
        { key: 'enter', label: action ?? 'select' },
        { key: 'esc', label: 'back' },
      ]}
    >
      <Box flexDirection="column">
        {livePresent ? (
          liveIdentity ? (
            <Text bold> Signed in as {liveIdentity}</Text>
          ) : (
            <Text bold> Signed in</Text>
          )
        ) : (
          <>
            <Text bold> Sign in to {displayName}</Text>
            <Text> </Text>
            <Text> {signInInstruction(props.providerId, displayName, props.source)}</Text>
            <Text> When sign-in finishes, return here.</Text>
          </>
        )}
        <Text> </Text>
        {showPicker ? (
          <Picker
            items={options.map((o) => ({ id: o.id, label: o.label }))}
            selectedIndex={selectedIndex}
          />
        ) : null}
      </Box>
    </ScreenShell>
  );
}

export interface StashResultScreenProps {
  providerId: string;
  displayName: string;
  cleared: boolean;
  backedUpTo: string | null;
  previousIdentity?: string;
  matchedByIdentity: boolean;
  skippedBackup?: boolean;
  source?: string;
  /** Re-detect the live login, so a sign-in finished in another terminal can be saved. */
  onCheckAgain: () => void;
  onDone: () => void;
}

/** After preparing for another login — sign-in instruction (DESIGN-TUI §9.3). */
export function StashResultScreen(props: StashResultScreenProps) {
  useInput((_input, key) => {
    if (key.return) {
      props.onCheckAgain();
      return;
    }
    if (key.escape) {
      props.onDone();
    }
  });

  const prev = props.previousIdentity?.trim() || 'previous login';
  const savedAs = props.backedUpTo ?? 'saved login';

  return (
    <ScreenShell
      path={['accounts', 'add another']}
      outcome="enter check for the new login"
      support="If the new login is detected, you can save it right away."
      hints={[
        { key: 'enter', label: 'check again' },
        { key: 'esc', label: 'done' },
      ]}
    >
      <Box flexDirection="column">
        <Text bold> Sign in to {props.displayName}</Text>
        <Text> </Text>
        <Text> {signInInstruction(props.providerId, props.displayName, props.source)}</Text>
        <Text> When sign-in finishes, return here.</Text>
        <Text> </Text>
        {props.skippedBackup ? (
          <>
            <Text dimColor> No existing {props.displayName} login to back up.</Text>
            <Text dimColor> Ready for a new login — when it&apos;s done, choose Save current.</Text>
          </>
        ) : (
          <>
            <Text dimColor>
              {' '}
              Previous login {prev}
              {props.backedUpTo ? `   saved as ${savedAs}` : ''}
            </Text>
            <Text dimColor> New login not detected yet</Text>
          </>
        )}
        {!props.cleared && !props.skippedBackup ? (
          <Text> ! {props.displayName} couldn&apos;t be prepared for another login.</Text>
        ) : null}
      </Box>
    </ScreenShell>
  );
}
