/**
 * Brand strings and hues, shared by the Ink TUI and the dependency-light CLI
 * bootstrap. Kept free of picocolors/Ink so `--help` stays on the fast path.
 */

export const BRAND_NAME = 'Hotplug';
export const BRAND_TAGLINE = 'Plug any AI into any tool.';

export const BRAND_HUES = {
  violet: '#6A5CFF',
  /**
   * Selection and focus. Electric blue rather than the brand cyan: a terminal's
   * background cannot be detected, and cyan on a light theme is about 1.9:1 —
   * unreadable. This holds ~5:1 on white and ~3.5:1 on the brand navy, so it
   * works without knowing which the user has.
   */
  blue: '#2563FF',
  /** Brand cyan. Safe only where the background is known to be dark. */
  cyan: '#00D4FF',
} as const;

const COLOR_OFF =
  Boolean(process.env.NO_COLOR) || process.env.TERM === 'dumb' || !process.stdout.isTTY;
// Hex hues need 24-bit escapes; below that the closest stock hue is magenta.
const TRUECOLOR = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';

export function brandTint(text: string): string {
  if (COLOR_OFF) {
    return text;
  }
  const open = TRUECOLOR ? '\u001b[38;2;106;92;255m' : '\u001b[35m';
  return `${open}${text}\u001b[39m`;
}
