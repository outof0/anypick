# ADR-0011: Account mutations lock a re-entrant provider-wide scope (CONC-02)

- Status: accepted (2026-07-26)
- Amends: [ADR-0009](0009-mutation-coordinator.md) (still in force; this record
  adds the scope granularity and re-entrancy it left unspecified)

## Context

ADR-0009 stated that every persisted mutation runs under the coordinator and
that correctness must never depend on the caller locking. `AccountService` did
not honour it: `save`, `use`, `stash`, `refresh`, `delete`, and `importAccount`
mutated snapshots and live credential files with no lock at all. Two concurrent
`hotplug` invocations could interleave `prepareSnapshot` → `provider.backup` →
`writeMeta`, and two saves of the same upstream login could each resolve their
target account before the other committed, producing duplicate accounts for one
identity.

Fixing it exposed two problems ADR-0009 did not answer.

**Granularity.** The obvious scope is one lock per account,
`account/<provider>/<name>`. It is wrong twice over. Every snapshot mutation is
reached through the *single* live credential file the provider owns on disk, so
two activations pointing different clients at different accounts of the same
provider are not independent — per-account locks would let them interleave two
rewrites of that one file. And `save`/`use`/`stash` resolve their target account
*by identity* partway through the operation, so the account to lock is not
knowable before the mutation starts and could not be acquired in a fixed order.

**Re-entrancy.** `activation-executor` acquires its source scope and then calls
`accounts.use()` / `accounts.refresh()`. File locks created with `open(path,
'wx')` are not re-entrant, so a service that locks the scope its caller already
holds spins against its own outer lock until it times out and fails with
`STATE_CONFLICT`. The alternative — having each service ask whether it was
already locked — is exactly the caller-supplied-lock design ADR-0009 rejected.

## Decision

1. **One scope per provider, not per account.** `providerScope(providerId)`
   (`provider/<id>`) covers a provider's live credential file and all of its
   snapshots. `AccountService.save`, `use`, `stash`, `refresh`, `delete`, and
   `importAccount` each acquire it for their whole body, identity resolution
   included (`src/core/refs.ts`, `src/core/service.ts`).
2. **Activation maps its source ref onto the same scope.**
   `mutationScopeForRef` collapses `account` and `account-pool` refs onto
   `providerScope`, so the executor and the nested service call contend for one
   lock *file* rather than two. Gateway and preset refs keep their own scope.
   The journal's `affectedResources` still records the precise
   `serializeRef` identity — that is recovery metadata, not a lock.
3. **Locks are re-entrant within one async context.**
   `mutation-lock.ts` tracks held lock paths in an `AsyncLocalStorage`; a scope
   already held is skipped instead of re-acquired. Identity is the *resolved
   lock path*, not the scope string, because scope sanitization is lossy and two
   scopes may map to one file.
4. **Re-entrancy never widens a claim.** Only scopes actually acquired are
   published as held, so a nested call for an unrelated scope still blocks.

Acquisition stays sorted (ADR-0009), and `provider/*` sorts before `proxy/*`,
which matches the real order: account mutations call into `ProxyService`, never
the reverse. No cycle exists.

## Consequences

- Two concurrent saves of one login converge on a single account instead of
  racing to create duplicates; a save cannot interleave another save's backup.
- An activation holding the provider scope can call account services freely —
  the pre-existing behaviour that made naive locking deadlock.
- Coarser than per-account: two accounts of the *same* provider no longer
  mutate in parallel. This is the point, not a regression — they share one live
  credential file. Different providers still run fully in parallel.
- The re-entrancy is per async context, so it cannot mask a genuine
  cross-process conflict: a second OS process shares no `AsyncLocalStorage` and
  still contends on the lock file.
- `tests/conc-service-locking.test.ts` pins both halves. Disabling re-entrancy
  fails the nested-call tests; removing the service lock fails the
  concurrent-save test.

## Rejected alternatives

- **Per-account locks (`account/<provider>/<name>`).** Cannot be acquired up
  front when the target is resolved by identity mid-operation, and does not
  serialize the shared live credential file.
- **A separate `live/<provider>` scope alongside per-account scopes.** Two
  scopes per operation invites the cycle where `stash` holds `live/` and wants
  `account/` while `use` holds `account/` and wants `live/`. Sorting prevents
  the cycle only if every caller knows its full scope set up front, which
  identity resolution prevents.
- **Passing an "already locked" flag into services.** Makes correctness depend
  on the caller, which ADR-0009 rejected.
- **A single global mutation lock.** Serializes unrelated providers and clients;
  ADR-0009 rejected it for the same reason.
