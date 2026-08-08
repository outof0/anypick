# Architecture decision records

Each ADR states one decision, the context that forced it, and the consequences
that follow. They are the answer to "why is it like this?" and are the right
thing to cite from a code comment — they are short, numbered stably, and
immutable once accepted.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-test-typecheck-resolution.md) | Tests are typechecked under a `bundler`-resolution config that mirrors how Vitest and the Vite SSR build actually consume extensionless source. | accepted |
| [0002](0002-account-import-trust-boundary.md) | Imported account envelopes are decoded from `unknown` by a versioned, I/O-free codec; every file key is validated for traversal before any mutation. (SEC-01) | accepted |
| [0003](0003-process-lease-ownership.md) | A spawned process is owned only if it echoes the `instanceId` Hotplug gave it; a live PID is never ownership proof. (PROC-01) | accepted |
| [0004](0004-atomic-snapshot-save.md) | `writeMeta` is the single atomic commit point for a snapshot; a failed backup or import can never destroy the previous saved account. (DATA-01) | accepted |
| [0005](0005-ephemeral-scoped-lifecycle.md) | An ephemeral run is one scoped lifecycle: the executor builds the isolated home exactly once, and the CLI launcher — not the executor — spawns the child. (RUN-01) | accepted |
| [0006](0006-proxy-authentication.md) | Every local credentialed proxy request is authenticated with a per-instance high-entropy secret; loopback alone is not a boundary. (PROXY-01) | accepted |
| [0007](0007-project-binding-scope.md) | A project binding writes project-scoped metadata only, never global client config or proxy state. (SCOPE-01) | accepted |
| [0008](0008-durable-recovery-storage.md) | Crash backups live in an owner-only recovery dir under the Hotplug root, keyed to avoid collisions — not in system temp. (TXN-01) | accepted |
| [0009](0009-mutation-coordinator.md) | Every persisted mutation runs under the internal coordinator with sorted, scoped locks; correctness never depends on the caller locking. (CONC-01) | accepted, amended by [0011](0011-reentrant-provider-scoped-locks.md) |
| [0010](0010-observable-degraded-state.md) | Degraded and lifecycle conditions are emitted through an injectable, redacting event port instead of being swallowed in `catch`. (OBS-01) | accepted |
| [0011](0011-reentrant-provider-scoped-locks.md) | Account mutations lock one re-entrant `provider/<id>` scope covering the live credential file and every snapshot; activation maps its source ref onto the same scope. (CONC-02) | accepted |
| [0012](0012-plugin-trust-boundary.md) | Plugins are installed disabled, enabled by an explicit decision, pinned to a digest verified before `import()`, activated inside the sealing window, and never fatal. (EXT-01) | accepted, amended by [0014](0014-plugin-package-digest.md) |
| [0013](0013-model-routed-proxy-hub.md) | One loopback Proxy Hub keeps provider model IDs unchanged, routes exact IDs only after explicit collision resolution, and gives each client a token-scoped manifest. (HUB-01) | accepted |
| [0014](0014-plugin-package-digest.md) | The plugin trust pin is a SHA-256 of the whole package (not only `main`), verified before `import()`. (EXT-02) | accepted |

## Writing a new one

Copy the shape of an existing record: `Status`, `Context` (what was wrong or
undecided), `Decision` (numbered, concrete), `Consequences`. Number it with the
next four-digit ordinal. Do not edit an accepted ADR to reflect new thinking —
write a new one and mark the old one superseded, naming its replacement.

The older planning documents in [`../docs/history/`](../docs/history/) are not
ADRs. They are proposals and narratives, superseded in places, kept only for
provenance.
