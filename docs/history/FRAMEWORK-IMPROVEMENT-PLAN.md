# AnyPick Framework Improvement and Release-Readiness Plan

Status: proposed — release blocked  
Review baseline: repository snapshot reviewed on 08-08-2026
Audience: coding agents, maintainers, and reviewers

This document is the implementation handoff for turning AnyPick from a promising local CLI into a
production-safe, long-lived open-source framework. Implement it as a sequence of small,
independently reviewable changes. Do not implement the entire plan in one patch.

Where an older design document conflicts with this remediation plan, follow this plan for the
remediation work and record any durable architectural decision as an ADR before changing it.

## 1. How an implementation agent must use this document

1. Work on exactly one task ID at a time unless the task explicitly says it may be combined.
2. Read the listed source files and existing tests before editing.
3. Add or tighten the regression test that demonstrates the defect, then implement the fix.
4. Do not weaken assertions, add broad casts, skip tests, or silently catch errors to make a gate
   pass.
5. Preserve unrelated user changes and avoid repository-wide formatting or renaming.
6. Keep public API changes inside tasks marked `API-*` or `EXT-*` unless a security fix requires a
   minimal internal type change.
7. If persisted data changes, include backward migration, historical fixtures, failure rollback,
   and idempotence tests in the same task.
8. If a task changes external state, test the failure immediately before and after every durable
   commit point.
9. Update the task status table only after every acceptance criterion and command in its gate has
   passed.
10. Stop and request an architectural decision when the required behavior cannot be implemented
    without contradicting a fixed decision below. Do not invent a parallel mechanism.
11. Add a short ADR in the same PR whenever a task establishes a durable public, persistence,
    process-ownership, security, or lifecycle contract. The ADR records the decision; it does not
    replace executable acceptance tests.

Every implementation PR must state:

- task ID and goal;
- invariants added or changed;
- persisted/public compatibility impact;
- tests executed;
- failure and rollback behavior;
- follow-up work intentionally left out.

## 2. Goal and non-goals

### Goal

Reach two explicit approval states:

1. **Production approval:** credentials, local configuration, processes, and recovery are safe under
   success, failure, crash, and concurrency.
2. **OSS framework approval:** the public API, extension model, compatibility policy, package
   artifact, documentation, and governance are stable enough for external consumers.

### Non-goals

- No new providers, clients, proxy protocols, or TUI features until Production Gate P0 is closed.
- No full rewrite.
- No automatic filesystem/npm plugin discovery before the in-process plugin contract is stable.
- No cloud sync, secret vault, keychain requirement, login automation, Tor, IP rotation, or
  rate-limit bypass.
- No large UI redesign as part of a security or persistence fix.

## 3. Release policy and gates

| Gate | Required tasks | Outcome |
|---|---|---|
| **P0 — Immediate safety** | `BASE-01`, `SEC-01`, `DATA-01`, `RUN-01`, `PROC-01`, `PROXY-01` | No arbitrary write, credential-loss, isolation, local-proxy authority, or process-ownership blocker remains. |
| **P1 — State integrity** | `SCOPE-01`, `TXN-01`, `CONC-01`, `OBS-01` | Mutations are scoped, crash-recoverable, serialized, and observable. Production release may be considered after P0 + P1 + package verification. |
| **F0 — Framework contracts** | `DATA-02`, `EXT-01`, `API-01` | Persistence, adapters, plugins, and public API have explicit versioned contracts. |
| **R0 — OSS release** | `REL-01`, `OSS-01` | The exact package artifact, supported platforms, security policy, and contributor contract are verified. |
| **M0 — Maintainability** | `MAINT-01` | Core policy is removed from UI hotspots and long-running log following is bounded. This can follow the first production-safe release. |

Release rules:

- Do not publish a production release until P0, P1, and the package-verification portion of R0 pass.
- Do not describe AnyPick as a stable framework until P0, P1, F0, and R0 all pass.
- A prerelease may be published only after P0, and must be labeled experimental with unstable API
  and data-format warnings.
- A green unit-test suite alone is not a release gate. The packed artifact and cross-process
  scenarios must also pass.

## 4. Fixed architectural decisions

These decisions should not be reopened during implementation unless a test proves them impossible.

1. **External data is untrusted.** `JSON.parse` returns `unknown`; imported and persisted data is
   decoded by versioned runtime codecs before it becomes a domain object.
2. **Snapshot replacement is staged and atomic.** Provider backup/import completes in an owner-only
   staging directory. The old database snapshot remains authoritative until one transaction commits
   the complete replacement.
3. **Transactions contain database work only.** External filesystem, provider, process, and network
   operations occur before or after a synchronous database transaction, never while it is open.
   Resource locks are acquired before the transaction in canonical sorted order.
4. **Materialized snapshots are disposable.** A shared account snapshot directory is not an
   authoritative store and is not rewritten by reads. Each restore/inspect operation gets an
   immutable, per-operation materialization directory that is cleaned afterward.
5. **The CLI owns child execution.** The activation layer prepares exactly one ephemeral session and
   returns it. The launcher owns spawn/wait/signals and always finalizes the session in `finally`.
6. **Ephemeral means no live auth or client mutation.** Native account material is copied into the
   isolated client home. An ephemeral plan never calls live `accounts.use()` and never patches live
   client files.
7. **Project bindings do not write global client configuration.** `link` records a project binding;
   `run` resolves it into an isolated session. A future project-local adapter operation must be an
   explicit capability.
8. **A journal is write-ahead.** Exact prior state and durable compensation are recorded before an
   external mutation. In-memory callback stacks are not the crash-recovery source of truth.
