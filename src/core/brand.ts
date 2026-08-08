/**
 * Brand strings and hues, shared by the Ink TUI and the dependency-light CLI
 * bootstrap. Kept free of picocolors/Ink so `--help` stays on the fast path.
 */

export const BRAND_NAME = 'AnyPick';
export const BRAND_TAGLINE = 'Pick any. Code on.';

export const BRAND_HUES = {
  violet: '#7357FF',
  /**
   * Selection and focus. This is the semantic info color rather than the bright
   * brand signal, which does not have enough contrast on a light terminal.
   */
  blue: '#60A5FA',
  /** Brand signal. Safe only where the background is known to be dark. */
  cyan: '#35D6E8',
} as const;

const COLOR_OFF =
  Boolean(process.env.NO_COLOR) || process.env.TERM === 'dumb' || !process.stdout.isTTY;
// Hex hues need 24-bit escapes; below that the closest stock hue is magenta.
const TRUECOLOR = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';

export function brandTint(text: string): string {
  if (COLOR_OFF) {
    return text;
  }
  const open = TRUECOLOR ? '\u001b[38;2;115;87;255m' : '\u001b[35m';
  return `${open}${text}\u001b[39m`;
}
