# ADR-0004: Atomic, non-destructive snapshot save (DATA-01)

- Status: accepted (2026-07-20)
- Task: DATA-01 (atomic, non-destructive snapshot save/import)

## Context

`AccountStore.prepareSnapshot` deleted the account's `account_snapshot_files`
rows immediately (before the caller ran `provider.backup`). `service.save`
then ran `provider.backup(snapshotDir)` and only afterwards called `writeMeta`
to re-ingest. If `provider.backup` threw (network, disk, provider bug), the old
snapshot rows were already gone — the previous saved account was destroyed even
though the new save never completed. This violated the DATA-01 invariant: a
failed overwrite must leave the prior snapshot exactly intact.

## Decision

1. **`prepareSnapshot` no longer deletes DB rows.** It only ensures the account
   row exists (for a new account) and clears the on-disk materialize cache. The
   authoritative `account_snapshot_files` rows are left untouched.
2. **`writeMeta` is the single atomic commit point.** Inside one SQLite
   `transaction`, it upserts the account metadata, deletes the old
   `account_snapshot_files` rows, and re-ingests the freshly filled snapshot
   dir. Any throw rolls back the whole transaction, leaving the prior metadata
   and snapshot rows exactly as they were.
3. **Callers fill the snapshot before committing.** `service.save` runs
   `provider.backup` into the prepared dir and only then calls `writeMeta`;
   `service.importAccount` decodes + stages files (SEC-01) then calls
   `writeMeta`. A fault in backup/import happens before any DB mutation.

## Consequences

- A failed backup/import during an overwrite preserves the previous snapshot
  (verified by `tests/snapshot-atomicity.test.ts`).
- The on-disk materialize dir is non-authoritative: it is re-derived from the
  DB rows on the next `getAccount`, so clearing it early in `prepareSnapshot`
  is safe.
- `refreshSavedAccount` (which reuses the existing on-disk snapshot dir and only
  updates metadata) continues to work: `writeMeta` re-ingests the unchanged
  on-disk files within the same transaction.

## Deferred

- Fault injection at *every* sub-phase (describe, per-file read, cache cleanup)
  and concurrent materialize/restore races are broader than this PR's regression
  set; the transaction boundary is the load-bearing guarantee and is covered.
  Deeper concurrency guarantees land in CONC-01 (MutationCoordinator).
