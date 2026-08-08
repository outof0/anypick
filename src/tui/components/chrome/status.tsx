import { Text } from 'ink';
import { BRAND_HUES } from '../../../core/brand';

export const theme = {
  /** Wordmark violet. Decoration only — never carries a status meaning. */
  brand: BRAND_HUES.violet,
  /** Selection and focus. Legible on light and dark terminals alike. */
  accent: BRAND_HUES.blue,
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
} as const;

export type StatusKind =
  | 'live'
  | 'signed-in'
  | 'running'
  | 'using'
  | 'saved'
  | 'stopped'
  | 'not-using'
  | 'changed'
  | 'attention'
  | 'failed'
  | 'unavailable'
  | 'checking'
  | 'switching'
  | 'done'
  | 'warn'
  | 'signed-out'
  | 'not-detected'
  | 'off'
  | 'na';

const DUMB = process.env.TERM === 'dumb';
export const NO_COLOR = Boolean(process.env.NO_COLOR);

function glyphs() {
  if (DUMB) {
    return {
      live: '*',
      open: 'o',
      changed: '!',
      fail: 'x',
      busy: '...',
      done: '*',
      warn: '!',
      focus: '>',
      dash: '-',
    } as const;
  }
  return {
    live: '●',
    open: '○',
    changed: '◐',
    fail: '×',
    busy: '…',
    done: '✓',
    warn: '!',
    focus: '›',
    dash: '–',
  } as const;
}

export const G = glyphs();

/** Brand hues are decoration, so NO_COLOR drops them rather than substituting. */
export function brandColor(token: 'brand' | 'accent'): string | undefined {
  return NO_COLOR ? undefined : theme[token];
}

export function statusSpec(kind: StatusKind): {
  glyph: string;
  label: string;
  color?: typeof theme.ok | typeof theme.warn | typeof theme.danger;
} {
  switch (kind) {
    case 'live':
      return { glyph: G.live, label: 'live', color: theme.ok };
    case 'signed-in':
      return { glyph: G.live, label: 'signed in', color: theme.ok };
    case 'running':
      return { glyph: G.live, label: 'running', color: theme.ok };
    case 'using':
      return { glyph: G.live, label: 'using', color: theme.ok };
    case 'saved':
      return { glyph: G.open, label: 'saved' };
    case 'stopped':
      return { glyph: G.open, label: 'stopped' };
    case 'not-using':
      return { glyph: G.open, label: 'not using' };
    case 'changed':
      return { glyph: G.changed, label: 'changed', color: theme.warn };
    case 'attention':
      return { glyph: G.changed, label: 'attention', color: theme.warn };
    case 'failed':
      return { glyph: G.fail, label: 'failed', color: theme.danger };
    case 'unavailable':
      return { glyph: G.fail, label: 'unavailable', color: theme.danger };
    case 'checking':
      return { glyph: G.busy, label: 'checking' };
    case 'switching':
      return { glyph: G.busy, label: 'switching' };
    case 'done':
      return { glyph: G.done, label: '', color: theme.ok };
    case 'warn':
      return { glyph: G.warn, label: '', color: theme.warn };
    case 'signed-out':
      return { glyph: G.dash, label: 'signed out' };
    case 'not-detected':
      return { glyph: G.dash, label: 'not detected' };
    case 'off':
      return { glyph: G.dash, label: 'off' };
    case 'na':
      return { glyph: G.dash, label: '' };
    default: {
      const _e: never = kind;
      return _e;
    }
  }
}

/** Glyph + label; color only on the token (optional; NO_COLOR strips). */
export function StatusToken(props: {
  kind: StatusKind;
  /** Override default label */
  label?: string;
  /** Hide label (glyph only) — avoid; design prefers label */
  glyphOnly?: boolean;
}) {
  const spec = statusSpec(props.kind);
  const label = props.label ?? spec.label;
  const color = NO_COLOR ? undefined : spec.color;
  if (props.glyphOnly || !label) {
    return <Text color={color}>{spec.glyph}</Text>;
  }
  return (
    <Text color={color}>
      {spec.glyph} {label}
    </Text>
  );
}

// ── Breakpoints ──────────────────────────────────────────────────

export type WidthBreakpoint = 'narrow' | 'medium' | 'wide';

export function widthBreakpoint(columns: number): WidthBreakpoint {
  if (columns >= 96) {
    return 'wide';
  }
  if (columns >= 64) {
    return 'medium';
  }
  return 'narrow';
}

// ── Header ───────────────────────────────────────────────────────