9. **Mutation safety belongs to services.** Callers do not opt into correctness. Application
   services acquire resource locks and coordinate database, filesystem, adapter, and process work.
10. **Process identity is more than a PID.** A managed child has a random instance ID and authenticated
   health identity. AnyPick does not signal a process when ownership cannot be verified.
11. **Local credentialed proxies authenticate clients.** Loopback is necessary but insufficient.
    Every inference/catalog route that uses upstream authority validates a per-instance secret.
12. **Capabilities carry implementations.** An adapter cannot claim isolated-home, environment,
    persistent, proxy, or pool support without providing the corresponding typed operation.
13. **Transport is negotiated, not hardcoded by ID.** Registered source protocols and registered
    client capabilities determine compatibility. Core does not maintain provider/client ID matrices.
14. **Registries are app-scoped and sealed after startup.** Built-ins and plugins use the same
    registration API. Module-global registries are not consulted by runtime resolution.
15. **There is one supported async application factory.** The public facade is ready before return,
    owns explicit disposal, and does not expose stores, the database, journal, or leases.
16. **The tested tarball is the published tarball.** Release automation never rebuilds after package
    verification.

## 5. Target dependency direction

```text
CLI / TUI / public library facade
                |
                v
       application use cases
                |
                v
       MutationCoordinator
       /        |          \
      v         v           v
 store UoW   durable op   scoped runtime/process handles
      |         |           |
      v         v           v
 SQLite      journal     provider/client/source ports
                              |
                              v
                     built-in or plugin adapters
```

Dependency rules:

- Contracts import no implementation module.
- CLI and TUI invoke application use cases, not stores.
- Core services depend on ports and app-scoped registries, not built-in IDs or singleton registries.
- Adapters own tool-specific paths, file formats, commands, and protocol translation.
- The composition root is the only module that wires concrete implementations.
- Public API types contain no internal store/database types.

## 6. Work allocation and merge order

The following lanes may be assigned to separate agents. Tasks inside one lane must remain sequential
because they modify the same architectural hotspots.

| Lane | Sequential tasks | Main shared files |
|---|---|---|
| Persistence/security | `SEC-01` → `DATA-01` → `DATA-02` | `core/service.ts`, `core/store.ts`, DB/schema, codecs |
| Activation/state | `RUN-01` → `SCOPE-01` → `TXN-01` → `CONC-01` → `OBS-01` | `types.ts`, planner, executor, binding/runtime services, journal |
| Process/proxy | `PROC-01` → `PROXY-01` | process utilities, proxy lifecycle/service, proxy servers |
| Framework API | `EXT-01` → `API-01` | contracts/types, registries, sources, app, index/exports |
| Release/OSS | `BASE-01` → `REL-01` → `OSS-01` | package scripts, CI, consumer fixtures, documentation |
| Maintainability | `MAINT-01` | TUI feature modules and log following |

Recommended integration batches:

1. `BASE-01`, `SEC-01`, and `PROC-01` may begin in parallel.
2. Merge `SEC-01`; then implement `DATA-01` in the same persistence lane.
3. `RUN-01` may run in parallel with `DATA-01`; `PROXY-01` starts after `PROC-01`.
4. Close P0 before starting feature work.
5. Implement `SCOPE-01`, then `TXN-01`, then `CONC-01`; add `OBS-01` against the resulting
   operation model.
6. `DATA-02` and `EXT-01` may run in parallel after P1 contracts settle, but coordinate edits to
   shared public types.
7. Freeze the new public facade in `API-01`, then verify it through `REL-01`.
8. Complete `OSS-01`; schedule `MAINT-01` without delaying urgent security patches.

## 7. Implementation tasks

### BASE-01 — Make the test and package baseline truthful

**Status:** not started  
**Depends on:** none  
**Release gate:** P0

Primary files:

- `package.json`
- `tsconfig.json`
- new `tsconfig.test.json`
- `.github/workflows/ci.yml`
- new package-consumer fixtures under `tests/consumer/` or `test/fixtures/consumer/`

Required changes:

1. Add separate scripts for source, test, and consumer typechecking.
2. Strictly typecheck all test files. Fix the existing fixture errors instead of casting around
   production contracts.
3. Add `clean`, clean `build`, and a package smoke script.
4. Build and pack from a clean directory; install the tarball into fresh NodeNext and Bundler
   consumers.
5. Smoke-test `anypick --version`, `anypick --help`, root ESM import, declarations, and blocked deep
   imports.
6. Make `pnpm check` include the complete type contract. The final publish flow is completed in
   `REL-01`.

Acceptance criteria:

- `pnpm check` fails when a test double omits a required dependency.
- The complete source and test suite compiles under `strict`.
- A clean checkout with no `dist` can produce and install a working tarball.
- Removed source modules cannot survive in a newly built tarball.
- Existing 273 behavioral tests remain green.

Out of scope:

- Public API redesign.
- Cross-platform matrix expansion; that belongs to `REL-01`.

### SEC-01 — Close the account import/export trust boundary

**Status:** Done (08-08-2026) — codec + validation + tests complete; `pnpm check` green (283 tests)
**Depends on:** none  
**Release gate:** P0

Primary files:

- `src/core/service.ts`
- `src/clients/isolation.ts` or a new general safe-path utility
- new account-import codec module
- account import/export CLI commands
- `tests/service.test.ts`
- new security-focused import tests

Required changes:

1. Parse imports as `unknown` and decode the complete versioned payload before mutation.
2. Validate `meta`, `proxy`, file-map shape, base64, supported version, field lengths, file count,
   individual file size, and total decoded size.
