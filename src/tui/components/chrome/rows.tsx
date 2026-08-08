import type React from 'react';
import { Text } from 'ink';
import {
  brandColor,
  G,
  NO_COLOR,
  statusSpec,
  type StatusKind,
  type WidthBreakpoint,
} from './status';

export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (s.length <= max) {
    return s;
  }
  if (max < 5) {
    return s.slice(0, max);
  }
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Left-pad or truncate to exact width (spaces, no ANSI). */
export function cellText(s: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  const t = truncateMiddle(s, width);
  return t.length >= width ? t : t + ' '.repeat(width - t.length);
}

function statusPlain(kind?: StatusKind, label?: string): string {
  if (!kind) {
    return '';
  }
  const spec = statusSpec(kind);
  const lab = label ?? spec.label;
  return lab ? `${spec.glyph} ${lab}` : spec.glyph;
}

function statusColor(kind?: StatusKind): string | undefined {
  if (!kind || NO_COLOR) {
    return undefined;
  }
  return statusSpec(kind).color;
}

const NAME_W = 12;
const STATUS_W = 12;
const EXTRA_W = 10;

function dataRowCells(
  term: number,
  hasExtra: boolean,
  indent: string,
): { nameW: number; detailW: number; extraW: number; statusW: number } {
  const extraW = hasExtra ? EXTRA_W : 0;
  // " " + indent + focus + " " + name + "  " + detail + "  " + [extra + "  "] + status
  const fixed = 1 + indent.length + 1 + 1 + NAME_W + 2 + 2 + (extraW ? extraW + 2 : 0) + STATUS_W;
  return {
    nameW: NAME_W,
    detailW: Math.max(8, term - fixed - 1),
    extraW,
    statusW: STATUS_W,
  };
}

/** Column header aligned to DataRow's cells. */
export function DataRowHeader(props: {
  name: string;
  identity?: string;
  extra?: string;
  status?: string;
  columns?: number;
  indent?: boolean;
}) {
  const term = Math.max(48, props.columns ?? 80);
  const indent = props.indent ? '  ' : '';
  const { nameW, detailW, extraW, statusW } = dataRowCells(term, Boolean(props.extra), indent);
  const mid = props.extra ? `${cellText(props.extra, extraW)}  ` : '';
  return (
    <Text dimColor>
      {` ${indent}  ${cellText(props.name, nameW)}  ${cellText(props.identity ?? '', detailW)}  `}
      {mid}
      {cellText(props.status ?? '', statusW)}
    </Text>
  );
}

/**
 * Standard list row — pad-based, one physical line.
 *
 *   `  › name________  detail____________________  status______`
 */
export function DataRow(props: {
  selected: boolean;
  name: string;
  identity?: string;
  /** Optional third field (age) between identity and status */
  extra?: string;
  status?: StatusKind;
  statusLabel?: string;
  columns?: number;
  indent?: boolean;
  /** @deprecated ignored — width comes from columns */
  width?: WidthBreakpoint;
  trailing?: React.ReactNode;
}) {
  void props.width;
  void props.trailing;
  const term = Math.max(48, props.columns ?? 80);
  const focus = props.selected ? G.focus : ' ';
  const indent = props.indent ? '  ' : '';
  const { nameW, detailW, extraW, statusW } = dataRowCells(term, Boolean(props.extra), indent);

  // Split so the accent covers the cursor and name only; the identity column
  // stays in the terminal foreground so a wide row does not read as one block.
  const head = ` ${indent}${focus} ${cellText(props.name, nameW)}  `;
  const detail = `${cellText(props.identity ?? '', detailW)}  `;
  const mid = props.extra ? `${cellText(props.extra, extraW)}  ` : '';
  const st = cellText(statusPlain(props.status, props.statusLabel), statusW);
  const color = statusColor(props.status);

  return (
    <Text>
      <Text bold={props.selected} color={props.selected ? brandColor('accent') : undefined}>
        {head}
      </Text>
      <Text>{detail}</Text>
      {mid ? <Text dimColor>{mid}</Text> : null}
      <Text bold={props.selected} color={color}>
        {st}
      </Text>
    </Text>
  );
}

/**
 * Proxy list row:
 *   ` › grok/jonben     ● running       Claude`
 */
export function ProxyRowLine(props: {
  selected: boolean;
  refLabel: string;
  status: StatusKind;
  usedBy: string;
  columns?: number;
}) {
  const term = Math.max(48, props.columns ?? 80);
  const focus = props.selected ? G.focus : ' ';
  const refW = 18;
  const statusW = 14;
  const fixed = 1 + 1 + 1 + refW + 2 + statusW + 2;
  const usedW = Math.max(6, term - fixed - 1);

  const left = ` ${focus} ${cellText(props.refLabel, refW)}  `;
  const st = cellText(statusPlain(props.status), statusW);
  const used = cellText(props.usedBy, usedW);
  const color = statusColor(props.status);

  return (
    <Text>
      <Text bold={props.selected} color={props.selected ? brandColor('accent') : undefined}>
        {left}
      </Text>
      <Text bold={props.selected} color={color}>
        {st}
      </Text>
      <Text dimColor={props.usedBy === '–' || props.usedBy === '-'}> {used}</Text>
    </Text>
  );
}

/**
 * Group header: tool name only (optional dim right for rare status like signed out).
 */
export function GroupHeader(props: { name: string; right?: string; columns?: number }) {
  const right = (props.right ?? '').trim();
  if (!right) {
    return <Text bold> {props.name}</Text>;
  }
  const term = Math.max(48, props.columns ?? 80);
  const left = ` ${props.name}`;
  const gap = Math.max(2, term - left.length - right.length - 1);
  return (
    <Text>
      <Text bold>{left}</Text>
      {' '.repeat(gap)}
      <Text dimColor>{right}</Text>
    </Text>
  );
}

/** @deprecated — use DataRow / ProxyRowLine */
export function AlignedRow(_props: {
  selected: boolean;
  columns?: number;
  indent?: boolean;
  cells: unknown[];
}) {
  return null;
}

/** @deprecated */
export function StatusCell(props: { kind: StatusKind; label?: string; width?: number }) {
  const w = props.width ?? 12;
  return (
    <Text color={statusColor(props.kind)}>{cellText(statusPlain(props.kind, props.label), w)}</Text>
  );
}

/** @deprecated */
export function tableLayout(terminalCols: number, _kind?: string) {
  const total = Math.max(48, terminalCols - 1);
  return {
    total,
    gutter: 4,
    name: 12,
    identity: Math.max(16, total - 30),
    status: 12,
    extra: 10,
    proxyRef: 18,
    usedBy: 16,
  };
}

/** @deprecated */
export const cols = {
  focus: 2,
  indent: 2,
  name: 12,
  identity: 28,
  identityMed: 22,
  status: 12,
  extra: 10,
  proxyRef: 18,
  usedBy: 16,
} as const;

// ── Viewport ─────────────────────────────────────────────────────
