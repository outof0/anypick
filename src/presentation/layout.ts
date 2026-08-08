/**
 * Shared terminal layout breakpoints for launcher + TUI.
 * Kept outside `cli/` so the TUI does not import CLI rendering just for width.
 */

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
