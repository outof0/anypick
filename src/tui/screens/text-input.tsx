/**
 * The one text-entry screen, shared by every purpose that takes free text.
 *
 * Everything here is derived from `screen.purpose`: which breadcrumb to show,
 * what the enter key is called, and whether the value is a secret. What the
 * value *does* is the parent's `onSubmit` — see `useTextInputSubmit`.
 */

import { Box, Text } from 'ink';
import { ScreenShell, TextInputField } from '../components/chrome';
import type { TextInputPurpose, TextInputScreen } from '../model/screen';

export interface TextInputScreenProps {
  screen: TextInputScreen;
  /** Provider display name, shown only by `save-name`. */
  providerName?: string;
  error?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function pathFor(purpose: TextInputPurpose): string[] {
  if (purpose === 'save-name') {
    return ['accounts', 'save'];
  }
  if (purpose === 'export-path') {
    return ['accounts', 'export'];
  }
  if (purpose.startsWith('import')) {
    return ['accounts', 'import'];
  }
  if (purpose === 'gateway-edit-endpoint') {
    return ['gateways', 'edit'];
  }
  if (purpose.startsWith('gateway')) {
    return ['gateways', 'add'];
  }
  return ['accounts'];
}

function enterLabelFor(purpose: TextInputPurpose): string {
  if (purpose === 'export-path') {
    return 'export';
  }
  if (purpose === 'gateway-api-key') {
    return 'continue';
  }
  // The other gateway steps are stages of a create wizard; this one commits.
  if (purpose === 'gateway-edit-endpoint') {
    return 'save';
  }
  return purpose.startsWith('gateway') ? 'next' : 'save';
}

export function TextInputScreenView(props: TextInputScreenProps) {
  const { screen, providerName, error, onSubmit, onCancel } = props;
  const enterLabel = enterLabelFor(screen.purpose);

  return (
    <ScreenShell
      path={pathFor(screen.purpose)}
      error={error}
      outcome={`enter ${enterLabel}`}
      support="esc cancel"
      hints={[
        { key: 'enter', label: enterLabel },
        { key: 'esc', label: 'cancel' },
      ]}
    >
      {screen.purpose === 'save-name' ? (
        <Box flexDirection="column">
          <Text bold> Save this {providerName ?? ''} login</Text>
          <Text> </Text>
        </Box>
      ) : null}
      <TextInputField
        label={screen.label}
        initial={screen.initial}
        hint={screen.hint}
        preview={screen.preview}
        password={screen.purpose === 'gateway-api-key'}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </ScreenShell>
  );
}
