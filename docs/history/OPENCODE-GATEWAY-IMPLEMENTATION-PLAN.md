# OpenCode Local Gateway and Optional Egress — Implementation Plan

Status: proposed

This document is the implementation handoff for the next coding agent. Implement it as a
sequence of small, independently testable changes. Do not implement every milestone in one
large patch.

## 1. Goal

When a user enables OpenCode from the TUI, Hotplug should expose a local OpenAI/Anthropic
compatible endpoint that:

- starts and stops deterministically;
- affects only explicitly bound clients;
- supports OpenCode public/free mode without requiring a Zen/Go API key;
- does not send outbound traffic merely because the TUI screen was opened;
- handles `429` and `Retry-After` without replaying inference requests blindly;
- can later use a user-selected remote egress without Tor or a machine-wide proxy setting.

The local gateway and the remote egress are separate concepts:

```text
TUI / client binding
        |
        v
Local compatibility gateway
        |
        v
OpenCode adapter + upstream policy
        |
        v
EgressTransport (direct by default, optional remote route later)
        |
        v
OpenCode Zen / Go
```

## 2. Fixed design decisions

These decisions are part of the plan and should not be reopened during implementation unless a
test proves one of them impossible.

1. Keep the provider adapter provider-specific. `src/providers/opencode-proxy` may eventually be
   renamed to `src/providers/opencode/gateway`, but it must not become a cross-provider god
   router. The existing `ProxyService`/`Provider.startProxy()` boundary is already generic.
2. Keep `hotplug proxy` CLI compatibility for now. UI copy may call it a "Local API" or
   "compatibility gateway" so users do not assume it changes their public IP.
3. `enabled` means persisted desired state. `running` means observed child-process state.
4. Enabling from the TUI starts the selected local listener immediately. It remains alive until
   Stop, Disable, account switch, or stale-process cleanup. It does not wait for the first HTTP
   request because a listener must already exist to receive that request.
5. Starting the listener must not fetch `/models`. Catalog access is lazy on the first model or
   inference request.
6. V1 public mode remains attached to a saved OpenCode account row. This allows OAuth-only
   OpenCode snapshots to be the lifecycle owner without changing the resource model. A truly
   accountless built-in `opencode/public` source is a later milestone.
7. No automatic IP rotation. No Tor, SOCKS daemon, system VPN mutation, or machine-wide proxy
   changes.
8. A non-direct egress is explicit and fail-closed. It must never silently fall back to direct.
9. Cross-account, cross-model, and cross-provider fallback are not part of the MVP. First build
   correct classification/cooldown and collect evidence.

## 3. Product behavior contract

### TUI lifecycle

- Opening the Proxy/Local API screen performs no start and no upstream request.
- Enable persists `enabled=true` and starts the selected active account.
- An inactive account may be explicitly started for testing, but starting it must not rewrite a
  client unless that exact provider/account is bound.
- Stop terminates the process but keeps `enabled=true`.
- Disable terminates the process and persists `enabled=false`.
- Exiting the TUI does not kill a healthy detached gateway.
- `hotplug run` continues to use isolated/ephemeral client configuration.

### OpenCode auth modes

```ts
export type OpenCodeAuthMode = 'auto' | 'public' | 'api';
```

- `public`: no auth file required; Zen only; public model requests use the public credential.
- `api`: a Zen/Go platform key is required; Zen and Go are available.
- `auto` (default/backward compatible): use API mode when a platform key exists, otherwise use
  public mode.
- In `auto`, a known public/free model may use the public credential while paid models use the
  saved API credential. This decision must be explicit in one helper, not duplicated across
  request handlers.
- Public OpenAI-compatible paths use `Authorization: Bearer public`.
- Public Anthropic `/messages` uses `x-api-key: public`.
- All public upstream requests include `x-opencode-client: desktop`.
- Client-provided credentials are never forwarded upstream.

### Rate-limit behavior

- Inference POST is sent once by default.
- A `429` is returned to the client with its status, structured body, and `Retry-After` preserved.
- The affected route enters an in-memory cooldown.
- A request during cooldown returns a local `429` and does not hit the upstream.
- Catalog GET may retry once for a transient network/502/503/504 failure.
- Network failures and ambiguous 5xx responses for inference are not replayed automatically.
- Once any semantic stream content has been forwarded, no retry or fallback is allowed.

