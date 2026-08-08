/**
 * Generic confirm — parent path, no CONFIRM title (DESIGN-TUI §11.3).
 */

import React from 'react';
import { useInput } from 'ink';
import { PlanSheet } from '../components/chrome';

export interface ConfirmScreenProps {
  title: string;
  body: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  path?: string | string[];
  onConfirm: () => void;
  onCancel: () => void;
}

// cancelLabel is passed through to PlanSheet

export function ConfirmScreen(props: ConfirmScreenProps) {
  const submitted = React.useRef(false);

  // A failed action leaves the user on the confirmation sheet so Enter can
  // retry. Reset the one-shot guard whenever the parent surfaces a new error.
  React.useEffect(() => {
    if (props.error) {
      submitted.current = false;
    }
  }, [props.error]);

  useInput((_input, key) => {
    if (props.busy) {
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      if (submitted.current) {
        return;
      }
      submitted.current = true;
      props.onConfirm();
    }
  });

  return (
    <PlanSheet
      path={props.path ?? 'switch'}
      title={props.title}
      body={props.body}
      danger={props.danger}
      busy={props.busy}
      busyLabel={props.busyLabel}
      error={props.error}
      confirmLabel={props.confirmLabel ?? 'confirm'}
      cancelLabel={props.cancelLabel ?? 'cancel'}
    />
  );
}
