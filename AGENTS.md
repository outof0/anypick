# Working on AnyPick

AnyPick points AI coding clients at AI accounts you already have. It rewrites
other tools' credential and config files and spawns local proxies, so a careless
change corrupts a developer's real logins. Bias toward verifying over assuming.

The engine is **Go** (`src/go/`): CLI, terminal UI and desktop service all run from
one bundled binary (ADR 0020). The macOS app is Swift (`src/macos/`). Distribution
is source checkouts plus GitHub Release assets (signed macOS app and CLI archives
first), a thin npm launcher in `npm/anypick/`, and package-manager metadata
generators in `packaging/` (Homebrew/WinGet/Scoop), all opt-in at release time.

`CLAUDE.md` and `GEMINI.md` are symlinks to this file — edit this one.
`docs/AGENTS.md` is its own document and covers the docs site, which has
different rules; `docs/AGENT.md` is the nimbus template's own authoring guide.

## Commands

`make test` is `go test ./...`. Nothing wraps it. Run `make help` for the full
list; the ones you will actually use:

```bash
make test                      # go test ./... -count=1
make test-race                 # the same under -race
make vet
make fmt-check                 # fails if anything is not gofmt-clean
make lint                      # staticcheck; wants it at $(go env GOPATH)/bin
make check                     # every static gate: fmt-check, vet, cross-file references
make review                    # check + test: the CODE_REVIEW.md §4 gates in one command
make build                     # -> src/go/bin/anypick-dev
make clean                     # remove build output; the only cleanup entry point

make run ARGS="providers"      # build, then run a command
make sandbox ARGS="providers"  # same, against a throwaway HOME + ANYPICK_HOME

make check-release             # every version source agrees with VERSION
make bump-version PART=patch   # also: make set-version VERSION=1.2.3
make check-artifact ROOT=path  # ADR 0020 §8: no Node runtime in the artifact

make open-macos                # open src/macos/AnyPick.xcodeproj
make test-macos                # xcodebuild unit tests
```

There is no root `package.json` and no pnpm workspace: the repository has no
JavaScript build and no `scripts/` directory — a `Makefile` and Go tooling are
all there is. The Node projects are `docs/` (the documentation site, with its
own lockfile) and the dependency-free npm launcher in `npm/anypick/` (no
dependencies, so no lockfile).

CI (`.github/workflows/ci.yml`) runs nine jobs: `check`
(format/vet/staticcheck/actionlint/pin-resolution), `go` (Ubuntu vet, test and
race), `linux-cli-headless` (static CLI smoke), `go-windows`, `tauri` (app check
and UI build), `macos-app` (app, helper contract and universal build), `macos-ui`
(XCUITest, non-blocking), `docs`, and `distribution` (npm launcher, packaging
adapters and payload smoke). Run the Go ones before you claim a change is done.

