# ADR-0012: Plugins are explicitly enabled, digest-pinned, and never fatal (EXT-01)

- Status: accepted (2026-07-26)

## Context

Hotplug's extension points were already open: `ProviderRegistry`,
`CatalogRegistry`, and `ClientRegistry` accept third-party implementations, and
`tests/provider-extension.test.ts` proves an out-of-tree provider is a
first-class citizen. But the only way to use them was to depend on
`@hotplug/core` and compose your own `createApp` — the shipped binary loaded
exactly the built-ins. Every real extension request ("add a provider we run
internally", "point a client we wrote at an account") therefore required forking
the CLI.

Loading third-party code changes the threat model rather than extending it.
Hotplug's process reads and rewrites live credential files for Claude, Codex,
Gemini, and Kiro, and holds per-instance proxy secrets in memory (ADR-0006). Any
module `import()`ed into that process can read all of it at module top level,
before a single line of plugin API is called. `SECURITY.md` previously claimed
plugins are never loaded, which was true and load-bearing.

Two structural constraints also had to be respected. `createApp` is
**synchronous** and seals all three registries the moment it returns, on
purpose: a long-lived TUI process must not resolve a different provider graph
half way through an activation. And `import()` is **asynchronous**. So plugin
code cannot be fetched at the point it needs to register.

## Decision

1. **Presence on disk is not permission to run.** `hotplug plugin add <dir>`
   records a plugin **disabled**. Enabling is a separate, interactive decision
   (`hotplug plugin enable`, which prompts, or `--yes`), because that is the
   moment the user grants in-process execution alongside their credentials.
   `HOTPLUG_NO_PLUGINS=1` skips loading entirely, for bisecting a bad plugin.
2. **The trusted artifact is a SHA-256 digest of the entry module, verified
   before `import()`.** `add` and `trust` pin it; the loader recomputes and
   compares it, and refuses on mismatch with `PLUGIN_UNTRUSTED`. Verification
   after the import would be theatre — top-level code has already run. A changed
   plugin stops loading until the user reviews it and runs
   `hotplug plugin trust`, so an upgrade or a `git pull` in a plugin directory is
   surfaced rather than silently adopted.
3. **The registry lives in SQLite, not a config file.** Plugin mutations are
   transactional with the rest of the data root and run under the coordinator on
   a single `plugins` scope (ADR-0009), and no plugin can enable itself by
   writing a file the loader happens to read.
4. **Discovery and `import()` happen in `createAppReady`; `activate()` runs
   synchronously inside `createApp`, after the built-ins and before `seal()`.**
   This is what reconciles async loading with a sealed graph: plugin
   contributions land inside the same registration window as the built-ins, and
   the sealed-registry guarantee is unchanged. A plugin cannot shadow a built-in
   and cannot register anything after startup.
5. **The plugin API is three register functions and nothing else.**
   `PluginContext` exposes `registerProvider`, `registerClient`,
   `registerCatalogProvider`, an `apiVersion`, and the plugin's own root path. It
   does not carry the database, the stores, the services, or the data root. A
   plugin extends the *composition graph*; it does not receive an ambient
   capability to read the credential snapshots that graph manages. `apiVersion`
   is checked against `PLUGIN_API_VERSION` at manifest parse time, so an
   incompatible plugin is refused with a version message instead of a
   `TypeError`.
6. **A refused plugin is a degraded condition, not a crash.** Load failures are
   collected into `pluginRuntime.failures`, emitted as `plugin_load_failed`
   events (ADR-0010), listed by `hotplug plugin list`, and reported by `doctor`.
   The framework's job is switching real logins; one broken third-party
   extension must not make `hotplug` unusable.
7. **A plugin entry may not escape its own directory.** `resolveEntry` rejects an
   absolute `main` and any path that resolves outside the plugin root, so a
   manifest obtained from a third party cannot make Hotplug import an arbitrary
   module from elsewhere on disk under the plugin's name.

## Consequences

- The advertised extension points are reachable from the shipped binary. Adding a
  provider or client no longer requires forking the CLI.
- `SECURITY.md` is amended: Hotplug now loads third-party code, but only code the
  user installed by path and enabled by name, and only at a digest they
  approved. It still never downloads or installs anything itself — there is no
  registry, no `npm install`, and no auto-update.
- A plugin that throws inside `activate` keeps whatever it registered before the
  throw. Unwinding a partial contribution would mean removing entries from a
  registry, which is precisely the mutable-graph behaviour sealing exists to
  prevent. The failure is reported instead.
- Editing a plugin during development means re-running `hotplug plugin trust`.
  This is the intended friction: the digest is the trust decision, not a cache.
- Plugin failures are visible in three places (events, `plugin list`, `doctor`)
  because a plugin silently not loading looks identical to a plugin that never
  worked.

## Rejected alternatives

- **Load whatever is present in a plugins directory.** Drop-in loading makes any
  process that can write one file a code-execution vector against live
  credentials. Explicit enable is the whole boundary.
- **A `plugins` array in the config file.** A file a plugin can write is a file a
  plugin can use to enable itself; it also would not be transactional with the
  rest of the data root.
- **Pinning a digest of the whole plugin tree.** Would make every unrelated file
  change — a README, a lockfile — an untrusted event, training users to run
  `trust` reflexively. The entry module is what gets executed.
- **`await import()` lazily at first use, keeping registries unsealed.** Would
  let a long-lived process resolve a different provider graph mid-activation,
  reintroducing exactly what sealing closed.
- **Handing plugins the `HotplugApp`.** Ergonomic and unbounded: it would grant
  every plugin read access to every credential snapshot and proxy secret. If a
  future plugin genuinely needs more, widening `PluginContext` is a security
  decision that gets its own ADR.
- **Aborting startup on a plugin failure.** A tampered or broken plugin would
  lock the user out of switching their own logins.