## 4. Pull request sequence

### PR 1 — Make process and lease ownership deterministic

Goal: one process has one lease, and an exited CLI/TUI process does not make a healthy detached
gateway look stale.

Files:

- `src/types.ts`
- `src/core/lease-store.ts`
- `src/core/proxy-service.ts`
- `src/core/activation-executor.ts`
- `src/core/proxy-lifecycle.ts`
- `src/core/app.ts`
- `tests/proxy.test.ts`
- `tests/rollback.test.ts`
- new `tests/proxy-lifecycle.test.ts`

Changes:

1. Extend `ProxyHandle` with optional lifecycle metadata:

   ```ts
   leaseId?: string;
   startedNow?: boolean;
   ```

2. Change `ProxyService.recordLease` to accept the complete handle rather than only the endpoint.
3. Store `ownerPid: handle.pid ?? process.pid`. A detached proxy lease is owned by the proxy
   child, not the short-lived CLI that requested the start.
4. Release any previous lease for the same provider/account before recording the new one.
5. Return the created lease id on `ProxyHandle` in all start paths:
   - healthy-process reuse;
   - first start;
   - port-bump retry;
   - pool start.
6. Mark `startedNow=false` for healthy reuse and `true` for a newly spawned child.
7. Remove the duplicate `deps.leases.create(...)` calls in `activation-executor.ts`. The
   `ProxyService` is the only lease owner.
8. Rollback stops a proxy only when that activation actually started it. It must not stop a
   healthy gateway that existed before activation.
9. `stopProxyInternal` and `stopPoolProxy` remain the only paths that release their lease.

Tests/acceptance:

- One successful start creates exactly one lease.
- Lease `ownerPid` equals the child pid when the provider returns one.
- Starting again reuses the process and still leaves one lease.
- A second app startup does not reap a live child-owned lease.
- A dead child pid is reaped.
- Disable, account switch, and rollback leave no orphan lease.
- Rollback does not stop a reused pre-existing proxy.

Compatibility:

- No DB schema change.
- Legacy leases owned by an exited CLI may be reaped once; the next start recreates them with the
  correct child owner.

### PR 2 — Remove provider-child global config side effects and make outbound lazy

Goal: starting a gateway changes runtime state only. Client configuration changes remain owned by
explicit binding/activation code.

Files:

- `src/providers/opencode-proxy/main.ts`
- `src/providers/gemini-proxy/main.ts`
- `src/providers/grok-proxy/main.ts`
- `src/clients/claude-settings-guard.ts`
- `src/core/realign-proxy-clients.ts`
- `src/providers/opencode-proxy/server.ts`
- `tests/realign-proxy-clients.test.ts`
- new `tests/proxy-client-ownership.test.ts`
- `tests/opencode-proxy.test.ts`

Changes:

1. Remove `startClaudeSettingsGuard` from every provider child entrypoint.
2. Delete `claude-settings-guard.ts` after verifying it has no callers.
3. Keep one-shot, intentional client writes in `RuntimeService`, client adapters, activation, and
   `realignClientsToAccountProxy`.
4. `realignClientsToAccountProxy` updates only clients whose current persistent binding or
   client state matches the exact provider/account. A project binding must not rewrite global
   live settings outside that project's activation.
5. Remove fire-and-forget `warmOpenCodeCatalog()` from `listenOpenCodeProxy()`.
6. `/health` must not load credentials or fetch a catalog. It reports process/config state only.
7. Keep catalog singleflight so concurrent first requests issue at most one catalog fetch per
   catalog.

Tests/acceptance:

- Opening the TUI or starting an unbound gateway leaves Claude/Codex config byte-identical.
- Two provider gateways running together never fight over `ANTHROPIC_BASE_URL`.
- Starting a bound account realigns only the matching client.
- User-managed Claude settings without a Hotplug marker are untouched.
- Listen + `/health` makes zero upstream calls.
- First `/models` or inference lazily loads the catalog.
- Concurrent first requests use catalog singleflight.
- `rg "startClaudeSettingsGuard" src/providers` returns no matches.