> **GOPATH trap.** `~/.zshrc` currently exports `GOPATH="$HOME/workspace/ocg/go"`,
> which is *another project's* module cache. Tests that shell out to `go build`
> (`cmd/anypick`'s `requireBuiltCLI`) then stall in module resolution and the
> package times out after many minutes — which looks exactly like a change you
> just broke. It cost hours once; check this before debugging any code.
>
> The Makefile pins `GOPATH := $(HOME)/go` and **exports** it, so `make` targets
> are always safe. The export is global on purpose: two builds spawn `go`
> indirectly and inherit the environment — Xcode runs
> `src/macos/scripts/bundle-go-helper.sh`, and `cargo tauri build` runs
> `src/tauri/app/build.rs`. Scoping the pin to the Makefile's own `go`
> invocations would hand the wrong module cache to both.
> If you run `go` directly, use `GOPATH=$HOME/go go test ./...` (warm once with
> `go mod download all`). The real fix is to delete that export from `~/.zshrc`:
> Go modules have not needed GOPATH since 1.16.
>
> **`go` may not be on your `PATH` at all.** `~/.zshrc` here also exports a
> `GOROOT` and a `PATH` entry for a `go@1.21` that is no longer installed, so a
> bare `go` fails with `command not found` (exit 127) — which reads exactly like
> a change that broke the build, and is how a gate quietly stops being run.
> Every `make` target that shells out to Go depends on `go-toolchain`, which
> fails with the install instructions instead of a bare 127; point it at a
> toolchain you already have with `make GO=/path/to/go/bin/go <target>`. A
> direct `go` invocation still needs `export PATH=<go-install>/bin:$PATH`. Keep
> `GOTOOLCHAIN=auto` (Go's default): the module requires go1.26, and an older
> local toolchain delegates upward only under `auto`.

The docs site is a **separate** pnpm project with its own lockfile:

```bash
cd docs && pnpm install && pnpm dev    # site only
cd docs && pnpm build
```

Your shell's working directory does not persist between tool calls, so prefix
every docs command with `cd docs &&` in the same invocation or you will silently
run it against the wrong project.

## Where the authority lives

| Question | Read |
| --- | --- |
| How is this layered? What do I implement to add a client/provider? | `CONTRIBUTING.md` |
| How does everything wire together? | `src/go/internal/app/app.go` — the composition root |
| How is a release produced and distributed? | `packaging/README.md` and `.github/workflows/release.yml` |
| *Why* is it like this? | `adr/` — cite records by number |
| What did we consider before? | `docs/history/` — **superseded proposals, provenance only.** Not the current spec. |
| What do users believe? | `docs/src/content/docs/` and `README.md` |
| How is a change reviewed? | `CODE_REVIEW.md` — severity, checklists, and when a finding needs a gate |
| How must the macOS app look and behave? | `src/macos/README.md`. Ship native controls. The Pen design file is product IA/content (not pixel-perfect; Pen is not 100% native) and is **not committed**: `/design/` is gitignored, so it is available only to someone with the design workspace. `src/macos/README.md` holds the contract that is enforced. |

Do not edit an accepted ADR to reflect new thinking; write a new one and mark the
old superseded.

## Invariants

Breaking one of these is a correctness or security regression, not a style nit.

1. **Capability pairs come from the adapters** in `src/go/internal/transport`.
   `claude`, `codex`, `opencode`, `zcode`, `dsh`, `commandcode`, `pi` and
   `omp` may accept a
   source from a different provider. A `gemini` or `kiro` *account* also serves
   those eight through the proxy (`ManagedBuiltinProxy`); it is the `gemini` and
   `kiro` *client* that returns `unsupported` for anything but their own, so
   nothing can be pointed at them. Do not read the account rule as a client rule
   or the reverse. The `grok` account adapter also serves the same eight
   (`GrokAccountAdapter`); it is absent from earlier revisions of this list,
   which is why the matrix test below is the authority and this prose is not.
   The workbuddy *client* uses
   its own login directly, so every other adapter still returns `unsupported`
   for it; a workbuddy *account* still serves `claude`,
   `codex`, `opencode`, `zcode`, `dsh`, `commandcode`, `pi` and `omp`
   through the proxy.
   Switching the WorkBuddy app itself between saved accounts works natively:
   the provider restores the desktop session file
   (`workbuddy-desktop-ai.info`), so the running app follows.
   `cline` is a provider login with no *client* adapter yet, so nothing can be
   pointed at it. Its own account adapter still classifies the `cline` client
   `ManagedBuiltinProxy` — Cline's subscription client is proxy-backed — and
   every other adapter returns `unsupported` for it.
   `src/go/internal/client` lists what *exists*, not what is *allowed* — never
   infer a pairing from the registry, and never publish one in docs or
   marketing copy without reading the adapter.
   `internal/transport/adapter_matrix_test.go` requires an explicit expectation
   for every registered client in every adapter row, so adding a client without
   classifying it there fails the build. It is an external test package for one
   reason: `internal/client` imports `internal/transport`, so a test in
   `package transport` cannot see the registry, and a hand-written client list is
   exactly what let `grok` ship unclassified.
2. **Proxy secrets never cross an output boundary.** Every local proxy
   authenticates each request with a per-instance secret (ADR 0006) and binds
   loopback only. `StartResult.Token` never reaches a status, start, snapshot or
   log surface: the CLI (`anypick proxy start`), the TUI
   (`src/go/internal/tui/toggleProxyCmd`), the desktop protocol and the
   management API (`anypick serve`, ADR 0034, `internal/mgmtapi`) all surface
   the endpoint only, and JSON output lands in CI logs. The one sanctioned exception
   is the dedicated `anypick proxy token <provider> <account> [--rotate]`
   command (and `proxy hub token`, and `anypick serve token` for the
   management API's own bearer, ADR 0034), which prints the bearer in human and
   `--json` form because retrieving it is its purpose. ADR 0006 does not name
   this exception; its §6 is the redaction rule the exception departs from;
   `cmd/anypick/status_secret_test.go` pins both halves of that split. An earlier
   wording here claimed the token was discarded by *every* caller, which was
   false and read as an argument against fixing a leak.
3. **Activation is planned, journalled, then executed.** `ActivationPlan.steps`
   is the single source of truth for execution; the executor must not re-derive
   behavior from transport capability, or planner and executor can diverge
   silently. Rollback is *not* a second planned list — it is the executor's undo
   stack run in reverse plus the journal replay in `recovery.go`. The plan used
   to carry a `Rollback` field nothing read, which asserted compensations the
   executor never performed; it was deleted rather than left to drift.
4. **`writeMeta` is the atomic commit point** for an account snapshot — a failed
   backup or import can never destroy the previously saved account (ADR 0004).
5. **Every persisted mutation runs under the coordinator** with sorted, scoped
   locks (ADR 0009). Correctness must not depend on the caller locking, so
   mutating store methods take the lock themselves via `AccountStore.mutate`:
   the services' `WithMutationLock` wrappers are now a broader-scope
   *optimisation*, not the thing that makes the write safe. Account mutations
   lock `providerScope(id)` — one scope per *provider*, not per account,
   because all of them are reached through the provider's single live
   credential file (ADR 0011). Locks are re-entrant within one context, so a
   service may lock a scope its caller already holds.
   **Mutating store methods take `ctx` as their first argument and have no
   ctx-less form** — see the deadlock trap below.
   `internal/store/coordinator_test.go` fails the build if a new mutating
   method bypasses the coordinator; the escape hatch is a map that requires a
   written reason.
6. **Every table has exactly one owning package.** Persistence is one package
   per group of tables (`internal/store`, `internal/journal`, `internal/pools`,
   `internal/hub`, `internal/presets`, `internal/bindings`, `internal/profile`,
   `internal/plugins`, `internal/modelcache`), not one store package for the
   whole schema — the older wording ("stores own SQL") was untrue and was
   therefore enforced by nobody. Ownership is declared in
   `internal/db/tables.go` and `internal/db/tables_test.go` fails the build when
   a package reaches into a table it does not own, or when a table appears with
   no owner. Sharing a table requires a written reason in the same map.
   Tables belonging to a client AnyPick integrates with (`auth_kv`,
   `credential`, `integration`) are marked `External` and are not ours.
7. **Never prompt without a TTY**, never guess a source, and keep `--json`
   machine-readable on every command. Exit codes come from `anyerr.ExitCode`.
   The TUI's TTY guard must use `isatty.IsTerminal`, not
   `Mode()&os.ModeCharDevice != 0` — see the trap below.
8. **The data directory is `~/.anypick`** (`ANYPICK_HOME` overrides).

## Traps that have cost real time

- **An unanchored `.gitignore` pattern matches at any depth.** `refs/` was
  written for the root screenshot folder; git also applied it to
  `src/go/internal/refs`, a real package that 45 committed files import. The
  result was three silences at once: `main` did not compile, `git status` said
  nothing (an ignored path is invisible, not merely untracked), and
  `refs.ProviderScope` — the lock scope behind ADR 0011 and invariant #5 — was
  absent from the repository. Anchor directory rules to the root: `/refs/`,
  `/design/`. `make check-paths` now fails if any `.go` file under `src/go` is
  git-ignored. Note that plain `git check-ignore` **skips tracked paths**, so
  the gate needs `--no-index` to see the pattern rather than the index.
- **`/dev/null` is a character device.** `Mode()&os.ModeCharDevice != 0` is not
  a TTY test: it says yes for `/dev/null`, so the TUI starts, reads no
  keystrokes and hangs under cron and CI. Use `isatty.IsTerminal(fd)`.
- **A TTY guard must run before any service is touched.** `tui.Run` checks it
  first, which is what lets a test pass a nil `*app.App` and assert the
  fail-closed path.
- **A mutating store call without `ctx` is a deadlock, not a missed lock.**
  Re-entrancy is carried in the context: `WithMutationLocks` skips scopes the
  context already holds. A store method that starts from
  `context.Background()` cannot see the lock its caller holds, so it calls
  `AcquireFileLock` again and waits on the in-process `pathMutex` until the
  budget runs out, then fails with `MUTATION_LOCK_TIMEOUT` (5s,
  `internal/lock/lock.go:20`). This already happened once, via
  `SaveInput` → `WriteMeta`. That is why the ctx-less `WriteMeta`, `Delete`,
  `SetActive`, `ClearActive`, `PatchMeta`, `WriteProxyState`,
  `ClearProxyState` and `SetProxyConfig` were **deleted** rather than kept as
  conveniences: the compiler now refuses the call. Reads keep their ctx-less
  form, but *not* because every read is lock-free: `AccountStore.Get` takes the
  provider lock because it re-materializes the snapshot cache, and `Get` is the
  wrong read for a display path. A browser sign-in holds `refs.ProviderScope`
  for its whole user-paced flow, so a ticker read that queues behind it burns
  the 5s budget and then fails with `MUTATION_LOCK_TIMEOUT`. Use
  `AccountStore.CachedAccount` (or `accounts.Service.CachedAccount`) for
  metadata-only display reads; reach for `Get` only when the files must exist on
  disk.
- **A mutation scope is not a resource identity.** `refs.ProviderScope` (lock
  scope, collapses accounts onto their provider) and `refs.Serialize` (precise
  identity, used for journal `affectedResources`) look interchangeable and are
  not. Using the precise identity for a lock silently splits one scope into many
  and reintroduces the interleaving ADR 0011 closed.
- **Error suggestions must live on the `anyerr.Error` instance**, via
  `anyerr.WithSuggestions`. Callers that format an error into a string before
  printing lose them.
- **Isolate tests.** `cmd/anypick` has `isolateEnv(t)` (temp `HOME` +
  `ANYPICK_HOME`) and `appReadyForTest`; the rest of the tree builds a root with
  `t.TempDir()` and `app.Options{SkipMigrate: true}`. Never let a test reach the
  developer's real `~/.anypick`.
- **The help tree has a golden.** `cmd/anypick/help_parity_test.go` compares the
  command tree against `src/go/testdata/parity/cli-tree.json`; adding or renaming a
  command fails until the fixture is regenerated.
- CI runs on `ubuntu-latest` and `windows-latest` for Go, plus macOS for the
  app. Do not claim support for platforms the release matrix does not build.
- The Codex desktop app keeps its own signed-in ChatGPT account and does **not**
  follow a switch of `~/.codex/auth.json`. AnyPick only detects the mismatch in
  order to suppress the quota readout (`src/go/internal/provider/codex.go`).
- **macOS chrome has one contract.** `src/macos/` is a System Settings
  clone (grouped `Form`, system controls, no cards) — except the menu-bar
  Quick Panel, which is deliberately customized product chrome per Pen
  board 29 (see `src/macos/README.md`). Pencil boards are IA/copy
  only. A prompt that says “native SwiftUI” is not enough if tray
  chrome is treated as a reference for panes or sheets.
- **`MenuBarExtra` is the `.window` Power Quick Panel.** Production and the
  fixture both host `src/macos/MenuBarMenu.swift`, matching Pencil node
  `m0s8el`. Do not replace it with a text-only menu. With no fixture variables
  set the app launches the regular macOS app and main window; the menu-bar extra
  remains a quick-access surface. Service rows must provide complete start/stop
  and restart actions; detailed configuration stays in the full app.
- **String-scan app tests lag the contract.** If a test fights
  `src/macos/README.md`, update the test.
- **Native app bundles are Node-free (ADR 0020).** Do not copy a private Node
  runtime, an npm/pnpm/tsx shim, an ESM plugin pack, or source-tree absolute
  paths into `AnyPick.app`. Two check enforce it and both must reject the same
  shapes: `src/macos/scripts/check-node-free-app.sh` (shell, used by Xcode) and
  `go run ./cmd/anypick-artifact node-free <root>` (Go, used by CI).
- **Repository-structure checks are Go, not shell in a recipe.** `make check-paths`
  and `make check-protocol` run `cmd/anypick-repocheck`, whose rules and reasons
  live in `internal/repocheck`. A check that parses a file must fail when it
  matches nothing — an empty extraction that reads as success is how three
  checks once went dead behind a comment in the Makefile. It also owns two rules
  nothing else can see: an untracked `.go` file under `src/go` (the module
  compiles it, a clean clone would not have it) and a stray untracked entry at
  the repository root (where a downloaded bundle or an exported credential
  would otherwise sit unnoticed).
- **A make target earns its place three ways only:** automation calls it, a
  document tells a human to run it, or it is the only way to run a distinct
  action. `make check-paths` fails when the target list and `.PHONY` disagree,
  and when a document or workflow names a target that does not exist.

## macOS SwiftUI (System Settings)

The macOS app’s main window must look like an app Apple could ship:
**System Settings structure**, not a website imitating macOS.

- **Edit `src/macos/`** for the app scene, panes, sheets, menu-bar content,
  and the production store/bridge. Fixture vs live is a data source, not a
  second app.
- **Use** `NavigationSplitView`, `List` (`.sidebar`), `Form` (`.grouped`),
  `Section`, `Toggle`, `Picker`, `TextField`, `Button`, native `Toolbar`,
  `ContentUnavailableView`. Platform-default fonts, spacing,
  colors, materials. Instant-apply toggles.
- **Do not use** custom cards, rounded containers, gradients, chip strips,
  handmade sidebars, RGB tokens, `TraySpacing` / `QuickPanelMetrics`, or
  pixel-perfect CSS-like padding in the main window. The menu-bar Quick
  Panel is the deliberate exception (customized per Pen board 29; details
  in `src/macos/README.md`). If SwiftUI cannot do a System Settings
  behavior, bridge AppKit (`NSAlert`, `NSOpenPanel`, `NSSavePanel`, `NSMenu`)
  instead of faking the control.
- **Settings (⌘,) is a normal main-window destination** with a sidebar row in
  both macOS and Tauri. It is one screen with separate grouped sections, not a
  popup or tabs. On macOS, keep its content in a native grouped `Form` and route
  the app-menu command to the same pane. Main destinations: Overview, Apps,
  Accounts & APIs, Proxy Hub, Proxies, Activity, Backups, Settings.
- **Preview the fixture, never a stale screenshot.** There is no
  `pnpm macos:design` — the root `package.json` was deleted with the JavaScript
  toolchain. Launch the app from Xcode with `ANYPICK_MACOS_FIXTURE` set in the
  scheme's environment variables; `src/macos/README.md` lists every variable.
- Full allowed/forbidden list, pane recipe, IA table, and current
  deviations: `src/macos/README.md`.

## Conventions

- Go is gofmt-clean and `go vet ./...` is clean. Run both before claiming a
  change is done; CI enforces them.
- Comments explain *why*, not what. Cite an ADR number when the constraint is
  load-bearing. Do not narrate the current task in a comment.
- The docs site (`docs/`) has its own formatter and lint policy; `cd docs` before
  running anything for it.
- **Do not add per-change entries to `CHANGELOG.md`.** It holds one short
  summary per release, written when the release is cut; full notes are
  generated from commits by `changelogithub`. A behavior change is recorded by
  writing a Conventional Commit subject a release reader would understand —
  `CONTRIBUTING.md` has the format.
- Provider-specific behavior belongs on the provider, not in core: the
  per-provider proxy upstream is `ResolveUpstream` on the provider value, the
  per-client model-role shape is `client.RolesFor`, and per-provider model-role
  defaults live in the `provider_model_roles` row keyed by
  `bindings.ModelRolesProviderKey`. Core, CLI, and TUI must not grow a
  `switch (providerId)`.
