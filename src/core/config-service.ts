/**
 * Service-owned global config mutations (ADR 0009).
 *
 * Call sites must not take `config/global` locks themselves. Every persisted
 * config write goes through this service so CLI/TUI/tray cannot forget the
 * coordinator.
 */
import type { GlobalConfig } from '../types';
import type { GlobalConfigStore } from './config';
import { withMutationLock } from './mutation-lock';

const CONFIG_SCOPE = 'config/global';

export type LaunchSurface = 'tui' | 'tray';

export function launchSurface(config: GlobalConfig): LaunchSurface | undefined {
  return config.ui?.defaultSurface;
}

export function updateLaunchSurface(config: GlobalConfig, surface: LaunchSurface): GlobalConfig {
  return {
    ...config,
    ui: {
      ...config.ui,
      defaultSurface: surface,
    },
  };
}

export function updateQuotaGuardEnabled(config: GlobalConfig, enabled: boolean): GlobalConfig {
  return {
    ...config,
    ui: {
      ...config.ui,
      quotaGuard: {
        ...config.ui?.quotaGuard,
        enabled,
      },
    },
  };
}

export function updateTrayPreference(
  config: GlobalConfig,
  key: 'startEnabledProxies' | 'showQuota',
  enabled: boolean,
): GlobalConfig {
  return {
    ...config,
    ui: {
      ...config.ui,
      tray: {
        ...config.ui?.tray,
        [key]: enabled,
      },
    },
  };
}

export class ConfigService {
  constructor(private readonly store: GlobalConfigStore) {}

  get root(): string {
    return this.store.root;
  }

  /** Underlying store — only for composition/migration that already holds broader locks. */
  get rawStore(): GlobalConfigStore {
    return this.store;
  }

  async read(): Promise<GlobalConfig> {
    return this.store.read();
  }

  /**
   * Bootstrap path used under `.migrate.lock`. Does not take `config/global`
   * because startup already serializes open/migrate.
   */
  async ensure(): Promise<GlobalConfig> {
    return this.store.ensure();
  }

  /** Replace the whole config document under the coordinator. */
  async write(config: GlobalConfig): Promise<void> {
    await withMutationLock(this.store.root, CONFIG_SCOPE, () => this.store.write(config));
  }

  /** Read-modify-write under one lock so concurrent updaters cannot clobber. */
  async update(mutator: (config: GlobalConfig) => GlobalConfig): Promise<GlobalConfig> {
    return withMutationLock(this.store.root, CONFIG_SCOPE, async () => {
      const next = mutator(await this.store.read());
      await this.store.write(next);
      return next;
    });
  }

  async setLaunchSurface(surface: LaunchSurface): Promise<GlobalConfig> {
    return this.update((config) => updateLaunchSurface(config, surface));
  }

  async setQuotaGuardEnabled(enabled: boolean): Promise<GlobalConfig> {
    return this.update((config) => updateQuotaGuardEnabled(config, enabled));
  }

  async setTrayPreference(
    key: 'startEnabledProxies' | 'showQuota',
    enabled: boolean,
  ): Promise<GlobalConfig> {
    return this.update((config) => updateTrayPreference(config, key, enabled));
  }
}
