import type { GlobalConfig, QuotaGuardPolicy } from '../types';

export const DEFAULT_QUOTA_GUARD_POLICY: QuotaGuardPolicy = {
  enabled: false,
  cooldownMinutes: 60,
};

/**
 * Quota Guard only governs multi-account compatibility proxies. It never
 * changes a native tool login or sends a saved credential anywhere.
 */
export function quotaGuardPolicy(config: GlobalConfig): QuotaGuardPolicy {
  const raw = config.ui?.quotaGuard;
  const cooldownMinutes = raw?.cooldownMinutes;
  return {
    enabled: raw?.enabled === true,
    cooldownMinutes:
      typeof cooldownMinutes === 'number' &&
      Number.isInteger(cooldownMinutes) &&
      cooldownMinutes >= 1 &&
      cooldownMinutes <= 24 * 60
        ? cooldownMinutes
        : DEFAULT_QUOTA_GUARD_POLICY.cooldownMinutes,
  };
}
