# Contributing to hotplug

Thanks for your interest in improving `hotplug`!

Working with an AI coding tool? `AGENTS.md` (symlinked as `CLAUDE.md` and
`GEMINI.md`) holds the invariants and the traps that have cost real time. This
file stays the reference for layering and lint policy.

## Getting started

```bash
pnpm install
pnpm build
pnpm dev --help
```

## Development workflow

- `pnpm format` — reformat with oxfmt
- `pnpm lint` — static analysis with oxlint (type-aware)
- `pnpm typecheck` — strict production and test type contracts
- `pnpm test` — run the vitest suite
- `pnpm check` — runs all of the above in order (what CI runs)

Please run `pnpm check` before opening a pull request. CI will run the same
command and will fail the build on any failure.

### Lint policy

The `typescript/no-unsafe-*` family and `no-floating-promises` are **errors** in
`src/`. This tool rewrites credential files and spawns proxies, so an
accidentally-`any` value reaching a filesystem or process call is a real hazard —
these rules already caught a live `ReferenceError` on the `account refresh`
error path.

Two deliberate exceptions:

- `no-unsafe-type-assertion` is **off**. Enabling it reports 266 violations,
  nearly all of them the intentional "assert the shape of a database row or an
  untrusted JSON payload" pattern. Turning it on would mean either 266
  suppressions or a schema-validation project; revisit as its own change, not as
  a drive-by.
- The `no-unsafe-*` rules are **off under `tests/**`**, where oxlint's type
  resolution disagrees with `tsc` on some ES2023 built-ins (`Array#toSorted`
  resolves as `error`-typed) and produces false positives. `pnpm typecheck`
  still covers tests in strict mode.

New `any` in `src/` should be narrowed at the boundary rather than suppressed.
`src/core/db.ts` shows the intended pattern: row shapes stay `any` because they
are genuinely dynamic, but `run()` returns a typed `SqlRunResult` — typing that
one return removed 42 downstream violations.

## Architecture overview

`hotplug` is layered. Read `src/core/app.ts` first — it is the composition
root that wires every store, registry, and service together and is the single
place to understand the dependency graph.

- **Stores** (`src/core/*-store.ts`) own persistence (a single SQLite
  database under `~/.hotplug/hotplug.db`). Services never embed SQL.
- **Registries** (`ProviderRegistry`, `ClientRegistry`, `CatalogRegistry`)
  hold the pluggable implementations. Adding a client or account provider
  means implementing its interface and registering it in
  `src/providers/index.ts` / `src/clients/index.ts`.
- **Services** (`AccountService`, `BindingService`, `RuntimeService`,
  `DoctorService`) orchestrate stores + registries. CLI/TUI call services,
  never stores directly.
- **Activation** is a three-stage pipeline: `activation-planner` builds an
  `ActivationPlan` (list of `PlanStep`s), `activation-executor` interprets
  that plan, and the `OperationJournal` records every mutating step so a
  failed activation can be rolled back and recovered on next startup.

## Adding a client or account provider

1. Implement `ClientAdapter` / `Provider` (see `src/types.ts`).
2. Register it in the appropriate `index.ts` — or, for a third-party provider,
   pass it to `createApp({ accountRegistry })` before the app is created.
   Registries are sealed once services start resolving adapters.
3. Declare the provider's **model policy** on the provider itself
   (`roleDefaults`, `suggestModels`, `roleFriendlyModels`,
   `staticFallbackModels`, `roleModelHints`). Core, CLI, and TUI ask the
   provider; they must not grow a `switch (providerId)`. A provider that omits
   these gets neutral behaviour rather than another vendor's model ids.
4. Keep transport classification on the adapter's `sourceAdapter`.
5. Add tests under `tests/` using `createAppReady` against a temp root.
   `tests/provider-extension.test.ts` is the reference: it defines a provider
   entirely outside the framework, registers it through the public API, and
   drives a full activation. If a change breaks third-party extensibility, that
   test should fail.

## Writing a plugin

A plugin ships the same `Provider` / `ClientAdapter` / `CatalogProvider` you
would write in-tree, but installs into a released binary instead of requiring a
fork. It is a directory with a `hotplug.plugin.json` and an ESM entry module:

```json
{
  "name": "acme-provider",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "dist/index.mjs"
}
```

```js
export default {
  activate(ctx) {
    ctx.registerProvider(new AcmeProvider());
  },
};
```

`activate` is synchronous and runs inside the window where the built-ins
register, immediately before the registries seal — so do all registration there
and never hold onto `ctx` for later. `PluginContext` is deliberately only the
three register functions: there is no database, no store, and no data root. If
you need something more, open an issue; widening it is a security decision
(ADR-0012), not an ergonomics one.

```bash
hotplug plugin add ./acme-provider   # installs it disabled
hotplug plugin enable acme-provider  # the trust decision — prompts
hotplug plugin trust acme-provider   # re-pin after you rebuild
```

The last one is the part that surprises people during development: the enabled
digest covers your entry module, so every rebuild needs a `trust` before the
plugin will load again. `HOTPLUG_NO_PLUGINS=1` disables loading if you need to
tell a plugin bug from a framework bug. `tests/plugins.test.ts` writes a real
plugin directory to a temp root and loads it end to end — copy its shape.

## Commit and PR guidelines

- Keep PRs focused; one logical change per PR.
- Add or update tests for behavior changes.
- Follow the existing code style (enforced by `oxfmt` + `oxlint`).

### Commit messages are the changelog

Release notes are generated from the commits in a tag range by `changelogithub`,
so write the subject line for someone reading the release, not for the diff.

```
feat(tui): collect an API key, its region and its name on one form
fix(gemini): write the Antigravity credential back to the OS credential store
```

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat`,
  `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `chore`. Only `feat`,
  `fix` and `perf` are listed in the notes; the rest stay out of them.
- A breaking change needs `!` after the type (`feat(core)!: …`) or a
  `BREAKING CHANGE:` footer. That is what makes the next release a major.
- The scope is the area a reader would recognise (`tui`, `proxy`, `gemini`,
  `docs`), not a file name.

### Cutting a release

`pnpm release` runs the full check, then `bumpp` picks the version, commits the
bump, tags it and pushes. Pushing the tag is what triggers `release.yml`, which
publishes the generated notes. Nothing is published to npm automatically.

## Code of conduct

Be respectful and constructive. This project follows the
[Contributor Covenant](https://www.contributor-covenant.org/) in spirit.