Known trade-off:

- This removes mid-session background repair if Claude rewrites its settings. If that remains a
  reproducible problem, implement one client-owned reconciler keyed by current `ClientState` in a
  separate PR. Do not restore one guard per provider process.

### PR 3 — Enforce a local-only security boundary

Goal: a saved upstream key must never be exposed through an accidental LAN listener or browser
CORS call.

Files:

- new `src/utils/network.ts`
- `src/core/proxy-service.ts`
- `src/providers/opencode.ts`
- `src/providers/gemini.ts`
- `src/providers/grok.ts`
- provider proxy `main.ts` entrypoints
- provider proxy server CORS helpers
- `src/cli/commands.ts`
- `tests/proxy.test.ts`
- new `tests/proxy-security.test.ts`

Changes:

1. Add `isLoopbackHost`/`assertLoopbackHost`. Accept only `127.0.0.1`, `::1`, and `localhost`.
2. Validate on enable, configure, start, pool enable/start, and again inside direct proxy
   entrypoints so bypassing core is still safe.
3. Reject `0.0.0.0`, `::`, LAN IPs, and arbitrary hostnames with stable error code
   `PROXY_UNSAFE_HOST`.
4. Stop reflecting arbitrary `Access-Control-Allow-Origin`. CLI clients do not need permissive
   CORS. If a real local browser client is supported, allow only explicit loopback origins.
5. Create proxy logs with mode `0600`, not `0644`.
6. Update CLI help to say `--host` is loopback-only.

Tests/acceptance:

- All accepted loopback forms work.
- Every non-loopback form fails before spawn/bind.
- Requests with an untrusted browser Origin are rejected before any upstream request.
- Health/log/error output contains no credential or auth-file contents.
- Port collision still bumps safely and never kills a foreign listener.

Compatibility:

- This intentionally breaks saved non-loopback configs. Fail clearly; do not silently rewrite
  them. Remote listening requires a separate design with an unpredictable inbound token.

### PR 4 — Make OpenCode public mode first-class

Goal: an OAuth-only saved OpenCode account can be enabled from the TUI and serve public models.

Files:

- `src/providers/opencode-proxy/auth.ts`
- `src/providers/opencode-proxy/models.ts`
- `src/providers/opencode-proxy/server.ts`
- `src/providers/opencode-proxy/main.ts`
- `src/providers/opencode.ts`
- `src/cli/commands.ts`
- `src/tui/model.ts`
- `tests/opencode-proxy.test.ts`
- `tests/providers.test.ts`

Types/helpers:

```ts
export type OpenCodeAuthMode = 'auto' | 'public' | 'api';

export type OpenCodeCredential =
  | { mode: 'public'; service: 'public'; apiKey: 'public' }
  | { mode: 'api'; service: string; apiKey: string };
```

Changes:

1. Add `resolveOpenCodeCredential(authPath, mode)`.
2. Preserve `loadOpenCodeCredential(path)` as the strict API-key wrapper for compatibility.
3. In `OpenCodeProvider.startProxy`, parse and validate `ctx.config.options?.authMode`; omission
   means `auto`.
4. Only explicit `api` mode requires a Zen/Go platform key.
5. Pass `--auth-mode auto|public|api` to the child. Make `--auth-path` optional in public mode.
6. Public mode queries Zen only. API mode queries Zen and Go.
7. Move/export the public-model classifier into `models.ts`. Use exact suffixes and explicit
   aliases; do not use a broad `includes("free")` match.
8. Public `/v1/models` exposes only models the classifier considers public. This prevents a paid
   model from being selected and then failing far upstream.
9. Centralize upstream credential selection and use it in every path:
   - catalog fetch;
   - direct OpenAI chat/responses;
   - native Anthropic messages;
   - Anthropic-to-OpenAI translation;
   - pass-through routes.
10. Reject a paid-only model locally in forced public mode with a structured 4xx and zero
    inference upstream calls.
11. `/health` and proxy status expose only `authMode`, never key material.
12. Add CLI options:

    ```text
    hotplug proxy enable opencode <account> --auth-mode auto|public|api
    hotplug proxy config opencode <account> --auth-mode auto|public|api
    ```

    Store the value under provider-specific `AccountProxyConfig.options.authMode`.
