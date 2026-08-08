# ADR-0013: One public Proxy Hub routes exact model IDs to provider-owned backends (HUB-01)

- Status: accepted (2026-08-03)

## Context

Hotplug could start one compatibility proxy for each account or provider. That
keeps each provider isolated, but clients that use several subscriptions need
several endpoints and cannot select a model from a single catalog. A shared
endpoint must not solve this by encoding ownership in model names (`cx/`,
`kr/`, and similar prefixes): those IDs leak implementation details into user
config, prompt files, and client model pickers.

The new listener still handles bearer credentials, provider OAuth material, and
streaming request bodies. It must preserve the proxy boundary in ADR-0006 and
the planned activation / rollback contract, rather than becoming an
un-journalled shortcut around activation.

## Decision

1. **Proxy Hub has one public, loopback-only listener per Hotplug root.** It
   exposes an OpenAI-compatible endpoint and holds no provider credentials in
   its client-facing state. Provider adapters may start private ephemeral
   loopback backends in the same Hub process, but those are implementation
   detail and are not published as user endpoints.
2. **Routes are exact, token-scoped manifests.** Activation creates an opaque
   route ID and high-entropy bearer token for one client. The token can only
   read and invoke models in that route's persisted manifest; it is stored in
   SQLite and crosses only from the executor into the client config. Status,
   CLI JSON, TUI, Tray, and logs receive no token (ADR-0006).
3. **Model IDs remain unchanged.** A model owned by exactly one enabled source
   is routable by that exact ID. A collision is absent from the public catalog
   until the user records an explicit owner. There is no first-source-wins
   fallback and no provider prefix convention.
4. **Providers own backend construction.** A provider opts in through
   `createProxyHubBackend`; core does not switch on provider IDs or infer a
   cross-provider pairing. Client compatibility is still decided by
   `transportFor` in the source adapter.
5. **Hub actions are normal activation steps.** Plans explicitly ensure the
   listener, attach the client manifest, wait for health, and validate the
   token-scoped catalog. The executor records inverse operations from those
   steps. Hub config, runtime records, and manifests use the mutation
   coordinator with the Hub plus relevant provider scopes (ADR-0009 and
   ADR-0011).

## Consequences

- Users choose `Proxy Hub` once and then use ordinary provider model IDs.
- Enabling a provider account is independent from starting the Hub; a disabled
  source cannot receive traffic.
- A Hub route is deliberately client-specific. Two clients can have different
  allowed model sets and revoking one client does not revoke the other.
- Provider pool support is opt-in at the provider backend boundary. A generic
  listener does not imply a provider's credential format or failover semantics
  can be pooled safely.
- TUI and Tray display only secret-free Hub health and source/model counts. The
  TUI/CLI owns collision resolution, so secrets never enter a desktop-helper
  protocol.

## Rejected alternatives

- **Keep a public proxy for every provider and add a switcher in front.** It
  leaves clients with several endpoints and keeps lifecycle state fragmented.
- **Prefix every model with a provider alias.** It prevents collisions but
  makes a provider implementation choice part of every user-facing model ID.
- **First enabled source wins on a duplicate.** Source ordering is mutable;
  silently changing it would route an unchanged model name to a different paid
  account.
- **Put all provider proxy code in Hub core.** It would make the composition
  root provider-specific and bypass the adapter capability authority.
