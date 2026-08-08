# ADR-0010: Observable degraded state & lifecycle events (OBS-01)

- Status: accepted (2026-07-20)
- Task: OBS-01 (structured event port for degraded/lifecycle conditions)

## Context

Hotplug previously swallowed several high-risk partial failures in `catch` blocks that only
called `logInternalError` (startup journal recovery failure, stale-lease reap failure) or
silently marked an operation `failed` (journal recovery refusal when a source could not be
re-resolved exactly). These conditions are exactly the ones a production operator needs to
see: a partial/crashed operation that could not be rolled back automatically, or a reaping
failure that leaves a stale proxy holding a port across sessions. Silence hides inconsistency
— the precise failure mode Hotplug must not exhibit.

At the same time, events must never carry secret material. A naive stderr surface would
tempt callers into logging tokens, auth files, or complete imported payloads. The design must
redact at the boundary by construction.

This ADR records the event port that now underpins OBS-01, locked by a regression suite
(`tests/obs-events.test.ts`).

## Decision

1. **Injectable sink, no CLI coupling.** `HotplugEventSink.emit(event)` is the only port.
   Library consumers supply their own sink (e.g. to feed a TUI status bar). When none is
   supplied, `createApp` uses an `InMemoryEventSink` ring (200 entries) that `doctor`/`status`
   can read, plus a `DebugStderrEventSink` echo that is a no-op unless `HOTPLUG_DEBUG` is set.
   `app.events = { sink, emit }` is exposed for callers; `createApp({ events })` injects a sink.
2. **Typed, sanitized event shape.** `HotplugEvent` carries `opId?`, `resourceIds?`, `step?`,
   `severity` (`info`|`warn`|`error`), a stable machine-readable `code`, a human `message`
   (must not contain secrets), an optional sanitized `context`, and an ISO `timestamp`.
3. **Redaction at the boundary.** `sanitizeContext` runs on every emit. It replaces known
   secret keys (`key`, `token`, `secret`, `password`, `apiKey`, `authorization`, `auth`,
   `accessToken`, `refreshToken`, `bearer`, …) with `<redacted>`, and also redacts any string
   value longer than 24 chars that looks like a bearer/token (`/[\w-]{24,}/`). Context is meant
   to be flat and small; nested objects are not traversed.
4. **Emit where degradation occurs.** `createAppReady` emits `startup_recovery_failed` and
   `startup_lease_reap_failed` on its two startup degraded paths. `recoverIncompleteOperations`
   now takes an `events` sink and emits `recovery_refused` (warn) with the op id when a source
   cannot be re-resolved exactly — a condition that was previously only reflected by a silent
   `failed` journal state.

## Consequences

- Startup recovery failure, lease-reap failure, and recovery refusal are now surfaced as
  ordered, redacted, structured events rather than swallowed (OBS-01 acceptance).
- A library consumer receives events without any CLI formatting dependency.
- Secret material cannot reach an event: known secret keys and long bearer-like values are
  redacted at the emit boundary regardless of caller.
- The default in-memory ring gives `doctor`/`status` a place to surface unresolved degraded
  conditions without changing call sites.

## Rejected alternatives

- **Ad hoc stderr strings per catch block.** Tempts secret leakage, couples library consumers
  to CLI formatting, and gives no stable `code` for machine consumption.
- **A single global event bus.** Couples every subsystem to a module-global and prevents
  app-scoped isolation per decision #14; an injected sink is the single source of truth.
- **Redaction inside each emitter.** Easy to forget at a new call site; redaction belongs at the
  one `makeEmitter` boundary so every future emit is safe by construction.
