# ADR-0037: Proxies record served token usage, and AnyPick estimates its cost from a dated price table

- Status: accepted (2026-10-27)
- Related: [0006](0006-proxy-authentication.md), [0009](0009-mutation-coordinator.md),
  [0034](0034-loopback-management-api.md)

## Context

The proxies, pools and the hub see every response they serve, and every
vendor reports token counts in the response. AnyPick kept none of it: the only
per-request record was one access-log line (method, path, status, latency) and
in-process counters on `/health`. A user who routes several clients through
several accounts could not answer "how much did I use this week, on which
account, with which model", nor "what would that have cost on the API".

## Decision

1. **The serving leaf meters the response it sends.** `proxy.MeterUsage` wraps
   the writer of the single-account proxy, of each pool member attempt, and of
   each hub account attempt (a hub pool step is metered by the pool's own
   ring, never twice). It reads the bytes already going to the client: the
   `usage` object (OpenAI chat, OpenAI Responses, Anthropic, including
   Anthropic's split across `message_start` and `message_delta`), Gemini's
   `usageMetadata`, and the model id. Translated and passthrough responses are
   metered by the same code because both arrive in the client's protocol.
2. **Only 2xx responses are recorded.** A refusal held back for failover never
   reaches the metered writer, and a final error is not usage. Error rates stay
   in the `/health` counters.
3. **A row holds counts and identifiers only** (ADR 0006): time, route,
   provider, account, model, status, four disjoint token counts (input
   excluding cache, output, cache read, cache write) and whether the vendor
   reported usage at all. Never a body, a header or a credential. The model id
   is the one vendor-supplied value; it is stored only if it matches a bounded
   model-id pattern, otherwise as empty.
4. **`usage_events` is owned by `internal/usagelog`** and kept 90 days, pruned
   when a writer starts and when history is read. It has no foreign key to
   `accounts`: removing an account must not rewrite what was spent.
5. **Writes bypass the coordinator lock.** Rows are append-only and never read
   back and rewritten, so the lock (ADR 0009) would serialise nothing SQLite
   does not; taking it would make served responses wait on another process's
   mutation. Each detached child batches events in memory (bounded, flushed
   every two seconds) and drops rather than grows when the database stays
   busy.
6. **Cost is an estimate from a dated table.** `internal/pricing/prices.json`
   is embedded with the date its prices were read and lists only prices read
   from a vendor's published list. A model it does not list gets no estimate,
   and summaries say how many requests that leaves out. Users add or correct
   prices in `<ANYPICK_HOME>/pricing.json`. A cache price the table does not
   list is charged at the input price, an upper bound. Prompt-size price tiers
   are not modelled. Every surface labels the figure an estimate at API list
   prices with its date: subscription logins are not charged per token.
7. **Two read surfaces share one read.** `anypick usage` and
   `GET /v1/usage/history` on the management API (ADR 0034) both answer from
   `App.UsageSummary`.

## Consequences

- The schema gains a migration. A data directory opened by this build is
  refused by an older one (`SCHEMA_NEWER`), as with every migration.
- An OpenAI-style stream without `stream_options.include_usage` carries no
  counts; it is recorded as a request with unreported usage, not as zero
  tokens. AnyPick does not add the option to client requests.
- The bundled table covers Anthropic's first-party prices only, as of its
  date. Prices change; the date is shown so a stale table is visible, and the
  override file is the escape hatch until the table is refreshed in a release.
- The desktop apps do not show usage history yet.
