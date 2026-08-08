/**
 * Switch confirmation (DESIGN-TUI §5.3).
 */

import { useInput } from 'ink';
import { PlanSheet } from '../components/chrome';
import { identityDisplayText, type AnyPickPreviewModel } from '../model';

export interface AnyPickPreviewScreenProps {
  preview: AnyPickPreviewModel;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AnyPickPreviewScreen(props: AnyPickPreviewScreenProps) {
  const { preview, busy, error, onConfirm, onCancel } = props;

  useInput((_input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onConfirm();
    }
  });

  const nowId = identityDisplayText(preview.fromIdentity, 'signed out');
  const afterId = identityDisplayText(preview.toIdentity);
  const nowName = preview.fromName ?? '—';
  const afterName = preview.toName;

  const body = [
    `now      ${nowId.padEnd(22)} ${nowName}`,
    `after    ${afterId.padEnd(22)} ${afterName}`,
    ...(preview.restoreOwner?.running
      ? [
          '',
          `${preview.restoreOwner.name} is open and keeps this login in memory.`,
          `Quit it completely, return here, then press Enter to switch.`,
        ]
      : []),
    '',
    "Other tools won't change.",
  ];

  return (
    <PlanSheet
      path="switch"
      title={`Switch ${preview.displayName} login?`}
      body={body}
      busy={busy}
      error={error}
      confirmLabel={preview.restoreOwner?.running ? 'check & switch' : 'confirm'}
      busyLabel={`Switching ${preview.displayName} to ${preview.toName}`}
    />
  );
}