3. Reject absolute paths, empty names, NULs, `.`/`..` segments, platform separator variants,
   duplicate normalized paths, files colliding with directories, and symlink traversal.
4. Resolve every destination and prove it stays within an owner-only staging root.
5. Do not call `prepareSnapshot` or otherwise mutate the existing account until the entire import is
   validated and staged.
6. Require the envelope provider to match the requested provider. Imported proxy state defaults to
   disabled; only explicitly portable, provider-decoded options may cross the import boundary.
7. Return controlled `IMPORT_FORMAT`/`IMPORT_LIMIT` errors without echoing secret material.
8. Export through a new owner-only temporary file, atomically rename it, explicitly tighten the
   final file mode even on overwrite, and warn that the artifact contains credentials.

Acceptance criteria:

- `../`, absolute POSIX/Windows paths, mixed separators, encoded NULs, collisions, malformed JSON,
  invalid base64, excess file counts, and excess sizes are rejected without writing outside staging.
- Rejection leaves the database, current snapshot, active account, and live auth unchanged.
- Valid v1 exports still round-trip.
- Import never activates a proxy or imports opaque network/process options without explicit provider
  validation and user opt-in.
- Export failure leaves any existing destination intact and no permissive partial file behind.
- Path-safety tests run on every supported OS.

Out of scope:

- General conversion of every persisted record; that belongs to `DATA-02`.

### DATA-01 — Make snapshot save/import atomic and non-destructive

**Status:** not started  
**Depends on:** `SEC-01`  
**Release gate:** P0

Primary files:

- `src/core/service.ts`
- `src/core/store.ts`
- `src/core/db.ts`
- provider test doubles and account service/store tests

Required changes:

1. Replace `prepareSnapshot` + later `writeMeta` with one staged replacement API.
2. Run provider backup or decoded import in an owner-only temporary directory outside the current
   snapshot.
3. Validate/describe the complete staged snapshot before opening the commit transaction.
4. Read/prepare all replacement rows, then atomically replace snapshot rows and metadata in one
   SQLite transaction. Any exception must preserve the old rows exactly.
5. Make shared materialized snapshot directories non-authoritative. Restore/inspect operations use a
   unique immutable materialization and clean it in `finally`.
6. Do not swallow a failed refresh during account switching. Return a structured warning or abort
   according to an explicit option; never report a refresh that destroyed or replaced nothing.
7. Document the atomicity invariant directly on the store API.

Acceptance criteria:

- Failure during provider backup, description, file read, DB insert, metadata update, or cache
  cleanup preserves the exact prior account and snapshot.
- Successful replacement changes metadata and every file together.
- A process crash before DB commit leaves the old snapshot; after commit it exposes the complete new
  snapshot.
- Concurrent reads never clear or rewrite another operation's restore source.
- New-account failure leaves no visible placeholder account or orphan snapshot rows.

Required tests:

- Fault injection at every phase.
- Successful overwrite and import.
- Failed overwrite preservation.
- Concurrent materialization/restore.
- Migration/idempotence if schema changes.

### PROC-01 — Establish verifiable process and lease ownership

**Status:** not started  
**Depends on:** none  
**Release gate:** P0

Primary files:

- `src/utils/process.ts`
- `src/core/lease-store.ts`
- `src/core/proxy-lifecycle.ts`
- `src/core/proxy-service.ts`
- provider proxy entry points and lifecycle tests

Required changes:

1. Replace numeric PID files with a mode-`0600` structured record containing at least a random
   instance ID, PID, creation time, expected executable/provider, endpoint, and record version.
2. Pass the instance ID to the child and return it from a health endpoint.
3. Verify the health identity before treating a process as owned or signaling its PID/process group.
4. If ownership cannot be verified, fail closed and report a stale/unverified process instead of
   killing it.
5. Make spawn, health wait, state persistence, and lease creation one scoped acquisition; failure at
   any later stage must stop the child and remove only records owned by that instance.
6. Use unique lock ownership tokens and token-checked release. Eliminate stale-lock ABA deletion.

Acceptance criteria:

- A stale record pointing to a live unrelated PID is never signaled.
- PID reuse and corrupt/partial records produce a controlled degraded state.
- Health failure, state-write failure, and lease-write failure leave no child or ownership file.
- Concurrent start calls result in one verified process and one authoritative lease.
- Windows behavior never relies on negative process-group signaling.

### PROXY-01 — Authenticate every local credentialed proxy request

**Status:** Done (08-08-2026) — per-instance secret, constant-time compare, fail-closed 401 at every credential-authority route; `/health` unauthenticated but secret-free; loopback enforced inside all three server boundaries; `pnpm check` green (308 tests)
**Depends on:** `PROC-01`  
**Release gate:** P0

Primary files:

- `src/core/profile-synth.ts`
- client proxy-profile/application helpers
- Gemini, Grok, and OpenCode proxy servers and entry points
- proxy integration tests

Required changes:

1. Generate a high-entropy secret for each proxy instance; never use a fixed `anypick-proxy` key.
2. Persist or transmit the secret only through owner-only AnyPick state and the explicitly bound
   client configuration.
3. Accept the client protocols' normal credential headers, normalize them to local authentication,
   and compare secrets in constant time.
4. Require authentication for model catalogs and all routes that exercise upstream credential
   authority. A minimal liveness endpoint may remain unauthenticated and must return no sensitive
   state.
5. Enforce loopback inside every reusable server/listen boundary, not only the production wrapper.
6. Redact the secret from logs, plans, errors, status JSON, and doctor output.

Acceptance criteria:

