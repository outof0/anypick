/**
 * Proxy process lifecycle ownership.
 *
 * Proxies are spawned as detached child processes so they survive the CLI
 * command that started them. That means nothing in the original process
 * reaps them — they linger across sessions and hold their ports. The lease
 * table records the owning pid; on startup we release leases whose owner is
 * no longer alive and stop the proxy process they reference.
 */

import type { ProxyService } from './proxy-service';
import type { LeaseStore } from './lease-store';
import type { PoolStore } from './pool-store';
import { isProcessRunning } from '../utils/process';

export interface ProxyLifecycleDeps {
  proxy: ProxyService;
  leases: LeaseStore;
  pools?: PoolStore;
}

/**
 * Release leases whose owning process has exited and stop any proxy process
 * they reference. Returns the lease ids that were reaped.
 *
 * Best-effort: individual stop/release failures are swallowed so one dead
 * lease cannot block reaping of the rest.
 */
export async function reapStaleLeases(deps: ProxyLifecycleDeps): Promise<string[]> {
  const reaped: string[] = [];
  const leases = deps.leases.list();

  for (const lease of leases) {
    const ownerAlive =
      typeof lease.ownerPid === 'number' && lease.ownerPid > 0
        ? isProcessRunning(lease.ownerPid)
        : false;
    // v0.8.0 accidentally recorded the proxy child as its own owner. Detect
    // and reap that legacy shape; a child cannot supervise its own lifecycle.
    let legacySelfOwned = false;
    if (ownerAlive) {
      try {
        const status = lease.account
          ? await deps.proxy.proxyStatus(lease.provider, lease.account)
          : await deps.proxy.poolProxyStatus(lease.provider);
        legacySelfOwned = status.pid === lease.ownerPid;
      } catch {
        // Unknown/live owner is safer to preserve.
      }
    }
    if (ownerAlive && !legacySelfOwned) {
      continue;
    }

    // Pool leases have no concrete account; stop the pool process instead.
    if (lease.account) {
      try {
        await deps.proxy.stopProxy(lease.provider, lease.account);
      } catch {
        // proxy already stopped or account missing — proceed to release lease
      }
    } else {
      try {
        await deps.proxy.stopPoolProxy(lease.provider);
      } catch {
        // ignore
      }
    }

    if (deps.leases.release(lease.leaseId)) {
      reaped.push(lease.leaseId);
    }
  }

  return reaped;
}
