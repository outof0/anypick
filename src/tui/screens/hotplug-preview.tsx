/**
 * Switch confirmation (DESIGN-TUI §5.3).
 */

import { useInput } from 'ink';
import { PlanSheet } from '../components/chrome';
import type { HotplugPreviewModel } from '../model';

export interface HotplugPreviewScreenProps {
  preview: HotplugPreviewModel;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function HotplugPreviewScreen(props: HotplugPreviewScreenProps) {
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

  const nowId = preview.fromIdentity?.trim() || 'signed out';
  const afterId = preview.toIdentity?.trim() || '—';
  const nowName = preview.fromName ?? '—';
  const afterName = preview.toName;

  const body = [
    `now      ${nowId.padEnd(22)} ${nowName}`,
    `after    ${afterId.padEnd(22)} ${afterName}`,
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
      confirmLabel="confirm"
      busyLabel={`Switching ${preview.displayName} to ${preview.toName}`}
    />
  );
}