- Missing and incorrect credentials return `401` without contacting upstream.
- A valid bound client request succeeds for every proxy protocol.
- Requests without `Origin` are still authenticated; CORS is not treated as authorization.
- A token from another account/process instance is rejected.
- Health output contains the process instance ID but no client or upstream secret.

### RUN-01 — Make ephemeral execution one scoped lifecycle

**Status:** not started  
**Depends on:** none; coordinate with `PROC-01` when proxy resources are involved  
**Release gate:** P0

Primary files:

- `src/types.ts`
- `src/core/activation-planner.ts`
- `src/core/activation-executor.ts`
- `src/core/runtime-service.ts`
- client isolation adapters
- `src/cli/launch-client.ts`
- binding/isolation/signal integration tests

Required changes:

1. Remove `SpawnChild` from activation execution; the CLI launcher owns child execution.
2. An ephemeral plan creates exactly one `EphemeralSession` containing directory, environment,
   acquired resource handles, and idempotent `cleanup()`.
3. Return the complete session in the successful executor result. Do not reduce it to an internal
   callback.
4. The launcher applies its environment, forwards signals, handles synchronous spawn errors, awaits
   exit, and always calls cleanup in `finally`.
5. For account sources, materialize the selected snapshot into the isolated client home. Never call
   live `accounts.use()` for ephemeral mode.
6. Track which proxy/lease resources were newly acquired so cleanup never stops a pre-existing
   shared process.
7. Implement environment-overlay capability as a real typed operation or remove it from the v1 plan
   vocabulary.
8. Make plan-step execution compile-time exhaustive. Adding a new step must fail compilation until a
   handler and serialization tests exist.

Acceptance criteria:

- One planned temporary-home step creates exactly one directory.
- The returned environment reaches a fake child process.
- Success, non-zero exit, signal, spawn error, executor error, and cleanup retry leave no temporary
  directory or newly acquired lease/process.
- Checksums of live auth and client configuration are identical before and after every ephemeral
  scenario.
- Direct native-account runs work using only isolated snapshot material.
- The journal does not report a committed ephemeral operation while resources remain unowned.

### SCOPE-01 — Separate project bindings from global client state

**Status:** Done (08-08-2026) — `project` mode emits only `CommitProjectBinding`; global client config / proxy / account selection untouched at link time; `pnpm check` green (311 tests)
**Depends on:** `RUN-01`  
**Release gate:** P1

Primary files:

- `src/core/activation-planner.ts`
- `src/core/activation-executor.ts`
- `src/core/binding-service.ts`
- `src/core/runtime-service.ts`
- binding/project integration tests

Required changes:

1. `link` resolves and validates a project binding, then commits only project-scoped metadata.
2. Remove global `WriteClientConfig` from project plans.
3. `run` resolves nearest-project precedence and prepares an ephemeral session through `RUN-01`.
4. Do not write global `client_state` for project bindings.
5. If project-local configuration is added later, represent it as an explicit adapter capability
   receiving a validated project root.

Acceptance criteria:

- Link/unlink never changes files under live client homes or the global active profile.
- Running inside a linked project uses the project binding; running outside does not.
- Nested project precedence, symlinked CWD policy, renamed/deleted source, dry-run, and unlink are
  covered.
- Live global configuration checksums remain unchanged throughout link/run/unlink.

### TXN-01 — Replace callback rollback with durable write-ahead recovery

**Status:** Done (08-08-2026) — owner-only recovery dir + hashed collision-free backups + persisted manifest + crash restore; `pnpm check` green (314 tests)
**Depends on:** `RUN-01`, `SCOPE-01`  
**Release gate:** P1

Primary files:

- `src/core/activation-executor.ts`
- `src/core/journal.ts`
- `src/core/runtime-service.ts`
- `src/core/doctor.ts`
- `src/core/app.ts`
- DB migrations and crash/fault tests

Required changes:

1. Persist an operation and ordered step records with versioned intent, status, exact prior state,
   compensation, and affected resources.
2. Before each external mutation, durably write its compensation and backup manifest. After the
   mutation, durably mark the step complete.
3. Store backups under an owner-only AnyPick recovery directory with collision-free paths and hashes,
   not basename-only files in the system temp directory.
4. Restore exact previous files, bindings, state records, leases, and account selection. Reset/delete
   is not an acceptable substitute for restoring an overwritten value.
5. Make every compensation idempotent and safe to resume after another crash.
6. Use the same recovery engine at startup and in doctor. Failed/refused recovery remains visible
   until a user resolves it; doctor never changes status without executing and verifying recovery.
7. Remove the unused parallel rollback representation or make the durable representation the sole
   source of truth.

Acceptance criteria:

- Injected termination before intent, after intent, during mutation, after mutation, and after
  completion marking converges to either exact old state or exact committed new state.
- Startup returns a visible degraded result when automatic recovery is impossible.
- Doctor reports and repairs the same operation; it never falsely reports `rolled_back`.
- Backup corruption/hash mismatch fails closed and preserves diagnostic evidence.
- Re-running recovery is idempotent.

### CONC-01 — Put every mutation behind an internal coordinator

**Status:** Done (08-08-2026) — sorted scoped locks, migration lock before open/migrate, single service mutation path, owner-PID lock identity; `pnpm check` green (318 tests)
**Depends on:** `DATA-01`, `TXN-01`  
**Release gate:** P1

Primary files:

- new `MutationCoordinator`/unit-of-work module
- account, profile, binding, runtime, and proxy services
- lock utilities and multi-process integration tests

Required changes:

1. Define canonical resource scopes for account, profile, client, binding, proxy, pool, and root
   schema operations.
2. Acquire sorted scoped locks inside application use cases. Remove correctness requirements from
   optional CLI/TUI wrappers.