13. TUI uses `auto` by default. It should display `public` or `api` in the row/detail after start;
    an advanced selector is optional and should not block the MVP.

Required tests:

- Public starts with missing/unreadable auth path.
- Public catalog uses `Bearer public` + desktop header.
- Direct OpenAI free inference uses public auth.
- Translated Anthropic free inference uses public auth.
- Native `/messages` public auth uses `x-api-key: public`.
- Client Authorization/x-api-key is always replaced.
- Public rejects paid-only model locally.
- Explicit API mode without key fails before spawn.
- Auto with key selects API; auto without platform key selects public.
- Existing API-key tests continue to pass.
- Health/log output never exposes a key.

Live contract test:

- Add `tests/live/opencode-free.live.test.ts`, gated by `OPENCODE_LIVE_TEST=1`.
- It may issue one catalog request and at most one tiny non-stream prompt.
- Never run it in normal CI and never turn it into a rate-limit soak test.

### PR 5 — Add a provider-neutral egress seam with direct behavior only

Goal: make remote network routing injectable without monkeypatching global fetch and without a
new dependency.

New files:

- `src/network/egress/types.ts`
- `src/network/egress/direct.ts`
- `src/network/egress/allowlist.ts`
- `src/network/egress/errors.ts`
- `src/network/egress/index.ts`
- new `tests/egress.test.ts`

Interface:

```ts
export type EgressOperation = 'catalog' | 'inference' | 'diagnostic';

export interface EgressDescriptor {
  id: string;
  kind: 'direct' | 'relay' | 'http-connect';
  networkPath: 'local' | 'remote';
  verification: 'not-applicable' | 'unverified' | 'verified';
  confidentiality: 'end-to-end-tls' | 'relay-terminates-tls';
}

export interface EgressTransport {
  readonly descriptor: EgressDescriptor;
  fetch(
    target: string | URL,
    init: RequestInit,
    meta: { operation: EgressOperation },
  ): Promise<Response>;
  close(): Promise<void>;
}
```

Contract:

- The factory binds an exact provider origin allowlist once. Callers cannot widen it per request.
- `fetch` performs exactly one network attempt.
- It never retries and never falls back to direct.
- It forces `redirect: 'manual'`; redirects must be revalidated before following.
- Descriptors and errors never contain secrets or URLs with userinfo.

Integration:

1. `createOpenCodeProxyServer` accepts `egress?: EgressTransport` and defaults to one
   `DirectEgressTransport` instance.
2. Route every OpenCode upstream catalog and inference request through that instance.
3. Close the transport when the server closes.
4. Test upstream overrides by injecting an egress/policy that explicitly allows the mock origin;
   do not weaken production allowlists.
5. Do not add user config, TUI, relay, HTTP proxy, or npm packages in this PR.

Acceptance:

- Catalog and every inference protocol pass through the injected transport.
- Direct mode is behavior-compatible with current global fetch.
- Exact-origin allowlist rejects any other target.
- Redirect cannot escape the allowlist.
- No process-global HTTP proxy environment is modified.
- No new runtime dependency.

### PR 6 — Replace blind retry with classification and cooldown

Goal: stop duplicate inference, preserve upstream rate-limit information, and establish a safe
basis for future routing.

New file:

- `src/providers/upstream-policy.ts`
- new `tests/upstream-policy.test.ts`
- new `tests/opencode-proxy-stream.test.ts`

Suggested types:

```ts
export type UpstreamFailureKind =
  | 'rate_limit'
  | 'auth'
  | 'transient'
  | 'server'
  | 'permanent';

export type LimitScope = 'ip' | 'credential' | 'model' | 'unknown';

export interface ClassifiedFailure {
  kind: UpstreamFailureKind;
  status?: number;
  scope: LimitScope;
  retryAfterMs?: number;
  message?: string;
}
```

Changes:

1. Implement pure, injected-clock helpers:
   - `parseRetryAfter(value, now)` for seconds and HTTP dates;
   - `classifyUpstreamFailure(status, headers, bodyPreview)`;
   - `CooldownRegistry` keyed by route.
