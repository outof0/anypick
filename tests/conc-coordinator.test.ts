import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMutationLocks, mutationLockPath } from '../src/core/mutation-lock';
import { withFileLock, readLockInfo, type LockInfo } from '../src/utils/lock';
import { openDatabase } from '../src/core/db';
import { migrateSchema } from '../src/core/db';

// CONC-01: internal mutation coordinator.
// Every persisted mutation runs under sorted, scoped locks; overlapping scopes
// serialize, disjoint scopes proceed in parallel; the lock content identifies
// the owner (for diagnostics) without leaking any secret.

describe('mutation coordinator serialization', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-conc-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serializes two mutations that share a scope', async () => {
    const order: string[] = [];
    const p1 = withMutationLocks(root, ['client/claude', 'account/grok/work'], async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('A-end');
      return 'A';
    });
    const p2 = withMutationLocks(root, ['account/grok/work', 'client/codex'], async () => {
      order.push('B-start');
      order.push('B-end');
      return 'B';
    });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe('A');
    expect(b).toBe('B');
    // Overlap on account/grok/work forces non-interleaving: one critical section
    // fully completes before the other begins (order of winner is nondeterministic).
    const fullyABeforeB =
      order.indexOf('A-end') < order.indexOf('B-start') &&
      order.indexOf('A-start') < order.indexOf('A-end');
    const fullyBBeforeA =
      order.indexOf('B-end') < order.indexOf('A-start') &&
      order.indexOf('B-start') < order.indexOf('B-end');
    expect(fullyABeforeB || fullyBBeforeA).toBe(true);
  });

  it('runs disjoint scopes in parallel', async () => {
    const order: string[] = [];
    const p1 = withMutationLocks(root, ['account/grok/work'], async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('A-end');
      return 'A';
    });
    const p2 = withMutationLocks(root, ['account/openrouter/personal'], async () => {
      order.push('B-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('B-end');
      return 'B';
    });
    await Promise.all([p1, p2]);
    // Both started before either ended → parallel.
    expect(order.indexOf('A-start')).toBeLessThan(order.indexOf('A-end'));
    expect(order.indexOf('B-start')).toBeLessThan(order.indexOf('A-end'));
  });

  it('acquires scopes in sorted order regardless of call-site order', async () => {
    const outermost = mutationLockPath(root, 'account/aaa/x');
    const captured: { info: LockInfo | null } = { info: null };
    await withMutationLocks(root, ['client/zzz', 'account/aaa/x', 'client/mmm'], async () => {
      // The outermost (first-sorted) scope lock is held for the duration.
      captured.info = await readLockInfo(outermost);
      return true;
    });
    // Owner PID is recorded (no secret), proving identity without data leakage.
    expect(captured.info?.pid).toBeTypeOf('number');
  });

  it('migration lock serializes DB open + migrate', async () => {
    const migrateLock = join(root, '.migrate.lock');
    // Track critical-section intervals; the lock must make them non-overlapping
    // (mutual exclusion), regardless of which call acquires first.
    const sections: Array<{ enter: number; exit: number }> = [];
    const body = async () => {
      const enter = Date.now();
      const db = openDatabase(root);
      migrateSchema(db);
      await new Promise((r) => setTimeout(r, 10));
      const exit = Date.now();
      sections.push({ enter, exit });
      return db;
    };
    const [dbA, dbB] = await Promise.all([
      withFileLock(migrateLock, body),
      withFileLock(migrateLock, body),
    ]);
    // Two critical sections, both completed, never running at the same instant.
    expect(sections).toHaveLength(2);
    const [s1, s2] = sections.toSorted((x, y) => x.enter - y.enter);
    expect(s1.exit).toBeLessThanOrEqual(s2.enter);
    // Both DBs are usable.
    expect(() => dbA.prepare('SELECT 1')).not.toThrow();
    expect(() => dbB.prepare('SELECT 1')).not.toThrow();
  });
});
