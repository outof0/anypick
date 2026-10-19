# Contributing to AnyPick

Thanks for your interest in improving `anypick`.

AnyPick rewrites other tools' credential and config files and spawns local
proxies, so a careless change can corrupt a developer's real logins. The
review bar is correspondingly high, and the codebase is organised to make the
dangerous parts hard to get wrong by accident.

`AGENTS.md` (symlinked as `CLAUDE.md` and `GEMINI.md`) holds the invariants and
the traps that have cost real time. **Read it before your first change.** This
file covers the mechanics: how to build, where the layers are, and how a change
gets merged.

## Getting started

AnyPick is a Go project with two native front ends. There is no JavaScript
build at the root — `docs/` is a separate pnpm project and `src/tauri/ui` is the
Tauri app's own package, each with its own lockfile.

```bash
git clone https://github.com/outof0/anypick.git
cd anypick
make help          # the full target list
make build         # -> src/go/bin/anypick-dev
make test          # go test ./...
make sandbox ARGS="providers"
```

`make sandbox` runs the CLI against a throwaway `HOME` and `ANYPICK_HOME`, so
it never touches your real `~/.anypick`. Use it while developing anything that
writes state.

## Development workflow

| Command | What it does |
| --- | --- |
| `make test` | `go test ./... -count=1` |
| `make test-race` | the same under `-race` |
| `make vet` | `go vet ./...` |
| `make fmt` / `make fmt-check` | gofmt; CI fails if anything is unformatted |
| `make check` | every cross-language gate (see below) |
| `make run ARGS="providers"` | build, then run a command |
| `make sandbox ARGS="status"` | the same against a throwaway data root |
| `make open-macos` / `make test-macos` | the macOS app (Xcode) |
| `make install-tauri` / `make build-tauri-ui` / `make build-tauri` | the Linux/Windows app |

Run `make review` before opening a pull request — it is `fmt-check`, `vet`,
`test` and `check` in one command. CI runs those four plus `make lint`
(staticcheck), which needs `go install honnef.co/go/tools/cmd/staticcheck@v0.8.1`
if you want it locally.

### `make check` — the cheap cross-language checks

Three facts are asserted in more than one language, and nothing links them:

- where the repository root is, for every script that walks `../` to find it;
- the `working-directory:` of every GitHub Actions step;
- the desktop stdio protocol version, declared independently in Go
  (`internal/buildinfo`), Rust (`src/tauri/app/src/protocol.rs`) and Swift
  (`src/macos/AppServiceClient.swift`).

`make check` (`paths` + `check-protocol` + `check-release`) verifies all of them
in about a second. It exists because moving a directory, or bumping the
protocol on one platform only, produces a failure that is otherwise very hard
to trace. **If you move a directory under `src/`, run `make check-paths` first.**

## Architecture overview

The engine is Go. The macOS app is Swift; the Linux and Windows app is Tauri
(Rust + a small React UI). Both front ends talk to the same bundled Go service
over a versioned stdio protocol — they are presentation, not a second
implementation of the logic.

```
src/go/       the engine: CLI, terminal UI, desktop service, proxy, hub
src/macos/    the macOS app (SwiftUI)
src/tauri/    the Linux and Windows app (Tauri 2 + React)
docs/         the documentation site (its own pnpm project)
adr/          architecture decision records
```

Inside the engine:

- **Stores** (`internal/store`, and the per-table stores in `internal/journal`,
  `internal/pools`, `internal/hub`, `internal/presets`, `internal/bindings`,
  `internal/profile`, `internal/plugins`) own persistence in one SQLite
  database under `~/.anypick/anypick.db`. Services never reach past them into
  SQL.
- **Registries** (`ProviderRegistry`, `ClientRegistry`, `CatalogRegistry`)
  hold the pluggable implementations. They are sealed once startup finishes
  resolving adapters, so a long-lived process can never observe the graph
  changing mid-operation.
- **Services** (`AccountService`, `RuntimeService`, proxy, activation, …)
  orchestrate stores and registries. CLI, TUI and the desktop protocol call
  services.
