# Architecture decision records

Each ADR states one decision, the context that forced it, and the consequences
that follow. They are the answer to "why is it like this?" and are the right
thing to cite from a code comment — they are short, numbered stably, and
immutable once accepted.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-test-typecheck-resolution.md) | Tests are typechecked under a `bundler`-resolution config that mirrors how Vitest and the Vite SSR build actually consume extensionless source. | accepted |
| [0002](0002-account-import-trust-boundary.md) | Imported account envelopes are decoded from `unknown` by a versioned, I/O-free codec; every file key is validated for traversal before any mutation. (SEC-01) | accepted |
| [0003](0003-process-lease-ownership.md) | A spawned process is owned only if it echoes the `instanceId` AnyPick gave it; a live PID is never ownership proof. (PROC-01) | accepted |
| [0004](0004-atomic-snapshot-save.md) | `writeMeta` is the single atomic commit point for a snapshot; a failed backup or import can never destroy the previous saved account. (DATA-01) | accepted |
| [0005](0005-ephemeral-scoped-lifecycle.md) | An ephemeral run is one scoped lifecycle: the executor builds the isolated home exactly once, and the CLI launcher — not the executor — spawns the child. (RUN-01) | accepted |
| [0006](0006-proxy-authentication.md) | Every local credentialed proxy request is authenticated with a per-instance high-entropy secret; loopback alone is not a boundary. (PROXY-01) | accepted |
| [0007](0007-project-binding-scope.md) | A project binding writes project-scoped metadata only, never global client config or proxy state. (SCOPE-01) | accepted |
| [0008](0008-durable-recovery-storage.md) | Crash backups live in an owner-only recovery dir under the AnyPick root, keyed to avoid collisions — not in system temp. (TXN-01) | accepted |
| [0009](0009-mutation-coordinator.md) | Every persisted mutation runs under the internal coordinator with sorted, scoped locks; correctness never depends on the caller locking. (CONC-01) | accepted, amended by [0011](0011-reentrant-provider-scoped-locks.md) |
| [0010](0010-observable-degraded-state.md) | Degraded and lifecycle conditions are emitted through an injectable, redacting event port instead of being swallowed in `catch`. (OBS-01) | accepted |
| [0011](0011-reentrant-provider-scoped-locks.md) | Account mutations lock one re-entrant `provider/<id>` scope covering the live credential file and every snapshot; activation maps its source ref onto the same scope. (CONC-02) | accepted |
| [0012](0012-plugin-trust-boundary.md) | Plugins are installed disabled, enabled by an explicit decision, pinned to a digest verified before `import()`, activated inside the sealing window, and never fatal. (EXT-01) | superseded by [0021](0021-plugin-host-removed-from-native-builds.md) — the registry and the digest survive; the execution grant does not |
| [0013](0013-model-routed-proxy-hub.md) | One loopback Proxy Hub keeps provider model IDs unchanged, routes exact IDs only after explicit collision resolution, and gives each client a token-scoped manifest. (HUB-01) | accepted, amended by [0036](0036-hub-named-combos.md) |
| [0014](0014-plugin-package-digest.md) | The plugin trust pin is a SHA-256 of the whole package (not only `main`), verified before `import()`. (EXT-02) | superseded by [0021](0021-plugin-host-removed-from-native-builds.md) — the pin is still computed and still verified; there is no import to gate |
| [0015](0015-declarative-compatible-provider-plugins.md) | Compatible provider plugins declare official endpoints and credential products; core owns snapshots, dual-protocol proxying, pools, and Hub backends. (EXT-03) | accepted, amended by [0017](0017-provider-owned-browser-login.md) and [0021](0021-plugin-host-removed-from-native-builds.md) — the mechanism now ships as built-ins |
| [0016](0016-compatible-backend-capability-routing.md) | Compatible providers use a credential-aware backend and route native protocol surfaces only when every pool candidate declares the capability. (EXT-04) | accepted |
| [0017](0017-provider-owned-browser-login.md) | Providers own browser login methods; official methods are preferred, not required. (AUTH-01) | accepted, amends [0015](0015-declarative-compatible-provider-plugins.md) |
| [0018](0018-macos-app-single-swift-tree.md) | macOS is one Dock app compiled from `src/macos/`. Fixture vs live is a data source, not a second Swift tree. | accepted |
| [0019](0019-native-app-cutover-architecture.md) | The native app owns lifecycle over a bundled Go service on bounded, versioned stdio; host effects are narrow typed requests; the Node plugin-host and npm channel are documented exceptions. | superseded by [0020](0020-node-free-native-app-distribution.md) |
| [0020](0020-node-free-native-app-distribution.md) | Native downloads are full desktop applications over one bundled Go engine, contain no Node runtime, and treat npm only as an optional distribution adapter. | accepted, amended by [0033](0033-macos-release-without-notarization.md) for macOS release signing/notarization and [0034](0034-loopback-management-api.md) decision 6 for the management API |
| [0021](0021-plugin-host-removed-from-native-builds.md) | Native builds install plugins but never execute them: the registry and the whole-package digest survive, no third-party code is loaded, and every candidate degrades to a visible `LoadFailure`. (EXT-05) | accepted |
| [0022](0022-bindings-coordinator-scopes.md) | `bindings.Store` carries the data `Root` and self-locks every persisted mutation through the coordinator by resource scope; correctness no longer depends on the caller locking. (CONC-03) | accepted |
| [0023](0023-lease-heartbeat-ttl.md) | A lease stays alive by heartbeat (`HeartbeatInterval=15s`, `LeaseExpiry=2m`); reaping is a PID *veto* plus a failed instance echo, never a PID verdict. (PROC-02) | accepted, amends [0003](0003-process-lease-ownership.md) |
| [0024](0024-pool-ring-total-deadline.md) | A pool ring has one pre-commit deadline budget (`DefaultPoolRingDeadline=2m`); a committed stream is never cut, and budget exhaustion returns `504 upstream_timeout`. (POOL-01) | accepted |
| [0025](0025-global-credential-store-test-seam.md) | The OS credential store is global, so the write seam is exported and every test binary that drives activation installs its own guard — which asserts it was consulted. (CRED-01) | proposed |
| [0026](0026-pool-rotation-and-all-cooling.md) | `round-robin` rotates a pool ring over its eligible members, and has one hub-wide counterpart that spreads each model across the accounts that can serve it; a fully cooled ring attempts the soonest-to-recover member and passes the vendor's verdict through instead of refusing locally. (POOL-02) | accepted, amends [0024](0024-pool-ring-total-deadline.md); amended by [0035](0035-soonest-reset-routing.md) |
| [0027](0027-action-outcome-contract.md) | Every app action ends in exactly one attributed terminal outcome: the engine names the request it refuses, bounds and contains every command, and the host settles each row from the frame that owns it. (DESK-01) | accepted |
| [0028](0028-provider-model-role-defaults.md) | Model roles resolve explicit pins → provider defaults → engine default; the planner copies defaults into fresh bindings and `model-roles` gains connection/provider scope plus reset. (MODEL-01) | accepted |
| [0029](0029-relational-hub-membership.md) | Hub membership is relational: `proxy_hub_sources` rows reference accounts and hubs with foreign keys instead of a serialized list, so a renamed or deleted account cannot leave a member behind that serving still resolves. | accepted |
| [0030](0030-hub-child-freshness.md) | Hub `/health` reports the config `Revision` the child started with and every start path rejects a child whose revision predates the current config; liveness is not freshness. | accepted |
| [0031](0031-provider-registration-is-in-tree.md) | A provider is registered in-tree and `app.Options` gains no registration parameter; the extension point is a declarative compatible-provider definition, and the two constructors that implemented the documented-but-absent hook are deleted. | accepted, amends [0015](0015-declarative-compatible-provider-plugins.md) and [0021](0021-plugin-host-removed-from-native-builds.md) |
| [0032](0032-delete-provider-owned-proxy-seam.md) | The provider-owned proxy seam is deleted rather than reserved: 849 unreachable lines, five branches on a predicate no provider satisfies, and three files describing a Node host that no longer exists. Log screening stays, because it is how ADR-0006's token boundary holds. | accepted, amends [0021](0021-plugin-host-removed-from-native-builds.md) decision 3 |
| [0033](0033-macos-release-without-notarization.md) | macOS releases build the universal app in CI with an ad-hoc code signature, publish DMG/ZIP without notarization, and explain first-launch Gatekeeper approval. | accepted, amends [0020](0020-node-free-native-app-distribution.md) decisions 8 and 9 |
| [0034](0034-loopback-management-api.md) | `anypick serve` is a versioned `/v1` management API on loopback: a per-install bearer on every route but `/health`, `Host` and `Origin` checks against rebinding and browsers, no secret in any response, and explicit resource actions instead of desktop action ids. | accepted, amends [0020](0020-node-free-native-app-distribution.md) decision 6 |
| [0035](0035-soonest-reset-routing.md) | Pools and the hub gain `soonest-reset`: each request starts at the account whose unused quota resets soonest, from a per-provider cache the request path only reads and a soonest-reset child refreshes from saved snapshots; missing or stale readings fall back to failover order. | accepted, amends [0026](0026-pool-rotation-and-all-cooling.md) |
| [0036](0036-hub-named-combos.md) | A combo is a named, ordered list of (hub source, model) steps clients request like a model id; it walks its steps on quota refusal, pool steps included, and the hub answers `GET /v1/models` itself with pins, single-owner catalog ids and combos. | accepted, amends [0013](0013-model-routed-proxy-hub.md) |
| [0037](0037-usage-history-and-cost-estimate.md) | Proxies, pools and the hub record each served 2xx response's token counts (no content) in `usage_events`, kept 90 days; `anypick usage` and the management API report them with a cost estimate from a dated, overridable list-price table that prices nothing it does not list. | accepted |

## Writing a new one

Copy the shape of an existing record: `Status`, `Context` (what was wrong or
undecided), `Decision` (numbered, concrete), `Consequences`. Number it with the
next four-digit ordinal. Do not edit an accepted ADR to reflect new thinking —
write a new one and mark the old one superseded, naming its replacement.

The older planning documents in [`../docs/history/`](../docs/history/) are not
ADRs. They are proposals and narratives, superseded in places, kept only for
provenance.
