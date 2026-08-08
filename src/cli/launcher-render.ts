/**
 * Pure renderer for the root command-center launcher (spec §7 rev 2.5).
 * Compact, scannable, no Clack rails.
 */

import {
  SECTION_LABELS,
  SECTION_ORDER,
  type LauncherAction,
  type LauncherModel,
  type LauncherSection,
} from './launcher-model';
import {
  layoutForColumns,
  noColor,
  paint,
  padEndVisible,
  truncate,
  visibleLen,
  type LayoutWidth,
  type Paint,
} from './render-util';
import { MARK } from './ux';

export type { LayoutWidth } from './render-util';
export { layoutForColumns } from './render-util';

const identity = (s: string) => s;

function groupBySection(actions: LauncherAction[]): Map<LauncherSection, LauncherAction[]> {
  const map = new Map<LauncherSection, LauncherAction[]>();
  for (const a of actions) {
    const list = map.get(a.section) ?? [];
    list.push(a);
    map.set(a.section, list);
  }
  return map;
}

export interface RenderFrameOpts {
  cursor: number;
  columns?: number;
  color?: boolean;
  /** When set, show a settled/submit frame instead of interactive chrome. */
  settled?: 'submit' | 'cancel';
}

/**
 * Render a full launcher frame. `cursor` is the index into ordered actions.
 */
export function renderLauncherFrame(model: LauncherModel, opts: RenderFrameOpts): string {
  const cols = Math.max(40, opts.columns ?? process.stdout.columns ?? 80);
  const layout = layoutForColumns(cols);
  const c = paint(opts.color ?? !noColor());
  const ordered = orderedActions(model);
  const focused = ordered[opts.cursor];
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────
  lines.push(renderHeader(model, cols, layout, c));
  if (model.mode === 'degraded') {
    lines.push(` ${c.yellow(model.subtitle)}`);
  } else if (model.mode === 'empty') {
    lines.push(` ${c.dim(model.subtitle)}`);
  } else {
    lines.push(` ${c.dim(model.subtitle)}`);
  }
  lines.push('');

  // ── Body ──────────────────────────────────────────────────────
  const bySection = groupBySection(model.actions);
  let actionIndex = 0;
  let sectionCount = 0;

  for (const section of SECTION_ORDER) {
    const items = bySection.get(section);
    if (!items?.length) {
      continue;
    }
    if (sectionCount > 0) {
      lines.push('');
    }
    sectionCount++;
    lines.push(` ${c.dim(SECTION_LABELS[section].toUpperCase())}`);

    for (const action of items) {
      const selected = actionIndex === opts.cursor && !opts.settled;
      const hotkey = actionIndex < 9 ? String(actionIndex + 1) : ' ';
      lines.push(formatActionRow(action, { selected, layout, cols, c, hotkey }));
      actionIndex++;
    }
  }

  lines.push('');

  // ── Footer (contextual) ───────────────────────────────────────
  if (opts.settled === 'cancel') {
    lines.push(` ${c.dim('quit')}`);
  } else if (opts.settled === 'submit' && focused) {
    lines.push(` ${c.cyan('→')} ${c.dim(focused.preview ?? focused.label)}`);
  } else {
    lines.push(renderFooter(focused, c, layout));
  }

  return lines.join('\n');
}

function renderHeader(model: LauncherModel, cols: number, layout: LayoutWidth, c: Paint): string {
  const brand = c.bold(' anypick');
  if (layout === 'narrow') {
    return brand;
  }
  const right = c.dim(model.cwdShort);
  const gap = Math.max(2, cols - visibleLen(` anypick`) - visibleLen(model.cwdShort) - 1);
  return brand + ' '.repeat(gap) + right;
}

function renderFooter(focused: LauncherAction | undefined, c: Paint, layout: LayoutWidth): string {
  if (layout === 'narrow') {
    if (focused?.preview) {
      return ` ${c.cyan('↵')} ${c.dim(truncate(focused.preview, 26))}  ${c.dim('esc · 1-9')}`;
    }
    return ` ${c.dim('↑↓  ↵  esc  1-9')}`;
  }

  const nav = c.dim('↑↓') + '  ' + c.dim('esc') + '  ' + c.dim('1-9');
  if (!focused?.preview) {
    return ` ${nav}`;
  }
  // Contextual action on the left — the "what enter does" signal
  return ` ${c.cyan('↵')} ${c.dim(focused.preview)}          ${nav}`;
}

function formatActionRow(
  action: LauncherAction,
  opts: {
    selected: boolean;
    layout: LayoutWidth;
    cols: number;
    c: Paint;
    hotkey: string;
  },
): string {
  const { selected, layout, c, hotkey } = opts;
  // Fixed-width marker so rows don't jump
  const marker = selected ? c.cyan(MARK.focus) : ' ';
  const num = c.dim(hotkey);

  if (layout === 'narrow') {
    const label = selected ? c.bold(action.label) : action.label;
    const tail =
      action.section === 'run'
        ? ` ${statusBadge(action, c, true)}`
        : action.detail
          ? c.dim(` ${truncate(action.detail, 16)}`)
          : '';
    return ` ${marker} ${num} ${label}${tail}`;
  }

  const labelW = layout === 'wide' ? 14 : 12;
  const detailW = layout === 'wide' ? 22 : 18;

  if (action.section === 'attention') {
    const lab = padEndVisible(
      (selected ? c.bold : identity)(truncate(action.label, labelW + 6)),
      labelW + 6,
    );
    const reason = c.red(truncate(action.detail ?? '', detailW + 8));
    return ` ${marker} ${num} ${lab}  ${reason}`;
  }

  if (action.section === 'run') {
    const lab = padEndVisible(
      (selected ? c.bold : c.white)(truncate(action.label, labelW)),
      labelW,
    );
    const det = padEndVisible(c.dim(truncate(action.detail ?? '', detailW)), detailW);
    const badge = statusBadge(action, c, false);
    return ` ${marker} ${num} ${lab}  ${det}  ${badge}`;
  }

  // configure / more / get-started / other
  const body = selected ? c.bold(action.label) : action.label;
  return ` ${marker} ${num} ${body}`;
}

function statusBadge(action: LauncherAction, c: Paint, compact: boolean): string {
  if (action.status === 'ready') {
    return compact ? c.green(MARK.live) : c.green(MARK.live) + c.dim(' ready');
  }
  if (action.severity === 'error') {
    return compact ? c.red('!') : c.red(MARK.live) + c.dim(' ' + (action.detail ?? 'error'));
  }
  if (action.status) {
    return c.dim(action.status);
  }
  return '';
}

/** Flat list of action ids in render order (must match cursor indices). */
export function orderedActions(model: LauncherModel): LauncherAction[] {
  const bySection = groupBySection(model.actions);
  const out: LauncherAction[] = [];
  for (const section of SECTION_ORDER) {
    const items = bySection.get(section);
    if (items) {
      out.push(...items);
    }
  }
  return out;
}

export function cursorForActionId(model: LauncherModel, id: string | undefined): number {
  if (!id) {
    return 0;
  }
  const list = orderedActions(model);
  const idx = list.findIndex((a) => a.id === id);
  return idx >= 0 ? idx : 0;
}
