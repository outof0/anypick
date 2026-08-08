/**
 * Scoped mutation locks for hotplug data root (spec §23.3, ADR 0009).
 *
 * Locks are re-entrant *within one async context*. Services own their locking
 * (ADR 0009: correctness must not depend on the caller), which means a service
 * that locks `account/grok/work` is routinely called from an activation already
 * holding that same scope. Without re-entrancy the inner acquisition would spin
 * against its own outer lock and fail with STATE_CONFLICT, so every nested call
 * would have to know whether it was already locked — exactly the
 * caller-supplied-lock design ADR 0009 rejected.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { withFileLock, type WithFileLockOptions } from '../utils/lock';
import { getHotplugRoot } from './paths';

/**
 * Lock file paths held by the current async context. Identity is the resolved
 * path rather than the scope string, because scope sanitization is lossy.
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

const NO_LOCKS: ReadonlySet<string> = new Set<string>();

export function mutationLockPath(root: string, scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9._@/-]+/g, '_').replace(/\//g, '__');
  return join(getHotplugRoot(root), 'locks', `${safe}.lock`);
}

/** Lock paths held by the current async context. Exposed for assertions and tests. */
export function heldMutationLocks(): ReadonlySet<string> {
  return heldLocks.getStore() ?? NO_LOCKS;
}

/** True when the current async context already holds `scope`. */
export function holdsMutationLock(root: string, scope: string): boolean {
  return heldMutationLocks().has(mutationLockPath(root, scope));
}

/**
 * Run a mutation under a scoped exclusive lock.
 * Scopes typically: `client/<id>`, `account/<provider>/<name>`, `db`, `proxy/<provider>/<name>`.
 */
export async function withMutationLock<T>(
  root: string,
  scope: string,
  fn: () => Promise<T>,
  opts?: WithFileLockOptions,
): Promise<T> {
  return withMutationLocks(root, [scope], fn, opts);
}

/**
 * Nested locks for multi-resource mutations (client + source).
 *
 * Scopes are de-duplicated and acquired in sorted order, so two mutations whose
 * scope sets overlap can never deadlock. Scopes already held by this async
 * context are skipped instead of re-acquired.
 */
export async function withMutationLocks<T>(
  root: string,
  scopes: string[],
  fn: () => Promise<T>,
  opts?: WithFileLockOptions,
): Promise<T> {
  const held = heldMutationLocks();

  // Sort by scope for a deterministic global acquisition order, then key by
  // resolved path so two scopes that sanitize to the same file lock once.
  const pending = new Map<string, string>();
  for (const scope of [...new Set(scopes)].toSorted()) {
    const path = mutationLockPath(root, scope);
    if (!held.has(path) && !pending.has(path)) {
      pending.set(path, scope);
    }
  }

  if (pending.size === 0) {
    return fn();
  }

  const nextHeld = new Set(held);
  for (const path of pending.keys()) {
    nextHeld.add(path);
  }

  return acquire([...pending], nextHeld, fn, opts);
}

async function acquire<T>(
  pending: Array<[path: string, scope: string]>,
  held: ReadonlySet<string>,
  fn: () => Promise<T>,
  opts?: WithFileLockOptions,
): Promise<T> {
  const head = pending[0];
  if (!head) {
    // Every scope is held: publish the set so nested service calls re-enter.
    return heldLocks.run(held, fn);
  }
  const [path, scope] = head;
  return withFileLock(path, () => acquire(pending.slice(1), held, fn, opts), {
    resource: scope,
    ...opts,
  });
}
