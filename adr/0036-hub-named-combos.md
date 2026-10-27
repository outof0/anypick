# ADR-0036: Named combos are models the hub defines, and the hub lists its models

- Status: accepted (2026-10-27)
- Amends: [0013](0013-model-routed-proxy-hub.md) (adds hub-defined model ids and
  a hub-answered model list)
- Related: [0030](0030-hub-child-freshness.md), [0035](0035-soonest-reset-routing.md)

## Context

The Proxy Hub routes a model id to the source that serves it, and on a quota
refusal moves to another account that serves the same id. It cannot express
"Claude Opus on my work account, then Claude Sonnet on the same account, then
GLM through an API key": every hop sends the same model id, and a pool source
ends the chain because it answers from inside its own ring.

Clients pick models by id, and a fallback chain is easiest to use when it is
one of those ids. Other routers call this a combo.

The hub also had no model list of its own. A `GET /v1/models` reached the
first source and returned that vendor's catalog, so a client listing models
through the hub saw one provider's ids, not what the hub can route.

## Decision

1. **A combo is a named, ordered list of steps** in the hub's configuration.
   Each step is a source already in the hub and the model id to send it. The
   name is a model id clients can request.
2. **A combo name wins over a pin and over a catalog id.** Choosing a combo
   name is an explicit decision, so it is honoured; the save refuses a name
   that collides with a pinned model, and the docs tell users to pick names no
   vendor uses.
3. **A combo request walks its steps in order.** Each step rewrites the
   request's model field to that step's model. The walk moves on only on a
   quota refusal or an unresolvable source, the same rule as the hub's own
   failover; any other answer is the client's answer. Steps whose account the
   hub's quota guard has cooled are skipped while another step is eligible.
4. **A pool step takes part in the walk.** Its ring answers through the same
   attempt recorder as an account, so a ring that is out of quota hands the
   request to the next step instead of ending it.
5. **The hub answers `GET /v1/models` itself.** It lists the route's pinned
   models, every model a single enabled source's provider publishes, and the
   combos. An id two providers both publish stays out unless pinned, as
   ADR-0013 already requires. When the hub knows no catalog at all it forwards
   the request as before, so a hub with empty caches does not list nothing.
6. **Combos live in the hub config document**, which the hub package already
   owns. Saving one bumps the config revision, so a running hub restarts onto
   it under ADR-0030.

## Consequences

- An older binary ignores the combos it reads, and its hub serves the combo
  name as an ordinary model id.
- Removing a source from a hub leaves combo steps that name it unresolvable;
  those steps are skipped at request time, and `proxy hub combo list` shows
  them, rather than the removal silently rewriting combos.