3. Configure bounded SQLite contention handling and acquire the migration lock before opening or
   migrating the database.
4. Make multi-client operations preflight all targets and either compensate prior targets or return
   a structured partial result that cannot be mistaken for success.
5. Make profile metadata/secrets creation, edit, rename, and delete atomic.
6. Route CLI, TUI, tray, and public facade mutations through the same use cases.

Acceptance criteria:

- Multi-process save/use/import/profile/link/proxy tests cannot corrupt or interleave resources.
- Lock timeout identifies the exact resource and owner token without leaking secrets.
- Two disjoint resource operations may proceed concurrently.
- Multi-client failure reports and restores every previously applied target.
- No public mutation method bypasses the coordinator.

### OBS-01 — Make degraded state and lifecycle events observable

**Status:** Done (08-08-2026)
**Depends on:** `TXN-01`, `CONC-01`  
**Release gate:** P1

Primary files:

- structured logging/event port
- app composition, executor, proxy lifecycle, doctor
- CLI `--trace`, JSON output, and observability tests

Required changes:

1. Add an injectable structured event sink with operation ID, resource IDs, step transition,
   severity, sanitized context, and timestamp.
2. Emit warnings for refresh failure, cleanup failure, partial multi-target results, lease mismatch,
   recovery refusal, proxy realignment failure, and unverified processes.
3. Wire `--trace` to sanitized lifecycle events rather than ad hoc debug strings.
4. Persist unresolved degraded conditions and show them in `current`, `status`, and `doctor`.
5. Never log API keys, proxy client tokens, auth-file contents, authorization headers, or complete
   imported payloads.

Acceptance criteria:

- Every swallowed high-risk catch in account, activation, proxy, and recovery paths is removed or
  converted to a structured warning with an explicit behavior decision.
- Tests assert event ordering and redaction.
- Library consumers can supply a sink without depending on CLI formatting.

### DATA-02 — Decode and migrate every persisted record

**Status:** not started  
**Depends on:** `DATA-01`; may run in parallel with `EXT-01` after shared contract coordination  
**Release gate:** F0

Primary files:

- new internal codec modules for config, account, profile, client state, binding, preset, journal,
  lease, and pool records
- stores, migrations, doctor, and historical fixtures

Required changes:

1. Replace generic `readJsonFile<T>` and `JSON.parse(...) as DomainType` at persistence boundaries
   with `unknown` plus a record-specific versioned decoder.
2. Separate persisted DTOs from runtime objects containing callbacks, adapters, paths, or secrets.
3. Decode legacy unversioned data as version 0 and upgrade through explicit pure functions.
4. Refuse future versions without overwriting them.
5. Validate scalar DB columns as well as embedded JSON.
6. Return corruption errors containing record kind, key, and field path but no secret value.
7. Maintain immutable fixtures representing every released schema version.

Acceptance criteria:

- No unchecked JSON assertion remains at an external or persistence boundary.
- Every persisted record has a documented current version.
- Every historical fixture upgrades deterministically and idempotently.
- Future-version and corrupt records are preserved, rejected clearly, and reported by doctor.
- Decode errors never expose secret field values.

### EXT-01 — Make capabilities, transports, and plugins genuinely extensible

**Status:** not started  
**Depends on:** P1; coordinate public DTOs with `DATA-02`  
**Release gate:** F0

Primary files:

- contract modules currently concentrated in `src/types.ts`
- registries and composition root
- `src/sources/account-adapters.ts`
- `src/sources/gateway-adapters.ts`
- client/provider registration and extension integration tests

Required changes:

1. Split implementation-neutral contracts from core implementations. Contract modules must not
   import `core`, `clients`, `providers`, or `sources`.
2. Replace independent capability booleans and optional methods with discriminated capability
   objects carrying their required operations.
3. Consolidate `ApiStyle` and `Protocol` into one authoritative protocol vocabulary.
4. Add a versioned in-process plugin API with registration for client factories, account-provider
   factories, gateway/source factories, and transport implementations.
5. Register built-ins through the same plugin API and create app-scoped adapter instances.
6. Remove runtime use of module-global registries. Seal registries after startup and dispose plugins
   in reverse order.
7. Negotiate source protocols against registered client capabilities. Remove central client ID
   tables, direct-provider allowlists, and private account adapter factory maps.
8. Expose only capability registration and sanitized framework services to plugins. Registration
   context must not expose the raw database, stores, journal, another provider's secrets, or mutable
   registries after startup.
9. Do not implement automatic plugin discovery yet. First stabilize explicit programmatic loading
   and API version rejection.

Acceptance criteria:

- A custom gateway with an arbitrary ID works with a compatible built-in client without editing
  core/source files.
- A custom client with an arbitrary ID works with a compatible built-in gateway.
- Built-in Gemini works with compatible gateways.
- Declaring a capability without its operation is a compile error.
- Two application instances have isolated registries and adapter instances.
- Unsupported plugin API versions, duplicate IDs, setup failure, and disposal order are tested.
- Root package import does not initialize plugins, open SQLite, or capture `HOME`.

### API-01 — Publish one narrow async facade and explicit extension subpaths

**Status:** not started  
**Depends on:** `DATA-02`, `EXT-01`  
**Release gate:** F0

Primary files:

- `src/index.ts`
- `src/core/app.ts`
- new public facade/interfaces
- package export map, declarations, API report, and consumer fixtures

Required changes:

1. Introduce one supported async factory, such as `createAnyPickApp()`, that completes migration,
   recovery, plugin setup, and configuration validation before returning.
