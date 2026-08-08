# ADR-0007: Project bindings record only project-scoped metadata (SCOPE-01)

- Status: accepted (2026-07-20)
- Task: SCOPE-01 (separate project bindings from global client state)

## Context

`hotplug link <client> --with <source>` records a *project* binding so that
`hotplug run` inside that project resolves the binding into an isolated
ephemeral session (RUN-01). The planner previously emitted the same
`WriteClientConfig` + `VerifyEffectiveState` steps for `project` mode as it did
for `persistent` (`use`) mode. Those steps write the **global** live client
config — e.g. `~/.claude/settings.json` `env` and the managed marker — and (for
account/proxy sources) start a managed proxy plus record `client_state`.

That violates fixed decision #7:

> **Project bindings do not write global client configuration.** `link` records
> a project binding; `run` resolves it into an isolated session. A future
> project-local adapter operation must be an explicit capability.

A side effect: linking a project silently mutated the user's global client
config and account/proxy state, and a `link` from a global binding could
duplicate proxy/state writes. The two scopes were not actually separated.

This ADR records how SCOPE-01 makes the separation real at the plan level.

## Decision

1. **`project` mode emits only `CommitProjectBinding`.** The planner no longer
   emits `WriteClientConfig`, `VerifyEffectiveState`, proxy lease/start/health,
   or `WriteNativeAuth` for `project` mode. A project link records project-scoped
   metadata and nothing else (`src/core/activation-planner.ts`).
2. **Proxy lifecycle and native-auth writes stay scoped to `persistent` use and
   `ephemeral` run.** These are the only modes that own shared live state; the
   proxy is started when `run` resolves the binding into the isolated session,
   not at `link` time.
3. **`run` inside a linked project resolves precedence** (project binding →
   global binding → error) and prepares the ephemeral session through RUN-01, so
   the global client home is never patched by a project run.

## Consequences

- `link` never writes `~/.claude/settings.json`, never records `client_state`,
  never starts a proxy, and never mutates the live account selection.
- A pre-existing global client config (set by `use`) is byte-for-byte preserved
  across a `link` (except the managed-marker timestamp, which `use` owns).
- `run` inside a linked project produces exactly one isolated ephemeral home and
  cleans it up; the live client home is unchanged (`tests/scope-project-binding.test.ts`).
- `use` (`persistent`) and `run` (`ephemeral`) retain their prior behavior
  (global config write + proxy for `use`; isolated session for `run`).

## Rejected alternatives

- **Emit `WriteClientConfig` but into a project-local file.** The fixed decision
  requires project-local config to be an explicit future adapter capability, not
  a copy of the global write path. Deferring keeps the separation honest.
- **Have `link` also start the proxy "so run is instant".** Violates decision #7
  (no global state at link) and RUN-01 (proxy is part of the ephemeral session).
  Starting the proxy belongs to `run`.
