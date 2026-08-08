/**
 * Shared client presentation helpers used by CLI, TUI, and tray.
 *
 * Lives outside `cli/` so tray/TUI do not import the CLI package for a
 * three-line label formatter.
 */

/**
 * Short, scannable names for compact surfaces (Run column, tray cards).
 *
 * Prefer the adapter's `shortName`. The clientId argument is only used when a
 * caller has no adapter handle; never hardcode built-in ids here.
 */
export function shortClientName(clientId: string, fullName: string, shortName?: string): string {
  const label = shortName ?? fullName;
  if (label.length > 14) {
    return label.slice(0, 13) + '…';
  }
  // Keep clientId referenced so call sites that only know the id still compile
  // when they pass it as the first argument for logging/debug.
  void clientId;
  return label;
}
