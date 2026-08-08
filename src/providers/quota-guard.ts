import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs';

/**
 * Runtime-only policy passed to a compatibility proxy. This is intentionally
 * not an account setting: a pool can be stopped, restarted, or deleted without
 * changing a user's native login.
 */
export interface QuotaGuardOptions {
  enabled: boolean;
  cooldownMs: number;
  /** Saved-account labels in the same order as the proxy credential ring. */
  accountNames?: string[];
  /** Owner-only, secret-free state below the pool runtime directory. */
  statePath?: string;
  providerId?: string;
}

export interface QuotaGuardEvent {
  id: string;
  createdAt: string;
  providerId?: string;
  from: string;
  to?: string;
  cooldownUntil: number;
}

export interface QuotaGuardState {
  version: 1;
  /** Last account that successfully took over. */
  activeAccount?: string;
  cooling: Record<string, number>;
  events: QuotaGuardEvent[];
}

const MAX_EVENTS = 100;

export async function readQuotaGuardState(path: string | undefined): Promise<QuotaGuardState> {
  if (!path || !(await pathExists(path))) {
    return emptyQuotaGuardState();
  }
  try {
    const value = await readJsonFile<unknown>(path);
    return normalizeQuotaGuardState(value);
  } catch {
    // A runtime audit file must never prevent a proxy from serving a request.
    return emptyQuotaGuardState();
  }
}

/**
 * Keeps account cooldowns across proxy restarts. It only accepts saved account
 * names supplied by the pool and never writes credential material.
 */
export class QuotaGuard {
  private state: QuotaGuardState | undefined;
  private write = Promise.resolve();

  constructor(private readonly options: QuotaGuardOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  async ordered<T extends { accountName?: string }>(candidates: readonly T[]): Promise<T[]> {
    if (!this.enabled || candidates.length < 2) {
      return [...candidates];
    }
    const state = await this.load();
    const now = Date.now();
    const eligible = candidates.filter((candidate) => {
      const account = candidate.accountName;
      return !account || (state.cooling[account] ?? 0) <= now;
    });
    if (eligible.length === 0) {
      return [];
    }
    if (!state.activeAccount) {
      return eligible;
    }
    const active = eligible.find((candidate) => candidate.accountName === state.activeAccount);
    return active ? [active, ...eligible.filter((candidate) => candidate !== active)] : eligible;
  }

  async exhausted(
    from: string | undefined,
    to: string | undefined,
    retryAfterMs?: number,
  ): Promise<void> {
    if (!this.enabled || !from) {
      return;
    }
    const cooldownMs = Math.max(1_000, retryAfterMs ?? this.options.cooldownMs);
    const cooldownUntil = Date.now() + cooldownMs;
    await this.mutate((state) => {
      state.cooling[from] = cooldownUntil;
      if (to) {
        state.activeAccount = to;
      }
      state.events.unshift({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        providerId: this.options.providerId,
        from,
        to,
        cooldownUntil,
      });
      state.events = state.events.slice(0, MAX_EVENTS);
    });
  }

  async activate(account: string | undefined): Promise<void> {
    if (!this.enabled || !account) {
      return;
    }
    if ((await this.load()).activeAccount === account) {
      return;
    }
    await this.mutate((state) => {
      state.activeAccount = account;
    });
  }

  private async load(): Promise<QuotaGuardState> {
    if (!this.state) {
      this.state = await readQuotaGuardState(this.options.statePath);
      const now = Date.now();
      this.state.cooling = Object.fromEntries(
        Object.entries(this.state.cooling).filter(([, until]) => until > now),
      );
    }
    return this.state;
  }

  private async mutate(change: (state: QuotaGuardState) => void): Promise<void> {
    await (this.write = this.write.then(async () => {
      const state = await this.load();
      change(state);
      if (this.options.statePath) {
        await writeJsonFile(this.options.statePath, state);
      }
    }));
  }
}

function emptyQuotaGuardState(): QuotaGuardState {
  return { version: 1, cooling: {}, events: [] };
}

function normalizeQuotaGuardState(value: unknown): QuotaGuardState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyQuotaGuardState();
  }
  const record = value as Record<string, unknown>;
  const cooling =
    record.cooling && typeof record.cooling === 'object' && !Array.isArray(record.cooling)
      ? Object.fromEntries(
          Object.entries(record.cooling as Record<string, unknown>).filter(
            ([account, until]) => account.length <= 128 && typeof until === 'number' && until > 0,
          ) as Array<[string, number]>,
        )
      : {};
  const events = Array.isArray(record.events)
    ? record.events.filter(isQuotaGuardEvent).slice(0, MAX_EVENTS)
    : [];
  return {
    version: 1,
    activeAccount: typeof record.activeAccount === 'string' ? record.activeAccount : undefined,
    cooling,
    events,
  };
}

function isQuotaGuardEvent(value: unknown): value is QuotaGuardEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    typeof event.createdAt === 'string' &&
    typeof event.from === 'string' &&
    (event.to === undefined || typeof event.to === 'string') &&
    typeof event.cooldownUntil === 'number'
  );
}
