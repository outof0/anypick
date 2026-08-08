import type { LiveUsage, LiveUsageWindow } from '../types';

export function parseCodexUsage(value: unknown): LiveUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const root = value as Record<string, unknown>;
  const rateLimit = objectValue(root.rate_limit) ?? objectValue(root.rate_limits) ?? root;
  const windows: LiveUsageWindow[] = [];
  for (const [key, label] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ] as const) {
    const window = objectValue(rateLimit[key]);
    const used = numberValue(window?.used_percent);
    if (used == null) {
      continue;
    }
    const resetsAtMs = resetAtMs(window);
    windows.push({
      label: usageLabel(label, window),
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - used))),
      ...(resetsAtMs != null ? { resetsAtMs } : {}),
    });
  }
  return windows.length ? { windows } : null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resetAtMs(window: Record<string, unknown> | undefined): number | undefined {
  const raw = numberValue(window?.reset_at) ?? numberValue(window?.resets_at);
  if (raw != null) {
    return raw < 10_000_000_000 ? raw * 1_000 : raw;
  }
  const afterSeconds = numberValue(window?.reset_after_seconds);
  return afterSeconds != null ? Date.now() + afterSeconds * 1_000 : undefined;
}

function usageLabel(fallback: string, window: Record<string, unknown> | undefined): string {
  const seconds = numberValue(window?.limit_window_seconds);
  if (!seconds) {
    return fallback;
  }
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600}h`;
  }
  return `${Math.round(seconds / 60)}m`;
}
