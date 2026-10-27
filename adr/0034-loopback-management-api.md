# ADR-0034: A versioned, token-gated loopback management API

- Status: accepted (2026-10-27)
- Amends: [0020](0020-node-free-native-app-distribution.md) decision 6
- Related: [0006](0006-proxy-authentication.md) (proxy authentication),
  [0003](0003-process-lease-ownership.md) (ownership by instance echo),
  [0009](0009-mutation-coordinator.md) (mutations self-lock)

## Context

ADR-0020 decision 6 keeps desktop IPC on bounded stdio and rules out "a
localhost control API" without another ADR. That rule is about the desktop
app: the Swift and Rust hosts own the engine through stdio, and nothing
should give them a second, divergent channel.

It never covered `anypick serve`, which predates the ADRs. That command already
ran a loopback HTTP server with `/health`, `/status` and `/agents`, and with no
authentication at all. `/status` returned each account's raw stored identity,
read through a locking path. Nothing in the repository called `/status` or
`/agents`.

Third-party tools want what `serve` half offered: tray apps, status lines,
dashboards and editor extensions that read quotas and switch accounts. The
competitor review that prompted this (CLIProxyAPI) found that a stable
management API is what an ecosystem of such tools builds on. Without one, the
only integration path is spawning the desktop engine over stdio, which is the
private protocol ADR-0020 means to keep private.

## Decision

1. **`anypick serve` is the management API.** It is a versioned HTTP API under
   `/v1`, and it is the only localhost control API. The desktop hosts keep
   stdio and do not use it; ADR-0020 decision 6 still holds for them.
2. **Loopback only, asserted in the server.** It binds `127.0.0.1`. Every
   request must also name the bound address in `Host` (`127.0.0.1`,
   `localhost` or `[::1]` with the bound port), which defeats DNS rebinding.
3. **A per-install bearer, checked on every route but `/health`.** The token is
   32 random bytes in `serve.token` under the data directory, mode 0600. It is
   compared in constant time and fails closed when absent. It is read per
   request, so rotation takes effect without a restart. `/health` stays open
   and secret-free, as ADR-0006 decision 4 keeps it for proxies.
4. **No browser can call it.** A request carrying `Origin` is refused, and a
   `POST` must send `Content-Type: application/json`, which a cross-origin page
   cannot send without a preflight the API never answers.
5. **No secret crosses it.** Responses never carry a proxy, hub or upstream key,
   a stored credential, or a raw identity. Identities go through the same
   display-safety filter as the desktop snapshot, and metadata is read through
   the non-locking cached path. There is no token-read endpoint: retrieving a
   key stays the job of the `proxy token` and `proxy hub token` commands.
6. **Actions are explicit resources, not desktop action ids.** Switching an
   account, starting or stopping an account proxy, and starting or stopping a
   hub are each a `POST` on a named resource. They call the same services the
   CLI calls, which take their own locks (ADR-0009), and they share the CLI's
   implementation where one exists. The desktop's revision-scoped action ids
   are not exposed.
7. **The unauthenticated `/status` and `/agents` routes are removed.** They had
   no callers. Their content moves under `/v1`, behind the token.
8. **`anypick serve token [--rotate]` prints the bearer.** Like `proxy token`,
   it is a sanctioned exception to the rule that secrets never reach output,
   because retrieving it is its purpose.

## Consequences

- A tool integrates by reading `serve.token` (or running `anypick serve
  token`) and calling `http://127.0.0.1:<port>/v1/...`. The port is in
  `serve.pid` and in the output of `anypick serve --detach`.
- Breaking a response shape needs `/v2`. Adding fields does not.
- Anyone who can read the data directory can drive the API. That is the same
  standing that already reads saved account snapshots there, so the token adds
  no new trust boundary; it stops other local users and web pages.
- Usage history and quota caches, when they exist, are published here rather
  than through a second surface.