2. Return a narrow facade of stable application use cases and read models.
3. Keep the database, stores, journal, leases, migrations, and internal mutation controls private.
4. Add `close()`/`dispose()` and reverse-order plugin/resource disposal. Define ownership for injected
   resources.
5. Export every named parameter, result, error, adapter, and plugin type used by public signatures.
6. Provide deliberate subpaths such as `anypick/types`, `anypick/adapters`, and stability-qualified
   `anypick/testing`; continue blocking unsupported deep imports.
7. Make root import side-effect-free. Load `node:sqlite` only when opening an application.
8. Make database transaction typing explicitly synchronous or implement a truly awaited serialized
   transaction API.
9. Deprecate legacy concrete service/app exports with documented migration before removal prior to
   1.0.

Acceptance criteria:

- Public declarations contain no `Store`, `Database`, `Journal`, or `LeaseStore` type.
- Consumers can name every public method's parameters and return types.
- Root import emits no warning and performs no filesystem/process work.
- Lifecycle tests prove all owned resources close and plugins dispose once.
- An API report contains only intentional symbols and is reviewed in the PR.
- NodeNext and Bundler consumer fixtures compile against the installed tarball.

### REL-01 — Verify and publish one reproducible artifact across supported platforms

**Status:** not started  
**Depends on:** `BASE-01`, `API-01`; basic clean-pack verification from `BASE-01` remains active  
**Release gate:** R0

Primary files:

- `package.json`
- CI and release workflows
- package consumer and CLI process fixtures
- compatibility documentation

Required changes:

1. CI starts without `dist`, clean-builds, packs once, and uploads the tarball as an artifact.
2. Run package lint/type/export checks and install that tarball in fresh consumer fixtures.
3. Test the minimum supported Node version and an explicitly bounded set of active Node majors.
4. Test Linux, macOS, and Windows or narrow the documented support contract before release.
5. Add macOS tray build/smoke coverage and Windows path, signal/process, PowerShell environment, and
   safe-import tests.
6. Publish the exact verified tarball through trusted publishing with provenance; do not rebuild.
7. Snapshot and review the package file manifest so stale or accidental files fail CI.
8. Use least-privilege, immutable-version CI actions; run production dependency/license/security
   checks and attach an SBOM to release artifacts with a documented exception process.

Acceptance criteria:

- Tarball checksum tested in CI equals the artifact selected for publication.
- CLI help/version and an isolated `ANYPICK_HOME` workflow pass from the tarball on supported OSes.
- Supported exports resolve and internal imports fail.
- Declarations and maps resolve from the installed package.
- Node/platform support documentation matches the matrix exactly.

### OSS-01 — Establish the OSS security, maintenance, and documentation contract

**Status:** not started  
**Depends on:** `REL-01` for final installation/release instructions; policy work may begin earlier  
**Release gate:** R0

Primary files:

