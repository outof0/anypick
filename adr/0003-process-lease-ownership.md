# ADR-0003: Verifiable process & lease ownership (PROC-01)

- Status: accepted (2026-07-20)
- Task: PROC-01 (establish verifiable process and lease ownership)

## Context

`spawnDetached` wrote a numeric PID to a `0o644` file with no owner token. PID
reuse (ABA) meant a future unrelated live process holding that PID could be
signaled by Hotplug on stop/reap. `stopPidFile` and `reapStaleLeases` only checked
`isProcessRunning(pid)` — liveness, not ownership. The lease table stored only
`owner_pid`, so an adopted/duplicated lease could not be proven to belong to the
current supervisor.

## Decision

1. **Structured ownership record.** `spawnDetached` writes a `PidRecord`
   (`{ recordVersion, instanceId, pid, endpoint?, provider?, account?, command?,
   createdAt }`) atomically to `pidPath` at mode `0o600`. `instanceId` is a
   `randomUUID()` generated per spawn.
2. **Fail-closed reads.** `readPidRecord` / `readPidFile` return `null` when the
   record is absent, corrupt/partial (invalid JSON or missing required fields),
   or a legacy numeric PID file. A numeric PID is never trusted as ownership
   proof.
3. **Identity verification via health echo.** `spawnDetached` injects
   `HOTPLUG_INSTANCE_ID` into the child env; each proxy server (`grok`,
   `gemini`, `opencode`) echoes it at `GET /health`. `waitForHttp` and the new
   `verifyProcessHealth` only count a process as ready/owned when the echoed
   instance id matches — not merely because the PID is alive.
4. **Fail-closed stop.** `stopPidFile` reads the structured record; if it is
   `null` (absent/unverifiable), it signals nothing and returns `false`. It
   never kills a process it cannot prove it owns.
5. **Lease carries instance id.** `ProxyHandle.instanceId` and
   `ProxyLease.instanceId` are threaded from `spawnDetached` → provider
   `startProxy` → `recordLease` → `proxy_leases.instance_id` column
   (`db.ts` + `lease-store.ts` updated). `reapStaleLeases` can therefore verify
   the actual process identity before treating a lease as owned.

## Consequences

- PID reuse / ABA can no longer cause Hotplug to signal an unrelated live
  process: a record must be present, structurally valid, and (for start/health)
  identity-matched.
- Legacy numeric PID files are treated as unowned (fail closed); old runtime
  dirs are simply re-created on next start.
- Proxy startup now fails fast if `/health` does not echo the expected instance
  id (guards against binding to someone else's listener).

## Deferred

- Full reaping integration in `reapStaleLeases` using `instanceId` is wired at
  the data layer; the `startProxy`/`waitForHttp` path already verifies identity
  at spawn time. Deeper cross-process adoption (tray supervisor adopting a
  child's instance id) builds on this same contract.
