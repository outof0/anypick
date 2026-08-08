import React from 'react';
import { Box, Text } from 'ink';
import type { OperationReceipt } from '../../model';
import { brandColor, G, NO_COLOR, theme } from './status';

export type ScreenPath = string;

function BrandPath(props: { pathText: string }) {
  const brand = brandColor('brand');
  return (
    <Box>
      <Text color={brand} dimColor={brand === undefined}>
        {' hotplug'}
      </Text>
      <Text> / </Text>
      <Text bold>{props.pathText}</Text>
    </Box>
  );
}

/**
 * `hotplug / switch` — brand violet, path segment normal/bold.
 * Ambient status right-aligned when width allows.
 */
export function ScreenHeader(props: {
  path: ScreenPath | string[];
  ambient?: string;
  columns?: number;
}) {
  const segments = Array.isArray(props.path) ? props.path : [props.path];
  const pathText = segments.filter(Boolean).join(' / ');
  const narrow = (props.columns ?? 80) < 64;

  if (narrow && props.ambient) {
    return (
      <Box flexDirection="column">
        <BrandPath pathText={pathText} />
        <Text dimColor> {props.ambient}</Text>
      </Box>
    );
  }

  return (
    <Box justifyContent="space-between">
      <BrandPath pathText={pathText} />
      {props.ambient ? <Text dimColor>{props.ambient} </Text> : null}
    </Box>
  );
}

/** @deprecated use ScreenHeader with path */
export type ScreenId = string;

// ── Notice slot (always two physical lines) ──────────────────────

export type NoticeKind = 'ok' | 'warn' | 'fail' | 'info' | 'busy';

export interface Notice {
  kind: NoticeKind;
  text: string;
  /** Optional second line */
  detail?: string;
}

function noticePrefix(kind: NoticeKind): { glyph: string; color?: string } {
  switch (kind) {
    case 'ok':
      return { glyph: G.done, color: NO_COLOR ? undefined : theme.ok };
    case 'warn':
      return { glyph: G.warn, color: NO_COLOR ? undefined : theme.warn };
    case 'fail':
      return { glyph: G.fail, color: NO_COLOR ? undefined : theme.danger };
    case 'busy':
      return { glyph: G.busy };
    default:
      return { glyph: '' };
  }
}

export function NoticeSlot(props: { notice?: Notice | null }) {
  const n = props.notice;
  if (!n) {
    return (
      <Box flexDirection="column" height={2}>
        <Text> </Text>
        <Text> </Text>
      </Box>
    );
  }
  const { glyph, color } = noticePrefix(n.kind);
  return (
    <Box flexDirection="column" height={2}>
      <Text color={color}>
        {' '}
        {glyph ? `${glyph} ` : ''}
        {n.text}
      </Text>
      <Text dimColor={Boolean(n.detail)}> {n.detail ?? ' '}</Text>
    </Box>
  );
}

export function noticeFromReceipt(receipt: OperationReceipt | null | undefined): Notice | null {
  if (!receipt) {
    return null;
  }
  const first = receipt.lines[0];
  if (!first) {
    return { kind: 'info', text: receipt.title };
  }
  // A successful operation can carry an important warning (for example an
  // export that contains credentials). Surface the strongest severity rather
  // than letting the first, usually-`ok`, line flatten it into dim detail.
  const kind: NoticeKind = receipt.lines.some((l) => l.kind === 'fail')
    ? 'fail'
    : receipt.lines.some((l) => l.kind === 'warn')
      ? 'warn'
      : receipt.lines.some((l) => l.kind === 'ok')
        ? 'ok'
        : 'info';
  // Prefer first line as the notice body (design: no title like "Hotplug complete")
  const detail =
    receipt.lines.length > 1
      ? receipt.lines
          .slice(1)
          .map((l) => l.text)
          .join(' ')
      : undefined;
  return { kind, text: first.text, detail };
}

// ── Key hints ────────────────────────────────────────────────────

export interface KeyHint {
  key: string;
  label: string;
  /** Hide when false */
  when?: boolean;
}

function renderKeyHintList(list: KeyHint[]) {
  return list.map((h, i) => (
    <React.Fragment key={`${h.key}-${i}`}>
      {i > 0 ? <Text dimColor> </Text> : null}
      <Text bold>{h.key}</Text>
      <Text dimColor> {h.label}</Text>
    </React.Fragment>
  ));
}

const HINT_GAP = 2;

function hintWidth(h: KeyHint): number {
  return h.key.length + 1 + h.label.length;
}

/** Greedily pack hints into at most `maxLines` lines of `perLine` width. */
function packHints(hints: KeyHint[], perLine: number, maxLines: number): KeyHint[][] {
  const lines: KeyHint[][] = [[]];
  let used = 0;
  for (const h of hints) {
    const w = hintWidth(h);
    const need = w + (lines[lines.length - 1].length > 0 ? HINT_GAP : 0);
    if (used + need <= perLine) {
      used += need;
      lines[lines.length - 1].push(h);
      continue;
    }
    if (lines.length >= maxLines) {
      break;
    }
    lines.push([h]);
    used = w;
  }
  return lines;
}

function packedCount(lines: KeyHint[][]): number {
  return lines.reduce((n, l) => n + l.length, 0);
}

export function KeyHints(props: {
  hints: KeyHint[];
  /** @deprecated wrapping is decided by overflow, not by a width breakpoint */
  twoLines?: boolean;
  columns?: number;
  max?: number;
}) {
  void props.twoLines;
  const all = props.hints.filter((h) => h.when !== false);
  const visible = props.max != null ? all.slice(0, props.max) : all;
  const perLine = Math.max(20, (props.columns ?? 80) - 3);

  let lines = packHints(visible, perLine, 2);
  // `h help` is the only route to keys that did not fit, so it must survive.
  if (packedCount(lines) < visible.length) {
    const help = visible.find((h) => h.key === 'h');
    const last = lines[lines.length - 1];
    if (help && !lines.some((l) => l.includes(help)) && last.length > 0) {
      last[last.length - 1] = help;
    }
  }
  lines = lines.filter((l) => l.length > 0);

  if (lines.length === 0) {
    return <Text> </Text>;
  }

  if (lines.length > 1) {
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}> {renderKeyHintList(line)}</Text>
        ))}
      </Box>
    );
  }

  return <Text> {renderKeyHintList(lines[0])}</Text>;
}

// ── Outcome rail ─────────────────────────────────────────────────
