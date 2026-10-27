# ADR-0035: Route by when quota resets, from a cache the request path only reads

- Status: accepted (2026-10-27)
- Amends: [0026](0026-pool-rotation-and-all-cooling.md) (adds a third strategy)
- Related: [0024](0024-pool-ring-total-deadline.md), [0013](0013-model-routed-proxy-hub.md)

## Context

Pools and the Proxy Hub had two strategies. `failover` keeps the account that
last served; `round-robin` spreads requests. Neither knows when an account's
quota comes back. Subscription windows reset on a clock (Codex's five-hour and
weekly windows, Claude's session and weekly limits), and quota left in a window
when it resets is gone. With several accounts, the one whose window resets
soonest is the one to spend first.

AnyPick could read reset times only for each provider's live login, and only
for display in the desktop app. Nothing stored them, and the pool and hub run as
detached children that cannot reach the desktop's memory.

## Decision

1. **A third strategy, `soonest-reset`,** for pools and the hub. Each request
   starts at the eligible account whose unused quota resets soonest. It is
   still a failover ring: a quota refusal moves to the next account, and the
   quota guard's cooldowns still decide eligibility.
2. **Reset times come from a per-provider cache file** next to the pool's
   runtime state. An entry records each window's remaining percent and reset
   time, and when it was read.
3. **The request path only reads the cache.** Fetching usage is a vendor call;
   doing it per request would add its latency and its failures to every
   request. A pool or hub child running `soonest-reset` refreshes its accounts
   in a background loop every five minutes.
4. **A saved account's usage is read from its own snapshot**, through an
   optional provider capability. It only reads: an expired token yields no
   reading, never a refresh, because a refresh rewrites the snapshot outside
   the account's lock. Codex and Claude implement it; other providers have no
   readings.
5. **Missing or stale readings fall back to failover order.** A reading older
   than thirty minutes is ignored, because a confidently wrong order is worse
   than the plain one. An account without a reading sorts after every account
   with one. A pool with no readings behaves exactly like `failover`.
6. **Only windows with quota left count.** An exhausted window's reset is when
   the account becomes usable again, which is the quota guard's cooldown, not
   quota at risk of being lost.

## Consequences

- An older binary refuses a hub config whose strategy it does not know
  (`decodeHubConfig`), so downgrading after choosing `soonest-reset` needs the
  strategy set back first.
- The strategy is only as good as its readings. An account whose saved token
  has expired drops to the back of the order until the account is refreshed.
- The cache is a file, not a table: like the quota guard's state, it is
  runtime data written by children, and losing it costs only the ordering.
