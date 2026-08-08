/**
 * Low-noise diagnostic logging for internal failures that are best-effort
 * (startup recovery, lease reaping, cleanup). These are intentionally not
 * thrown — the operation is optional — but swallowing them silently hides
 * exactly the partial-state conditions this tool exists to catch, so we log
 * them to stderr behind HOTPLUG_DEBUG instead of discarding them.
 */

function debugEnabled(): boolean {
  return process.env.HOTPLUG_DEBUG === '1' || process.env.HOTPLUG_DEBUG === 'true';
}

/** Log an internal/best-effort failure to stderr (no-op unless HOTPLUG_DEBUG). */
export function logInternalError(label: string, err: unknown): void {
  if (!debugEnabled()) {
    return;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[hotplug:debug] ${label}: ${message}\n`);
}
