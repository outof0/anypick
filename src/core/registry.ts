import type { Provider } from '../types';
import { HotplugError } from '../utils/errors';

/**
 * Shared registry base. The account/client/catalog registries are near-identical
 * `Map` wrappers; this base holds the common register/get/has/list/ids logic so
 * the three concrete registries only supply their item type and error wording.
 */
export interface RegistryConfig {
  /** Noun phrase used in error messages, e.g. "Provider" or "catalog provider". */
  kind: string;
  duplicateCode: string;
  unknownCode: string;
}

export interface RegistryItem {
  readonly id: string;
}

export class Registry<T extends RegistryItem> {
  protected readonly items = new Map<string, T>();
  private sealed = false;

  constructor(protected readonly config: RegistryConfig) {}

  register(item: T): void {
    if (this.sealed) {
      throw new HotplugError(
        `Cannot register ${this.config.kind} after the application has started. Register extensions before createAppReady().`,
        'REGISTRY_SEALED',
      );
    }
    if (this.items.has(item.id)) {
      throw new HotplugError(
        `${this.config.kind} already registered: ${item.id}`,
        this.config.duplicateCode,
      );
    }
    this.items.set(item.id, item);
  }

  get(id: string): T {
    const item = this.items.get(id);
    if (!item) {
      const known = this.ids().join(', ') || '(none)';
      throw new HotplugError(
        `Unknown ${this.config.kind} "${id}". Available: ${known}`,
        this.config.unknownCode,
      );
    }
    return item;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(): T[] {
    return [...this.items.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  ids(): string[] {
    return this.list().map((i) => i.id);
  }

  /** Freeze the composition graph once services begin resolving adapters. */
  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * Capture registrations before untrusted plugin setup. A failed plugin must
   * not leave a half-registered adapter graph behind.
   */
  checkpoint(): readonly string[] {
    return [...this.items.keys()];
  }

  /** Restore a checkpoint while startup registration is still open. */
  restore(checkpoint: readonly string[]): void {
    if (this.sealed) {
      throw new HotplugError(
        `Cannot restore ${this.config.kind} after the application has started.`,
        'REGISTRY_SEALED',
      );
    }
    const allowed = new Set(checkpoint);
    for (const id of this.items.keys()) {
      if (!allowed.has(id)) {
        this.items.delete(id);
      }
    }
  }
}

/**
 * Simple in-memory registry. Providers register at process start.
 * Adding a provider = implement Provider + register() in index.
 */
export class ProviderRegistry extends Registry<Provider> {
  constructor() {
    super({
      kind: 'Provider',
      duplicateCode: 'DUPLICATE_PROVIDER',
      unknownCode: 'UNKNOWN_PROVIDER',
    });
  }
}

/** Shared default registry used by the CLI. */
export const registry = new ProviderRegistry();