2. A route key must include at least provider, account/source id, model, auth mode, and egress id.
   Never include a raw API key. If a key distinction is needed, use a short SHA-256 fingerprint.
3. Classify `FreeUsageLimitError`/explicit IP text as IP scope. A generic `429` remains unknown;
   do not guess.
4. Replace `fetchWithRetry` with two explicit operations:
   - catalog GET: at most two total attempts for safe transient failures;
   - inference: one attempt, no implicit replay.
5. Buffer only a bounded error preview when classification needs the response body, then rebuild a
   response so the client still receives the original status/body/headers.
6. Store the full cooldown deadline. Do not clamp a daily `Retry-After` to 30 seconds.
7. Do not wait inline for a long cooldown. Return immediately.
8. If a route is cooling, return a structured local `429` with remaining `Retry-After` and make no
   upstream request.
9. Remove the current pre-upstream `200`/SSE header commit. The gateway must see the upstream
   status before committing a success stream to the client.
10. Disable the automatic empty-stream -> second non-stream inference replay by default. Any
    future opt-in replay must be explicit and must never occur after semantic content.
11. `/health` may expose cooldown count and nearest expiry, but not request bodies, keys, or full
    account secrets.

Required tests:

- `Retry-After` seconds/date/invalid/negative/large values.
- `x-ratelimit-remaining: 10` does not trigger a limit; remaining `0` may when reset is valid.
- 429 inference reaches upstream once and preserves the response.
- 500/network inference reaches upstream once.
- A repeated request during cooldown makes zero additional upstream calls.
- Catalog GET retries one transient failure and no more.
- Client abort creates no retry/cooldown.
- No retry after first text or tool-use content.
- Upstream error before stream commit remains a real non-200 response.
- Upstream close after semantic content ends/errors the existing stream without opening another
  route.

Acceptance:

- No inference is duplicated by default.
- No same-IP retry occurs after 429.
- Clients receive actionable `Retry-After`.
- Policy logs contain route id/classification only and redact credentials.

### PR 7 — Experimental remote relay, evidence-gated

Do not start this PR merely because PR 5 exists.

Evidence gate:

1. Wait until a natural rate limit occurs; do not intentionally hammer it.
2. Use one fixed model, auth mode, non-stream body, max token count, and session id.
3. Disable retries.
4. Compare the same request on the original egress and a genuinely different egress (trusted
   relay, existing VPN, or mobile hotspot).
5. Verify the network paths report different public egress identities.
6. Required observation: alternate egress repeatedly succeeds while the immediate direct control
   still fails. Direct vs local gateway on the same machine is not evidence.

If the gate passes, implement an experimental relay transport using built-in fetch:

- new `src/network/egress/relay.ts`;
- environment-only initial config:
  - `HOTPLUG_EGRESS_RELAY_URL`;
  - `HOTPLUG_EGRESS_RELAY_TOKEN`;
- pass these only to the selected detached OpenCode child;
- mark the feature experimental and unverified until an explicit diagnostic succeeds.

Relay protocol requirements:

- HTTPS only.
- Separate relay bearer token.
- Fixed route mapping, for example:

  ```text
  https://opencode.ai/zen/v1/...    -> <relay>/r/opencode/zen/v1/...
  https://opencode.ai/zen/go/v1/... -> <relay>/r/opencode/zen/go/v1/...
  ```

- No arbitrary target URL/header.
- Exact OpenCode host/path allowlist.
- Manual/revalidated redirects.
- Method and body-size limits.
- Strip all relay control headers before upstream.
- Stream request/response bodies and propagate aborts.
- Fail closed; relay outage must never fall back direct.
- Warn that a reverse relay terminates TLS and can read prompts and API credentials. Use only a
  user-controlled relay.

Tests:

- Target allowlist and redirect escape rejection.
- Missing/wrong relay token.
- Streaming order and abort propagation.
- Strict failure with zero direct requests.
- Relay control headers never reach OpenCode.
- Secrets never appear in descriptor, status, CLI JSON, or logs.
- Direct and relay cooldown keys are distinct.

Productization after the experiment, not before:

