# ADR-0006: Local credentialed proxies authenticate every request (PROXY-01)

- Status: accepted (2026-07-20)
- Task: PROXY-01 (authenticate every local credentialed proxy request)

## Context

The Gemini, Grok, and OpenCode compatibility proxies previously trusted loopback
plus a hardcoded placeholder key `'hotplug-proxy'` that no code path validated.
Any local process able to reach `127.0.0.1:<port>` obtained full upstream
credential authority — it could list catalogs and forward inference requests
carrying the local user's OAuth token / API key to the upstream provider. Looback
is necessary but not sufficient as a security boundary on a multi-tenant or
shared machine.

Three gaps existed:

1. A fixed, non-random key (`hotplug-proxy`) that could be guessed or copied.
2. No verification at the routes that actually exercise upstream authority
   (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`).
3. The OpenCode proxy server did not assert loopback inside its own `create*`
   boundary — only the production `main.ts` wrapper did — so any other caller of
   `listenOpenCodeProxy` skipped the check.

This ADR records how PROXY-01 closes all three.

## Decision

1. **Per-instance high-entropy secret.** Each proxy start generates
   `randomBytes(32).toString('hex')`. The secret is persisted in the owner-only
   `proxy_state` record (mode `0o600` DB), reused across restarts, and threaded
   through every start / realign / reuse path. It is transmitted to the child
   **only** via the `HOTPLUG_PROXY_TOKEN` environment variable. No fixed default
   key survives.
2. **Constant-time, fail-closed verification.** A shared `requireProxyAuth(req,
   res, expectedToken)` helper accepts the secret via the client protocols' own
   credential headers (`Authorization: Bearer <t>` or `x-api-key: <t>`),
   normalizes to local authentication, and compares in constant time
   (`crypto.timingSafeEqual`, run over a length-mismatch path too). When
   `expectedToken` is empty/unset, the proxy is misconfigured — it fails closed
   with `401` rather than admitting traffic.
3. **Every credential-authority route is gated.** Model catalog and all
   inference routes require the token before contacting upstream. The upstream is
   therefore never reached on a missing/incorrect token (verified in
   `tests/proxy-auth.test.ts`).
4. **Liveness stays unauthenticated but secret-free.** `/health` needs no
   credential and returns only process state plus the echoed `instanceId`
   (`HOTPLUG_INSTANCE_ID`). It never returns the proxy secret, any client key, or
   any upstream credential.
5. **Loopback enforced inside every server boundary.** The OpenCode server now
   calls `assertLoopbackHost(opts.host)` at the start of `createOpenCodeProxy`
   (matching Gemini and Grok), so loopback is guaranteed regardless of caller.
6. **Redaction.** The secret is never logged, written into plans, errors, status
   JSON, or doctor output; it is transmitted only via the dedicated env var.

## Consequences

- A local process without the per-instance token gets `401` and cannot use the
  upstream credentials. The token is scoped to one proxy instance / account.
- CORS / `Origin` is not used as authorization: requests without an `Origin`
  header are still authenticated by the token (no CSRF handshake via CORS).
- Bound clients (Claude Code, Codex) receive the token in their synthesized
  proxy profile `apiKey`, so legitimate traffic is unaffected.
- `/health` remains usable for liveness checks by any local observer, but leaks
  no secret.
- New regression suite `tests/proxy-auth.test.ts` (15 cases across all three
  proxies) encodes the missing / incorrect / valid / no-Origin / health-leak
  behaviors.

## Rejected alternatives

- **Reuse the client's upstream credential as the proxy token.** Fails because
  the provider credential is forwarded upstream verbatim; it cannot also gate the
  proxy without leaking it. A distinct per-instance local secret is required.
- **Per-request signature / mTLS.** Heavier than loopback + token for the
  local-only threat model; the per-instance token already closes the gap for the
  supported deployment.
