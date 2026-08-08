/**
 * Listen-port allocation for account-backed and pool proxies.
 *
 * Extracted from `ProxyService`, which had grown to own lifecycle, pools, leases
 * and allocation at once. Allocation is a cohesive unit with a narrow
 * dependency surface — it needs only to enumerate proxy-capable providers and
 * their saved port preferences — so it tests and evolves independently.
 *
 * Two deliberately different behaviours:
 *
 * - An **explicitly requested** port is validated and rejected if taken. Moving
 *   a port the user typed would turn `-p` from an instruction into a suggestion.
 * - An **unspecified** port falls back to the provider default (or the saved
 *   preference) and walks upward past anything already reserved or bound.
 */

import { HotplugError } from '../utils/errors';
import { isListenPortFree } from '../utils/process';
import { providerCanProxy } from './capabilities';
import type { Provider } from '../types';
import type { ProviderRegistry } from './registry';
import type { AccountStore } from './store';

/** Highest valid TCP port. 0 means "let the OS pick" (tests / advanced use). */
const MAX_PORT = 65535;

export function validatePort(port: number): number {
  // 0 = OS ephemeral (tests / advanced); 1–65535 = explicit bind
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new HotplugError(
      `Invalid port ${port}. Use an integer 0–${MAX_PORT} (0 = ephemeral).`,
      'PROXY_PORT_INVALID',
    );
  }
  return port;
}

export interface ResolvePortRequest {
  /** Port the caller asked for explicitly. Validated, never relocated. */
  requested?: number;
  /** Port already saved on this account's proxy config. */
  existing?: number;
  providerId: string;
  accountName: string;
}

/** Enumerates reserved ports and picks free ones. */
export class ProxyPortAllocator {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly store: AccountStore,
  ) {}

  /**
   * Resolve the port a proxy should bind. Honors an explicit request (failing if
   * unavailable) and otherwise finds the nearest free port at or above the
   * provider's preference.
   */
  async resolve(provider: Provider, opts: ResolvePortRequest): Promise<number> {
    if (opts.requested != null) {
      const port = validatePort(opts.requested);
      await this.assertAvailable(port, opts.providerId, opts.accountName);
      return port;
    }
    const preferred =
      opts.existing != null && Number.isInteger(opts.existing)
        ? validatePort(opts.existing)
        : (provider.defaultProxyPort ?? 8080);
    // Prefer saved/default if free; otherwise walk upward
    if (
      preferred === 0 ||
      ((await isListenPortFree(preferred, '127.0.0.1')) &&
        !(await this.collectUsedPorts(opts.providerId, opts.accountName)).has(preferred))
    ) {
      return preferred;
    }
    return this.allocateFrom(preferred + 1, opts.providerId, opts.accountName);
  }

  /** Ports already reserved by other hotplug proxy configs. */
  async collectUsedPorts(excludeProvider?: string, excludeAccount?: string): Promise<Set<number>> {
    const used = new Set<number>();
    for (const p of this.registry.list().filter((x) => providerCanProxy(x))) {
      for (const a of await this.store.listAccounts(p.id)) {
        if (
          excludeProvider &&
          excludeAccount &&
          p.id === excludeProvider &&
          a.meta.name === excludeAccount
        ) {
          continue;
        }
        if (a.proxy.port != null && Number.isInteger(a.proxy.port)) {
          used.add(a.proxy.port);
        }
      }
    }
    return used;
  }

  /** First free port at or above `base`, skipping hotplug-reserved ports. */
  async allocateFrom(base: number, providerId: string, accountName: string): Promise<number> {
    const used = await this.collectUsedPorts(providerId, accountName);
    const start = validatePort(base);
    for (let port = start; port <= MAX_PORT; port++) {
      if (used.has(port)) {
        continue;
      }
      if (await isListenPortFree(port, '127.0.0.1')) {
        return port;
      }
    }
    throw new HotplugError(
      `No free proxy port found starting from ${start}.`,
      'PROXY_PORT_EXHAUSTED',
    );
  }

  /**
   * Throw unless `port` is free, both in hotplug's own config and on the machine.
   * Names the conflicting account when hotplug itself already reserved the port,
   * because "used by codex/work" is actionable where a bare port number is not.
   */
  async assertAvailable(port: number, providerId: string, accountName: string): Promise<void> {
    // Ephemeral port 0 is never "in use" in config terms
    if (port === 0) {
      return;
    }
    const used = await this.collectUsedPorts(providerId, accountName);
    if (used.has(port)) {
      const owners: string[] = [];
      for (const p of this.registry.list().filter((x) => providerCanProxy(x))) {
        for (const a of await this.store.listAccounts(p.id)) {
          if (a.proxy.port === port && !(p.id === providerId && a.meta.name === accountName)) {
            owners.push(`${p.id}/${a.meta.name}`);
          }
        }
      }
      throw new HotplugError(
        `Port ${port} is already used by ${
          owners.join(', ') || 'another account'
        }. Pick another with -p.`,
        'PROXY_PORT_IN_USE',
      );
    }
    // Also refuse ports held by foreign OS processes (other apps / zombie proxies)
    if (!(await isListenPortFree(port, '127.0.0.1'))) {
      throw new HotplugError(
        `Port ${port} is already in use on this machine. Pick another with -p, or stop the process holding it.`,
        'PROXY_PORT_IN_USE',
      );
    }
  }
}
