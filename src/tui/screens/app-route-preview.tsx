import { useInput } from 'ink';
import { PlanSheet } from '../components/chrome';

export function AppRoutePreviewScreen(props: {
  clientName: string;
  native?: boolean;
  sourceLabel?: string;
  lines: string[];
  warnings: string[];
  columns: number;
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  onConfirm: () => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (props.busy) {
      return;
    }
    if (key.escape) {
      return props.onBack();
    }
    if (key.return) {
      props.onConfirm();
    }
  });

  return (
    <PlanSheet
      path={['apps', props.clientName, 'preview']}
      title={
        props.native
          ? `Switch ${props.clientName} to ${props.sourceLabel ?? 'this native account'}?`
          : `Activate this route for ${props.clientName}?`
      }
      body={[
        ...props.lines,
        ...(props.warnings.length
          ? ['', 'Warnings:', ...props.warnings.map((line) => `· ${line}`)]
          : []),
      ]}
      confirmLabel={props.native ? 'switch account' : 'activate route'}
      cancelLabel="back"
      busy={props.busy}
      busyLabel={props.busyLabel}
      error={props.error}
      columns={props.columns}
    />
  );
}
