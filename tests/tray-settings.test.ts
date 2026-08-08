import { describe, expect, it } from 'vitest';
import {
  launchSurface,
  quotaGuardPolicy,
  trayPreferences,
  updateLaunchSurface,
  updateQuotaGuardEnabled,
  updateTrayPreference,
} from '../src/tray/settings';
import { DEFAULT_GLOBAL_CONFIG } from '../src/types';

describe('tray settings', () => {
  it('uses safe defaults for existing config records', () => {
    expect(trayPreferences(DEFAULT_GLOBAL_CONFIG)).toEqual({
      launchAtLogin: false,
      startEnabledProxies: true,
      showQuota: true,
      quotaGuardEnabled: false,
    });
  });

  it('keeps Quota Guard opt-in and preserves every unrelated UI preference', () => {
    const config = updateQuotaGuardEnabled(
      {
        ...DEFAULT_GLOBAL_CONFIG,
        ui: { color: false, tray: { showQuota: false } },
      },
      true,
    );
    expect(quotaGuardPolicy(config)).toEqual({ enabled: true, cooldownMinutes: 60 });
    expect(config.ui).toEqual({
      color: false,
      tray: { showQuota: false },
      quotaGuard: { enabled: true },
    });
  });

  it('updates one preference without dropping other global UI config', () => {
    const config = updateTrayPreference(
      {
        ...DEFAULT_GLOBAL_CONFIG,
        ui: { color: false, tray: { showQuota: true } },
      },
      'startEnabledProxies',
      false,
    );
    expect(config.ui).toEqual({
      color: false,
      tray: { showQuota: true, startEnabledProxies: false },
    });
  });

  it('stores the bare-command surface without dropping tray preferences', () => {
    const config = updateLaunchSurface(
      {
        ...DEFAULT_GLOBAL_CONFIG,
        ui: { color: false, tray: { showQuota: true } },
      },
      'tray',
    );
    expect(launchSurface(config)).toBe('tray');
    expect(config.ui).toEqual({
      color: false,
      defaultSurface: 'tray',
      tray: { showQuota: true },
    });
  });
});
