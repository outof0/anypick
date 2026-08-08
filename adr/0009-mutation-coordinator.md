# ADR-0009: Every persisted mutation runs under the internal coordinator (CONC-01)

- Status: accepted (2026-07-20)
- Task: CONC-01 (put every mutation behind an internal coordinator)

## Context

Hotplug persists to a single `node:sqlite` database plus a handful of owned files
(bindings, profiles, client config, proxy state). Concurrent invocations (two
terminals, the TUI + a CLI, the tray supervisor + a `run`) must not interleave
mutations that touch overlapping resources and corrupt state. Correctness must
not depend on the caller (CLI/TUI/tray) remembering to lock — it belongs to the
services.

This ADR records the coordinator contract that already underpins the codebase
and is now locked by a regression suite (`tests/conc-coordinator.test.ts`):

1. **Sorted, scoped locks.** `withMutationLocks(root, scopes, fn)` de-duplicates
   and sorts scopes (`toSorted`) and acquires them recursively, so any two
   mutations that share a scope serialize while disjoint scopes proceed in
   parallel and deadlocks are impossible (`src/core/mutation-lock.ts`).
2. **Migration lock before open/migrate.** `createAppReady` takes the root
   `.migrate.lock` before `migrateFilesystemIfNeeded` / `migrateBindingsIfNeeded`
   and before any other store work, so a second process cannot migrate a
   half-opened DB (`src/core/app.ts`).
3. **Single owner identity, no secrets.** Lock files record `{pid, startedAt}`
   only; the owner is identifiable for diagnostics (stale-lock detection) without
   exposing any credential.
4. **One mutation path.** CLI, TUI, tray, and the facade all mutate through the
   same services (`app.profiles`, `app.bindings`, `app.proxy`, …); none open the
   DB or raw stores directly for writes.

## Decision

- All persisted mutations acquire scoped coordinator locks via the use cases;
  the call-sites (CLI/TUI/tray/facade) never take locks themselves.
- Overlapping scopes serialize; disjoint scopes run concurrently; scope order is
  always sorted to avoid deadlock.
- The migration lock is taken once, before open/migrate, per process.
- Lock content is limited to `{pid, startedAt}` — no secrets, paths, or payloads.

## Consequences

- Two simultaneous mutations over the same account/profile/client serialize
  without corruption (`tests/conc-coordinator.test.ts`).
- Disjoint mutations run in parallel — no false global serialization.
- A second process opening the same root cannot race the schema/FS migration.
- Stale locks are stealable after the owner PID dies, and the stealer identifies
  itself by PID without leaking data.

## Rejected alternatives

- **Global single big lock around every mutation.** Simple but serializes all
  unrelated work (e.g. editing two unrelated profiles), defeating the point of
  per-resource scopes.
- **Caller-supplied locks.** Moves correctness into every UI surface and forgets
  easily; the coordinator inside the services is the single source of truth.