- **Activation** is a three-stage pipeline: `activation/planner` builds an
  `ActivationPlan`, `activation/executor` interprets it, and
  `internal/journal` records every mutating step so a failed activation can be
  rolled back and recovered on the next startup.

`src/go/internal/app/app.go` is the composition root — the single place to read
the dependency graph.

### The mutation coordinator

Every persisted mutation runs under the coordinator with sorted, scoped locks
(ADR 0009, ADR 0011). Two rules follow, and both are load-bearing:

1. **Mutating store methods take the lock themselves** (via
   `AccountStore.mutate`), so correctness does not depend on the caller
   remembering to lock. `internal/store/coordinator_test.go` fails the build if
   a new mutating method bypasses it.
2. **Mutating store methods take `ctx` as their first argument and have no
   ctx-less form.** Re-entrancy is carried *in the context*: a method reached
   through a fresh `context.Background()` cannot see the lock its caller holds
   and will block on it forever. Deleting the ctx-less wrappers was deliberate
   — it makes the compiler refuse the mistake.

Inside a `func(c context.Context)` lock closure, use `c`, not the outer `ctx`.
`make check` will not catch this one; the lock timeout will, after five
seconds, with an error that says exactly what went wrong.

Compensation and rollback paths should use `context.WithoutCancel(ctx)`: they
have to be able to finish after the operation that triggered them is cancelled.

## Adding a client or account provider

1. Implement `ClientAdapter` / `Provider`.
2. Register it in-tree. There is no runtime registration hook: `app.Options`
   takes no provider, `app.New` takes a root string, and the registries are
   sealed once startup begins, so nothing can be added after compose (ADR 0031).
   For a provider that is a set of official endpoints and credential products,
   add a declarative compatible-provider definition instead — that is the
   supported extension point, and `provider.RegisterBuiltinCompatibles` loads
   it at startup.

   Registering a *client* means touching every site that enumerates one. Miss
   one and the feature half-works — it shows up in the CLI but not the desktop
   app, or activates but cannot be rolled back — which is worse than not
   landing it:

   - `internal/client/client.go` — the builtin registry.
   - `internal/transport/adapter.go` — every `TransportFor` closure that names
     accepted clients (gemini, grok, workbuddy, kiro, pool, generic).
   - `internal/runtime/service.go` — `PrepareClientConfigRecovery`, so a failed
     activation can restore what the adapter is about to overwrite.
   - `internal/desktop/snapshot.go` — `designAppName` and
     `managedAppClientIDs`.
   - `src/macos/ProductionModel.swift` — `providerSymbol`, `designAppName` and
     `nativeAppOrder`.
   - `docs/src/content/docs/concepts.mdx` — the client list.
   - `internal/tui/data.go` — `routingAppAllowlist`. `routingAppIDs` is the
     **only** place the terminal UI enumerates clients, so a client that is
     neither listed here nor a provider AnyPick can log in for is invisible
     there. `TestEveryRegisteredClientIsReachableInTheTUI` fails the build on
     exactly that. A client with no provider of its own (`zcode`) *must* be
     added; one whose login AnyPick already manages (gemini, kiro, opencode,
     workbuddy) must not.

   `internal/transport/adapter_matrix_test.go` requires an explicit expectation
   for every registered client in every adapter row, so a client that was
   registered but never classified fails the build instead of shipping as
   `Unsupported`.
3. Put the provider's **model policy** on the provider itself
   (`roleDefaults`, `suggestModels`, `roleFriendlyModels`,
   `staticFallbackModels`, `roleModelHints`). Core, CLI and TUI ask the
   provider; they must not grow a `switch (providerId)`. A provider that omits
   these gets neutral behaviour rather than another vendor's model ids.
4. Keep transport classification on the adapter's `sourceAdapter`. Capability
   pairs come from `TransportFor` in `internal/transport` — never infer one
   from the client registry, which lists what *exists*, not what is *allowed*.
