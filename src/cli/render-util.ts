/**
 * Shared terminal rendering helpers for launcher + TUI.
 * Visible-length aware (ANSI-stripped) so colored columns align.
 */

import pc from 'picocolors';

export type LayoutWidth = 'wide' | 'medium' | 'narrow';

export function layoutForColumns(cols: number): LayoutWidth {
  if (cols < 50) {
    return 'narrow';
  }
  if (cols < 80) {
    return 'medium';
  }
  return 'wide';
}

export function noColor(): boolean {
  return Boolean(process.env.NO_COLOR) || process.env.FORCE_COLOR === '0';
}

const identity = (s: string) => s;

export function paint(enabled: boolean) {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      green: identity,
      red: identity,
      yellow: identity,
      cyan: identity,
      white: identity,
      inverse: identity,
    };
  }
  return {
    bold: pc.bold,
    dim: pc.dim,
    green: pc.green,
    red: pc.red,
    yellow: pc.yellow,
    cyan: pc.cyan,
    white: pc.white,
    inverse: pc.inverse,
  };
}

export type Paint = ReturnType<typeof paint>;

const ANSI_RE = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g');

export function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

export function padEndVisible(s: string, n: number): string {
  const len = visibleLen(s);
  if (len >= n) {
    return s;
  }
  return s + ' '.repeat(n - len);
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  if (n <= 1) {
    return s.slice(0, n);
  }
  return s.slice(0, n - 1) + '…';
}

export function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && (cwd === home || cwd.startsWith(home + '/'))) {
    return '~' + cwd.slice(home.length);
  }
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length > 3 && cwd.length > 28) {
    return '…/' + parts.slice(-2).join('/');
  }
  return cwd;
}
