import type React from 'react';
import { Box, Text } from 'ink';
import type { OperationReceipt, OperationReceiptLine } from '../../model';
import { G, NO_COLOR, theme } from './status';
import {
  KeyHints,
  NoticeSlot,
  ScreenHeader,
  noticeFromReceipt,
  type KeyHint,
  type Notice,
  type ScreenPath,
} from './header';

export function OutcomeRail(props: {
  /** Primary outcome line (bold). Blank when none. */
  outcome?: string;
  /** Supporting fact (dim). */
  support?: string;
  hints: KeyHint[];
  busy?: boolean;
  busyLabel?: string;
  columns?: number;
}) {
  const outcome = props.busy ? `${G.busy} ${props.busyLabel ?? 'Working'}` : (props.outcome ?? '');
  const support = props.busy ? '' : (props.support ?? '');

  return (
    <Box flexDirection="column">
      <Rule columns={props.columns} />
      <Text bold> {outcome || ' '}</Text>
      <Text dimColor> {support || ' '}</Text>
      {props.busy ? <Text> </Text> : <KeyHints hints={props.hints} columns={props.columns} />}
    </Box>
  );
}

// ── List rows (simple pad strings — no flex) ─────────────────────
//
// Wireframe (DESIGN-TUI §5):
//   Codex                                      now  xolvlab@acme.com
//       work        dames@acme.com                       ◐ changed
//     › personal    me@gmail.com                         ○ saved
//
// One Text line per row. Fixed char widths. Status may be colored.

export function Viewport(props: {
  rows: number;
  children: React.ReactNode[];
  selectedIndex: number;
}) {
  const total = props.children.length;
  const height = Math.max(1, props.rows);
  let start = 0;
  if (total > height) {
    // Keep selection in view
    const sel = Math.max(0, Math.min(props.selectedIndex, total - 1));
    start = Math.max(0, Math.min(sel - Math.floor(height / 2), total - height));
  }
  const end = Math.min(total, start + height);
  const slice = props.children.slice(start, end);
  const above = start;
  const below = total - end;

  return (
    <Box flexDirection="column">
      {above > 0 ? <Text dimColor> ↑ {above} more</Text> : null}
      {slice}
      {below > 0 ? <Text dimColor> ↓ {below} more</Text> : null}
    </Box>
  );
}

// ── Screen shell ─────────────────────────────────────────────────

export function ScreenShell(props: {
  path: ScreenPath | string[];
  ambient?: string;
  columns?: number;
  notice?: Notice | null;
  /** Receipt auto-converted to notice when notice not set */
  receipt?: OperationReceipt | null;
  error?: string;
  busy?: boolean;
  busyLabel?: string;
  outcome?: string;
  support?: string;
  hints: KeyHint[];
  children: React.ReactNode;
}) {
  const notice =
    props.notice ??
    (props.error ? { kind: 'fail' as const, text: props.error } : noticeFromReceipt(props.receipt));

  return (
    <Box flexDirection="column">
      <ScreenHeader path={props.path} ambient={props.ambient} columns={props.columns} />
      <NoticeSlot notice={notice} />
      <Box flexDirection="column" flexGrow={1}>
        {props.children}
      </Box>
      <OutcomeRail
        outcome={props.outcome}
        support={props.support}
        hints={props.hints}
        busy={props.busy}
        busyLabel={props.busyLabel}
        columns={props.columns}
      />
    </Box>
  );
}

// ── Layout helpers ───────────────────────────────────────────────

export function Spacer() {
  return <Box height={1} />;
}

export function Rule(props: { columns?: number }) {
  const w = Math.max(40, Math.min(80, (props.columns ?? 60) - 2));
  return <Text dimColor> {'─'.repeat(w)}</Text>;
}

export function EmptyState(props: { text: string; hint?: string }) {
  return (
    <Box flexDirection="column">
      <Text> {props.text}</Text>
      {props.hint ? <Text dimColor> {props.hint}</Text> : null}
    </Box>
  );
}

// ── Receipt (legacy multi-line; prefer NoticeSlot) ───────────────

function receiptColor(kind: OperationReceiptLine['kind']): string | undefined {
  if (NO_COLOR) {
    return undefined;
  }
  switch (kind) {
    case 'ok':
      return theme.ok;
    case 'fail':
      return theme.danger;
    case 'warn':
      return theme.warn;
    default:
      return undefined;
  }
}

function receiptMark(kind: OperationReceiptLine['kind']): string {
  switch (kind) {
    case 'ok':
      return G.done;
    case 'fail':
      return G.fail;
    case 'warn':
      return G.warn;
    default:
      return '·';
  }
}

export function ReceiptView(props: { receipt: OperationReceipt }) {
  const { receipt } = props;
  return (
    <Box flexDirection="column">
      {receipt.lines.map((line, i) => (
        <Text key={i} color={receiptColor(line.kind)}>
          {' '}
          {receiptMark(line.kind)} {line.text}
        </Text>
      ))}
    </Box>
  );
}

export function LoadingView(props: { label?: string }) {
  return (
    <Box flexDirection="column">
      <ScreenHeader path="switch" />
      <NoticeSlot notice={{ kind: 'busy', text: props.label ?? 'Loading saved logins' }} />
    </Box>
  );
}

// ── Confirm / plan sheet ─────────────────────────────────────────

export function PlanSheet(props: {
  path?: ScreenPath | string[];
  title: string;
  body: string[];
  danger?: boolean;
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  columns?: number;
}) {
  return (
    <ScreenShell
      path={props.path ?? 'switch'}
      error={props.error}
      busy={props.busy}
      busyLabel={props.busyLabel ?? 'Working'}
      outcome={props.busy ? undefined : props.title}
      support={undefined}
      hints={
        props.busy
          ? []
          : [
              { key: 'enter', label: props.confirmLabel ?? 'confirm' },
              { key: 'esc', label: props.cancelLabel ?? 'cancel' },
            ]
      }
      columns={props.columns}
    >
      <Box flexDirection="column">
        <Text bold color={props.danger && !NO_COLOR ? theme.danger : undefined}>
          {' '}
          {props.title}
        </Text>
        <Spacer />
        {props.body.map((line, i) => (
          <Text key={`b${i}`}> {line === '' ? ' ' : line}</Text>
        ))}
      </Box>
    </ScreenShell>
  );
}

// ── Text field ───────────────────────────────────────────────────