5. Add tests next to the code, using `t.TempDir()` and
   `app.Options{SkipMigrate: true}`. Never let a test reach a developer's real
   `~/.anypick`.

Third-party plugin packages are a special case: a native build installs, pins
and enables them but **never executes them**. See
[ADR-0021](adr/0021-plugin-host-removed-from-native-builds.md).

## Commit and PR guidelines

- Keep PRs focused; one logical change per PR.
- Add or update tests for behaviour changes.
- Go must be gofmt-clean and `go vet` must be clean.
- Comments explain *why*, not what. Cite an ADR number when a constraint is
  load-bearing.
- **Review against `CODE_REVIEW.md`.** It holds the severity model, the area
  checklists, and what a reviewer owes you. Two rules from it are worth
  repeating here:
  - A finding that was a *family*, not a one-off, needs a new invariant test or
    gate alongside the fix — not only the fix (§5).
  - Self-review is not independent review. A risky change needs a reviewer that
    did not write it.

### Commit messages are the changelog

Release notes are generated from the commits in a tag range by
`changelogithub`, so write the subject line for someone reading the release,
not for the diff.

```
feat(tui): collect an API key, its region and its name on one form
fix(gemini): write the Antigravity credential back to the OS credential store
```

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat`,
  `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `chore`. Only `feat`,
  `fix` and `perf` appear in the notes.
- A breaking change needs `!` after the type (`feat(core)!: …`) or a
  `BREAKING CHANGE:` footer. That is what makes the next release a major.
- The scope is the area a reader would recognise (`tui`, `proxy`, `gemini`,
  `docs`), not a file name.

`CHANGELOG.md` holds one short, hand-written summary per release, written
when the release is cut; the full notes are generated from commits and
published on GitHub Releases. Do not add per-change entries to it.

### Cutting a release

Prepare the version in a reviewed PR, then publish the merged commit with the
manually dispatched GitHub Actions workflow. Before opening the version PR,
run `make plan-release` against the current release history: a breaking change
bumps major, `feat` bumps minor, and `fix` / `perf` bumps patch. If it reports
`mode=none`, there is no user-facing release to cut. Use the planned version in
`make set-version VERSION=x.y.z`, add one short summary under that version in
`CHANGELOG.md`, and commit the synchronized version files. The release workflow
checks that the version is stable, newer than the latest tag, and has a
changelog section; it does not edit `main`.

`VERSION` at the repository root is canonical. Five other places ship the same
number and must agree with it: `MARKETING_VERSION` in the Xcode project,
`version` in `src/tauri/app/Cargo.toml`, `version` in
`src/tauri/app/Cargo.lock`, `version` in `src/tauri/app/tauri.conf.json`, and
`version` in `npm/anypick/package.json`.
`make check-release` verifies all six;
`make bump-version PART=patch` or `make set-version VERSION=1.2.3` updates them
together.

The bump itself is decided from Conventional Commits by
`make plan-release` (`anypick-release plan`), which prints `mode`, `bump`,
`version` and `tag`. `mode=none` means there is no `feat`, `fix` or `perf`
commit since the current tag and the run stops before changing anything.
Adding a version source means adding it to `secondarySources` in
`src/go/cmd/anypick-release/version.go` — the check will not enforce it
otherwise.

The workflow is safe to rerun after a partial external failure: an existing
tag or published version is verified and reused rather than recreated. Its
default `all` scope publishes the macOS app, Linux and Windows desktop
installers, all CLI archives, and the npm launcher. The macOS app uses an
ad-hoc code signature in CI and is not notarized. `cli-only` skips desktop
installers. Linux and Windows installer payloads are smoke-tested on their
own OS (`packaging/smoke/`), including native WebDriver checks against the
packaged GUI and its bundled service. npm,
Homebrew and Scoop publishing default to enabled and can be disabled in the
workflow inputs. WinGet manifests are attached for manual submission when
Windows desktop artifacts are built.

## Code of conduct

Be respectful and constructive. This project follows the
[Contributor Covenant](CODE_OF_CONDUCT.md).