1. Add a named `EgressProfileStore`.
2. Add `egressProfile?: string` to `AccountProxyConfig`; omission means `direct`.
3. Persist only non-secret config. Relay/proxy credentials are referenced from environment or a
   dedicated 0600 secret store, never `AccountProxyConfig.options`.
4. Add CLI:

   ```text
   hotplug egress list
   hotplug egress add relay <name> --url <https-url> --token-env <VAR>
   hotplug egress test <name> --provider opencode
   hotplug proxy config opencode <account> --egress <name|direct>
   ```

5. TUI displays two independent fields:

   ```text
   Local API      running · 127.0.0.1:4120
   Network route direct (this machine)
   ```

   or:

   ```text
   Network route relay:lab · unverified
   ```

6. TUI selection only chooses an existing profile. Secret entry remains outside normal TUI state.

## 5. HTTP CONNECT option after evidence

If the user already owns a trusted HTTP CONNECT proxy, prefer it over a reverse relay because TLS
stays end-to-end. Do not hand-write CONNECT/SOCKS.

Choose one of these only after the evidence gate:

- bundle `undici` as a direct runtime dependency and use a per-transport `ProxyAgent`; or
- raise the runtime requirement to Node `>=22.21` and use native env proxy support inside the
  provider-specific child.

The current development runtime is Node `22.17.1`, so simply setting `HTTP_PROXY` today is not a
working implementation. A process-global env proxy is acceptable only while the child is dedicated
to one provider/egress profile. A future shared gateway process needs per-request transports.

## 6. Explicitly deferred work

Do not implement these while executing PRs 1–6:

- accountless `opencode/public` resource;
- OpenCode multi-account failover;
- model rewriting/fallback;
- cross-provider fallback;
- automatic egress rotation after 429;
- Tor or SOCKS;
- system VPN/proxy mutation;
- LAN listener mode;
- persistent cooldown database;
- a shared public relay operated by Hotplug.

Cross-provider fallback requires one stable gateway that owns candidate selection before stream
commit. It does not belong inside `opencode-proxy/server.ts`.

## 7. Test infrastructure and gates

Before PR 6 grows the existing test file further, add a reusable mock helper:

- `tests/helpers/mock-ai-upstream.ts`
  - scripted status sequences;
  - JSON and SSE bodies;
  - delayed headers;
  - socket close before/after response;
  - request recorder with redacted headers;
  - abort/close observation.

Use injected clock/random/sleep for policy unit tests. Do not make HTTP integration tests depend on
long real timers.

Per-PR verification:

```text
pnpm format --check
pnpm lint
pnpm typecheck
pnpm test <targeted files>
```

Before final handoff:

```text
pnpm check
```

Live OpenCode tests remain opt-in and bounded. Normal CI must use deterministic mock upstreams.

## 8. End-to-end acceptance scenarios

The implementation is ready for the evidence-gated relay experiment only when all scenarios below
pass:

1. Opening the TUI proxy screen causes no process start and no upstream traffic.
2. Enabling an API-key OpenCode account starts one child, one lease, and uses API mode.
3. Enabling an OAuth-only OpenCode account starts one child and selects public mode.
4. Starting a gateway does not change an unbound Claude/Codex configuration.
5. Two different provider gateways can run without settings-file oscillation.
6. `/health` works offline and does not read auth/catalog state.
7. The first actual model/inference request lazily loads the catalog.
8. Public requests use only the public contract and cannot select a paid-only model.
9. A non-loopback host fails before spawn.
10. A 429 inference reaches upstream once, preserves `Retry-After`, and opens cooldown.
11. A second request during cooldown is rejected locally.
12. Client abort, network error, 500, and partial stream never duplicate inference.
13. Direct egress remains behavior-compatible after the egress seam is introduced.

## 9. Coding-agent stop points

- The first coding assignment should implement PR 1 only.
- After PR 1 passes, continue with PRs 2–3.
- PR 4 is the first user-visible functional milestone.
- PRs 5–6 establish the correct egress/rate policy boundary.
- Stop after PR 6 and report evidence/results.
- Do not implement PR 7 until the user explicitly confirms an alternate egress/relay and the A/B
  evidence gate passes.