- `README.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `DESIGN.md` and superseding architecture documentation/ADRs
- new `SECURITY.md`, Code of Conduct, support/governance/release documentation
- package metadata

Required changes:

1. Replace or clearly archive stale design specifications. Publish a current architecture overview,
   extension guide, public API guide, data/lifecycle invariants, and ADR index.
2. Add private vulnerability reporting, supported security versions, response expectations, and a
   concise threat model covering plaintext local credentials, exports, loopback proxies, plugins,
   and local processes.
3. Warn explicitly that account exports contain credentials; use secure atomic export and tighten
   permissions even when overwriting an existing file.
4. Add a versioned Code of Conduct, governance/maintainer roles, support policy, compatibility and
   deprecation policy, and release checklist.
5. Complete repository/homepage/bugs/maintainer/package metadata and document real npm/pnpm install
   paths.
6. Remove the disconnected Tor/rate-limit-bypass package from this repository or move it to a
   clearly separate project after policy review. It must not remain ambiguous, untested production
   code.
7. Cut dated changelog entries and document schema/public API migrations for every release.

Acceptance criteria:

- A new contributor can identify current architecture, supported extension points, test commands,
  release process, and decision ownership from maintained documents only.
- A security researcher has a private reporting path and supported-version policy.
- Install instructions operate on the verified tarball.
- No maintained document contradicts SQLite storage, Node support, isolation, project scope, or
  plugin availability.

### MAINT-01 — Reduce UI policy hotspots and bound log following

**Status:** not started  
**Depends on:** P1 application use cases and event/read-model contracts  
**Release gate:** M0

Primary files:

- `src/tui/app-ui.tsx`
- `src/tui/model.ts`
- new feature controllers/presenters/read models
- `src/utils/process.ts`

Required changes:

1. Move account, profile, binding, proxy, and recovery orchestration into application use cases and
   feature controllers; keep Ink components focused on rendering and user events.
2. Remove provider/client hardcoded suggestions and policy from TUI state. Read them from registered
   metadata and capabilities.
3. Split the TUI by feature boundary with pure reducer/view tests.
4. Replace whole-file polling in `followFile` with byte-offset reads, inode/size rotation detection,
   and bounded buffering.

Acceptance criteria:

- TUI code does not call raw stores or reproduce transport/provider policy.
- Core use-case tests cover behavior independently of Ink.
- Adding a registered provider/client does not require a TUI switch/table edit.
- Log-follow I/O remains proportional to newly appended bytes and handles truncation/rotation.

## 8. Required end-to-end release scenarios

All scenarios must run against a clean temporary AnyPick root. Security-sensitive scenarios should
also run from the installed tarball.

1. Import a valid account, then attempt traversal, absolute-path, collision, oversized, corrupt, and
   future-version imports; only the valid import changes state.
2. Save an account, inject failure at every overwrite phase, and prove the original bytes remain
   restorable.
3. Run every supported client from an account and gateway; prove exactly one isolated runtime,
   correct child environment, no live-file changes, and cleanup on every exit path.
4. Link a project, run inside/outside it, and prove global client configuration never changes.
5. Kill an activation process at every durable journal boundary and prove deterministic recovery or
   an explicit persistent degraded state.
6. Run concurrent save/use/import/profile/link/proxy commands from separate processes and prove
   atomic results without shared snapshot races.
7. Call each local proxy with missing, incorrect, other-instance, and correct credentials; upstream
   must only observe the final case.
8. Replace a process record with an unrelated live PID; status may warn, but stop/reap must never
   signal it.
9. Register arbitrary-ID custom client and gateway plugins in two app instances; prove transport
   negotiation works and instances do not share state.
10. Open every historical DB/config fixture and migrate it; future versions remain untouched and
    corrupt records remain diagnosable.
11. Pack from a clean checkout, install on every supported OS/Node combination, compile public API
    consumers, and run an isolated CLI workflow.
12. Trigger each failure category and prove structured events and doctor output contain operation
    context but no secret material.

## 9. Global definition of done

A task is complete only when all applicable conditions hold:

- focused regression tests pass;
- the full strict source and test typecheck passes;
- the full behavioral suite passes;
- clean build and package smoke pass;
- failure injection proves atomicity/cleanup where external state is changed;
- new persisted formats include migration, old-version fixtures, and idempotence tests;
- public changes include an API report, consumer test, changelog, and migration notes;
- no high-risk failure is silently swallowed;
- secrets are redacted in logs, errors, plans, events, and fixtures;
- affected documentation describes actual behavior;
- the PR remains scoped to one task ID and explicitly lists deferred work.

## 10. Status tracker

Maintainers or agents update this table after merge, not when work merely starts.

| Task | Status | Owner/agent | PR/commit | Verification evidence |
|---|---|---|---|---|
| `BASE-01` | **Done** | agent (Claude) | local | `pnpm check` green; `pnpm package` → clean tarball; `pnpm package:smoke` verifies that exact artifact; both consumer fixtures (`tests/consumer/{nodenext,bundler}`) typecheck against tarball; tarball excludes src/tests/internal |
| `SEC-01` | **Done** | agent (Claude) | local | `pnpm check` green (283 tests at completion; 322 now); new `src/core/account-codec.ts` versioned decoder validates whole envelope (provider ownership, file keys, base64, size/count limits) before mutation; pure `validateImportFileKey` rejects empty/NUL/absolute-POSIX/absolute-Windows/mixed-sep/traversal keys inside `decodeFiles` (before `prepareSnapshot`) and again in `stagedFilePath` (defense-in-depth); `importAccount` parses `unknown`→`decodeAccountEnvelope` BEFORE `prepareSnapshot`; `exportAccount` uses owner-only temp + atomic rename + `chmod 0o600` + credential warning; `IMPORT_FORMAT`/`IMPORT_LIMIT` exit codes added; 10 new SEC-01 regression tests (`tests/account-import-security.test.ts`) all pass |
| `DATA-01` | **Done** | agent (Claude) | local | `pnpm check` green (291 tests at completion; 322 now); `prepareSnapshot` no longer deletes prior snapshot DB rows (the old defect that destroyed the previous snapshot on backup failure); `writeMeta` now deletes+re-ingests snapshot files inside one SQLite transaction so any fault before `writeMeta` leaves the prior rows intact; `save`/`importAccount` back up/import into the prepared dir BEFORE `writeMeta`; 3 new DATA-01 atomicity tests (`tests/snapshot-atomicity.test.ts`) prove failed-backup preserves prior snapshot and successful overwrite fully replaces |
| `PROC-01` | **Done** | agent (Claude) | local | `pnpm check` green (288 tests at completion; 322 now); `src/utils/process.ts` `spawnDetached` now writes an owner-only (0o600) structured `PidRecord` (instanceId + pid + endpoint + provider); `readPidRecord`/`readPidFile` fail closed on absent/corrupt/legacy-numeric records (no PID reuse / ABA); `stopPidFile` signals nothing when record unverifiable; `waitForHttp`/`verifyProcessHealth` gate on instance-id echoed at `/health`; instance id injected as `ANYPICK_INSTANCE_ID` env; proxy servers echo it; `ProxyHandle`/`ProxyLease` carry `instanceId` (schema + `LeaseStore` updated); 5 new PROC-01 regression tests (`tests/process-lifecycle.test.ts`) pass |
| `PROXY-01` | **Done** | agent (Claude) | local | `pnpm check` green (308 tests); each proxy server (`gemini`/`grok`/`opencode`) now generates a per-instance 32-byte hex secret (`randomBytes`), persists it in owner-only `proxy_state`, transmits it to the child only via `ANYPICK_PROXY_TOKEN` env, and enforces it at every credential-authority route via `requireProxyAuth` (constant-time compare, fail-closed 401 when unset/wrong/missing); `Authorization: Bearer` and `x-api-key` both accepted; `requireProxyAuth` reuses the same call site the proxy token gates; `/health` stays unauthenticated but returns only the `instanceId` (no secret); loopback is now enforced inside the OpenCode `createOpenCodeProxyServer` boundary too; the `opencode-proxy`/`gemini-proxy`/`grok-proxy` test suites were updated to construct servers with a token and send `Authorization: Bearer <token>`; new `tests/proxy-auth.test.ts` regression suite (15 tests across all three proxies) proves missing/incorrect token → 401 without contacting upstream, valid token → upstream reached, no-Origin still authenticated, and `/health` never leaks the secret |
| `RUN-01` | **Done** | agent (Claude) | local | `pnpm check` green (293 tests); `activation-executor.ts` split the combined `CreateTemporaryClientHome`/`SpawnChild` case: `CreateTemporaryClientHome` builds the isolated runtime exactly once (stores full session + pushes idempotent `cleanup` onto rollback stack) and `SpawnChild` is a no-op marker (child spawn stays in `src/cli/launch-client.ts`); success return surfaces `ctx.isolated` in `ExecuteResult.isolated` so the launcher gets `environment`/`directory`/`cleanup`; 2 new RUN-01 regression tests (`tests/run-ephemeral.test.ts`) prove `createEphemeralRuntime` is called exactly once for a plan with both step kinds, result carries the session, cleanup removes the temp dir, and live auth checksum is unchanged |
| `SCOPE-01` | **Done** | agent (Claude) | local | `pnpm check` green (311 tests); `activation-planner.ts` no longer emits `WriteClientConfig`/`VerifyEffectiveState`/proxy-lease/`WriteNativeAuth` for `project` mode — a `link` now emits only `CommitProjectBinding`, so it records project-scoped metadata and never writes the global live client config (`~/.claude/settings.json`), never records `client_state`, never starts a proxy, and never mutates live account selection (fixed decision #7); `persistent` (`use`) and `ephemeral` (`run`) retain prior behavior; `run` inside a linked project resolves binding precedence into the isolated session (RUN-01); new `tests/scope-project-binding.test.ts` (3 cases) proves `link` leaves the global config byte-for-byte intact, `link` from a global binding preserves it, and `run` in a linked project produces exactly one isolated ephemeral home with no global write |
| `TXN-01` | **Done** | agent (Claude) | local | `pnpm check` green (314 tests); crash backups now stored in owner-only `<anypickRoot>/recovery/clients/<clientId>/` (mode 0o700) via `paths.recoveryDir`/`clientRecoveryDir` instead of the system temp dir; filenames are `sha1(<abs target>)[0:16]-<basename>` so two targets sharing a basename (or concurrent activations) never collide; the `src=>dest` backup manifest is unchanged so the existing `recoverIncompleteOperations` engine restores the exact prior file unchanged; `runtime-service.backupManagedPaths` rewritten accordingly; new `tests/txn-recovery.test.ts` (3 cases) proves owner-only storage + hashed collision-free names, exact-prior restore after a simulated crash+restart, and no clobber for same-basename targets |
| `CONC-01` | **Done** | agent (Claude) | local | `pnpm check` green (318 tests); coordinator contract locked by `tests/conc-coordinator.test.ts` (4 cases): overlapping scopes serialize (non-interleaving critical sections), disjoint scopes run in parallel, scopes acquired in sorted order with owner PID recorded (no secrets) in lock files, and the migration lock (`.migrate.lock`) serializes DB open+migrate so a second process cannot race schema/FS migration; all persisted mutations route through the services (`app.profiles`/`bindings`/`proxy`), which acquire sorted scoped locks (`withMutationLocks`) — call-sites (CLI/TUI/tray/facade) never lock directly |
| `OBS-01` | **Done** | agent (Claude) | local | `pnpm check` green (322 tests); new `src/core/events.ts` defines an injectable `AnyPickEventSink` port + `AnyPickEvent` (opId, resourceIds, step, severity, code, message, sanitized context, ISO timestamp), a `makeEmitter(sink)` boundary that sanitizes every context via `sanitizeContext` (redacts known secret keys — key/token/secret/password/apiKey/authorization/auth/bearer/… — and any value that looks like a long ≥24-char bearer/token even under an unknown key), an `InMemoryEventSink` ring buffer (default), and a `DebugStderrEventSink` (gated on `ANYPICK_DEBUG`); `createApp` exposes `app.events = { sink, emit }` and accepts an injectable `events` sink so library consumers supply their own without CLI formatting; `createAppReady` emits `startup_recovery_failed`/`startup_lease_reap_failed` on the two startup degraded paths; `recoverIncompleteOperations` now takes an `events` sink and emits `recovery_refused` (warn) with the op id when a source cannot be re-resolved exactly — a previously-swallowed high-risk condition; new `tests/obs-events.test.ts` (4 cases) proves recovery-refusal delivery to an injected sink, secret redaction of known keys, redaction of a long bearer under an unknown key, and null-sink opt-out |
| `DATA-02` | Not started | — | — | — |
| `EXT-01` | Not started | — | — | — |
| `API-01` | Not started | — | — | — |
| `REL-01` | Not started | — | — | — |
| `OSS-01` | Not started | — | — | — |
| `MAINT-01` | Not started | — | — | — |

## 11. Copy-paste prompt for the next coding agent

```text
Implement task <TASK-ID> from FRAMEWORK-IMPROVEMENT-PLAN.md.

Read the document's agent rules, fixed architectural decisions, dependencies, acceptance criteria,
and global definition of done before editing. Work only within <TASK-ID>; do not implement adjacent
tasks or broaden the public API. First inspect the listed source and existing tests, then add the
regression/failure test and implement the smallest architecture-consistent fix.

Run every required focused test plus the full repository checks. Report:
1. invariants established;
2. files and public/persisted contracts changed;
3. commands and results;
4. failure/rollback behavior verified;
5. intentionally deferred follow-ups.

Do not mark the status tracker complete unless every acceptance criterion passes.
```

For parallel agent execution, assign at most one active agent per lane from section 6. Agents may
review another lane, but they must not edit files owned by that lane without coordinating the merge
order first.
