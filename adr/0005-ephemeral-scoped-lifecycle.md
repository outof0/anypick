# ADR-0005: Ephemeral execution is one scoped lifecycle (RUN-01)

- Status: accepted (2026-07-20)
- Task: RUN-01 (ephemeral execution as one scoped lifecycle)

## Context

The ephemeral activation plan emits two adjacent steps:
`CreateTemporaryClientHome` followed by `SpawnChild`. The executor previously
handled these in a single combined `switch` case, so both step kinds ran the
same body. Depending on the plan that could build the isolated runtime twice
(two temp homes for one run) — or, in the launcher-owned spawn model, the
executor tried to spawn the child itself, duplicating the CLI launcher's job
(`src/cli/launch-client.ts`, which already applies env, forwards signals, awaits
exit, and cleans up in `finally`).

Separately, the executor stored only the ephemeral session's `cleanup` function
on the activation context and never returned the session in `ExecuteResult`. The
launcher reads `result.isolated.{environment,directory,cleanup}` to spawn the
child in the isolated home — so with `isolated` always `undefined`, ephemeral
runs could not actually launch a child against isolated material.

## Decision

1. **`CreateTemporaryClientHome` builds the isolated runtime exactly once.** It
   calls `runtime.createEphemeralRuntime(resolvedPlan)`, stores the full session
   (`directory`, `environment`, `cleanup`) on the activation context, marks the
   context mutated, and pushes an idempotent `cleanup()` onto the rollback stack.
2. **`SpawnChild` is a pure no-op marker in the executor.** The actual child
   process is spawned by the CLI launcher, which owns env application, signal
   forwarding, exit waiting, and `cleanup()` in `finally`. The executor never
   spawns.
3. **The session is surfaced in `ExecuteResult.isolated`.** The success return
   propagates `ctx.isolated` so the launcher can start the child in the isolated
   home and clean it up on every exit path.

## Consequences

- A single-temp-home ephemeral plan produces exactly one directory
  (verified by `tests/run-ephemeral.test.ts` — `createEphemeralRuntime` is
  called once even though the plan carries both step kinds).
- `result.isolated` carries `environment`, `directory`, and `cleanup` for the
  launcher; `cleanup()` removes the temp dir.
- Ephemeral runs commit no global binding and leave live account auth untouched
  (checksum-verified before/after).
- Rollback-on-failure still calls the session's `cleanup()` via the undo stack,
  so a fault after home creation strands no temp dir.

## Deferred

- Full launcher-level fault matrix (non-zero exit / signal / spawn-error /
  cleanup-retry) is exercised at the `makeIsolatedRuntime` + launcher level in
  `tests/isolation-signals.test.ts`; the executor's guarantee here is the
  single-session boundary and result surfacing.
- Making plan-step execution compile-time exhaustive (new step → compile error)
  is tracked as broader work; the current switch covers every declared
  `PlanStepKind`.
