import type { GlobalConfig } from '../types';
import { CURRENT_SCHEMA_VERSION, DEFAULT_GLOBAL_CONFIG } from '../types';
import { decodeWithFallback, decoders } from './codec';
import type { AnyPickDatabase } from './db';
import { getConfigValue, setConfigValue } from './db';
import { getAnyPickRoot } from './paths';

const GLOBAL_KEY = 'global';

/**
 * SQLite-backed global config store.
 */
export class GlobalConfigStore {
  readonly root: string;
  readonly db: AnyPickDatabase;

  constructor(root: string, db: AnyPickDatabase) {
    this.root = getAnyPickRoot(root);
    this.db = db;
  }

  async read(): Promise<GlobalConfig> {
    const raw = getConfigValue(this.db, GLOBAL_KEY);
    if (!raw) {
      return { ...DEFAULT_GLOBAL_CONFIG };
    }
    const data = decodeWithFallback(
      raw,
      decoders.globalConfig,
      {
        ...DEFAULT_GLOBAL_CONFIG,
      },
      'global',
    );
    return {
      ...DEFAULT_GLOBAL_CONFIG,
      ...data,
      schemaVersion: data.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    };
  }

  async write(config: GlobalConfig): Promise<void> {
    setConfigValue(
      this.db,
      GLOBAL_KEY,
      JSON.stringify({
        ...config,
        schemaVersion: config.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      }),
    );
  }

  async ensure(): Promise<GlobalConfig> {
    const existing = getConfigValue(this.db, GLOBAL_KEY);
    if (!existing) {
      const config = { ...DEFAULT_GLOBAL_CONFIG };
      await this.write(config);
      return config;
    }
    return this.read();
  }
}
