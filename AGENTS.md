# Working on AnyPick

AnyPick is a Node CLI + Ink terminal UI that points AI coding clients at AI
accounts you already have. It rewrites other tools' credential and config files
and spawns local proxies, so a careless change corrupts a developer's real
logins. Bias toward verifying over assuming.

`CLAUDE.md` and `GEMINI.md` are symlinks to this file — edit this one.
`docs/AGENTS.md` (symlinked the same way) covers the docs site, which has
different rules; `docs/AGENT.md` is the nimbus template's own authoring guide.

## Commands

```bash
pnpm install
pnpm dev --help   # single app entry from source (tsx); long-running cmds auto-watch
pnpm check        # oxfmt --check + oxlint --type-aware + tsc (src & tests) + vitest
pnpm test         # vitest run
pnpm vitest run tests/<file>.test.ts   # one file
pnpm format       # rewrite with oxfmt
```

`pnpm dev …` is the only local app command — CLI, TUI, tray, proxies. It runs
source via tsx (no rebuild). `tui` / `tray` / `proxy serve` enable file watch
restart; force with `--watch` / disable with `--no-watch`.

`pnpm check` is exactly what CI runs. Run it before you claim a change is done.

The docs site is a **separate** pnpm project with its own lockfile:

```bash
cd docs && pnpm install && pnpm dev    # site only
cd docs && pnpm build
```

Your shell's working directory does not persist between tool calls. A bare
`pnpm build` runs the *CLI* build, not the site — prefix every docs command with
`cd docs &&` in the same invocation or you will silently test stale output.

## Where the authority lives

| Question | Read |
| --- | --- |
| How is this layered? What do I implement to add a client/provider? | `CONTRIBUTING.md` |
| How does everything wire together? | `src/core/app.ts` — the composition root |
| *Why* is it like this? | `adr/` — 10 accepted ADRs, cite them by number |
| What did we consider before? | `docs/history/` — **superseded proposals, provenance only.** Not the current spec. |
| What do users believe? | `docs/src/content/docs/` and `README.md` |

Do not edit an accepted ADR to reflect new thinking; write a new one and mark the
old superseded.

## Invariants

Breaking one of these is a correctness or security regression, not a style nit.

1. **Capability pairs come from `transportFor`** in
   `src/sources/account-adapters.ts`. Only `claude` and `codex` accept a source
   from a different provider; `gemini` and `kiro` return `unsupported` for
   anything but their own. `src/clients/index.ts` lists what *exists*, not what
   is *allowed* — never infer a pairing from the registry, and never publish one
   in docs or marketing copy without reading the adapter.
2. **Proxy secrets never cross an output boundary.** Every local proxy
   authenticates each request with a per-instance secret (ADR 0006) and binds
   loopback only (`assertLoopbackHost`). `publicProxyHandle` in
   `src/cli/commands.ts` strips the token before anything is printed — JSON
   output lands in CI logs.
3. **Activation is planned, journalled, then executed.** `ActivationPlan.steps`
   is the single source of truth for both execution and rollback; the executor
   must not re-derive behavior from transport capability, or planner and executor
   can diverge silently.
4. **`writeMeta` is the atomic commit point** for an account snapshot — a failed
   backup or import can never destroy the previously saved account (ADR 0004).
5. **Every persisted mutation runs under the coordinator** with sorted, scoped
   locks (ADR 0009). Correctness must not depend on the caller locking. Stores
   own SQL; services never embed it. Account mutations lock
   `providerScope(id)` — one scope per *provider*, not per account, because all
   of them are reached through the provider's single live credential file
   (ADR 0011). Locks are re-entrant within one async context, so a service may
   lock a scope its caller already holds.
6. **Never prompt without a TTY**, never guess a source, and keep `--json`
   machine-readable on every command. Exit codes come from `ExitCode` in
   `src/utils/errors.ts`.
7. **The data directory is `~/.anypick`** (`ANYPICK_HOME` overrides).

## Traps that have cost real time

- `tests/golden.test.ts` snapshots the help text. Any edit to `afterHelpText()`
  or command descriptions fails CI until
  `pnpm vitest run tests/golden.test.ts -u`.
- **A mutation scope is not a resource identity.** `mutationScopeForRef` (lock
  scope, collapses accounts onto their provider) and `serializeRef` (precise
  identity, used for journal `affectedResources`) look interchangeable and are
  not. Using `serializeRef` for a lock silently splits one scope into many and
  reintroduces the interleaving ADR 0011 closed.
- **Error suggestions must live on the `AnyPickError` instance.**
  `handleCliError` prints `err.toHuman()`, a *string*, so the `ERROR_HINTS` map
  in `src/cli/ux.ts` is only consulted by the call sites that pass the error
  object itself. Adding a key there does nothing for a thrown error.
- `tests/setup.ts` repoints `HOME` at a temp directory as a safety net. Write
  tests against a `mkdtemp` root via `createAppReady({ root, skipMigrate: true })`
  — see `tests/provider-extension.test.ts` for the reference shape.
- `.oxfmtrc.json` ignores `docs/**` and `*.md`. Do not run oxfmt on the site.
- CI runs on `ubuntu-latest` only. Do not claim Windows support anywhere.
- Node ≥22.5 is required for `node:sqlite`. `src/cli.ts` silences that
  `ExperimentalWarning` *before* any import that touches sqlite — keep it first.
- The Codex desktop app keeps its own signed-in ChatGPT account and does **not**
  follow a switch of `~/.codex/auth.json`. AnyPick only detects the mismatch in
  order to suppress the quota readout (`src/providers/codex.ts`).

## Conventions

- ESM, single quotes, 2-space indent, 100 columns, trailing commas — enforced, so
  just run `pnpm format`.
- Comments explain *why*, not what. Cite an ADR number when the constraint is
  load-bearing. Do not narrate the current task in a comment.
- New `any` in `src/` is narrowed at the boundary, not suppressed; see the lint
  policy in `CONTRIBUTING.md` for the two deliberate rule exceptions.
- **Do not edit `CHANGELOG.md`.** It is frozen at 1.0.0; later notes are
  generated from commits by `changelogithub`. A behavior change is recorded by
  writing a Conventional Commit subject a release reader would understand —
  `CONTRIBUTING.md` has the format.
- Provider-specific behavior belongs on the provider (`roleDefaults`,
  `suggestModels`, …). Core, CLI, and TUI must not grow a `switch (providerId)`.
